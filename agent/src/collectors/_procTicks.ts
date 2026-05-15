// Shared /proc helpers used by both the nvidia and rocm process
// collectors. CPU sampling is stateful (delta between ticks), so the
// public surface is a factory that owns its own per-pid history map —
// each collector gets an independent instance.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Linux clock-tick rate. Could be read from sysconf(_SC_CLK_TCK) but
// it's 100 on every mainstream distro for the past two decades, and
// no portable way exists from Node without a native addon.
const CLK_TCK = 100;

export interface CpuSampler {
  /** Sample the % of a single core used by this pid since last call. */
  sample(pid: number): number | null;
  /** Drop history for pids no longer present so the map stays bounded. */
  retain(stillAlive: Set<number>): void;
}

export function createCpuSampler(hostProc: string): CpuSampler {
  const prev = new Map<number, { ticks: number; ts: number }>();
  return {
    sample(pid: number): number | null {
      const ticks = readProcTicks(pid, hostProc);
      if (ticks === null) return null;
      const now = Date.now();
      const before = prev.get(pid);
      prev.set(pid, { ticks, ts: now });
      if (!before) return null;
      const dt = (now - before.ts) / 1000;
      if (dt <= 0) return null;
      const dTicks = ticks - before.ticks;
      if (dTicks < 0) return null;
      return Math.round((dTicks / (dt * CLK_TCK)) * 100 * 10) / 10;
    },
    retain(stillAlive: Set<number>): void {
      for (const pid of prev.keys()) {
        if (!stillAlive.has(pid)) prev.delete(pid);
      }
    },
  };
}

/** Read `argv[0]` (basename) from /proc/<pid>/cmdline, falling back to comm. */
export function resolveProcessName(pid: number, hostProc: string): string | null {
  try {
    const cmdline = readFileSync(`${hostProc}/${pid}/cmdline`, 'utf8');
    const argv0 = cmdline.split('\0')[0];
    if (argv0) return basename(argv0);
  } catch { /* fall through to comm */ }
  try {
    const comm = readFileSync(`${hostProc}/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch { /* ignore */ }
  return null;
}

/** Full cmdline with NUL → space, trimmed. Null if /proc/<pid>/cmdline is unreadable. */
export function readCmdline(pid: number, hostProc: string): string | null {
  try {
    const raw = readFileSync(`${hostProc}/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    return raw.replaceAll('\0', ' ').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read cumulative utime+stime ticks from /proc/<pid>/stat.
 *
 * The comm field (#2) is wrapped in parens and may itself contain
 * spaces (think `(ldconfig real)` or weird thread names), so we slice
 * from the LAST `)` to avoid a tokenisation trap. utime/stime are
 * fields 14/15 (1-based) → indices 11/12 after the slice.
 */
export function readProcTicks(pid: number, hostProc: string): number | null {
  try {
    const stat = readFileSync(`${hostProc}/${pid}/stat`, 'utf8');
    const after = stat.lastIndexOf(')');
    if (after < 0) return null;
    const fields = stat.slice(after + 2).split(' ');
    const utime = Number.parseInt(fields[11], 10);
    const stime = Number.parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}
