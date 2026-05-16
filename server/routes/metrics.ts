import { Router } from 'express';
import { exportService, renderPrometheus, applyHostFilter } from '../services/exportService.js';

// Prometheus exposition endpoint. Mounted unauthenticated by design (scrapers).
// Toggle on/off via Settings > Exports > Prometheus. When disabled returns 404.
const router = Router();

router.get('/', (_req, res) => {
  const cfg = exportService.getConfigs().prometheus;
  if (!cfg.enabled) {
    res.status(404).type('text/plain').send('# Prometheus exporter disabled\n');
    return;
  }
  // Apply the host/GPU filter to the scrape view too — admins who
  // opted into "only push these hosts" expect the same restriction
  // here. Empty filter = passthrough (existing scrapes unaffected).
  const samplesByHost = applyHostFilter(exportService.getLatestSamplesByHost(), cfg.hostFilter);
  res.type('text/plain; version=0.0.4').send(renderPrometheus(samplesByHost, cfg.includeSystemStats));
});

export default router;
