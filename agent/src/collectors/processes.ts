// Per-host GPU-process collector for the agent.
//
// Mirrors the hub's server/services/processCollector.ts but stays
// self-contained — no hub imports — because the agent ships as its
// own binary and may run on a host where the hub code isn't present.
//
// Output shape matches the wire frame the hub's agentIngestWS
// dispatches on `case 'processes':`: { tsEpoch, processes[] } where
// each process carries pid, name, gpu_uuid, used_memory, plus the
// nvtop-style enrichment (type, command, cpu_pct, gpu_pct).

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../logger.js';

export type GpuProcessType = 'C' | 'G' | 'G+C' | null;

export interface AgentGpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number;        // MiB
  type: GpuProcessType;       // C = Compute, G = Graphics, G+C = both
  command: string | null;     // full /proc/<pid>/cmdline, NULs → spaces
  cpu_pct: number | null;     // % of a single core, sampled between ticks
  gpu_pct: number | null;     // GPU SM utilization for this pid (from pmon)
}

export interface ProcessSnapshot {
  tsEpoch: number;
  processes: AgentGpuProcess[];
}

export type ProcessCollectorOptions = Readonly<{
  nvidiaSmiPath: string;
  tickMs: number;
  hostProc: string;
  onSnapshot: (snap: ProcessSnapshot) => void;
}>;

export interface ProcessCollectorHandle {
  start(): void;
  stop(): void;
  available(): boolean;
}

// Cap how often we spawn nvidia-smi — process churn rarely exceeds
// once a second and clients see updates throttled by REFRESH_MS in
// the table anyway.
const MIN_TICK_MS = 1_000;

// Linux jiffies/sec, see hub processCollector for rationale.
const CLK_TCK = 100;

const QUERY = ['pid', 'process_name', 'gpu_uuid', 'used_memory'].join(',');

export function createProcessCollector(opts: ProcessCollectorOptions): ProcessCollectorHandle {
  const tickMs = Math.max(opts.tickMs, MIN_TICK_MS);
  let timer: NodeJS.Timeout | null = null;
  let nvidiaSmiAvailable: boolean | null = null;
  let inflight = false;
  const cpuPrev = new Map<number, { ticks: number; ts: number }>();

  function checkNvidiaSmi(): boolean {
    if (nvidiaSmiAvailable !== null) return nvidiaSmiAvailable;
    try {
      const r = spawnSync(opts.nvidiaSmiPath, ['--version'], { timeout: 3_000 });
      nvidiaSmiAvailable = r.status === 0;
    } catch {
      nvidiaSmiAvailable = false;
    }
    return nvidiaSmiAvailable;
  }

  function spawnComputeApps(): Promise<AgentGpuProcess[]> {
    return new Promise((resolve) => {
      const child = spawn(opts.nvidiaSmiPath, [
        `--query-compute-apps=${QUERY}`,
        '--format=csv,noheader,nounits',
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', () => resolve([]));
      child.on('close', (code) => {
        if (code !== 0) {
          if (stderr.trim()) logger.debug('proc', `nvidia-smi compute-apps exited ${code}: ${stderr.trim()}`);
          resolve([]);
          return;
        }
        resolve(parseComputeApps(stdout, opts.hostProc));
      });
    });
  }

  function spawnPmon(): Promise<Map<number, { type: GpuProcessType; gpuPct: number | null }>> {
    return new Promise((resolve) => {
      const child = spawn(opts.nvidiaSmiPath, ['pmon', '-c', '1', '-s', 'u']);
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.on('error', () => resolve(new Map()));
      child.on('close', (code) => {
        if (code !== 0) { resolve(new Map()); return; }
        resolve(parsePmon(stdout));
      });
    });
  }

  function sampleCpu(pid: number): number | null {
    const ticks = readProcTicks(pid, opts.hostProc);
    if (ticks === null) return null;
    const now = Date.now();
    const prev = cpuPrev.get(pid);
    cpuPrev.set(pid, { ticks, ts: now });
    if (!prev) return null;
    const dt = (now - prev.ts) / 1000;
    if (dt <= 0) return null;
    const dTicks = ticks - prev.ticks;
    if (dTicks < 0) return null;
    return Math.round((dTicks / (dt * CLK_TCK)) * 100 * 10) / 10;
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const [procs, pmonByPid] = await Promise.all([spawnComputeApps(), spawnPmon()]);
      const enriched: AgentGpuProcess[] = procs.map((p) => {
        const pmon = pmonByPid.get(p.pid);
        const command = readCmdline(p.pid, opts.hostProc);
        return {
          ...p,
          type: pmon?.type ?? (command ? 'C' : null),
          command,
          cpu_pct: sampleCpu(p.pid),
          gpu_pct: pmon?.gpuPct ?? null,
        };
      });
      // Forget pids we no longer see so cpuPrev doesn't grow unbounded.
      const seen = new Set(procs.map((p) => p.pid));
      for (const pid of cpuPrev.keys()) {
        if (!seen.has(pid)) cpuPrev.delete(pid);
      }
      opts.onSnapshot({ tsEpoch: Math.floor(Date.now() / 1000), processes: enriched });
    } finally {
      inflight = false;
    }
  }

  return {
    available(): boolean {
      return checkNvidiaSmi();
    },
    start(): void {
      if (timer) return;
      if (!checkNvidiaSmi()) {
        logger.warn('proc', `nvidia-smi not available at ${opts.nvidiaSmiPath} — process collector disabled`);
        return;
      }
      logger.success('proc', `Process collector started (tick=${tickMs}ms, hostProc=${opts.hostProc})`);
      void tick();
      timer = setInterval(() => { void tick(); }, tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function resolveName(pid: number, procRoot: string): string | null {
  try {
    const cmdline = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
    const argv0 = cmdline.split('\0')[0];
    if (argv0) return basename(argv0);
  } catch { /* fall through */ }
  try {
    const comm = readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch { /* ignore */ }
  return null;
}

function readCmdline(pid: number, procRoot: string): string | null {
  try {
    const raw = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    return raw.replaceAll('\0', ' ').trim() || null;
  } catch {
    return null;
  }
}

// /proc/<pid>/stat: comm (field 2) is wrapped in parens and may itself
// contain spaces, so slice from the last `)` to avoid a tokenisation
// trap. utime + stime are fields 14/15 (1-based) → indices 11/12 after
// the slice.
function readProcTicks(pid: number, procRoot: string): number | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
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

function parseComputeApps(out: string, procRoot: string): AgentGpuProcess[] {
  const procs: AgentGpuProcess[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    const used = Number.parseInt(parts[3], 10);
    let name = parts[1] || '';
    if (!name || name === '[Not Found]' || name === '-' || name.toLowerCase() === 'n/a') {
      name = resolveName(pid, procRoot) || 'unknown';
    }
    procs.push({
      pid,
      process_name: name,
      gpu_uuid: parts[2] || '',
      used_memory: Number.isFinite(used) ? used : 0,
      type: null,
      command: null,
      cpu_pct: null,
      gpu_pct: null,
    });
  }
  return procs;
}

function parsePmon(out: string): Map<number, { type: GpuProcessType; gpuPct: number | null }> {
  const result = new Map<number, { type: GpuProcessType; gpuPct: number | null }>();
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid)) continue;
    const typeRaw = parts[2];
    let type: GpuProcessType = null;
    if (typeRaw === 'C' || typeRaw === 'G' || typeRaw === 'G+C') type = typeRaw;
    const sm = Number.parseInt(parts[3], 10);
    result.set(pid, { type, gpuPct: Number.isFinite(sm) ? sm : null });
  }
  return result;
}
