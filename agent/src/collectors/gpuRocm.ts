// rocm-smi collector for the agent. Mirrors the nvidia gpu collector
// contract (createGpuCollector → { start, stop, available }) so the
// agent dispatcher can pick either at boot without leaking vendor
// specifics into transport.ts.
//
// One rocm-smi invocation per tick with every flag we need bundled
// together — cheaper than the 5-call combo and matches what the JSON
// shape supports (info commands aggregate cleanly into a single card0
// object).

import { spawn, spawnSync } from 'node:child_process';
import {
  mapRocmInfoToSamples,
  parseRocmInfo,
} from '../../../server/services/parsers/rocm.js';
import type { GpuSample } from '../../../server/services/parsers/nvidia.js';
import { logger } from '../logger.js';

export type GpuCollectorOptions = Readonly<{
  rocmSmiPath: string;
  tickMs: number;
  onSample: (samples: GpuSample[]) => void;
}>;

export interface GpuCollectorHandle {
  start(): void;
  stop(): void;
  available(): boolean;
}

// Aggregated info call. Order matters only in that flags surface
// disjoint sets of keys inside the same card<N> object — picking the
// minimum that hydrates our GpuSample fields.
const INFO_FLAGS = [
  '--showmeminfo', 'vram',
  '--showclocks',
  '--showtemp',
  '--showuse',
  '--showpower',
  '--showid',
  '--showbus',
  '--showdriverversion',
  '--json',
];

export function createRocmGpuCollector(opts: GpuCollectorOptions): GpuCollectorHandle {
  let timer: NodeJS.Timeout | null = null;
  let rocmSmiAvailable: boolean | null = null;
  let firstStderrLogged = false;
  let emptyOutputWarned = false;
  // Guard against pile-up: rocm-smi wall time is ~80-130 ms and the
  // default tick is 1000 ms, but a momentarily busy host (or a stuck
  // python import) can push past that. Without this, setInterval keeps
  // queueing ticks behind the slow one and we end up with N concurrent
  // rocm-smi processes. Same pattern as processesRocm.ts.
  let inflight = false;

  function checkRocmSmi(): boolean {
    if (rocmSmiAvailable !== null) return rocmSmiAvailable;
    try {
      const r = spawnSync(opts.rocmSmiPath, ['--version'], { timeout: 3_000 });
      rocmSmiAvailable = r.status === 0;
    } catch {
      rocmSmiAvailable = false;
    }
    return rocmSmiAvailable;
  }

  function tick(): void {
    if (inflight) return;
    inflight = true;
    const child = spawn(opts.rocmSmiPath, INFO_FLAGS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    // stderr typically carries the harmless `Fail to open libdrm_amdgpu.so`
    // warning when libdrm-amdgpu1 isn't installed. We only surface it once,
    // at debug level — JSON on stdout is still complete.
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      inflight = false;
      logger.error('gpu', 'rocm-smi spawn failed:', err.message);
    });
    child.on('close', (code) => {
      inflight = false;
      if (code !== 0) {
        logger.warn('gpu', `rocm-smi exited ${code}: ${stderr.trim()}`);
        return;
      }
      if (!firstStderrLogged && stderr.trim()) {
        firstStderrLogged = true;
        logger.debug('gpu', `rocm-smi stderr (ignored): ${stderr.trim().split('\n')[0]}`);
      }
      const info = parseRocmInfo(stdout);
      const samples = mapRocmInfoToSamples(info);
      if (samples.length > 0) {
        opts.onSample(samples);
        return;
      }
      // rocm-smi exits 0 even when it fails to load librocm_smi64.so —
      // the script prints "Unable to load the rocm_smi library …" on
      // stderr but the exit code stays 0 and stdout is empty. Without
      // this log line the agent appears to be healthy ("ROCm collector
      // started") while silently sending nothing to the hub. Worth one
      // warn so the user can grep their logs and fix LD_LIBRARY_PATH.
      if (!emptyOutputWarned) {
        emptyOutputWarned = true;
        const hint = stderr.trim().split('\n')[0] || '(no stderr)';
        logger.warn('gpu', `rocm-smi returned 0 cards (stdout empty); stderr: ${hint}`);
      }
    });
  }

  return {
    available(): boolean {
      return checkRocmSmi();
    },
    start(): void {
      if (timer) return;
      if (!checkRocmSmi()) {
        logger.error('gpu', `rocm-smi not available at ${opts.rocmSmiPath} — collector disabled`);
        return;
      }
      logger.success('gpu', `ROCm collector started (tick=${opts.tickMs}ms, bin=${opts.rocmSmiPath})`);
      tick();
      timer = setInterval(tick, opts.tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
