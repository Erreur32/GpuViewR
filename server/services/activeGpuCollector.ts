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
import type { GpuSample } from './parsers/nvidia.js';

export interface ActiveGpuCollector {
  start(): void;
  stop(): void;
  getLatest(): GpuSample[];
  on(event: 'sample', listener: (samples: GpuSample[]) => void): this;
}

export type ResolvedVendor = 'nvidia' | 'amd';

let active: ActiveGpuCollector = gpuCollector;
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
    active = gpuCollector;
    resolvedVendor = 'nvidia';
    logger.info('gpu', 'Vendor: nvidia (mock mode)');
    return { collector: active, vendor: resolvedVendor };
  }
  if (config.gpuVendor === 'nvidia') {
    active = gpuCollector;
    resolvedVendor = 'nvidia';
    logger.info('gpu', 'Vendor: nvidia (forced by GPU_VENDOR)');
    return { collector: active, vendor: resolvedVendor };
  }
  if (config.gpuVendor === 'amd') {
    active = rocmGpuCollector;
    resolvedVendor = 'amd';
    logger.info('gpu', `Vendor: amd (forced by GPU_VENDOR, bin=${config.rocmSmiPath})`);
    return { collector: active, vendor: resolvedVendor };
  }
  // auto — probe nvidia-smi first (historical default, exposes strictly
  // more telemetry than rocm-smi), fall back to rocm-smi. Empty install
  // sticks with nvidia so the existing "nvidia-smi not available" warn
  // path fires as users expect.
  if (probesNvidia()) {
    active = gpuCollector;
    resolvedVendor = 'nvidia';
    logger.info('gpu', 'Vendor: nvidia (auto-detected)');
    return { collector: active, vendor: resolvedVendor };
  }
  if (probesRocm()) {
    active = rocmGpuCollector;
    resolvedVendor = 'amd';
    logger.info('gpu', `Vendor: amd (auto-detected, bin=${config.rocmSmiPath})`);
    return { collector: active, vendor: resolvedVendor };
  }
  active = gpuCollector;
  resolvedVendor = 'nvidia';
  logger.warn('gpu', 'Vendor: no GPU binary detected (probed nvidia-smi and rocm-smi). Falling back to nvidia collector — it will log "not available" and stay disabled.');
  return { collector: active, vendor: resolvedVendor };
}

export function getActiveCollector(): ActiveGpuCollector {
  return active;
}

export function getResolvedVendor(): ResolvedVendor {
  return resolvedVendor;
}
