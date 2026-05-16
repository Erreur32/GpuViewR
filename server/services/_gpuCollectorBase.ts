// Shared lifecycle/persistence layer for the per-vendor GPU collectors.
// gpuCollector (nvidia-smi) and rocmGpuCollector (rocm-smi) override
// only the bits that actually differ — binary probe + spawn/parse —
// while DB persistence, heartbeat throttling and the mock path live
// here once.

import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { GpuDeviceRepository, GpuMetricRepository, type GpuMetric } from '../database/models/GpuMetric.js';
import { HostsRepo, LOCAL_HOST_ID } from '../database/models/Host.js';
import { buildFakeSamples } from './mockGpu.js';
import { type GpuSample } from './parsers/nvidia.js';
import { metricsBus } from './_metricsBus.js';

const LAST_SEEN_THROTTLE_MS = 5_000;
const FLUSH_INTERVAL_MS = 60_000;

export abstract class GpuCollectorBase extends EventEmitter {
  protected timer: NodeJS.Timeout | null = null;
  protected lastSamples: GpuSample[] = [];
  private buffer: GpuMetric[] = [];
  private lastFlush = Date.now();
  private lastSeenWroteAt = 0;

  /** Vendor-specific binary probe. Cached by the subclass — base
   *  doesn't memoise so the subclass can decide when to retry. */
  protected abstract checkAvailable(): boolean;

  /** Vendor-specific spawn+parse loop. Must call persistSamples() once
   *  it has a non-empty sample array; the base handles the rest. */
  protected abstract tick(): void;

  /** Human-readable line for the "could not start" warning. */
  protected abstract unavailableMessage(): string;

  /** Human-readable line for the success log on first start. */
  protected abstract startedMessage(): string;

  start(): void {
    if (this.timer) return;
    if (config.mockGpu) {
      logger.warn('gpu', `Mock collector started (tick=${config.gpuTickMs}ms) — synthetic data, NOT REAL GPUS`);
      this.mockTick();
      this.timer = setInterval(() => this.mockTick(), config.gpuTickMs);
      return;
    }
    if (!this.checkAvailable()) {
      logger.warn('gpu', this.unavailableMessage());
      return;
    }
    logger.success('gpu', this.startedMessage());
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

  /** Push samples through the standard pipeline: gpu_devices upsert,
   *  gpu_metrics buffer, metricsBus broadcast, hosts.last_seen
   *  heartbeat, and time-based DB flush. Subclasses call this once
   *  per successful spawn. */
  protected persistSamples(samples: GpuSample[]): void {
    if (samples.length === 0) return;
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
    if (Date.now() - this.lastFlush >= FLUSH_INTERVAL_MS) this.flushBuffer();
  }

  protected mockTick(): void {
    const samples = buildFakeSamples();
    if (samples.length > 0) this.persistSamples(samples);
  }

  /** Touch hosts.last_seen for the local row so the Hosts settings
   *  table shows a fresh heartbeat (the WS ingest path does the same
   *  for remote agents). No-op until the throttle window elapses. */
  private touchLocalLastSeen(): void {
    const now = Date.now();
    if (now - this.lastSeenWroteAt < LAST_SEEN_THROTTLE_MS) return;
    this.lastSeenWroteAt = now;
    try {
      HostsRepo.markSeen(LOCAL_HOST_ID);
    } catch (err) {
      // Don't let a SQLite hiccup take down the collect loop — the
      // heartbeat is best-effort metadata, not the sample pipeline.
      logger.debug('gpu', `markSeen(local) failed: ${(err as Error).message}`);
    }
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
