import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnNvidiaSmi, spawnSyncNvidiaSmi } from '../utils/nvidiaSmi.js';
import { GpuDeviceRepository, GpuMetricRepository, type GpuMetric } from '../database/models/GpuMetric.js';
import { AppConfigRepo } from '../database/models/AppConfig.js';
import { buildFakeSamples } from './mockGpu.js';

const QUERY_FIELDS = [
  'index',
  'name',
  'uuid',
  'driver_version',
  'temperature.gpu',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'power.draw',
  'fan.speed',
  'clocks.gr',
  'clocks.mem',
];

export interface GpuSample {
  gpu_index: number;
  name: string;
  uuid: string | null;
  driver_version: string | null;
  temperature: number;
  utilization: number | null;
  memory_used: number;
  memory_total: number | null;
  power: number;
  fan_speed: number | null;
  clock_graphics: number | null;
  clock_memory: number | null;
  timestamp: string;
  timestamp_epoch: number;
}

function num(v: string): number {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: string): number | null {
  if (!v || v.trim() === '' || v.includes('N/A') || v.includes('Not Supported')) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function nowTimestamp(): { iso: string; epoch: number } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { iso, epoch: Math.floor(d.getTime() / 1000) };
}

class GpuCollector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private nvidiaSmiAvailable: boolean | null = null;
  private buffer: GpuMetric[] = [];
  private lastFlush = Date.now();
  private readonly flushIntervalMs = 60_000; // persist every minute
  private lastSamples: GpuSample[] = [];

  start(): void {
    if (this.timer) return;
    if (config.mockGpu) {
      logger.warn('gpu', `Mock collector started (tick=${config.gpuTickMs}ms) — synthetic data, NOT REAL GPUS`);
      this.mockTick();
      this.timer = setInterval(() => this.mockTick(), config.gpuTickMs);
      return;
    }
    this.checkNvidiaSmi();
    if (!this.nvidiaSmiAvailable) {
      logger.warn('gpu', 'nvidia-smi not available: collector disabled (UI will show no data)');
      return;
    }
    logger.success('gpu', `Collector started (tick=${config.gpuTickMs}ms)`);
    this.tick();
    this.timer = setInterval(() => this.tick(), config.gpuTickMs);
  }

  private mockTick(): void {
    const samples = buildFakeSamples();
    if (samples.length === 0) return;
    this.lastSamples = samples;
    for (const s of samples) {
      GpuDeviceRepository.upsert({
        gpu_index: s.gpu_index,
        name: s.name,
        uuid: s.uuid,
        memory_total: s.memory_total,
        driver_version: s.driver_version,
      });
      this.buffer.push({
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
    this.emit('sample', samples);
    if (Date.now() - this.lastFlush >= this.flushIntervalMs) this.flushBuffer();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.buffer.length) this.flushBuffer();
  }

  getLatest(): GpuSample[] {
    return this.lastSamples;
  }

  private checkNvidiaSmi(): void {
    if (this.nvidiaSmiAvailable !== null) return;
    try {
      const r = spawnSyncNvidiaSmi(['--version'], 3000);
      this.nvidiaSmiAvailable = r.status === 0;
    } catch {
      this.nvidiaSmiAvailable = false;
    }
  }

  private tick(): void {
    const child = spawnNvidiaSmi([
      `--query-gpu=${QUERY_FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => logger.error('gpu', 'nvidia-smi spawn failed:', err.message));
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('gpu', `nvidia-smi exited ${code}: ${stderr.trim()}`);
        return;
      }
      this.handleOutput(stdout);
    });
  }

  private handleOutput(out: string): void {
    const { iso, epoch } = nowTimestamp();
    const samples: GpuSample[] = [];
    for (const line of out.split('\n')) {
      const row = line.trim();
      if (!row) continue;
      const parts = row.split(',').map((p) => p.trim());
      if (parts.length < QUERY_FIELDS.length) continue;
      const sample: GpuSample = {
        gpu_index: num(parts[0]),
        name: parts[1] || 'GPU',
        uuid: parts[2] || null,
        driver_version: parts[3] || null,
        temperature: num(parts[4]),
        utilization: numOrNull(parts[5]),
        memory_used: num(parts[6]),
        memory_total: numOrNull(parts[7]),
        power: numOrNull(parts[8]) ?? 0,
        fan_speed: numOrNull(parts[9]),
        clock_graphics: numOrNull(parts[10]),
        clock_memory: numOrNull(parts[11]),
        timestamp: iso,
        timestamp_epoch: epoch,
      };
      samples.push(sample);

      GpuDeviceRepository.upsert({
        gpu_index: sample.gpu_index,
        name: sample.name,
        uuid: sample.uuid,
        memory_total: sample.memory_total,
        driver_version: sample.driver_version,
      });

      this.buffer.push({
        gpu_index: sample.gpu_index,
        timestamp: sample.timestamp,
        timestamp_epoch: sample.timestamp_epoch,
        temperature: sample.temperature,
        utilization: sample.utilization,
        memory_used: sample.memory_used,
        memory_total: sample.memory_total,
        power: sample.power,
        fan_speed: sample.fan_speed,
        clock_graphics: sample.clock_graphics,
        clock_memory: sample.clock_memory,
      });
    }
    if (samples.length === 0) return;
    this.lastSamples = samples;
    this.emit('sample', samples);

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

export const gpuCollector = new GpuCollector();

export function startRetentionJob(): void {
  const oneHour = 60 * 60 * 1000;
  setInterval(() => {
    // Prefer the runtime-configurable retention (Settings UI), fall back to
    // the env-driven default if no value has been set.
    let days = config.retentionDays;
    try {
      // Lazy require to avoid a circular import at module load.
      const stored = AppConfigRepo.get('retention_days');
      const n = stored ? Number.parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n > 0) days = n;
    } catch {
      // ignore: keep env default
    }
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const removed = GpuMetricRepository.pruneOlderThan(cutoff);
    if (removed > 0) logger.info('gpu', `Retention: pruned ${removed} rows older than ${days}d`);
  }, oneHour);
}
