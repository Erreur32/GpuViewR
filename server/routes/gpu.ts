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
  const gpuIndex = parseInt(String(req.query.gpu || '0'), 10);
  const range = String(req.query.range || '1h');
  const seconds = parseRange(range);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const rows = GpuMetricRepository.history(gpuIndex, since);
  res.json({ gpuIndex, range, count: rows.length, history: rows });
});

router.get('/stats', (req, res) => {
  const gpuIndex = parseInt(String(req.query.gpu || '0'), 10);
  const range = String(req.query.range || '24h');
  const seconds = parseRange(range);
  const since = Math.floor(Date.now() / 1000) - seconds;
  res.json({ gpuIndex, range, stats: GpuMetricRepository.stats(gpuIndex, since) });
});

function parseRange(input: string): number {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(input);
  if (!m) return 3600;
  const n = parseFloat(m[1]);
  switch (m[2]) {
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
