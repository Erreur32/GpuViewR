// WebSocket ingest path for remote agents (multi-host jalon 3).
//
// Auth model (cf. Docs/MULTI_HOST_PLAN.md §3):
//  - token + host_id arrive as query string params at handshake
//  - host_id must NOT equal LOCAL_HOST_ID (self-loop guard)
//  - hub looks up the host by id (kind must be 'agent', not 'disabled')
//  - bcrypt.compare against the stored hash
//  - after handshake, the session's host_id is authoritative — any
//    host_id field present in incoming frames is IGNORED to defeat
//    the "compromised agent A publishes as host B" attack
//
// The rate limit (RATE_LIMIT_PER_SEC) is per-session; an offending
// agent gets 1008 Policy Violation and must reconnect with backoff.

import type { IncomingMessage } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { HostsRepo, LOCAL_HOST_ID, type HostRecord } from '../database/models/Host.js';
import { metricsBus } from './_metricsBus.js';
import { logger } from '../utils/logger.js';
import { hostHostname } from '../utils/hostHostname.js';
import type { GpuSample } from './parsers/nvidia.js';
import { agentProcessStore } from './agentProcessStore.js';
import type { GpuProcess } from './_processTypes.js';

const RATE_LIMIT_PER_SEC = 100;
const LAST_SEEN_THROTTLE_MS = 1000;
const PROTOCOL_VER = 1;
/** Cooldown between auto-update pushes to the same host. Stops a hard
 *  crash-loop on the remote (agent crashes → systemd restarts → hello
 *  with same old version → another push) from saturating the WS.
 *  Configurable via AUTO_UPDATE_COOLDOWN_MS env (default 5 min) — bumping
 *  it down to e.g. 60s is useful for testing the v0.6.5 scheduler. */
