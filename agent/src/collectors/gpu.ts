// nvidia-smi collector for the agent. Mirrors the hub's gpuCollector
// in pure form: spawn, parse via parsers/nvidia, emit GpuSample[].
// No DB writes, no event emitter — the caller (transport) decides
// what to do with each tick. Shares the parser with the hub so any
// future driver-format quirk fix lands in one place.

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  QUERY_FIELDS,
  num,
  numOrNull,
  nowTimestamp,
  normalizeBusId,
  parsePciThroughput,
  parseSlowdownTemps,
  type GpuSample,
  type PcieThroughput,
} from "../../../server/services/parsers/nvidia.js";
import { logger } from "../logger.js";

export type GpuCollectorOptions = Readonly<{
  nvidiaSmiPath: string;
  tickMs: number;
  /** Refresh cadence for `nvidia-smi -q` (PCIe RX/TX). The full-driver
   *  query is ~5x more expensive than the main `--query-gpu` call, and
   *  PCIe throughput moves slowly enough that 5 s is plenty. Optional
   *  for back-compat; defaults to 5000 ms when omitted. */
  pcieTickMs?: number;
  onSample: (samples: GpuSample[]) => void;
}>;

export interface GpuCollectorHandle {
  start(): void;
  stop(): void;
  available(): boolean;
}

/** Delay before respawning an exited stream. */
const RESPAWN_DELAY_MS = 3_000;
/** Exits without a single line before giving up on streaming. */
const MAX_COLD_FAILURES = 3;
/** Lines of one interval arrive in a burst; flush this long after the last. */
const BATCH_FLUSH_MS = 50;

/** Groups the `--query-gpu ... -lms` output into one batch per interval.
 *  A GPU index seen twice means the next interval has started. The caller
 *  also flushes on a short timer so the last interval doesn't wait for
 *  the next one. */
export function createQueryBatcher(onBatch: (lines: string[]) => void) {
  let lines: string[] = [];
  const seen = new Set<string>();
  function flush(): void {
    if (lines.length === 0) return;
    const out = lines;
    lines = [];
    seen.clear();
    onBatch(out);
  }
  return {
    push(line: string): void {
      const row = line.trim();
      if (!row) return;
      const idx = row.split(",", 1)[0].trim();
      if (seen.has(idx)) flush();
      seen.add(idx);
      lines.push(row);
    },
    flush,
  };
}

