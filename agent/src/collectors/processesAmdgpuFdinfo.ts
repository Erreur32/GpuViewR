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
  /** Max across this pid's fds — avoids double-counting when a process
   *  holds duplicate/inherited fds pointing at the same client. Device
   *  memory: amdgpu drm-memory-vram, i915 drm-resident-local0, xe
   *  drm-resident-vram0. */
  vramBytes: number;
  /** System memory mapped to the GPU, max across fds like vramBytes:
   *  amdgpu drm-memory-gtt, i915 drm-resident-system0, xe drm-resident-gtt. */
  gttBytes: number;
  /** Cumulative graphics engine busy time (amdgpu drm-engine-gfx, i915
   *  drm-engine-render), summed across this pid's fds. xe reports cycles,
   *  not ns, so it stays 0 there. */
  gfxNs: number;
  /** Cumulative drm-engine-compute, summed across this pid's fds. */
  computeNs: number;
}

/** Strip a trailing unit ("123 ns", "123 KiB") and parse the leading integer. */
function parseLeadingInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/** drm-usage-stats memory value: an integer with an optional KiB/MiB/GiB
 *  unit, bytes without one. */
function parseMemBytes(raw: string): number {
  const n = parseLeadingInt(raw);
  if (raw.endsWith("GiB")) return n * 1024 ** 3;
  if (raw.endsWith("MiB")) return n * 1024 ** 2;
  if (raw.endsWith("KiB")) return n * 1024;
  return n;
}

/** fdinfo key → field, per driver family. First listed key wins for
 *  memory (resident before total). */
const VRAM_KEYS = ["drm-memory-vram", "drm-resident-local0", "drm-resident-vram0", "drm-total-local0", "drm-total-vram0"];
const GTT_KEYS = ["drm-memory-gtt", "drm-resident-system0", "drm-resident-gtt", "drm-total-system0", "drm-total-gtt"];
const GFX_KEYS = new Set(["drm-engine-gfx", "drm-engine-render"]);

/** DRM drivers whose fdinfo the scan keeps. */
export const AMD_DRIVERS: ReadonlySet<string> = new Set(["amdgpu"]);
export const INTEL_DRIVERS: ReadonlySet<string> = new Set(["i915", "xe"]);

function parseFdinfoText(text: string): {
  driver: string | null;
  pdev: string | null;
  vramBytes: number;
  gttBytes: number;
  gfxNs: number;
  computeNs: number;
} {
  let driver: string | null = null;
  let pdev: string | null = null;
  const mem = new Map<string, number>();
  let gfxNs = 0;
  let computeNs = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "drm-driver") driver = value;
    else if (key === "drm-pdev") pdev = value;
    else if (GFX_KEYS.has(key)) gfxNs += parseLeadingInt(value);
    else if (key === "drm-engine-compute") computeNs = parseLeadingInt(value);
    else if (key.startsWith("drm-")) mem.set(key, parseMemBytes(value));
  }
  const first = (keys: string[]) => keys.map((k) => mem.get(k)).find((v) => v !== undefined) ?? 0;
  return { driver, pdev, vramBytes: first(VRAM_KEYS), gttBytes: first(GTT_KEYS), gfxNs, computeNs };
}