const AUTO_UPDATE_COOLDOWN_MS = (() => {
  const raw = Number.parseInt(process.env.AUTO_UPDATE_COOLDOWN_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
})();
/** Hard cap on the bundle base64 payload size. Real bundles are
 *  ~215 KB; 2 MB is comfortable headroom and refuses anything absurd
 *  if the build pipeline goes wrong. */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

interface HelloFrame {
  type: 'hello';
  host_id: string;
  agent_version?: string;
  protocol_ver?: number;
  hostname?: string;
  install_mode?: 'docker' | 'systemd' | 'windows' | 'unknown';
  capabilities?: { gpu?: boolean; system?: boolean; temps?: boolean; processes?: boolean };
}

interface SampleFrame {
  type: 'sample';
  ts_epoch?: number;
  samples: GpuSample[];
}

interface PingFrame {
  type: 'ping';
  ts_epoch?: number;
}

interface ProcessFrame {
  type: 'processes';
  ts_epoch?: number;
  processes: GpuProcess[];
}

type IncomingFrame = HelloFrame | SampleFrame | PingFrame | ProcessFrame | { type: string; [k: string]: unknown };

/**
 * Look up the host that owns this token + claimed id.
 *
 * Two auth paths:
 *  1. Bootstrap (v0.5+) — token equals config.localAgentBootstrap AND
 *     claimedHostId === LOCAL_HOST_ID. Used by the sidecar agent in
 *     the same docker compose stack. Auto-upserts the local host row
 *     as kind='agent' if missing or migrates a legacy kind='local' row.
 *     Constant-time compare to avoid leaking which envs are set.
 *  2. Regular agent — bcrypt-verify against host.token_hash, enrolled
 *     beforehand via Settings → Hosts. Bcrypt comparison is per-
 *     handshake (typically once per agent restart); LRU cache lives
 *     in MULTI_HOST_PLAN.md §13.1.1 if scale ever needs it.
 */
export async function authenticateAgent(token: string, claimedHostId: string): Promise<HostRecord | null> {
  if (!token || !claimedHostId) return null;

  // Bootstrap path: only valid for LOCAL_HOST_ID + when the hub has a
  // LOCAL_AGENT_BOOTSTRAP configured (aggregator-only deployments
  // leave it empty, which disables the sidecar enrollment entirely).
  if (claimedHostId === LOCAL_HOST_ID) {
    if (!config.localAgentBootstrap) return null;
    if (!constantTimeEqual(token, config.localAgentBootstrap)) return null;
    return upsertLocalSidecarHost();
  }

  const host = HostsRepo.findById(claimedHostId);
  if (!host) return null;
  if (host.kind !== 'agent') return null;
  if (host.status === 'disabled') return null;
  if (!host.token_hash) return null;
  const ok = await bcrypt.compare(token, host.token_hash);
  return ok ? host : null;
}

/** Ensures the local-host row exists as kind='agent' for the sidecar.
 *  Handles three states:
 *    - Row absent          → INSERT.
 *    - kind='local' legacy → migrate kind to 'agent' (v0.4 → v0.5).
 *    - kind='agent' already → no-op, return it.
 *  Idempotent — called on every successful sidecar handshake. */
function upsertLocalSidecarHost(): HostRecord {
  const existing = HostsRepo.findById(LOCAL_HOST_ID);
  const hostname = hostHostname();
  if (!existing) {
    HostsRepo.insert({
      id: LOCAL_HOST_ID,
      label: hostname,
      hostname,
      kind: 'agent',
      token_hash: null,   // bootstrap token isn't bcrypt-hashed; auth happens via shared-secret compare
      capabilities: JSON.stringify({ gpu: true, system: false, temps: false, processes: true }),
      agent_version: null,
      status: 'online',
    });
    logger.success('agent', `Auto-enrolled sidecar agent: ${LOCAL_HOST_ID} (label=${hostname})`);
    return HostsRepo.findById(LOCAL_HOST_ID)!;
  }
  if (existing.kind !== 'agent') {
    HostsRepo.update(LOCAL_HOST_ID, { ...existing, kind: 'agent' });
    logger.info('agent', `Migrated legacy 'local' host (kind=${existing.kind}) to kind='agent' for v0.5 sidecar.`);
    return HostsRepo.findById(LOCAL_HOST_ID)!;
  }
  return existing;
}

/** Constant-time string compare. Avoids leaking the bootstrap secret
 *  through string-length / early-exit timing differences. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn('agent', 'send failed:', (err as Error).message);
  }
}

// ── Auto-update push (v0.5.3+) ──────────────────────────────────────
//
// The hub holds the canonical agent.mjs (the same file served at
// /agent.mjs for bare-metal bootstraps). On a successful hello from
// an agent that has opted into auto-update, the hub pushes that bundle
// down the existing WS so the agent can self-replace and restart.
//
// We cache the bundle + its SHA256 once at boot. The bundle changes
// only on hub upgrade (image rebuild) so re-reading the file on every
// hello would be pure waste.
//
// Security note: the WS is already authenticated (bcrypt token or
// bootstrap shared-secret), so a connected agent already trusts the
// hub. Adding binary-replace authority on top is still a meaningful
// escalation though, which is why auto_update is opt-in per host
// (default 0) and Docker hosts are skipped entirely (their bundle
// lives in the read-only image layer, can't be replaced from inside).

const __filename = fileURLToPath(import.meta.url);
const BUNDLE_PATH = path.resolve(path.dirname(__filename), '..', '..', 'agent', 'dist', 'agent.mjs');

interface CachedBundle { base64: string; sha256: string; size: number; version: string }
let cachedBundle: CachedBundle | null = null;
/** In-memory per-host throttle: last push timestamp. Resets on hub
 *  restart, which is exactly what we want — a fresh hub means a fresh
 *  bundle, so re-pushing right away is correct behaviour. */
const lastPushedAtMs = new Map<string, number>();

/** Live WebSocket registry, keyed by canonical host_id (set after auth).
 *  Lets the REST API push agent_update frames out-of-band — without it,
 *  the only path to send is the closure inside handleConnection. Cleared
 *  on close so a stale socket can't accidentally receive a push.
 *  Exported so the v0.6.5 auto-update scheduler can iterate connected
 *  hosts without re-implementing the auth/lifecycle bookkeeping here. */
export const liveAgentSockets = new Map<string, WebSocket>();

/** Populate lastPushedAtMs from the DB at boot so the cooldown survives
 *  hub restarts. Without this, a hub bounce immediately re-pushes the
 *  same bundle on every reconnect (one push per agent), which on a fleet
 *  of N hosts means N × bundle_size egress for nothing. Called once
 *  during setupAgentIngestWS. */
function bootstrapCooldownFromDb(): void {
  let restored = 0;
  for (const h of HostsRepo.list()) {
    if (h.last_update_pushed_at) {
      lastPushedAtMs.set(h.id, h.last_update_pushed_at * 1000);
      restored++;
    }
  }
  if (restored > 0) logger.info('agent', `Auto-update cooldown bootstrapped from DB: ${restored} host(s)`);
}

function loadBundle(hubVersion: string): CachedBundle | null {
  if (cachedBundle) return cachedBundle;
  if (!fs.existsSync(BUNDLE_PATH)) {
    logger.warn('agent', `Auto-update unavailable: bundle missing at ${BUNDLE_PATH}`);
    return null;
  }
  const buf = fs.readFileSync(BUNDLE_PATH);
  if (buf.length > MAX_BUNDLE_BYTES) {
    logger.warn('agent', `Auto-update disabled: bundle ${buf.length}B > cap ${MAX_BUNDLE_BYTES}B`);
    return null;
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  cachedBundle = { base64: buf.toString('base64'), sha256, size: buf.length, version: hubVersion };
  logger.info('agent', `Auto-update bundle cached: ${buf.length}B, sha256=${sha256.slice(0, 12)}…, version=${hubVersion}`);
  return cachedBundle;
}

/** True when the agent declared a version we know is older than the
 *  hub. Same semver-ish rules as the frontend's isAgentOutdated —
 *  intentionally simple: major.minor.patch numeric compare, prerelease
 *  suffixes stripped, unparseable → false (don't push). */
function isOlder(agentVer: string | null, hubVer: string): boolean {
  if (!agentVer) return false;
  const parse = (v: string): [number, number, number] | null => {
    let clean = v;
    if (clean.startsWith('v')) clean = clean.slice(1);
    const dashAt = clean.indexOf('-');
    if (dashAt >= 0) clean = clean.slice(0, dashAt);
    const parts = clean.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return [parts[0], parts[1], parts[2]];
  };
  const a = parse(agentVer); const h = parse(hubVer);
  if (!a || !h) return false;
  if (a[0] !== h[0]) return a[0] < h[0];
  if (a[1] !== h[1]) return a[1] < h[1];
  return a[2] < h[2];
}

/** Force-push the current agent bundle to a connected host. Bypasses
 *  the opt-in (auto_update) and version (isOlder) and cooldown gates —
 *  this is the admin's "do it now" button — but keeps the install-mode
 *  guard: Docker agents have a read-only bundle baked in the image,
 *  pushing to them is pointless and would just confuse the agent.
 *
 *  Returns a discriminated union the route handler can map to HTTP
 *  status codes — no thrown errors, so the REST surface stays predictable.
 */
export function forceAgentUpdate(
  hostId: string,
  hubVersion: string,
): { ok: true; version: string; size: number } | { ok: false; reason: string; status: number } {
  const host = HostsRepo.findById(hostId);
  if (!host) return { ok: false, reason: 'host not found', status: 404 };
  if (host.kind !== 'agent') return { ok: false, reason: 'not an agent host', status: 400 };
  // Auto-update works on systemd (Linux) and windows (launcher.ps1
  // supervisor swaps .pending into place on next iteration). Docker
  // can't rewrite a baked-in bundle; 'unknown' is legacy / dev runs.
  if (host.install_mode !== 'systemd' && host.install_mode !== 'windows') {
    return { ok: false, reason: `force-update only supported on systemd/windows hosts (install_mode=${host.install_mode ?? 'unknown'})`, status: 400 };
  }
  const ws = liveAgentSockets.get(hostId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: 'agent not connected', status: 409 };
  }
  const bundle = loadBundle(hubVersion);
  if (!bundle) return { ok: false, reason: 'bundle unavailable on this hub', status: 503 };

  // Manual triggers still update the cooldown timestamp so the
  // post-restart hello doesn't immediately re-push on top of itself.
  const nowMs = Date.now();
  lastPushedAtMs.set(hostId, nowMs);
  logger.info(
    'agent',
    `Force-update push → ${host.id} (label=${host.label}, ${host.agent_version ?? '?'} → ${hubVersion}, ${bundle.size}B)`,
  );
  safeSend(ws, {
    type: 'agent_update',
    target_version: hubVersion,
    sha256: bundle.sha256,
    size: bundle.size,
    bundle_b64: bundle.base64,
  });
  // Persist for the UI tooltip + cooldown survival across hub restarts.
  HostsRepo.update(hostId, {
    last_update_pushed_at: Math.floor(nowMs / 1000),
    last_update_pushed_version: hubVersion,
  });
  return { ok: true, version: hubVersion, size: bundle.size };
}

/** Exported so the v0.6.5 scheduler (server/services/agentUpdateScheduler.ts)
 *  can re-use the exact same gate logic on its periodic tick — no risk of
 *  the scheduler and the welcome-time path drifting apart. */
export function maybePushAutoUpdate(ws: WebSocket, host: HostRecord, hubVersion: string): void {
  // Gate 1: opt-in.
  if (!host.auto_update) return;
  // Gate 2: bare-metal only — Docker agents can't rewrite a baked-in
  // bundle. The 'unknown' bucket (legacy agents, dev runs) is also
  // skipped: better to surface the manual pill than push to something
  // we can't reliably restart. 'windows' is allowed: launcher.ps1
  // supervises node + atomically swaps agent.mjs.pending on the next
  // iteration of its while-loop (same effective semantics as systemd's
  // ExecStart restart, ~5 s downtime).
  if (host.install_mode !== 'systemd' && host.install_mode !== 'windows') return;
  // Gate 3: outdated.
  if (!isOlder(host.agent_version, hubVersion)) return;
  // Gate 4: cooldown — protect against crash-loop amplification.
  const lastAt = lastPushedAtMs.get(host.id) ?? 0;
  if (Date.now() - lastAt < AUTO_UPDATE_COOLDOWN_MS) {
    logger.info('agent', `Auto-update skipped for ${host.id}: cooldown active`);
    return;
  }
  const bundle = loadBundle(hubVersion);
  if (!bundle) return;
  const nowMs = Date.now();
  lastPushedAtMs.set(host.id, nowMs);
  logger.info(
    'agent',
    `Auto-update push → ${host.id} (label=${host.label}, ${host.agent_version} → ${hubVersion}, ${bundle.size}B)`,
  );
  safeSend(ws, {
    type: 'agent_update',
    target_version: hubVersion,
    sha256: bundle.sha256,
    size: bundle.size,
    bundle_b64: bundle.base64,
  });
  // Persist for the UI tooltip + cooldown survival across hub restarts.
  HostsRepo.update(host.id, {
    last_update_pushed_at: Math.floor(nowMs / 1000),
    last_update_pushed_version: hubVersion,
  });
}

/**
 * Returns the WSS in noServer mode. The HTTP `upgrade` event is
 * dispatched centrally in index.ts (see gpuStreamWS for the rationale).
 */
export function setupAgentIngestWS(hubVersion: string): WebSocketServer {
  // Bootstrap cooldown map BEFORE the WSS starts accepting connections.
  // Otherwise a fast-reconnecting agent could welcome+isOlder before
  // we'd loaded its last_update_pushed_at, and we'd re-push the bundle
  // for free.
  bootstrapCooldownFromDb();

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    handleConnection(ws, req, hubVersion).catch((err) => {
      logger.error('agent', 'connection handler crashed:', (err as Error).message);
      try { ws.close(1011, 'server error'); } catch { /* ignore */ }
    });
  });

  logger.success('agent', 'Agent WebSocket ready on /agent');
  return wss;
}

