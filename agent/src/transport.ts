// WebSocket client side of the agent. Connects to one or more hubs
// in parallel (multi-hub since v0.5+), performs the hello/welcome
// handshake, drains an offline-replay buffer on every reconnect.
//
// Each hub gets its own:
//   - WS connection
//   - reconnect timer + exponential backoff state
//   - ping timer
//   - replay queue (a slow hub doesn't block samples to a fast one)
//
// A single-hub config (legacy HUB_URL/HOST_ID/AGENT_TOKEN) is just
// the array-of-1 case — no special path.
//
// Design notes (cf. Docs/V0_5_PLAN.md §7, MULTI_HOST_PLAN.md §4):
//  - Reconnect uses exponential backoff (1s → 30s) with ±20% jitter
//    so N agents redialing after a hub restart don't thunder-herd.
//  - Outbound samples while disconnected go into a ring buffer
//    capped at BUFFER_MAX entries (~1 h × 1 Hz × few GPUs).
//  - On reconnect the buffer drains in chunks of REPLAY_CHUNK frames
//    per REPLAY_DELAY_MS, well under the hub's RATE_LIMIT_PER_SEC.
//  - 4001 (Unauthorized) / 1008 (Policy) on a single hub doesn't
//    kill the agent — other hubs keep going. A repeated 4001 on the
//    SAME hub still exits because the token is permanently bad.

import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  accessSync,
  utimesSync,
  constants as fsConstants,
} from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { logger } from "./logger.js";
import type { GpuSample } from "../../server/services/parsers/nvidia.js";
import type { AgentGpuProcess } from "./collectors/processes.js";
import type { AgentConfig, HubTarget } from "./config.js";

export type InstallMode = "docker" | "systemd" | "windows" | "unknown";

// Detected once at module load — the runtime context doesn't change
// over the life of the agent process. Result is included in every
// hello frame so the hub can show the *right* update command per
// host (bare-metal curl vs `docker compose pull`).
export const INSTALL_MODE: InstallMode = detectInstallMode();

function detectInstallMode(): InstallMode {
  // Windows always reports 'windows'. The install.ps1 installer
  // registers a Scheduled Task + launcher.ps1 supervisor — distinct
  // enough from 'systemd' (different update mechanism: .pending file
  // swap vs systemd unit restart) that the hub needs to know.
  if (process.platform === "win32") return "windows";
  // Strongest signal — Docker mounts an empty marker file.
  if (existsSync("/.dockerenv")) return "docker";
  // Fallback: cgroup v1 paths usually contain /docker/ or /containerd/.
  try {
    const cg = readFileSync("/proc/self/cgroup", "utf8");
    if (/docker|containerd|kubepods/i.test(cg)) return "docker";
  } catch {
    /* /proc not readable — happens on non-Linux */
  }
  // systemd-launched agents have INVOCATION_ID set, but absence
  // doesn't prove bare-metal (could be a launched-by-hand binary).
  // We bucket every non-Docker run as 'systemd' since the update
  // command is the same: curl + systemctl restart.
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) return "systemd";
  // If we got here we're outside Docker but not under systemd —
  // most likely a developer running `node agent.mjs` by hand.
  return "unknown";
}

const BUFFER_MAX = 3600;
const RECONNECT_MIN_MS = 1_000;
const PING_INTERVAL_MS = 15_000;
const REPLAY_CHUNK = 50;
const REPLAY_DELAY_MS = 600;
// A connection has to stay open this long before we consider it "stable"
// and reset the reconnect backoff. Without it, a hub that accepts the WS
// then closes 1008 right after welcome would reboucle à 1s indefinitely.
const STABLE_RESET_MS = 30_000;

// Module-level: same FS for every hub, so warn once per process even if
// several hubs push the same agent_update frame.
let agentUpdateRoWarned = false;
// Build-time inject via esbuild --define (scripts/build.mjs). The
// typeof guard keeps `tsx`/dev runs alive — when the literal isn't
// substituted, `typeof __AGENT_VERSION__` evaluates to 'undefined'
// without throwing, and we fall back to a clearly tagged dev marker.
export const AGENT_VERSION: string =
  typeof __AGENT_VERSION__ !== "undefined" ? __AGENT_VERSION__ : "0.0.0-dev";
