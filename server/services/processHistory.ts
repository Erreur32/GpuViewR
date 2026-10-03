// Per-process history: one row per (host, card, process key) per minute,
// with the peak GPU memory and the mean GPU % seen over that minute.
// Feeds the "Top 24 h" view under the process table.
//
// Key: `<runtime>:<model>` for a recognised LLM (so a model keeps its
// line across restarts and pid changes), the process name otherwise.
// Kept as long as the GPU metrics (retention_days); pruned hourly.

import { getDatabase } from '../database/connection.js';
import { metricsBus, type ProcessesEvent } from './_metricsBus.js';
import type { GpuProcess } from './_processTypes.js';
import { logger } from '../utils/logger.js';

const FLUSH_MS = 60_000;

const ddl = `
CREATE TABLE IF NOT EXISTS process_history (
  host_id  TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  gpu_uuid TEXT NOT NULL,
  pkey     TEXT NOT NULL,
  name     TEXT NOT NULL,
  runtime  TEXT,
  model    TEXT,
  vram_mib INTEGER NOT NULL,
  gpu_pct  REAL
);
CREATE INDEX IF NOT EXISTS idx_process_history_host_ts ON process_history(host_id, ts);
`;

interface Bucket {
  host_id: string;
  gpu_uuid: string;
  pkey: string;
  name: string;
  runtime: string | null;
  model: string | null;
  vramMax: number;
  gpuSum: number;
  gpuCount: number;
}

export interface ProcessTopRow {
  pkey: string;
  name: string;
  runtime: string | null;
  model: string | null;
  gpu_uuid: string;
  vram_max: number;
  vram_avg: number;
  gpu_avg: number | null;
  /** Minutes seen in the window. */
  minutes: number;
  last_seen: number;
}

export function processKey(p: GpuProcess): string {
  return p.llm_runtime && p.llm_model ? `${p.llm_runtime}:${p.llm_model}` : p.process_name;
}

const buckets = new Map<string, Bucket>();

function record(e: ProcessesEvent): void {
  for (const p of e.processes) {
    const pkey = processKey(p).slice(0, 200);
    const id = `${e.host_id}|${p.gpu_uuid}|${pkey}`;
    const b = buckets.get(id) ?? {
      host_id: e.host_id,
      gpu_uuid: p.gpu_uuid,
      pkey,
      name: p.process_name.slice(0, 200),
      runtime: p.llm_runtime ?? null,
      model: p.llm_model?.slice(0, 200) ?? null,
      vramMax: 0,
      gpuSum: 0,
      gpuCount: 0,
    };
    b.vramMax = Math.max(b.vramMax, p.used_memory + (p.gtt_memory ?? 0));
    if (typeof p.gpu_pct === 'number' && Number.isFinite(p.gpu_pct)) {
      b.gpuSum += p.gpu_pct;
      b.gpuCount += 1;
    }
    buckets.set(id, b);
  }
}

export function flushProcessHistory(now = Date.now()): number {
  if (buckets.size === 0) return 0;
  const ts = Math.floor(now / 1000);
  const insert = getDatabase().prepare(
    `INSERT INTO process_history (host_id, ts, gpu_uuid, pkey, name, runtime, model, vram_mib, gpu_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rows = [...buckets.values()];
  buckets.clear();
  getDatabase().transaction(() => {
    for (const b of rows) {
      insert.run(b.host_id, ts, b.gpu_uuid, b.pkey, b.name, b.runtime, b.model, Math.round(b.vramMax),
        b.gpuCount > 0 ? Math.round((b.gpuSum / b.gpuCount) * 10) / 10 : null);
    }
  })();
  return rows.length;
}

export const processHistory = {
  init(): void {
    getDatabase().exec(ddl);
    metricsBus.on('processes', record);
    setInterval(() => {
      try {
        flushProcessHistory();
      } catch (err) {
        logger.warn('proc', `process history flush failed: ${(err as Error).message}`);
      }
    }, FLUSH_MS).unref();
  },

  /** Top processes of a host over the last `hours`, by peak GPU memory. */
  top(hostId: string, hours: number, limit = 10): ProcessTopRow[] {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    return getDatabase().prepare(
      `SELECT pkey, MAX(name) AS name, MAX(runtime) AS runtime, MAX(model) AS model, gpu_uuid,
              MAX(vram_mib) AS vram_max, ROUND(AVG(vram_mib)) AS vram_avg,
              ROUND(AVG(gpu_pct), 1) AS gpu_avg, COUNT(*) AS minutes, MAX(ts) AS last_seen
       FROM process_history
       WHERE host_id = ? AND ts >= ?
       GROUP BY pkey, gpu_uuid
       ORDER BY vram_max DESC
       LIMIT ?`,
    ).all(hostId, since, limit) as ProcessTopRow[];
  },

  pruneOlderThan(epoch: number): number {
    return Number(getDatabase().prepare('DELETE FROM process_history WHERE ts < ?').run(epoch).changes || 0);
  },

  /** Test hook. */
  _record: record,
};
