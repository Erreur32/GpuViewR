// Vendor selection lives here, not in index.ts, so the (handful of)
// downstream consumers — gpuStreamWS, /api/gpu, /api/health,
// processCollector, /api/processes — don't have to know which vendor
// is wired. They call getActiveCollector().getLatest() and forget.
//
// Both collectors expose the same minimal surface (start / stop /
// getLatest / EventEmitter). The structural type below is enough to
// keep TS happy without a full base class refactor; both singletons
// already satisfy it by construction.

import { spawnSyncNvidiaSmi } from '../utils/nvidiaSmi.js';
import { spawnSyncRocmSmi } from '../utils/rocmSmi.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { gpuCollector } from './gpuCollector.js';
import { rocmGpuCollector } from './rocmGpuCollector.js';
import { processCollector } from './processCollector.js';
import { rocmProcessCollector } from './rocmProcessCollector.js';
import type { GpuSample } from './parsers/nvidia.js';
import type { GpuProcess } from './processCollector.js';

export interface ActiveGpuCollector {
  start(): void;
  stop(): void;
  getLatest(): GpuSample[];
  on(event: 'sample', listener: (samples: GpuSample[]) => void): this;
}

export interface ActiveProcessCollector {
  getSnapshot(): Promise<{ ts: number; processes: GpuProcess[] }>;
}

export type ResolvedVendor = 'nvidia' | 'amd';

let active: ActiveGpuCollector = gpuCollector;
let activeProcess: ActiveProcessCollector = processCollector;
let resolvedVendor: ResolvedVendor = 'nvidia';

function probesNvidia(): boolean {
  try {
    return spawnSyncNvidiaSmi(['--version'], 3_000).status === 0;
  } catch {
    return false;
  }
}

function probesRocm(): boolean {
  try {
    return spawnSyncRocmSmi(config.rocmSmiPath, ['--version'], 3_000).status === 0;
  } catch {
    return false;
  }
}

/** Pick a collector based on GPU_VENDOR + binary probes. Called once
 *  from index.ts at boot. Subsequent imports of getActiveCollector()
 *  resolve to the chosen instance. */
export function resolveActiveCollector(): { collector: ActiveGpuCollector; vendor: ResolvedVendor } {
  // Mock mode is vendor-neutral by construction (buildFakeSamples
  // returns NVIDIA-shaped names but the wire shape is identical), so
  // we keep the nvidia singleton — it owns the mockTick code path.
  if (config.mockGpu) {
    setNvidia('mock mode');
    return { collector: active, vendor: resolvedVendor };
  }
  if (config.gpuVendor === 'nvidia') {
    setNvidia('forced by GPU_VENDOR');
    return { collector: active, vendor: resolvedVendor };
  }
  if (config.gpuVendor === 'amd') {
    setAmd('forced by GPU_VENDOR');
    return { collector: active, vendor: resolvedVendor };
  }
  // auto — probe nvidia-smi first (historical default, exposes strictly
  // more telemetry than rocm-smi), fall back to rocm-smi. Empty install
  // sticks with nvidia so the existing "nvidia-smi not available" warn
  // path fires as users expect.
  if (probesNvidia()) {
    setNvidia('auto-detected');
    return { collector: active, vendor: resolvedVendor };
  }
  if (probesRocm()) {
    setAmd('auto-detected');
    return { collector: active, vendor: resolvedVendor };
  }
  setNvidia('no GPU binary detected — falling back', true);
  return { collector: active, vendor: resolvedVendor };
}

function setNvidia(reason: string, warn = false): void {
  active = gpuCollector;
  activeProcess = processCollector;
  resolvedVendor = 'nvidia';
  const msg = `Vendor: nvidia (${reason})`;
  if (warn) logger.warn('gpu', msg);
  else logger.info('gpu', msg);
}

function setAmd(reason: string): void {
  active = rocmGpuCollector;
  activeProcess = rocmProcessCollector;
  resolvedVendor = 'amd';
  logger.info('gpu', `Vendor: amd (${reason}, bin=${config.rocmSmiPath})`);
}

export function getActiveCollector(): ActiveGpuCollector {
  return active;
}

export function getActiveProcessCollector(): ActiveProcessCollector {
  return activeProcess;
}

export function getResolvedVendor(): ResolvedVendor {
  return resolvedVendor;
}
