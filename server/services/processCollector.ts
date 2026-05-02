import { logger } from '../utils/logger.js';
import { spawnNvidiaSmi } from '../utils/nvidiaSmi.js';

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

function parse(out: string): GpuProcess[] {
  const procs: GpuProcess[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    const used = parseInt(parts[3], 10);
    procs.push({
      pid,
      process_name: parts[1] || 'unknown',
      gpu_uuid: parts[2] || '',
      used_memory: Number.isFinite(used) ? used : 0,
    });
  }
  return procs;
}

export const processCollector = new ProcessCollector();
