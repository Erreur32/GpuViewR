import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { gpuCollector } from '../services/gpuCollector.js';
import { GpuDeviceRepository, GpuMetricRepository } from '../database/models/GpuMetric.js';

const router = Router();

router.use(requireAuth);

router.get('/devices', (_req, res) => {
  res.json({ devices: GpuDeviceRepository.list() });
});

router.get('/current', (_req, res) => {
  res.json({ samples: gpuCollector.getLatest() });
});

router.get('/history', (req, res) => {
  const gpuIndex = Number.parseInt(String(req.query.gpu || '0'), 10);
  const range = String(req.query.range || '1h');
  const seconds = parseRange(range);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const rows = GpuMetricRepository.history(gpuIndex, since);
  res.json({ gpuIndex, range, count: rows.length, history: rows });
});

// Streaming CSV export. `gpu=all` exports every GPU; otherwise a single GPU
// index. Streamed via better-sqlite3 iterate() so memory stays bounded even
// for multi-day exports.
const CSV_COLUMNS = [
  'gpu_index', 'timestamp', 'timestamp_epoch', 'temperature', 'utilization',
  'memory_used', 'memory_total', 'power', 'fan_speed', 'clock_graphics', 'clock_memory',
] as const;

router.get('/history.csv', (req, res) => {
  const gpuParam = String(req.query.gpu ?? '0');
  const range = String(req.query.range ?? '24h');
  const seconds = parseRange(range);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const gpuIndex = gpuParam === 'all' ? null : Number.parseInt(gpuParam, 10);
  if (gpuIndex !== null && !Number.isFinite(gpuIndex)) {
    return res.status(400).json({ error: 'Invalid gpu parameter' });
  }

  const slug = gpuParam === 'all' ? 'all' : `gpu${gpuIndex}`;
  const filename = `gpuviewr-${slug}-${range}-${Math.floor(Date.now() / 1000)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  // Excel needs the BOM to read UTF-8 cleanly; harmless for everything else.
  res.write('﻿');
  res.write(CSV_COLUMNS.join(',') + '\n');

  const iter = GpuMetricRepository.historyIterate(gpuIndex, since);
  for (const row of iter) {
    const r = row as unknown as Record<string, unknown>;
    res.write(CSV_COLUMNS.map((c) => csvField(r[c])).join(',') + '\n');
  }
  res.end();
});

function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  // Quote when the value contains a CSV special char; double internal quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/stats', (req, res) => {
  const gpuIndex = Number.parseInt(String(req.query.gpu || '0'), 10);
  const range = String(req.query.range || '24h');
  const seconds = parseRange(range);
  const since = Math.floor(Date.now() / 1000) - seconds;
  res.json({ gpuIndex, range, stats: GpuMetricRepository.stats(gpuIndex, since) });
});

function parseRange(input: string): number {
  // "live" = the rolling 90-second window shown by default on the chart.
  // Kept in sync with LIVE_WINDOW_S in src/components/dashboard/LiveChart.tsx
  // so the history fetch returns just enough rows to seed the rolling
  // scope without overshooting.
  if (input === 'live') return 90;
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(input);
  if (!m) return 3600;
  const n = Number.parseFloat(m[1]);
  switch (m[2]) {
    case 's':
      return Math.max(1, Math.floor(n));
    case 'm':
      return Math.floor(n * 60);
    case 'h':
      return Math.floor(n * 3600);
    case 'd':
      return Math.floor(n * 86400);
    default:
      return 3600;
  }
}

export default router;
