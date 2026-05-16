// Periodic cleanup of old gpu_metrics rows. Previously lived next
// to the hub-local gpuCollector; extracted here when the hub became
// vendor-neutral (v0.5.0) so retention is independent of any
// collector lifecycle.

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { GpuMetricRepository } from '../database/models/GpuMetric.js';
import { AppConfigRepo } from '../database/models/AppConfig.js';

export function startRetentionJob(): void {
  const oneHour = 60 * 60 * 1000;
  setInterval(() => {
    // Prefer the runtime-configurable retention (Settings UI), fall
    // back to the env-driven default if no value has been set.
    let days = config.retentionDays;
    try {
      const stored = AppConfigRepo.get('retention_days');
      const n = stored ? Number.parseInt(stored, 10) : Number.NaN;
      if (Number.isFinite(n) && n > 0) days = n;
    } catch {
      // ignore: keep env default
    }
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const removed = GpuMetricRepository.pruneOlderThan(cutoff);
    if (removed > 0) logger.info('gpu', `Retention: pruned ${removed} rows older than ${days}d`);
  }, oneHour);
}
