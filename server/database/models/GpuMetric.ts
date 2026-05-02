import { getDatabase } from '../connection.js';

export interface GpuMetric {
  gpu_index: number;
  timestamp: string;
  timestamp_epoch: number;
  temperature: number;
  utilization: number;
  memory_used: number;
  memory_total: number | null;
  power: number;
  fan_speed: number | null;
  clock_graphics: number | null;
  clock_memory: number | null;
}

export const GpuMetricRepository = {
  insert(m: GpuMetric): void {
    getDatabase()
      .prepare(
        `INSERT INTO gpu_metrics
         (gpu_index, timestamp, timestamp_epoch, temperature, utilization,
          memory_used, memory_total, power, fan_speed, clock_graphics, clock_memory)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.gpu_index,
        m.timestamp,
        m.timestamp_epoch,
        m.temperature,
        m.utilization,
        m.memory_used,
        m.memory_total,
        m.power,
        m.fan_speed,
        m.clock_graphics,
        m.clock_memory
      );
  },

  insertMany(metrics: GpuMetric[]): void {
    if (metrics.length === 0) return;
    const stmt = getDatabase().prepare(
      `INSERT INTO gpu_metrics
       (gpu_index, timestamp, timestamp_epoch, temperature, utilization,
        memory_used, memory_total, power, fan_speed, clock_graphics, clock_memory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = getDatabase().transaction((rows: GpuMetric[]) => {
      for (const m of rows) {
        stmt.run(
          m.gpu_index,
          m.timestamp,
          m.timestamp_epoch,
          m.temperature,
          m.utilization,
          m.memory_used,
          m.memory_total,
          m.power,
          m.fan_speed,
          m.clock_graphics,
          m.clock_memory
        );
      }
    });
    tx(metrics);
  },

  history(gpuIndex: number, sinceEpoch: number): GpuMetric[] {
    return getDatabase()
      .prepare(
        `SELECT * FROM gpu_metrics
         WHERE gpu_index = ? AND timestamp_epoch >= ?
         ORDER BY timestamp_epoch ASC`
      )
      .all(gpuIndex, sinceEpoch) as GpuMetric[];
  },

  stats(gpuIndex: number, sinceEpoch: number) {
    return getDatabase()
      .prepare(
        `SELECT
           MIN(temperature) as temp_min, MAX(temperature) as temp_max, AVG(temperature) as temp_avg,
           MIN(utilization) as util_min, MAX(utilization) as util_max, AVG(utilization) as util_avg,
           MIN(memory_used) as mem_min,  MAX(memory_used) as mem_max,  AVG(memory_used) as mem_avg,
           MIN(power)       as pow_min,  MAX(power)       as pow_max,  AVG(power)       as pow_avg
         FROM gpu_metrics
         WHERE gpu_index = ? AND timestamp_epoch >= ?`
      )
      .get(gpuIndex, sinceEpoch);
  },

  pruneOlderThan(epoch: number): number {
    const info = getDatabase()
      .prepare('DELETE FROM gpu_metrics WHERE timestamp_epoch < ?')
      .run(epoch);
    return Number(info.changes || 0);
  },
};

export interface GpuDevice {
  gpu_index: number;
  name: string;
  uuid: string | null;
  memory_total: number | null;
  driver_version: string | null;
  first_seen: number;
  last_seen: number;
}

export const GpuDeviceRepository = {
  upsert(d: Omit<GpuDevice, 'first_seen' | 'last_seen'>): void {
    const now = Math.floor(Date.now() / 1000);
    getDatabase()
      .prepare(
        `INSERT INTO gpu_devices (gpu_index, name, uuid, memory_total, driver_version, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(gpu_index) DO UPDATE SET
           name = excluded.name,
           uuid = excluded.uuid,
           memory_total = excluded.memory_total,
           driver_version = excluded.driver_version,
           last_seen = excluded.last_seen`
      )
      .run(d.gpu_index, d.name, d.uuid, d.memory_total, d.driver_version, now, now);
  },

  list(): GpuDevice[] {
    return getDatabase()
      .prepare('SELECT * FROM gpu_devices ORDER BY gpu_index ASC')
      .all() as GpuDevice[];
  },
};