/**
 * Scan hostProc/<pid>/fdinfo/<fd> for every pid on the box, keeping
 * only fds whose drm-driver is "amdgpu". Fully defensive: a pid we
 * can't read (not ours, no CAP_SYS_PTRACE, already exited) or a
 * malformed fd file is skipped silently — most pids on a host aren't
 * GPU clients and/or aren't readable, and that's the expected case,
 * not an error worth logging on every tick.
 *
 * Returns one entry per (pid, pdev) pair, not one per pid: a process
 * with fds open on two different cards (genuine multi-GPU job) gets
 * two array entries, each carrying that card's own vram/gfx/compute
 * numbers. This is what makes multi-card AMD process attribution
 * possible without `rocm-smi --showpidgpus` — see processesRocm.ts,
 * which is the only other consumer of this per-device breakdown.
 * Multiple fds on the *same* card still merge (max vram, summed
 * gfx/compute ns), same as before this became per-device.
 *
 * `state` (optional, owned by the caller so it survives across ticks)
 * keeps the scan from tripping AppArmor over and over. Opening
 * /proc/<pid>/fdinfo is a ptrace-gated access: under Docker's
 * `docker-default` profile it's denied for every unconfined peer, i.e.
 * every process running directly on the host (other containers share
 * the docker-default label and stay readable with CAP_SYS_PTRACE), and
 * each attempt emits a kernel audit record. Two guards:
 *   - a pid refused with EACCES/EPERM lands in `deniedPids` and is
 *     never retried while it lives (v0.9.8, stopped the
 *     `audit: backlog limit exceeded` storm);
 *   - a pid is only tried once it has been seen for at least
 *     FDINFO_MIN_AGE_MS (`firstSeen`). A busy host spawns hundreds of
 *     short-lived pids per minute (cron, shells, healthchecks), each of
 *     which cost one denial before this. GPU clients are long-running,
 *     so the only cost is a Vulkan/OpenGL-only client showing up a few
 *     seconds late;
 *   - kernel threads (`kernelThreads`, `Kthread:` in /proc/<pid>/status)
 *     are never tried. The kernel keeps spawning kworkers that outlive
 *     the age gate, they never hold a DRM fd, and each one was still
 *     costing one denial in v0.9.9. The check reads `status`, not
 *     `stat`: AppArmor audits the ptrace check inside `stat` even
 *     though the read succeeds, so v0.9.10 (which used `stat`) paid
 *     one denial per new pid, short-lived ones included.
 * All are purged once the pid is gone from hostProc, so a recycled
 * pid starts over.
 */
export const FDINFO_MIN_AGE_MS = 10_000;

export interface FdinfoScanState {
  /** Pids whose fdinfo dir was refused, skipped until they exit. */
  deniedPids: Set<number>;
  /** Wall-clock ms when each pid was first seen under hostProc. */
  firstSeen: Map<number, number>;
  /** Kernel threads, detected once on first sighting, never scanned. */
  kernelThreads: Set<number>;
}

export function createFdinfoScanState(): FdinfoScanState {
  return {
    deniedPids: new Set(),
    firstSeen: new Map(),
    kernelThreads: new Set(),
  };
}

/** True if /proc/<pid>/status says `Kthread: 1`. Kernels without that
 *  line fall back to kthreadd (pid 2) and its children (`PPid: 2`). */
function isKernelThread(hostProc: string, pid: number): boolean {
  try {
    const status = readFileSync(`${hostProc}/${pid}/status`, "utf8");
    const kthread = /^Kthread:\s*(\d+)/m.exec(status);
    if (kthread) return kthread[1] === "1";
    const ppid = /^PPid:\s*(\d+)/m.exec(status);
    return pid === 2 || ppid?.[1] === "2";
  } catch {
    return false;
  }
}

const CAP_SYS_PTRACE_BIT = 19n;

/** True when this process holds CAP_SYS_PTRACE in its effective set,
 *  read from its own /proc/self/status (CapEff, hex bitmask). */
export function hasPtraceCap(statusPath = "/proc/self/status"): boolean {
  try {
    const capEff = /^CapEff:\s*([0-9a-f]+)/im.exec(readFileSync(statusPath, "utf8"));
    return capEff ? ((BigInt(`0x${capEff[1]}`) >> CAP_SYS_PTRACE_BIT) & 1n) === 1n : false;
  } catch {
    return false;
  }
}