const PROTOCOL_VER = 1;
// Number of consecutive auth failures before we give up on a hub
// entirely. One 4001 might be a transient race during hub restart;
// three in a row means the token is genuinely wrong.
const AUTH_FAILURE_LIMIT = 3;

// Heartbeat file touched on every successful WS frame send. Docker
// healthcheck compares its mtime against now (60 s threshold) to gate
// the container's "healthy" status. Stays in /tmp because:
//   - Docker containers always have /tmp writable (no extra mount).
//   - systemd unit uses PrivateTmp=true so the file is namespaced
//     per-service; no risk of cross-collisions on a shared host.
// HEARTBEAT_FILE env override is supported for non-default rootfs
// layouts but the default is what compose/healthcheck command both
// hard-code, so changing it requires updating both sides.
const HEARTBEAT_FILE =
  process.env.HEARTBEAT_FILE || "/tmp/.gpuviewr-agent-alive";

interface SampleFrame {
  type: "sample";
  ts_epoch: number;
  samples: GpuSample[];
}

interface ProcessFrame {
  type: "processes";
  ts_epoch: number;
  processes: AgentGpuProcess[];
}

type BufferableFrame = SampleFrame | ProcessFrame;
type OutboundFrame =
  | BufferableFrame
  | { type: "hello" | "ping"; [k: string]: unknown };

interface IncomingFrame {
  type: string;
  [k: string]: unknown;
}

export interface Transport {
  start(): void;
  stop(): void;
  enqueueSample(samples: GpuSample[]): void;
  enqueueProcesses(processes: AgentGpuProcess[]): void;
}

interface HubConnection {
  target: HubTarget;
  ws: WebSocket | null;
  reconnectDelayMs: number;
  reconnectTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  replayTimer: NodeJS.Timeout | null;
  /** Fires STABLE_RESET_MS after `open`; resets reconnectDelayMs. */
  stableTimer: NodeJS.Timeout | null;
  buffer: BufferableFrame[];
  authFailures: number;
  /** True while a drain pass is in flight. New samples produced during
   *  the drain are queued instead of sent inline — keeps the wire under
   *  the hub's rate limit (replay chunk + live samples could otherwise
   *  combine and trip a close 1008). */
  replaying: boolean;
  /** Short tag for logging — `hub1`, `hub2` … so messages stay
   *  unambiguous when N hubs share the same logger. */
  tag: string;
}

