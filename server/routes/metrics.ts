import { Router } from 'express';
import { exportService, renderPrometheus } from '../services/exportService.js';

// Prometheus exposition endpoint. Mounted unauthenticated by design (scrapers).
// Toggle on/off via Settings > Exports > Prometheus. When disabled returns 404.
const router = Router();

router.get('/', (_req, res) => {
  const cfg = exportService.getConfigs().prometheus;
  if (!cfg.enabled) {
    res.status(404).type('text/plain').send('# Prometheus exporter disabled\n');
    return;
  }
  const samples = exportService.getLatestSamples();
  res.type('text/plain; version=0.0.4').send(renderPrometheus(samples, cfg.includeSystemStats));
});

export default router;
