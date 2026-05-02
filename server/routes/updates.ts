import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { updateService } from '../services/updateService.js';

const router = Router();
router.use(requireAuth);

/** GET /api/updates/check — returns latest available version (cached unless ?force=true). */
router.get('/check', async (req, res, next) => {
  try {
    const force = req.query.force === 'true';
    const result = await updateService.check(force);
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/updates/config — current update-checker config (enabled / frequency). */
router.get('/config', (_req, res) => {
  res.json({ config: updateService.getConfig() });
});

/** PATCH /api/updates/config — admin-only, change enabled or frequencyHours. */
router.patch('/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch: Partial<{ enabled: boolean; frequencyHours: number }> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.frequencyHours === 'number' && Number.isFinite(body.frequencyHours)) {
    patch.frequencyHours = Math.floor(body.frequencyHours);
  }
  res.json({ config: updateService.setConfig(patch) });
});

export default router;
