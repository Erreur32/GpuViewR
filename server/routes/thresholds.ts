import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { chartThresholds, ChartThresholdsError } from '../services/chartThresholds.js';

// Settings > Chart thresholds: global lines + per-GPU overrides. Read for
// any signed-in user (every dashboard draws them), write for admins.

const router = Router();
router.use(requireAuth);

router.get('/', (_req, res) => {
  res.json(chartThresholds.get());
});

router.put('/', requireAdmin, (req, res) => {
  try {
    res.json(chartThresholds.set(req.body));
  } catch (err) {
    if (err instanceof ChartThresholdsError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
