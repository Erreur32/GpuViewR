// AMD per-process GPU accounting via the kernel's vendor-neutral DRM
// fdinfo interface (/proc/<pid>/fdinfo/<fd>, documented in
// Documentation/gpu/drm-usage-stats.rst, standardized since Linux 5.19).
//
// Why this exists alongside processesRocm.ts: rocm-smi --showpids only
// sees processes that opened /dev/kfd (ROCm/HIP compute contexts). A
// Vulkan or OpenGL workload (e.g. llama.cpp built against the Vulkan
// backend) talks to the GPU through /dev/dri instead and never touches
// KFD — it's structurally invisible to rocm-smi regardless of
// permissions or container setup. fdinfo is populated by the amdgpu
// DRM driver for *any* client holding an open fd on the device, so it
// catches what rocm-smi misses. This module is purely additive: the
// rocm-smi collector still wins for pids it already reports (keeps
// cu_occupancy), this only fills in the gap.
//
// Same reasoning as gpuAmdgpuSysfs.ts for going straight to the kernel
// interface instead of shelling out: this runs once per tick across
// every pid on the box, so it needs to be cheap.

import { readdirSync, readFileSync } from "node:fs";
import type { GpuProcessType } from "./processes.js";

export interface FdinfoGpuUsage {
  /** drm-pdev, e.g. "0000:c5:00.0" — lowercase, as the kernel reports it. */
  pdev: string | null;
  /** Max across this pid's amdgpu fds — avoids double-counting when a
   *  process holds duplicate/inherited fds pointing at the same client. */
  vramBytes: number;
  /** Cumulative drm-engine-gfx, summed across this pid's amdgpu fds. */
  gfxNs: number;
  /** Cumulative drm-engine-compute, summed across this pid's amdgpu fds. */
  computeNs: number;
}

/** Strip a trailing unit ("123 ns", "123 KiB") and parse the leading integer. */
function parseLeadingInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseFdinfoText(text: string): {
  driver: string | null;
  pdev: string | null;
  vramBytes: number;
  gfxNs: number;
  computeNs: number;
} {
  let driver: string | null = null;
  let pdev: string | null = null;
  let vramBytes = 0;
  let gfxNs = 0;
  let computeNs = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "drm-driver") driver = value;
    else if (key === "drm-pdev") pdev = value;
    else if (key === "drm-memory-vram")
      vramBytes = parseLeadingInt(value) * 1024;
    else if (key === "drm-engine-gfx") gfxNs = parseLeadingInt(value);
    else if (key === "drm-engine-compute") computeNs = parseLeadingInt(value);
  }
  return { driver, pdev, vramBytes, gfxNs, computeNs };
}

/**
 * Scan hostProc/<pid>/fdinfo/<fd> for every pid on the box, keeping
 * only fds whose drm-driver is "amdgpu". Fully defensive: a pid we
 * can't read (not ours, no CAP_SYS_PTRACE, already exited) or a
 * malformed fd file is skipped silently — most pids on a host aren't
 * GPU clients and/or aren't readable, and that's the expected case,
 * not an error worth logging on every tick.
 */
export function scanAmdgpuFdinfo(
  hostProc: string,
): Map<number, FdinfoGpuUsage> {
  const result = new Map<number, FdinfoGpuUsage>();
  let pidDirs: string[];
  try {
    pidDirs = readdirSync(hostProc);
  } catch {
    return result;
  }
  for (const entry of pidDirs) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    let fds: string[];
    try {
      fds = readdirSync(`${hostProc}/${entry}/fdinfo`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let text: string;
      try {
        text = readFileSync(`${hostProc}/${entry}/fdinfo/${fd}`, "utf8");
      } catch {
        continue;
      }
      const parsed = parseFdinfoText(text);
      if (parsed.driver !== "amdgpu") continue;
      const existing = result.get(pid);
      if (existing) {
        existing.vramBytes = Math.max(existing.vramBytes, parsed.vramBytes);
        existing.gfxNs += parsed.gfxNs;
        existing.computeNs += parsed.computeNs;
        if (!existing.pdev) existing.pdev = parsed.pdev;
      } else {
        result.set(pid, {
          pdev: parsed.pdev,
          vramBytes: parsed.vramBytes,
          gfxNs: parsed.gfxNs,
          computeNs: parsed.computeNs,
        });
      }
    }
  }
  return result;
}

export interface FdinfoGpuSampler {
  /** % of wall-clock time spent busy on gfx+compute engines since the
   *  last sample for this pid. Null on the first observation (no
   *  baseline yet) or on a non-positive elapsed/delta, same contract
   *  as createCpuSampler in _procTicks.ts. */
  sample(
    pid: number,
    usage: FdinfoGpuUsage,
  ): { gpuPct: number | null; type: GpuProcessType };
  /** Drop history for pids no longer present so the map stays bounded. */
  retain(stillAlive: Set<number>): void;
}

export function createFdinfoGpuSampler(): FdinfoGpuSampler {
  const prev = new Map<
    number,
    { gfxNs: number; computeNs: number; ts: number }
  >();
  return {
    sample(pid, usage) {
      const type: GpuProcessType =
        usage.gfxNs > 0 && usage.computeNs > 0
          ? "G+C"
          : usage.computeNs > 0
            ? "C"
            : usage.gfxNs > 0
              ? "G"
              : null;

      const now = Date.now();
      const before = prev.get(pid);
      prev.set(pid, {
        gfxNs: usage.gfxNs,
        computeNs: usage.computeNs,
        ts: now,
      });
      if (!before) return { gpuPct: null, type };

      const dt = (now - before.ts) / 1000;
      if (dt <= 0) return { gpuPct: null, type };
      const dBusyNs =
        usage.gfxNs - before.gfxNs + (usage.computeNs - before.computeNs);
      if (dBusyNs < 0) return { gpuPct: null, type };

      const pct = (dBusyNs / (dt * 1e9)) * 100;
      const gpuPct = Math.min(100, Math.round(pct * 10) / 10);
      return { gpuPct, type };
    },
    retain(stillAlive) {
      for (const pid of prev.keys()) {
        if (!stillAlive.has(pid)) prev.delete(pid);
      }
    },
  };
}
