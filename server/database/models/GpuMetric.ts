import { getDatabase } from '../connection.js';

export interface GpuMetric {
  host_id: string;
  gpu_index: number;
  timestamp: string;
  timestamp_epoch: number;
  temperature: number;
  utilization: number | null;
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
         (host_id, gpu_index, timestamp, timestamp_epoch, temperature, utilization,
          memory_used, memory_total, power, fan_speed, clock_graphics, clock_memory)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.host_id,
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
       (host_id, gpu_index, timestamp, timestamp_epoch, temperature, utilization,
        memory_used, memory_total, power, fan_speed, clock_graphics, clock_memory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = getDatabase().transaction((rows: GpuMetric[]) => {
      for (const m of rows) {
        stmt.run(
          m.host_id,
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

  history(hostId: string, gpuIndex: number, sinceEpoch: number): GpuMetric[] {
    return getDatabase()
      .prepare(
        `SELECT * FROM gpu_metrics
         WHERE host_id = ? AND gpu_index = ? AND timestamp_epoch >= ?
         ORDER BY timestamp_epoch ASC`
      )
      .all(hostId, gpuIndex, sinceEpoch) as GpuMetric[];
  },

  /**
   * Bucket-averaged history for the chart. At 1Hz collection, a 3-day
   * range is ~260k rows / ~30MB JSON — too heavy to ship and parse.
   * The chart only paints ~1200px wide, so we average rows into
   * bucketSec-wide buckets and return just the columns the chart
   * actually reads (matches HistoryRow on the client).
   */
  historyDownsampled(hostId: string, gpuIndex: number, sinceEpoch: number, bucketSec: number): Array<{
    timestamp_epoch: number;
    temperature: number;
    utilization: number | null;
    memory_used: number;
    memory_total: number | null;
    power: number;
    fan_speed: number | null;
  }> {
    return getDatabase()
      .prepare(
        `SELECT
           CAST(timestamp_epoch / ? AS INTEGER) * ? AS timestamp_epoch,
           AVG(temperature) AS temperature,
           AVG(utilization) AS utilization,
           AVG(memory_used) AS memory_used,
           MAX(memory_total) AS memory_total,
           AVG(power) AS power,
           AVG(fan_speed) AS fan_speed
         FROM gpu_metrics
         WHERE host_id = ? AND gpu_index = ? AND timestamp_epoch >= ?
         GROUP BY CAST(timestamp_epoch / ? AS INTEGER)
         ORDER BY timestamp_epoch ASC`,
      )
      .all(bucketSec, bucketSec, hostId, gpuIndex, sinceEpoch, bucketSec) as Array<{
        timestamp_epoch: number;
        temperature: number;
        utilization: number | null;
        memory_used: number;
        memory_total: number | null;
        power: number;
        fan_speed: number | null;
      }>;
  },

  /**
   * Streaming variant for CSV export. gpuIndex=null fetches every GPU
   * of that host. Uses better-sqlite3 .iterate() so memory stays
   * bounded for multi-day exports.
   */
  historyIterate(hostId: string, gpuIndex: number | null, sinceEpoch: number): IterableIterator<GpuMetric> {
    const db = getDatabase();
    const stmt = gpuIndex === null
      ? db.prepare(
          `SELECT * FROM gpu_metrics
           WHERE host_id = ? AND timestamp_epoch >= ?
           ORDER BY gpu_index ASC, timestamp_epoch ASC`,
        )
      : db.prepare(
          `SELECT * FROM gpu_metrics
           WHERE host_id = ? AND gpu_index = ? AND timestamp_epoch >= ?
           ORDER BY timestamp_epoch ASC`,
        );
    return (gpuIndex === null
      ? stmt.iterate(hostId, sinceEpoch)
      : stmt.iterate(hostId, gpuIndex, sinceEpoch)) as IterableIterator<GpuMetric>;
  },

  stats(hostId: string, gpuIndex: number, sinceEpoch: number) {
    return getDatabase()
      .prepare(
        `SELECT
           MIN(temperature) as temp_min, MAX(temperature) as temp_max, AVG(temperature) as temp_avg,
           MIN(utilization) as util_min, MAX(utilization) as util_max, AVG(utilization) as util_avg,
           MIN(memory_used) as mem_min,  MAX(memory_used) as mem_max,  AVG(memory_used) as mem_avg,
           MIN(power)       as pow_min,  MAX(power)       as pow_max,  AVG(power)       as pow_avg,
           MIN(fan_speed)   as fan_min,  MAX(fan_speed)   as fan_max,  AVG(fan_speed)   as fan_avg
         FROM gpu_metrics
         WHERE host_id = ? AND gpu_index = ? AND timestamp_epoch >= ?`
      )
      .get(hostId, gpuIndex, sinceEpoch);
  },

  pruneOlderThan(epoch: number): number {
    const info = getDatabase()
      .prepare('DELETE FROM gpu_metrics WHERE timestamp_epoch < ?')
      .run(epoch);
    return Number(info.changes || 0);
  },
};

export interface GpuDevice {
  host_id: string;
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
        `INSERT INTO gpu_devices (host_id, gpu_index, name, uuid, memory_total, driver_version, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id, gpu_index) DO UPDATE SET
           name = excluded.name,
           uuid = excluded.uuid,
           memory_total = excluded.memory_total,
           driver_version = excluded.driver_version,
           last_seen = excluded.last_seen`
      )
      .run(d.host_id, d.gpu_index, d.name, d.uuid, d.memory_total, d.driver_version, now, now);
  },

  /** All devices across all hosts. Used by the future /fleet endpoint. */
  list(): GpuDevice[] {
    return getDatabase()
      .prepare('SELECT * FROM gpu_devices ORDER BY host_id ASC, gpu_index ASC')
      .all() as GpuDevice[];
  },

  /** Devices for one host. Drives the per-host drill-down dashboard. */
  listByHost(hostId: string): GpuDevice[] {
    return getDatabase()
      .prepare('SELECT * FROM gpu_devices WHERE host_id = ? ORDER BY gpu_index ASC')
      .all(hostId) as GpuDevice[];
  },
};
