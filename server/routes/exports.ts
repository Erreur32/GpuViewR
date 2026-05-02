import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { exportService, type ExporterKind } from '../services/exportService.js';

const router = Router();

// Read configs (auth required, secrets are masked).
router.get('/', requireAuth, (_req, res) => {
  res.json(exportService.getConfigsRedacted());
});

// Update one exporter config (admin).
router.put('/:kind', requireAuth, requireAdmin, (req, res) => {
  const kind = req.params.kind as ExporterKind;
  const allowed: ExporterKind[] = ['prometheus', 'mqtt', 'influxdb', 'webhook'];
  if (!allowed.includes(kind)) return res.status(400).json({ error: 'Unknown exporter kind' });
  const updated = exportService.setConfig(kind, req.body ?? {});
  res.json(updated);
});

// Quick "send test" for the chosen exporter (admin).
router.post('/:kind/test', requireAuth, requireAdmin, async (req, res) => {
  const kind = req.params.kind as ExporterKind;
  const allowed: ExporterKind[] = ['prometheus', 'mqtt', 'influxdb', 'webhook'];
  if (!allowed.includes(kind)) return res.status(400).json({ error: 'Unknown exporter kind' });
  const r = await exportService.test(kind);
  res.status(r.ok ? 200 : 502).json(r);
});

export default router;
