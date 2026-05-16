import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnNvidiaSmi } from '../utils/nvidiaSmi.js';
import { getActiveCollector } from './activeGpuCollector.js';
import { buildFakeProcesses } from './mockGpu.js';
import { resolveProcessName, readCmdline, createCpuSampler, type CpuSampler } from './_procUtil.js';

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

class ProcessCollector {
  private last: Snapshot = { ts: 0, processes: [] };
  private inflight: Promise<Snapshot> | null = null;
  private readonly cpuSampler: CpuSampler = createCpuSampler();

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
      const samples = getActiveCollector().getLatest();
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
        this.cpuSampler.retain(new Set(procs.map((p) => p.pid)));
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
    return {
      ...p,
      type: pmon?.type ?? (command ? 'C' : null),
      command,
      cpu_pct: this.cpuSampler.sample(p.pid),
      gpu_pct: pmon?.gpuPct ?? null,
    };
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
      name = resolveProcessName(pid) || 'unknown';
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