async function handleConnection(ws: WebSocket, req: IncomingMessage, hubVersion: string): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const token = url.searchParams.get('token') || '';
  const claimedHostId = url.searchParams.get('host_id') || '';

  const host = await authenticateAgent(token, claimedHostId);
  if (!host) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  logger.success('agent', `Agent connected: ${host.id} (label=${host.label})`);

  // Replace any previous socket for this host_id. A reconnect from the
  // same agent (e.g. after `systemctl restart`) hits this path before
  // the old socket's 'close' has fired, so eviction by id is the safe
  // ordering — last writer wins, matches what the agent expects.
  const previous = liveAgentSockets.get(host.id);
  if (previous && previous !== ws) {
    try { previous.close(1000, 'replaced by new connection'); } catch { /* ignore */ }
  }
  liveAgentSockets.set(host.id, ws);

  safeSend(ws, { type: 'welcome', hub_version: hubVersion, protocol_ver: PROTOCOL_VER, tick_ms: 1000 });

  HostsRepo.markSeen(host.id);
  metricsBus.emit('host_status', {
    host_id: host.id,
    status: 'online',
    last_seen: Math.floor(Date.now() / 1000),
  });

  let lastSeenWroteAt = Date.now();
  const messageWindow: number[] = [];
  // Throttle the rate-limit warning: a single misbehaving agent can
  // emit hundreds of frames in the same event-loop tick before the
  // close round-trips, and every one triggered a warn line. Log once,
  // close, move on.
  let rateLimitWarned = false;

  ws.on('message', (data) => {
    const now = Date.now();

    messageWindow.push(now);
    while (messageWindow.length > 0 && now - messageWindow[0] > 1000) messageWindow.shift();
    if (messageWindow.length > RATE_LIMIT_PER_SEC) {
      if (!rateLimitWarned) {
        rateLimitWarned = true;
        logger.warn('agent', `Rate limit exceeded for ${host.id} (${messageWindow.length} frames/s > ${RATE_LIMIT_PER_SEC}), closing`);
      }
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let frame: IncomingFrame;
    try {
      frame = JSON.parse(data.toString()) as IncomingFrame;
    } catch {
      logger.warn('agent', `Bad JSON from ${host.id}`);
      return;
    }

    dispatchFrame(ws, host, frame, hubVersion);

    if (now - lastSeenWroteAt > LAST_SEEN_THROTTLE_MS) {
      HostsRepo.markSeen(host.id);
      lastSeenWroteAt = now;
    }
  });

  ws.on('close', () => {
    logger.info('agent', `Agent disconnected: ${host.id} (label=${host.label})`);
    // Only un-register if WE are still the registered socket — a
    // reconnect that landed BEFORE this close fired has already
    // overwritten the slot, and clearing it here would orphan the
    // newly-connected session.
    if (liveAgentSockets.get(host.id) === ws) liveAgentSockets.delete(host.id);
    // Don't flip offline here — the watchdog handles transient drops
    // so a 200ms blip during reconnect doesn't toggle the UI dot.
  });
  ws.on('error', (err) => logger.warn('agent', `Socket error from ${host.id}:`, err.message));
}

