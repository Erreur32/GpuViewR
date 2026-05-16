// rocm-smi collector for the hub. Sibling of gpuCollector.ts (the
// nvidia-smi one): same lifecycle (start/stop/getLatest), same
// downstream contract (GpuMetric buffer + DB flush, metricsBus
// 'sample' broadcasts, hosts.last_seen heartbeat). The vendor split
// stops at the spawn boundary — everything past handleSamples() looks
// identical between the two collectors.
//
// One rocm-smi invocation per tick with every flag bundled in a single
// --json dump. Mirrors what the agent's createRocmGpuCollector does.

import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnRocmSmi, spawnSyncRocmSmi } from '../utils/rocmSmi.js';
import { GpuDeviceRepository, GpuMetricRepository, type GpuMetric } from '../database/models/GpuMetric.js';
import { HostsRepo, LOCAL_HOST_ID } from '../database/models/Host.js';
import { buildFakeSamples } from './mockGpu.js';
import { mapRocmInfoToSamples, parseRocmInfo } from './parsers/rocm.js';
import { type GpuSample } from './parsers/nvidia.js';
import { metricsBus } from './_metricsBus.js';

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

class RocmGpuCollector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private rocmSmiAvailable: boolean | null = null;
  private buffer: GpuMetric[] = [];
  private lastFlush = Date.now();
  private readonly flushIntervalMs = 60_000;
  private lastSamples: GpuSample[] = [];
  private lastSeenWroteAt = 0;
  private static readonly LAST_SEEN_THROTTLE_MS = 5_000;
  // rocm-smi often prints harmless stderr (libdrm warnings, library load
  // hints). Log the first line once so users can debug a misconfigured
  // install without flooding logs with repeated copies.
  private firstStderrLogged = false;
  private emptyOutputWarned = false;

  private touchLocalLastSeen(): void {
    const now = Date.now();
    if (now - this.lastSeenWroteAt < RocmGpuCollector.LAST_SEEN_THROTTLE_MS) return;
    this.lastSeenWroteAt = now;
    try {
      HostsRepo.markSeen(LOCAL_HOST_ID);
    } catch (err) {
      logger.debug('gpu', `markSeen(local) failed: ${(err as Error).message}`);
    }
  }

  start(): void {
    if (this.timer) return;
    if (config.mockGpu) {
      logger.warn('gpu', `Mock collector started (tick=${config.gpuTickMs}ms) — synthetic data, NOT REAL GPUS`);
      this.mockTick();
      this.timer = setInterval(() => this.mockTick(), config.gpuTickMs);
      return;
    }
    this.checkRocmSmi();
    if (!this.rocmSmiAvailable) {
      logger.warn('gpu', `rocm-smi not available at ${config.rocmSmiPath}: collector disabled (UI will show no data)`);
      return;
    }
    logger.success('gpu', `ROCm collector started (tick=${config.gpuTickMs}ms, bin=${config.rocmSmiPath})`);
    this.tick();
    this.timer = setInterval(() => this.tick(), config.gpuTickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.buffer.length) this.flushBuffer();
  }

  getLatest(): GpuSample[] {
    return this.lastSamples;
  }

  private checkRocmSmi(): void {
    if (this.rocmSmiAvailable !== null) return;
    try {
      const r = spawnSyncRocmSmi(config.rocmSmiPath, ['--version'], 3000);
      this.rocmSmiAvailable = r.status === 0;
    } catch {
      this.rocmSmiAvailable = false;
    }
  }

  private mockTick(): void {
    const samples = buildFakeSamples();
    if (samples.length === 0) return;
    this.persistSamples(samples);
  }

  private tick(): void {
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
        // Same trap as the agent: rocm-smi can exit 0 with empty stdout
        // when librocm_smi64.so fails to load (typically a missing
        // LD_LIBRARY_PATH in containerized installs). Surface a single
        // warning so this doesn't silently drop the UI to "no data".
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

  private persistSamples(samples: GpuSample[]): void {
    this.lastSamples = samples;
    for (const s of samples) {
      GpuDeviceRepository.upsert({
        host_id: LOCAL_HOST_ID,
        gpu_index: s.gpu_index,
        name: s.name,
        uuid: s.uuid,
        memory_total: s.memory_total,
        driver_version: s.driver_version,
      });
      this.buffer.push({
        host_id: LOCAL_HOST_ID,
        gpu_index: s.gpu_index,
        timestamp: s.timestamp,
        timestamp_epoch: s.timestamp_epoch,
        temperature: s.temperature,
        utilization: s.utilization,
        memory_used: s.memory_used,
        memory_total: s.memory_total,
        power: s.power,
        fan_speed: s.fan_speed,
        clock_graphics: s.clock_graphics,
        clock_memory: s.clock_memory,
      });
    }
    metricsBus.emit('sample', { host_id: LOCAL_HOST_ID, samples });
    this.touchLocalLastSeen();
    if (Date.now() - this.lastFlush >= this.flushIntervalMs) this.flushBuffer();
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    try {
      GpuMetricRepository.insertMany(this.buffer);
      logger.debug('gpu', `Flushed ${this.buffer.length} samples to DB`);
    } catch (err) {
      logger.error('gpu', 'flushBuffer failed:', (err as Error).message);
    }
    this.buffer = [];
    this.lastFlush = Date.now();
  }
}

export const rocmGpuCollector = new RocmGpuCollector();
