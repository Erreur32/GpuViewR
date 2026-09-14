// One-shot, boot-time (or per-tick, for memory pressure) lookups of Mac
// identity/memory fields via standard, long-stable macOS CLIs — sysctl,
// sw_vers, system_profiler, vm_stat. Kept separate from
// gpuMacosPowermetrics.ts so the text-parsing logic is unit-testable
// without spawning real binaries (cf. Docs/MACOS_AGENT.md §2.2, §2.3).

import { spawnSync } from 'node:child_process';

function runOnce(bin: string, args: string[]): string | null {
  try {
    const r = spawnSync(bin, args, { timeout: 5_000, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const out = (r.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

/** `system_profiler SPDisplaysDataType` → first "Chipset Model:" line. */
export function parseChipsetModel(raw: string): string | null {
  const m = raw.match(/Chipset Model:\s*(.+)/);
  return m ? m[1].trim() : null;
}

/** Best-effort GPU/chip name. `system_profiler` is authoritative
 *  ("Apple M2 Max") but takes ~1-2s; falls back to
 *  `sysctl machdep.cpu.brand_string`, which on Apple Silicon reports the
 *  chip name too (there's no separate x86-style CPU brand string). */
export function getMacGpuName(): string {
  const profiler = runOnce('system_profiler', ['SPDisplaysDataType']);
  const chipset = profiler ? parseChipsetModel(profiler) : null;
  if (chipset) return chipset;
  const brand = runOnce('sysctl', ['-n', 'machdep.cpu.brand_string']);
  if (brand) return brand;
  return 'Apple GPU';
}

/** `sysctl -n hw.memsize` → bytes. Pure parse, no spawn. */
export function parseMemsizeBytes(raw: string): number | null {
  const bytes = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/** Unified memory (RAM) total in MiB — doubles as `memory_total` since
 *  Apple Silicon has no dedicated VRAM (cf. Docs/MACOS_AGENT.md §2.3). */
export function getMacMemoryTotalMb(): number | null {
  const raw = runOnce('sysctl', ['-n', 'hw.memsize']);
  if (!raw) return null;
  const bytes = parseMemsizeBytes(raw);
  return bytes !== null ? Math.round(bytes / 1_048_576) : null;
}

/** macOS build version, used as a `driver_version` proxy — Apple Silicon
 *  has no discrete GPU driver, the closest analog is the OS/kernel build. */
export function getMacOsVersion(): string | null {
  return runOnce('sw_vers', ['-productVersion']);
}

/** Parses `vm_stat` output into a page-count map. Format has been stable
 *  across macOS releases: `"<Label>:  <N>."` lines plus a page-size
 *  header. Exported standalone so it's testable against captured text
 *  fixtures without spawning the real binary. */
export function parseVmStatPages(raw: string): { pageSize: number; pages: Record<string, number> } {
  const sizeMatch = raw.match(/page size of (\d+) bytes/);
  const pageSize = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : 4096;
  const pages: Record<string, number> = {};
  const lineRe = /^([A-Za-z][A-Za-z0-9 "'.-]*?):\s+(\d+)\.?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(raw))) {
    pages[m[1].trim()] = Number.parseInt(m[2], 10);
  }
  return { pageSize, pages };
}

/** Derives a "memory pressure" figure from `vm_stat` — active + wired +
 *  compressor pages, scaled to MiB and capped at `totalMb`. This is
 *  Option A from Docs/MACOS_AGENT.md §2.3: an honest proxy for "memory
 *  under pressure", not literal GPU VRAM usage (unified memory has no
 *  such concept). Pure function so it's testable without spawning
 *  `vm_stat`; see `getMacMemoryUsedMb` for the live wrapper. */
export function computeMemoryUsedMb(raw: string, totalMb: number | null): number | null {
  if (totalMb === null) return null;
  const { pageSize, pages } = parseVmStatPages(raw);
  const active = pages['Pages active'] ?? 0;
  const wired = pages['Pages wired down'] ?? 0;
  const compressed = pages['Pages occupied by compressor'] ?? 0;
  const usedBytes = (active + wired + compressed) * pageSize;
  const usedMb = Math.round(usedBytes / 1_048_576);
  return Math.min(usedMb, totalMb);
}

export function getMacMemoryUsedMb(totalMb: number | null): number | null {
  const raw = runOnce('vm_stat', []);
  if (!raw) return null;
  return computeMemoryUsedMb(raw, totalMb);
}