export function createGpuCollector(
  opts: GpuCollectorOptions,
): GpuCollectorHandle {
  let timer: NodeJS.Timeout | null = null;
  let pcieTimer: NodeJS.Timeout | null = null;
  let running = false;
  // Main samples come from ONE long-lived `nvidia-smi --query-gpu ... -lms
  // <tickMs>` instead of a fork per tick: 234 ms vs 744 ms CPU per minute
  // on a 3060 Ti. Falls back to the per-tick fork (tick() below) when the
  // loop mode never produces a line on this host.
  let stream: ChildProcessWithoutNullStreams | null = null;
  let streamProduced = false;
  let coldFailures = 0;
  let lastLineAt = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  const batcher = createQueryBatcher((lines) => {
    const samples = parseOutput(lines.join("\n"), lastPcieThroughput, lastSlowdownTemps);
    if (samples.length > 0) opts.onSample(samples);
  });
  let nvidiaSmiAvailable: boolean | null = null;
  let lastPcieThroughput: Map<string, PcieThroughput> = new Map();
  // Slowdown temperature comes from the same `-q` call, so it's free.
  let lastSlowdownTemps: Map<string, number | null> = new Map();
  let pcieDiagLogged = false;
  // `||` (not `??`) on purpose: pcieTickMs must be > 0 to be valid; an
  // explicit 0 would yield a zero-delay interval that pegs the event loop.
  // `parseInt10` already rejects 0/negative env values, but the collector
  // API is exported so direct callers can't accidentally pass 0 either.
  const pcieTickMs =
    opts.pcieTickMs && opts.pcieTickMs > 0 ? opts.pcieTickMs : 5_000;

  function checkNvidiaSmi(): boolean {
    if (nvidiaSmiAvailable !== null) return nvidiaSmiAvailable;
    try {
      const r = spawnSync(opts.nvidiaSmiPath, ["--version"], {
        timeout: 3_000,
      });
      nvidiaSmiAvailable = r.status === 0;
    } catch {
      nvidiaSmiAvailable = false;
    }
    return nvidiaSmiAvailable;
  }

  function refreshPcieThroughput(): void {
    const child = spawn(opts.nvidiaSmiPath, ["-q"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (!pcieDiagLogged) {
        pcieDiagLogged = true;
        logger.warn(
          "gpu",
          `nvidia-smi -q spawn failed (PCIe RX/TX disabled): ${err.message}`,
        );
      }
    });
    child.on("close", (code) => {
      if (code !== 0) {
        if (!pcieDiagLogged) {
          pcieDiagLogged = true;
          logger.warn(
            "gpu",
            `nvidia-smi -q exited ${code} (PCIe RX/TX disabled): ${stderr.trim() || "(no stderr)"}`,
          );
        }
        return;
      }
      lastPcieThroughput = parsePciThroughput(stdout);
      lastSlowdownTemps = parseSlowdownTemps(stdout);
    });
  }

  function tick(): void {
    // PCIe throughput refresh runs on its own slower interval (see start()).
    // Each tick re-uses the most recent lastPcieThroughput snapshot so we
    // don't fork the expensive `nvidia-smi -q` at the main GPU cadence.
    const child = spawn(opts.nvidiaSmiPath, [
      `--query-gpu=${QUERY_FIELDS.join(",")}`,
      "--format=csv,noheader,nounits",
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      logger.error("gpu", "nvidia-smi spawn failed:", err.message),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        logger.warn("gpu", `nvidia-smi exited ${code}: ${stderr.trim()}`);
        return;
      }
      const samples = parseOutput(stdout, lastPcieThroughput, lastSlowdownTemps);
      if (samples.length > 0) opts.onSample(samples);
    });
  }

  function startForking(): void {
    tick();
    timer = setInterval(tick, opts.tickMs);
  }

  function startStream(): void {
    let stderr = "";
    let buf = "";
    lastLineAt = Date.now();
    const child = spawn(opts.nvidiaSmiPath, [
      `--query-gpu=${QUERY_FIELDS.join(",")}`,
      "--format=csv,noheader,nounits",
      "-lms",
      String(opts.tickMs),
    ]);
    stream = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stream !== child) return; // abandoned by the watchdog
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        batcher.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        streamProduced = true;
        lastLineAt = Date.now();
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(batcher.flush, BATCH_FLUSH_MS);
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      logger.error("gpu", "nvidia-smi spawn failed:", err.message),
    );
    child.on("close", (code) => {
      // A child the watchdog already replaced must not respawn a second one.
      if (stream !== child) return;
      stream = null;
      batcher.flush();
      if (!running) return;
      if (!streamProduced && ++coldFailures >= MAX_COLD_FAILURES) {
        logger.warn(
          "gpu",
          `nvidia-smi loop mode unusable (exit ${code}: ${stderr.trim() || "no output"}), forking per tick`,
        );
        startForking();
        return;
      }
      logger.warn(
        "gpu",
        `nvidia-smi stream exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}, respawning in 3 s`,
      );
      setTimeout(() => {
        if (running && !timer) startStream();
      }, RESPAWN_DELAY_MS).unref();
    });
  }

  /** A stream that stays silent (driver hang, GPU fell off the bus) is
   *  abandoned and replaced at once. SIGKILL because a stopped or hung
   *  process never acts on SIGTERM, so waiting for its close event could
   *  leave the host without samples for good. */
  function checkStream(): void {
    const silentFor = Date.now() - lastLineAt;
    if (!stream || silentFor <= Math.max(5 * opts.tickMs, 10_000)) return;
    logger.warn("gpu", `nvidia-smi stream silent for ${Math.round(silentFor / 1000)} s, replacing it`);
    const stale = stream;
    stream = null;
    stale.kill("SIGKILL");
    startStream();
  }

  return {
    available(): boolean {
      return checkNvidiaSmi();
    },
    start(): void {
      if (running) return;
      if (!checkNvidiaSmi()) {
        logger.error(
          "gpu",
          `nvidia-smi not available at ${opts.nvidiaSmiPath} — collector disabled`,
        );
        return;
      }
      logger.success(
        "gpu",
        `Collector started (tick=${opts.tickMs}ms, pcie=${pcieTickMs}ms, bin=${opts.nvidiaSmiPath})`,
      );
      // Prime the PCIe map once so the first tick already has data, then
      // refresh on its own slower cadence.
      running = true;
      refreshPcieThroughput();
      pcieTimer = setInterval(refreshPcieThroughput, pcieTickMs);
      // If the agent dies hard, the orphaned nvidia-smi exits on its own once
      // its stdout pipe breaks: checked on Linux (SIGPIPE) and on Windows
      // 11 with driver tools (gone within 6 s after Stop-Process -Force).
      startStream();
      watchdog = setInterval(checkStream, opts.tickMs);
    },
    stop(): void {
      running = false;
      if (timer) clearInterval(timer);
      if (pcieTimer) clearInterval(pcieTimer);
      if (watchdog) clearInterval(watchdog);
      if (flushTimer) clearTimeout(flushTimer);
      stream?.kill();
      stream = null;
      timer = null;
      pcieTimer = null;
      watchdog = null;
      // Reset the once-flag so a subsequent start() re-reports persistent
      // PCIe spawn failures (otherwise the operator sees a single warning
      // for the very first session and silence forever after a restart).
      pcieDiagLogged = false;
    },
  };
}

