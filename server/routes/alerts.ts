import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { AlertEventRepo, AlertRuleRepo, type AlertCondition, type AlertMetric } from '../database/models/Alert.js';
import { alertService } from '../services/alertService.js';

const router = Router();
router.use(requireAuth);

const VALID_METRICS: AlertMetric[] = ['temperature', 'utilization', 'memory', 'power', 'fan_speed'];
const VALID_CONDITIONS: AlertCondition[] = ['above', 'below'];

router.get('/rules', (_req, res) => {
  res.json({ rules: AlertRuleRepo.list() });
});

router.post('/rules', requireAdmin, (req, res) => {
  const body = req.body || {};
  const err = validate(body);
  if (err) return res.status(400).json({ error: err });
  const rule = AlertRuleRepo.create({
    name: String(body.name),
    metric: body.metric,
    condition: body.condition,
    threshold: Number(body.threshold),
    duration_s: int(body.duration_s, 0),
    gpu_index: body.gpu_index === null || body.gpu_index === undefined ? null : Number(body.gpu_index),
    enabled: body.enabled === false ? 0 : 1,
    notify_browser: body.notify_browser === false ? 0 : 1,
    notify_sound: body.notify_sound ? 1 : 0,
    cooldown_s: int(body.cooldown_s, 300),
  });
  alertService.invalidateCache();
  res.json({ rule });
});

router.patch('/rules/:id', requireAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const body = req.body || {};
  const err = validate(body, true);
  if (err) return res.status(400).json({ error: err });
  const rule = AlertRuleRepo.update(id, {
    ...(body.name !== undefined && { name: String(body.name) }),
    ...(body.metric !== undefined && { metric: body.metric }),
    ...(body.condition !== undefined && { condition: body.condition }),
    ...(body.threshold !== undefined && { threshold: Number(body.threshold) }),
    ...(body.duration_s !== undefined && { duration_s: int(body.duration_s, 0) }),
    ...(body.gpu_index !== undefined && { gpu_index: body.gpu_index === null ? null : Number(body.gpu_index) }),
    ...(body.enabled !== undefined && { enabled: body.enabled ? 1 : 0 }),
    ...(body.notify_browser !== undefined && { notify_browser: body.notify_browser ? 1 : 0 }),
    ...(body.notify_sound !== undefined && { notify_sound: body.notify_sound ? 1 : 0 }),
    ...(body.cooldown_s !== undefined && { cooldown_s: int(body.cooldown_s, 300) }),
  });
  if (!rule) return res.status(404).json({ error: 'Not found' });
  alertService.invalidateCache();
  res.json({ rule });
});

router.delete('/rules/:id', requireAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  AlertRuleRepo.delete(id);
  alertService.invalidateCache();
  res.json({ ok: true });
});

router.get('/events', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit || '100'), 10)));
  res.json({ events: AlertEventRepo.list(limit) });
});

function validate(body: Record<string, unknown>, partial = false): string | null {
  const must = (key: string) => !partial && (body[key] === undefined || body[key] === null);
  if (must('name')) return 'name is required';
  if (must('metric')) return 'metric is required';
  if (must('condition')) return 'condition is required';
  if (must('threshold')) return 'threshold is required';

  if (body.metric !== undefined && !VALID_METRICS.includes(body.metric as AlertMetric)) {
    return `metric must be one of ${VALID_METRICS.join(', ')}`;
  }
  if (body.condition !== undefined && !VALID_CONDITIONS.includes(body.condition as AlertCondition)) {
    return `condition must be 'above' or 'below'`;
  }
  if (body.threshold !== undefined && !Number.isFinite(Number(body.threshold))) {
    return 'threshold must be a number';
  }
  return null;
}

function int(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default router;