export function scanAmdgpuFdinfo(
  hostProc: string,
  state?: FdinfoScanState,
  now: number = Date.now(),
  drivers: ReadonlySet<string> = AMD_DRIVERS,
): Map<number, FdinfoGpuUsage[]> {
  const result = new Map<number, FdinfoGpuUsage[]>();
  let pidDirs: string[];
  try {
    pidDirs = readdirSync(hostProc);
  } catch {
    return result;
  }
  const alive = new Set<number>();
  for (const entry of pidDirs) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    alive.add(pid);
    if (state) {
      if (state.deniedPids.has(pid) || state.kernelThreads.has(pid)) continue;
      let seen = state.firstSeen.get(pid);
      if (seen === undefined) {
        if (isKernelThread(hostProc, pid)) {
          state.kernelThreads.add(pid);
          continue;
        }
        seen = now;
        state.firstSeen.set(pid, now);
      }
      if (now - seen < FDINFO_MIN_AGE_MS) continue;
    }
    let fds: string[];
    try {
      fds = readdirSync(`${hostProc}/${entry}/fdinfo`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") state?.deniedPids.add(pid);
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
      if (!parsed.driver || !drivers.has(parsed.driver)) continue;
      const perPid = result.get(pid) ?? [];
      // Known limitation: fds with an unreadable/missing drm-pdev all
      // key as pdev===null, so they merge into a single entry here —
      // if the same pid genuinely spans two physical cards and BOTH
      // fail to report drm-pdev, they'd be incorrectly collapsed into
      // one row instead of two. No way to disambiguate them from this
      // interface alone; processesRocm.ts's null-pdev fallback (uses
      // defaultUuid) is the safety net for this case.
      const existing = perPid.find((u) => u.pdev === parsed.pdev);
      if (existing) {
        existing.vramBytes = Math.max(existing.vramBytes, parsed.vramBytes);
        existing.gttBytes = Math.max(existing.gttBytes, parsed.gttBytes);
        existing.gfxNs += parsed.gfxNs;
        existing.computeNs += parsed.computeNs;
      } else {
        perPid.push({
          pdev: parsed.pdev,
          vramBytes: parsed.vramBytes,
          gttBytes: parsed.gttBytes,
          gfxNs: parsed.gfxNs,
          computeNs: parsed.computeNs,
        });
        result.set(pid, perPid);
      }
    }
  }
  if (state) {
    for (const pid of state.deniedPids) {
      if (!alive.has(pid)) state.deniedPids.delete(pid);
    }
    for (const pid of state.firstSeen.keys()) {
      if (!alive.has(pid)) state.firstSeen.delete(pid);
    }
    for (const pid of state.kernelThreads) {
      if (!alive.has(pid)) state.kernelThreads.delete(pid);
    }
  }
  return result;
}

export interface FdinfoGpuSampler {
  /** % of wall-clock time spent busy on gfx+compute engines since the
   *  last sample for this (pid, device) pair. Null on the first
   *  observation (no baseline yet) or on a non-positive elapsed/delta,
   *  same contract as createCpuSampler in _procTicks.ts. Call once per
   *  device when a pid spans multiple GPUs — history is keyed by
   *  (pid, pdev), not pid alone, so per-card deltas don't bleed into
   *  each other. */
  sample(
    pid: number,
    usage: FdinfoGpuUsage,
  ): { gpuPct: number | null; type: GpuProcessType };
  /** Drop history for pids no longer present so the map stays bounded. */
  retain(stillAlive: Set<number>): void;
}

// Sample history is keyed by (pid, pdev) so two cards for the same pid
// track independent deltas, but the pid is also stored in the value
// (not just encoded in the string key) so retain() below can filter by
// pid without an implicit "pid never contains a colon" string-parsing
// convention.
function sampleKey(pid: number, pdev: string | null): string {
  return `${pid}:${pdev ?? ""}`;
}

export function createFdinfoGpuSampler(): FdinfoGpuSampler {
  const prev = new Map<
    string,
    { pid: number; gfxNs: number; computeNs: number; ts: number }
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

      const key = sampleKey(pid, usage.pdev);
      const now = Date.now();
      const before = prev.get(key);
      prev.set(key, {
        pid,
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
      for (const [key, value] of prev) {
        if (!stillAlive.has(value.pid)) prev.delete(key);
      }
    },
  };
}
