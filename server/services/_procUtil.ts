// Shared /proc helpers for the nvidia and rocm process collectors.
// Identical in spirit to agent/src/collectors/_procTicks.ts on the
// agent side — kept separate because the hub reads HOST_PROC at
// module load time (one process, one mount point) while the agent
// threads it through per-collector options. CpuSampler is stateful
// (delta between ticks), so the public surface is a factory each
// collector instantiates independently.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const CLK_TCK = 100;
const PROC_ROOT = process.env.HOST_PROC ?? '/proc';

export interface CpuSampler {
  /** Sample the % of a single core used by `pid` since the last call.
   *  Returns null on the first call (need two samples to derive a rate)
   *  or when /proc/<pid>/stat is unreadable. */
  sample(pid: number): number | null;
  /** Drop history for pids no longer present so the map stays bounded
   *  across long-running daemons. */
  retain(stillAlive: Set<number>): void;
}

export function createCpuSampler(): CpuSampler {
  const prev = new Map<number, { ticks: number; ts: number }>();
  return {
    sample(pid: number): number | null {
      const ticks = readProcTicks(pid);
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

/** Read argv[0] (basename) from /proc/<pid>/cmdline, falling back to
 *  /proc/<pid>/comm. Null when both are unreadable (kernel thread,
 *  PID race, namespace gap). */
export function resolveProcessName(pid: number): string | null {
  try {
    const cmdline = readFileSync(`${PROC_ROOT}/${pid}/cmdline`, 'utf8');
    const argv0 = cmdline.split('\0')[0];
    if (argv0) return basename(argv0);
  } catch { /* fall through to comm */ }
  try {
    const comm = readFileSync(`${PROC_ROOT}/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch { /* ignore */ }
  return null;
}

/** Full /proc/<pid>/cmdline with NUL separators replaced by spaces,
 *  trimmed of the trailing NUL the kernel always emits. Null when the
 *  process is gone or the file is unreadable. */
export function readCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`${PROC_ROOT}/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    return raw.replaceAll('\0', ' ').trim() || null;
  } catch {
    return null;
  }
}

/** Cumulative utime+stime ticks from /proc/<pid>/stat. comm (field 2)
 *  is wrapped in parens and may itself contain spaces, so we slice
 *  from the LAST `)` to avoid a tokenisation trap. utime/stime are
 *  fields 14/15 (1-based) → indices 11/12 after the slice. */
export function readProcTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`${PROC_ROOT}/${pid}/stat`, 'utf8');
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