export function createTransport(config: AgentConfig): Transport {
  let stopped = false;

  const connections: HubConnection[] = config.hubs.map((target, i) => ({
    target,
    ws: null,
    reconnectDelayMs: RECONNECT_MIN_MS,
    reconnectTimer: null,
    pingTimer: null,
    replayTimer: null,
    stableTimer: null,
    buffer: [],
    authFailures: 0,
    replaying: false,
    tag: config.hubs.length > 1 ? `hub${i + 1}` : "ws",
  }));

  // ── Per-hub helpers (closure over `conn`) ─────────────────────────────────

  function pushToBuffer(conn: HubConnection, frame: BufferableFrame): void {
    conn.buffer.push(frame);
    while (conn.buffer.length > BUFFER_MAX) conn.buffer.shift();
  }

  // Bump the healthcheck heartbeat file's mtime. utimesSync is the
  // cheapest path (a single utimensat syscall); fallback to a tiny
  // writeFileSync handles the first call when the file doesn't exist
  // yet. Any error is swallowed: the agent must never crash on a
  // healthcheck plumbing issue (e.g. read-only /tmp on a weirdly
  // restricted host).
  function touchHeartbeat(): void {
    try {
      const now = new Date();
      utimesSync(HEARTBEAT_FILE, now, now);
    } catch {
      try {
        writeFileSync(HEARTBEAT_FILE, "");
      } catch {
        /* swallow: no healthcheck signal but agent must keep running */
      }
    }
  }

  function sendRaw(conn: HubConnection, frame: OutboundFrame): void {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(frame));
      touchHeartbeat();
    } catch (err) {
      logger.warn(conn.tag, "send failed:", (err as Error).message);
    }
  }

  function buildUrl(target: HubTarget): string {
    const u = new URL(target.url);
    if (!u.pathname || u.pathname === "/") u.pathname = "/agent";
    u.searchParams.set("token", target.token);
    u.searchParams.set("host_id", target.hostId);
    return u.toString();
  }

  function flushBuffer(conn: HubConnection): void {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
    if (conn.replaying) return;
    conn.replaying = true;
    drainChunk(conn, 0);
  }

  function drainChunk(conn: HubConnection, totalDrained: number): void {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      conn.replayTimer = null;
      conn.replaying = false;
      return;
    }
    let drained = totalDrained;
    let n = 0;
    while (
      n < REPLAY_CHUNK &&
      conn.buffer.length > 0 &&
      conn.ws.readyState === WebSocket.OPEN
    ) {
      const frame = conn.buffer.shift()!;
      sendRaw(conn, frame);
      n++;
      drained++;
    }
    if (conn.buffer.length === 0) {
      if (drained > 0)
        logger.info(
          conn.tag,
          `Replayed ${drained} buffered frame(s) after reconnect`,
        );
      conn.replayTimer = null;
      conn.replaying = false;
      return;
    }
    conn.replayTimer = setTimeout(
      () => drainChunk(conn, drained),
      REPLAY_DELAY_MS,
    );
  }

  function startPing(conn: HubConnection): void {
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => {
      if (conn.ws?.readyState === WebSocket.OPEN) {
        sendRaw(conn, {
          type: "ping",
          ts_epoch: Math.floor(Date.now() / 1000),
        });
      }
    }, PING_INTERVAL_MS);
  }

  function stopPing(conn: HubConnection): void {
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.pingTimer = null;
  }

  function sendHello(conn: HubConnection): void {
    sendRaw(conn, {
      type: "hello",
      host_id: conn.target.hostId,
      agent_version: AGENT_VERSION,
      protocol_ver: PROTOCOL_VER,
      hostname: process.env.HOSTNAME || null,
      install_mode: INSTALL_MODE,
      capabilities: {
        gpu: config.features.gpu,
        system: config.features.system,
        temps: config.features.temps,
        processes: config.features.processes,
      },
    });
  }

  function handleIncoming(conn: HubConnection, raw: string): void {
    let frame: IncomingFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      logger.warn(conn.tag, "Bad JSON from hub");
      return;
    }
    switch (frame.type) {
      case "welcome": {
        logger.success(
          conn.tag,
          `Hub welcomed us (hub_version=${frame.hub_version}, protocol_ver=${frame.protocol_ver})`,
        );
        const hubProto = frame.protocol_ver as number | undefined;
        if (hubProto !== undefined && hubProto > PROTOCOL_VER) {
          logger.error(
            conn.tag,
            `Hub speaks protocol_ver=${hubProto} > agent's ${PROTOCOL_VER}. Upgrade agent.`,
          );
          process.exit(1);
        }
        conn.authFailures = 0;
        sendHello(conn);
        flushBuffer(conn);
        break;
      }
      case "pong":
        break;
      case "config":
        // Reserved for future hub-driven tick rate changes.
        break;
      case "agent_update":
        // Self-replace + exit. systemd / Docker restart-policy picks
        // up the new binary on the next launch. Failures (bad
        // checksum, write error) are logged and the agent keeps
        // running the old version — never crash on a bad push.
        applyAgentUpdate(conn, frame);
        break;
      default:
        logger.debug(conn.tag, `Unknown frame type from hub: ${frame.type}`);
    }
  }

  function applyAgentUpdate(conn: HubConnection, frame: IncomingFrame): void {
    const targetVersion = String(frame.target_version ?? "?");
    const sha256 = String(frame.sha256 ?? "");
    const sizeClaim = Number(frame.size ?? 0);
    const b64 = String(frame.bundle_b64 ?? "");
    if (!sha256 || !b64) {
      logger.warn(
        conn.tag,
        "agent_update: missing sha256 or bundle_b64; ignoring",
      );
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch (err) {
      logger.warn(
        conn.tag,
        `agent_update: base64 decode failed: ${(err as Error).message}`,
      );
      return;
    }
    if (sizeClaim && buf.length !== sizeClaim) {
      logger.warn(
        conn.tag,
        `agent_update: size mismatch (got ${buf.length}, expected ${sizeClaim})`,
      );
      return;
    }
    const computed = createHash("sha256").update(buf).digest("hex");
    if (computed !== sha256) {
      logger.warn(
        conn.tag,
        `agent_update: sha256 mismatch (got ${computed.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…)`,
      );
      return;
    }
    // process.argv[1] is the path of the launched script — for the
    // systemd unit that's /opt/gpuviewr-agent/agent.mjs. Atomic swap:
    // write to a sibling .new file, fsync, rename. POSIX rename(2) is
    // atomic on the same filesystem, so a half-written .new can never
    // be picked up as agent.mjs on next boot.
    const target = process.argv[1];
    if (!target || !existsSync(target)) {
      logger.warn(
        conn.tag,
        `agent_update: can't resolve own binary path (argv[1]=${target}); skipping`,
      );
      return;
    }
    // systemd install ships with ProtectSystem=strict + ReadWritePaths=
    // (cf. agent/install.sh.tpl), which mounts /opt read-only. Without
    // this pre-check the writeFileSync below EROFS every ~2h and spams
    // the journal. Detect once, warn once, then stay quiet.
    const installDir = dirname(target);
    try {
      accessSync(installDir, fsConstants.W_OK);
    } catch {
      if (!agentUpdateRoWarned) {
        agentUpdateRoWarned = true;
        logger.warn(
          conn.tag,
          `agent_update skipped: install dir is read-only (${installDir}). systemd unit needs ReadWritePaths=${installDir}, or use the Docker install for auto-updates.`,
        );
      }
      return;
    }
    // Cross-platform swap strategy:
    //
    //   Linux: write .new, fsync, atomic rename(2) → target, exit. systemd
    //   restarts the unit and picks up the new bundle. rename(2) is atomic
    //   on the same FS so a half-written .new can never be loaded.
    //
    //   Windows: rename-onto-target while the .mjs may still be cached by
    //   the running node process is fragile (sharing mode quirks, AV
    //   handles, etc.), and a clean exit(0) doesn't re-trigger a Task
    //   Scheduler restart from an AtStartup trigger — that would leave
    //   the agent dead until reboot. We instead stage a sibling
    //   `agent.mjs.pending`, exit, and let launcher.ps1's while-loop
    //   atomically swap it on the next iteration (when node is no longer
    //   running, so no lock contention).
    const isWin = process.platform === "win32";
    const tmp = isWin ? `${target}.pending` : `${target}.new`;
    try {
      writeFileSync(tmp, buf, { mode: 0o755 });
      // Open r+ (read+write) so fsyncSync has GENERIC_WRITE access on
      // Windows. With 'r' the Windows fsync → FlushFileBuffers Win32
      // call fails with EPERM ("operation not permitted, fsync"),
      // observed on the v0.6.9 Windows agent receiving v0.8.0 push
      // 2026-05-18 evening. Posix accepts fsync on any open fd so
      // 'r+' is also fine on Linux.
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!isWin) renameSync(tmp, target);
    } catch (err) {
      logger.error(
        conn.tag,
        `agent_update: filesystem swap failed: ${(err as Error).message}`,
      );
      return;
    }
    logger.success(
      conn.tag,
      isWin
        ? `agent_update staged at ${tmp}: ${AGENT_VERSION} → ${targetVersion} (${buf.length}B). Exiting; launcher.ps1 will swap and restart node.`
        : `agent_update applied: ${AGENT_VERSION} → ${targetVersion} (${buf.length}B). Exiting; systemd will restart.`,
    );
    // Tiny tail so the log line flushes through the logger transport
    // before the process dies. 100ms is enough for stdout to drain.
    setTimeout(() => process.exit(0), 100).unref();
  }

  function scheduleReconnect(conn: HubConnection): void {
    if (stopped) return;
    if (conn.reconnectTimer) return;
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    const delay = Math.min(
      conn.reconnectDelayMs * jitter,
      config.reconnectMaxMs,
    );
    logger.info(
      conn.tag,
      `Reconnecting in ${Math.round(delay)}ms (buffered=${conn.buffer.length})`,
    );
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      connect(conn);
    }, delay);
    conn.reconnectDelayMs = Math.min(
      conn.reconnectDelayMs * 2,
      config.reconnectMaxMs,
    );
  }

  function connect(conn: HubConnection): void {
    if (stopped) return;
    const url = buildUrl(conn.target);
    logger.info(
      conn.tag,
      `Connecting to ${url.replace(/token=[^&]+/, "token=***")}`,
    );
    const opts = config.tlsInsecure ? { rejectUnauthorized: false } : {};
    const ws = new WebSocket(url, opts);
    conn.ws = ws;
    ws.on("open", () => {
      logger.success(conn.tag, "Connection open");
      // Don't reset backoff on `open` alone — a hub that accepts the
      // WS then closes 1008 right after welcome would loop at 1s.
      // Only reset after the connection has held for STABLE_RESET_MS.
      if (conn.stableTimer) clearTimeout(conn.stableTimer);
      conn.stableTimer = setTimeout(() => {
        conn.reconnectDelayMs = RECONNECT_MIN_MS;
        conn.stableTimer = null;
      }, STABLE_RESET_MS);
      startPing(conn);
    });
    ws.on("message", (data) => handleIncoming(conn, data.toString()));
    ws.on("close", (code, reason) => {
      stopPing(conn);
      if (conn.stableTimer) {
        clearTimeout(conn.stableTimer);
        conn.stableTimer = null;
      }
      // If a replay was in flight, mark it done so the next reconnect
      // can start a fresh drain (drainChunk also resets this on its
      // own NOT-OPEN exit, but it only runs between chunks).
      conn.replaying = false;
      const r = reason?.toString() || "";
      logger.warn(
        conn.tag,
        `Connection closed (code=${code}${r ? `, reason=${r}` : ""})`,
      );
      conn.ws = null;
      // 4001/1008 = auth or policy violations. With multi-hub, one bad
      // hub doesn't kill the agent — other hubs keep working. But three
      // repeated failures on the SAME hub is a permanent token issue.
      if (code === 4001 || code === 1008) {
        conn.authFailures++;
        if (conn.authFailures >= AUTH_FAILURE_LIMIT) {
          logger.error(
            conn.tag,
            `${conn.authFailures} consecutive auth failures — giving up on this hub. Check its HOST_ID/AGENT_TOKEN.`,
          );
          // Don't schedule another reconnect for this hub. Other hubs
          // (if any) continue. Single-hub config → agent effectively
          // stops sending samples but keeps the process alive so
          // a fix-and-restart of the .env recovers cleanly.
          return;
        }
      }
      scheduleReconnect(conn);
    });
    ws.on("error", (err) => {
      logger.warn(conn.tag, `Socket error: ${err.message}`);
    });
  }

  // ── Public API: fan-out to every hub ──────────────────────────────────────

  function broadcast(frame: BufferableFrame): void {
    for (const conn of connections) {
      // If a replay drain is in flight, queue behind it instead of
      // racing — otherwise live samples + buffered frames combine and
      // trip the hub's RATE_LIMIT_PER_SEC, triggering a close 1008
      // → reconnect → replay → close storm.
      if (conn.ws?.readyState === WebSocket.OPEN && !conn.replaying) {
        sendRaw(conn, frame);
      } else {
        pushToBuffer(conn, frame);
      }
    }
  }

  return {
    start(): void {
      stopped = false;
      for (const conn of connections) connect(conn);
    },
    stop(): void {
      stopped = true;
      for (const conn of connections) {
        stopPing(conn);
        if (conn.reconnectTimer) {
          clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = null;
        }
        if (conn.replayTimer) {
          clearTimeout(conn.replayTimer);
          conn.replayTimer = null;
        }
        if (conn.stableTimer) {
          clearTimeout(conn.stableTimer);
          conn.stableTimer = null;
        }
        conn.replaying = false;
        if (conn.ws) {
          try {
            conn.ws.close(1000);
          } catch {
            /* ignore */
          }
          conn.ws = null;
        }
      }
    },
    enqueueSample(samples: GpuSample[]): void {
      if (samples.length === 0) return;
      broadcast({
        type: "sample",
        ts_epoch: Math.floor(Date.now() / 1000),
        samples,
      });
    },
    enqueueProcesses(processes: AgentGpuProcess[]): void {
      // Empty snapshots are meaningful — they signal "no procs right
      // now" so a stale list clears. Don't drop them.
      broadcast({
        type: "processes",
        ts_epoch: Math.floor(Date.now() / 1000),
        processes,
      });
    },
  };
}

/** Exposed for tests — verifies that pushing past BUFFER_MAX drops old entries. */
export const _TEST_HOOKS = { BUFFER_MAX };
