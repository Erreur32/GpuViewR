// nvidia-smi collector for the agent. Mirrors the hub's gpuCollector
// in pure form: spawn, parse via parsers/nvidia, emit GpuSample[].
// No DB writes, no event emitter — the caller (transport) decides
// what to do with each tick. Shares the parser with the hub so any
// future driver-format quirk fix lands in one place.

import { spawn, spawnSync } from "node:child_process";
import {
  QUERY_FIELDS,
  num,
  numOrNull,
  nowTimestamp,
  normalizeBusId,
  parsePciThroughput,
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

export function createGpuCollector(
  opts: GpuCollectorOptions,
): GpuCollectorHandle {
  let timer: NodeJS.Timeout | null = null;
  let pcieTimer: NodeJS.Timeout | null = null;
  let nvidiaSmiAvailable: boolean | null = null;
  let lastPcieThroughput: Map<string, PcieThroughput> = new Map();
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
      const samples = parseOutput(stdout, lastPcieThroughput);
      if (samples.length > 0) opts.onSample(samples);
    });
  }

  return {
    available(): boolean {
      return checkNvidiaSmi();
    },
    start(): void {
      if (timer) return;
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
      refreshPcieThroughput();
      pcieTimer = setInterval(refreshPcieThroughput, pcieTickMs);
      tick();
      timer = setInterval(tick, opts.tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      if (pcieTimer) clearInterval(pcieTimer);
      timer = null;
      pcieTimer = null;
      // Reset the once-flag so a subsequent start() re-reports persistent
      // PCIe spawn failures (otherwise the operator sees a single warning
      // for the very first session and silence forever after a restart).
      pcieDiagLogged = false;
    },
  };
}

function parseOutput(
  out: string,
  throughputMap: Map<string, PcieThroughput>,
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
    // Explicit branching avoids the `string && get(...)` short-circuit
    // returning `""` in TS's view, which makes the union widen to
    // `"" | PcieThroughput | undefined` and breaks `.rxKbps` access.
    let throughput: PcieThroughput | undefined;
    if (busId) throughput = throughputMap.get(normalizeBusId(busId));
    if (!throughput) throughput = throughputMap.get(`idx:${gpuIdx}`);
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
      timestamp: iso,
      timestamp_epoch: epoch,
    });
  }
  return samples;
}
