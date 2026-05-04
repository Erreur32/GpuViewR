import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnNvidiaSmi } from '../utils/nvidiaSmi.js';
import { gpuCollector } from './gpuCollector.js';
import { buildFakeProcesses } from './mockGpu.js';

export type GpuProcessType = 'C' | 'G' | 'G+C' | null;

export interface GpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number; // MiB
  // nvtop-style enrichment.
  type: GpuProcessType;          // C = Compute, G = Graphics, G+C = both
  command: string | null;        // full /proc/<pid>/cmdline, '\0' → ' '
  cpu_pct: number | null;        // % of a single core, sampled between refreshes
  gpu_pct: number | null;        // GPU SM utilization for this pid (from `pmon`)
}

interface Snapshot {
  ts: number;
  processes: GpuProcess[];
}

const QUERY = ['pid', 'process_name', 'gpu_uuid', 'used_memory'].join(',');
// Cap how often we hit nvidia-smi even when many clients ask at once.
const CACHE_MS = 1500;
// Linux clock-tick rate (jiffies/sec). 100 is the default since 2.6 and
// matches every distro we ship to; reading it from sysconf would need a
// native binding for ~zero gain.
const CLK_TCK = 100;

class ProcessCollector {
  private last: Snapshot = { ts: 0, processes: [] };
  private inflight: Promise<Snapshot> | null = null;
  // Per-pid CPU-time bookkeeping for delta-based CPU% calculation.
  // Keyed by pid; value is (utime+stime) in jiffies and the wall-clock
  // ts we sampled it at. Cleaned of stale pids on each refresh.
  private readonly cpuPrev: Map<number, { ticks: number; ts: number }> = new Map();

  // Returns a recent snapshot, refreshing if older than CACHE_MS. Errors
  // resolve to an empty snapshot rather than rejecting so the caller can
  // always render a stable table (e.g. nvidia-smi missing on dev hosts).
  async getSnapshot(): Promise<Snapshot> {
    if (Date.now() - this.last.ts < CACHE_MS) return this.last;
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private refresh(): Promise<Snapshot> {
    if (config.mockGpu) {
      const samples = gpuCollector.getLatest();
      this.last = { ts: Date.now(), processes: buildFakeProcesses(samples) };
      return Promise.resolve(this.last);
    }
    return new Promise((resolve) => {
      // Issue the compute-apps and pmon spawns in parallel — they each
      // take ~50 ms and pmon gives us the type + per-pid GPU% that the
      // CSV query doesn't expose.
      const compute = this.spawnComputeApps();
      const pmon = this.spawnPmon();
      Promise.all([compute, pmon]).then(([procs, pmonByPid]) => {
        const enriched = procs.map((p) => this.enrichFromProc(p, pmonByPid.get(p.pid)));
        // Drop CPU bookkeeping for pids we no longer see so the map
        // doesn't grow unbounded across long-running daemons.
        const seen = new Set(procs.map((p) => p.pid));
        for (const pid of this.cpuPrev.keys()) {
          if (!seen.has(pid)) this.cpuPrev.delete(pid);
        }
        this.last = { ts: Date.now(), processes: enriched };
        resolve(this.last);
      });
    });
  }

  private spawnComputeApps(): Promise<GpuProcess[]> {
    return new Promise((resolve) => {
      const child = spawnNvidiaSmi([
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
          if (stderr.trim()) logger.debug('gpu', `nvidia-smi compute-apps exited ${code}: ${stderr.trim()}`);
          resolve([]);
          return;
        }
        resolve(parseComputeApps(stdout));
      });
    });
  }

  /**
   * `nvidia-smi pmon -c 1 -s u` gives us the per-pid type (C/G/G+C) and
   * GPU SM utilization that the CSV --query-compute-apps doesn't carry.
   * Output looks like:
   *
   *   # gpu        pid  type    sm   mem   enc   dec   command
   *   #  Idx        #   C/G     %     %     %     %   name
   *       0     1234   C       50    20     0     0   python3
   *
   * Returns a map keyed by pid so we can cheaply join into the
   * compute-apps list.
   */
  private spawnPmon(): Promise<Map<number, { type: GpuProcessType; gpuPct: number | null }>> {
    return new Promise((resolve) => {
      const child = spawnNvidiaSmi(['pmon', '-c', '1', '-s', 'u']);
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.on('error', () => resolve(new Map()));
      child.on('close', (code) => {
        if (code !== 0) { resolve(new Map()); return; }
        resolve(parsePmon(stdout));
      });
    });
  }

  private enrichFromProc(
    p: GpuProcess,
    pmon: { type: GpuProcessType; gpuPct: number | null } | undefined,
  ): GpuProcess {
    const command = readCmdline(p.pid);
    const cpuPct = this.sampleCpu(p.pid);
    return {
      ...p,
      type: pmon?.type ?? (command ? 'C' : null),
      command,
      cpu_pct: cpuPct,
      gpu_pct: pmon?.gpuPct ?? null,
    };
  }

  private sampleCpu(pid: number): number | null {
    const ticks = readProcTicks(pid);
    if (ticks === null) return null;
    const now = Date.now();
    const prev = this.cpuPrev.get(pid);
    this.cpuPrev.set(pid, { ticks, ts: now });
    if (!prev) return null; // need two samples to compute a rate
    const dt = (now - prev.ts) / 1000;
    if (dt <= 0) return null;
    const dTicks = ticks - prev.ticks;
    if (dTicks < 0) return null; // pid was reused; treat as unknown
    // Single-core relative %: 100 ticks/s/core is one core fully busy.
    return Math.round((dTicks / (dt * CLK_TCK)) * 100 * 10) / 10;
  }
}

const PROC_ROOT = process.env.HOST_PROC ?? '/proc';

function resolveName(pid: number): string | null {
  try {
    const cmdline = readFileSync(`${PROC_ROOT}/${pid}/cmdline`, 'utf8');
    const argv0 = cmdline.split('\0')[0];
    if (argv0) return basename(argv0);
  } catch { /* fall through */ }
  try {
    const comm = readFileSync(`${PROC_ROOT}/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch { /* ignore */ }
  return null;
}

// Full cmdline with NUL separators replaced by spaces, trimmed of the
// trailing NUL the kernel always emits. Returns null when the process
// is gone or the file is unreadable (kernel threads, namespace gaps).
function readCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`${PROC_ROOT}/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    return raw.replaceAll('\0', ' ').trim() || null;
  } catch {
    return null;
  }
}

// /proc/<pid>/stat field 14 (utime) + field 15 (stime), each in clock
// ticks. comm (field 2) is wrapped in parentheses and may itself
// contain spaces, so we slice from the *last* `)` to dodge the issue.
function readProcTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`${PROC_ROOT}/${pid}/stat`, 'utf8');
    const after = stat.lastIndexOf(')');
    if (after < 0) return null;
    const fields = stat.slice(after + 2).split(' ');
    // After stripping "<pid> (<comm>) ", field 0 is `state`, field 11
    // is utime and field 12 is stime — i.e. original 14/15 minus the
    // 2 already-consumed fields and the 1-based → 0-based shift.
    const utime = Number.parseInt(fields[11], 10);
    const stime = Number.parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}

function parseComputeApps(out: string): GpuProcess[] {
  const procs: GpuProcess[] = [];
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
      name = resolveName(pid) || 'unknown';
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
    // Whitespace-separated columns: gpu pid type sm mem enc dec command
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

export const processCollector = new ProcessCollector();
