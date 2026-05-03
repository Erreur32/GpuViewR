import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnNvidiaSmi } from '../utils/nvidiaSmi.js';
import { gpuCollector } from './gpuCollector.js';
import { buildFakeProcesses } from './mockGpu.js';

export interface GpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number; // MiB
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
      const child = spawnNvidiaSmi([
        `--query-compute-apps=${QUERY}`,
        '--format=csv,noheader,nounits',
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', () => {
        // nvidia-smi missing on this host: keep the previous (likely empty)
        // snapshot but bump the timestamp so we throttle retries.
        this.last = { ts: Date.now(), processes: [] };
        resolve(this.last);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          if (stderr.trim()) logger.debug('gpu', `nvidia-smi compute-apps exited ${code}: ${stderr.trim()}`);
          this.last = { ts: Date.now(), processes: [] };
          resolve(this.last);
          return;
        }
        this.last = { ts: Date.now(), processes: parse(stdout) };
        resolve(this.last);
      });
    });
  }
}

// nvidia-smi returns "[Not Found]" when it cannot stat /proc/<pid>/exe (e.g.
// the process lives in another PID namespace, or we lack permission). Try
// reading procfs ourselves before giving up. Works in two deployment modes:
//   - pid: host             → read the container's own /proc (PIDs match host)
//   - /proc bind-mounted ro → set HOST_PROC=/host/proc to read host PIDs
//                             without sharing the PID namespace.
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

function parse(out: string): GpuProcess[] {
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
    });
  }
  return procs;
}

export const processCollector = new ProcessCollector();