/** `-q` data for one GPU: by bus id, else by block order (see parseQueryBlocks). */
function byGpu<T>(map: Map<string, T>, busId: string | null, gpuIdx: number): T | undefined {
  const hit = busId ? map.get(normalizeBusId(busId)) : undefined;
  return hit ?? map.get(`idx:${gpuIdx}`);
}

export function parseOutput(
  out: string,
  throughputMap: Map<string, PcieThroughput>,
  slowdownTemps: Map<string, number | null> = new Map(),
): GpuSample[] {
  const { iso, epoch } = nowTimestamp();
  const samples: GpuSample[] = [];
  for (const line of out.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const parts = row.split(",").map((p) => p.trim());
    if (parts.length < QUERY_FIELDS.length) continue;
    const busId = parts[12] || null;
    const gpuIdx = num(parts[0]);
    const throughput = byGpu(throughputMap, busId, gpuIdx);
    const tempLimit = byGpu(slowdownTemps, busId, gpuIdx);
    samples.push({
      gpu_index: gpuIdx,
      name: parts[1] || "GPU",
      uuid: parts[2] || null,
      driver_version: parts[3] || null,
      temperature: num(parts[4]),
      utilization: numOrNull(parts[5]),
      memory_used: num(parts[6]),
      memory_total: numOrNull(parts[7]),
      power: numOrNull(parts[8]) ?? 0,
      fan_speed: numOrNull(parts[9]),
      clock_graphics: numOrNull(parts[10]),
      clock_memory: numOrNull(parts[11]),
      pci_bus_id: busId,
      pcie_gen_current: numOrNull(parts[13]),
      pcie_gen_max: numOrNull(parts[14]),
      pcie_width_current: numOrNull(parts[15]),
      pcie_width_max: numOrNull(parts[16]),
      pcie_rx_kbps: throughput?.rxKbps ?? null,
      pcie_tx_kbps: throughput?.txKbps ?? null,
      power_limit: numOrNull(parts[17]),
      temp_limit: tempLimit ?? null,
      timestamp: iso,
      timestamp_epoch: epoch,
    });
  }
  return samples;
}
