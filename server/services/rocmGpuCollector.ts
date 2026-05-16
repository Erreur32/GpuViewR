// rocm-smi collector for the hub. Sibling of gpuCollector.ts (the
// nvidia-smi one); both extend GpuCollectorBase which owns the
// shared lifecycle, DB persistence and heartbeat throttling. This
// file only carries the vendor split: probe rocm-smi, spawn it once
// per tick with the right flags, parse the JSON.

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnRocmSmi, spawnSyncRocmSmi } from '../utils/rocmSmi.js';
import { mapRocmInfoToSamples, parseRocmInfo } from './parsers/rocm.js';
import { GpuCollectorBase } from './_gpuCollectorBase.js';

// Same INFO_FLAGS as the agent — keeps the JSON shape consistent so
// the parser doesn't have to branch by collector origin.
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

class RocmGpuCollector extends GpuCollectorBase {
  private rocmSmiAvailable: boolean | null = null;
  // rocm-smi often prints harmless stderr (libdrm warnings, library
  // load hints). Log the first line once so users can debug a
  // misconfigured install without flooding logs with repeated copies.
  private firstStderrLogged = false;
  private emptyOutputWarned = false;

  protected checkAvailable(): boolean {
    if (this.rocmSmiAvailable !== null) return this.rocmSmiAvailable;
    try {
      this.rocmSmiAvailable = spawnSyncRocmSmi(config.rocmSmiPath, ['--version'], 3000).status === 0;
    } catch {
      this.rocmSmiAvailable = false;
    }
    return this.rocmSmiAvailable;
  }

  protected unavailableMessage(): string {
    return `rocm-smi not available at ${config.rocmSmiPath}: collector disabled (UI will show no data)`;
  }

  protected startedMessage(): string {
    return `ROCm collector started (tick=${config.gpuTickMs}ms, bin=${config.rocmSmiPath})`;
  }

  protected tick(): void {
    const child = spawnRocmSmi(config.rocmSmiPath, INFO_FLAGS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => logger.error('gpu', 'rocm-smi spawn failed:', err.message));
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('gpu', `rocm-smi exited ${code}: ${stderr.trim()}`);
        return;
      }
      if (!this.firstStderrLogged && stderr.trim()) {
        this.firstStderrLogged = true;
        logger.debug('gpu', `rocm-smi stderr (ignored): ${stderr.trim().split('\n')[0]}`);
      }
      const info = parseRocmInfo(stdout);
      const samples = mapRocmInfoToSamples(info);
      if (samples.length === 0) {
        // Same trap as the agent: rocm-smi can exit 0 with empty
        // stdout when librocm_smi64.so fails to load (typically a
        // missing LD_LIBRARY_PATH in containerised installs). Surface
        // a single warning so this doesn't silently drop the UI to
        // "no data".
        if (!this.emptyOutputWarned) {
          this.emptyOutputWarned = true;
          const hint = stderr.trim().split('\n')[0] || '(no stderr)';
          logger.warn('gpu', `rocm-smi returned 0 cards (stdout empty); stderr: ${hint}`);
        }
        return;
      }
      this.persistSamples(samples);
    });
  }
}

export const rocmGpuCollector = new RocmGpuCollector();