function dispatchFrame(ws: WebSocket, host: HostRecord, frame: IncomingFrame, hubVersion: string): void {
  switch (frame.type) {
    case 'hello':
      handleHello(ws, host, frame as HelloFrame, hubVersion);
      return;
    case 'sample':
      handleSample(host, frame as SampleFrame);
      return;
    case 'ping':
      safeSend(ws, { type: 'pong', ts_epoch: Math.floor(Date.now() / 1000) });
      return;
    case 'processes':
      handleProcesses(host, frame as ProcessFrame);
      return;
    case 'system':
    case 'temps':
      // Reserved for jalon 5+. Accept as heartbeat (already drove
      // the throttled markSeen above) but don't dispatch on the bus yet.
      return;
    default:
      logger.warn('agent', `Unknown frame type from ${host.id}: ${frame.type}`);
  }
}

function handleProcesses(host: HostRecord, frame: ProcessFrame): void {
  if (!Array.isArray(frame.processes)) return;
  // Empty list is a legitimate signal ("no GPU processes right now") —
  // we keep it so a stale snapshot clears as soon as the host idles.
  agentProcessStore.set(host.id, {
    ts: frame.ts_epoch ?? Math.floor(Date.now() / 1000),
    processes: frame.processes,
  });
}

function handleHello(ws: WebSocket, host: HostRecord, frame: HelloFrame, hubVersion: string): void {
  if (frame.host_id !== host.id) {
    // Session was authenticated; the frame's host_id mismatch is
    // either a bug in the agent or an attempt to confuse the hub.
    // Log + ignore — don't tear down the session.
    logger.warn('agent', `hello: claimed ${frame.host_id} but session is ${host.id}`);
    return;
  }
  const caps = frame.capabilities ? JSON.stringify(frame.capabilities) : null;
  // install_mode: only overwrite when the agent declares it. A NULL
  // payload (pre-v0.5.3 agent) leaves the DB column alone, so we don't
  // wipe a previously-recorded mode on protocol downgrade.
  HostsRepo.update(host.id, {
    hostname: frame.hostname ?? host.hostname,
    agent_version: frame.agent_version ?? host.agent_version,
    install_mode: frame.install_mode ?? host.install_mode,
    capabilities: caps ?? host.capabilities,
    protocol_ver: frame.protocol_ver ?? host.protocol_ver,
  });
  // Re-read with the freshly-merged values: maybePushAutoUpdate gates
  // on install_mode + agent_version, both of which may have just been
  // populated by this hello (a v0.5.3+ remote that's connecting for
  // the first time after upgrade has them in `frame`, not in `host`).
  const refreshed = HostsRepo.findById(host.id);
  if (refreshed) maybePushAutoUpdate(ws, refreshed, hubVersion);
}

function handleSample(host: HostRecord, frame: SampleFrame): void {
  if (!Array.isArray(frame.samples) || frame.samples.length === 0) return;
  // The session host_id is authoritative — any host_id in the frame
  // payload is dropped on the floor. Security invariant (§3 of plan).
  metricsBus.emit('sample', { host_id: host.id, samples: frame.samples });
}
