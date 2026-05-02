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

// Curated, classic presets users can seed in one click. They land
// disabled so the user reviews thresholds for their own GPU before
// arming them. Re-using a preset id duplicates it (we don't dedupe
// on name) — fine for now since the user can delete unwanted rows.
const ALERT_PRESETS = [
  { id: 'temp_critical',  name: 'Temperature critical',     metric: 'temperature' as AlertMetric, condition: 'above'  as AlertCondition, threshold: 85,  duration_s: 30,  cooldown_s: 300, notify_sound: 1 },
  { id: 'temp_high',      name: 'Temperature high',         metric: 'temperature' as AlertMetric, condition: 'above'  as AlertCondition, threshold: 80,  duration_s: 60,  cooldown_s: 300, notify_sound: 0 },
  { id: 'mem_saturated',  name: 'VRAM saturated',           metric: 'memory'      as AlertMetric, condition: 'above'  as AlertCondition, threshold: 95,  duration_s: 60,  cooldown_s: 300, notify_sound: 0 },
  { id: 'mem_high',       name: 'VRAM high',                metric: 'memory'      as AlertMetric, condition: 'above'  as AlertCondition, threshold: 85,  duration_s: 120, cooldown_s: 600, notify_sound: 0 },
  { id: 'power_high',     name: 'Power draw high',          metric: 'power'       as AlertMetric, condition: 'above'  as AlertCondition, threshold: 350, duration_s: 60,  cooldown_s: 600, notify_sound: 0 },
  { id: 'util_sustained', name: 'Sustained 100% utilization',metric: 'utilization' as AlertMetric, condition: 'above'  as AlertCondition, threshold: 98,  duration_s: 300, cooldown_s: 900, notify_sound: 0 },
  { id: 'fan_runaway',    name: 'Fan runaway',              metric: 'fan_speed'   as AlertMetric, condition: 'above'  as AlertCondition, threshold: 90,  duration_s: 60,  cooldown_s: 600, notify_sound: 1 },
  { id: 'fan_stalled',    name: 'Fan stalled',              metric: 'fan_speed'   as AlertMetric, condition: 'below'  as AlertCondition, threshold: 5,   duration_s: 60,  cooldown_s: 600, notify_sound: 1 },
  { id: 'idle_anomaly',   name: 'GPU idle anomaly',         metric: 'utilization' as AlertMetric, condition: 'below'  as AlertCondition, threshold: 1,   duration_s: 600, cooldown_s: 1800, notify_sound: 0 },
];

router.get('/presets', (_req, res) => {
  res.json({ presets: ALERT_PRESETS });
});

router.post('/presets/install', requireAdmin, (req, res) => {
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const created = [];
  for (const id of ids) {
    const p = ALERT_PRESETS.find((x) => x.id === id);
    if (!p) continue;
    created.push(AlertRuleRepo.create({
      name: p.name,
      metric: p.metric,
      condition: p.condition,
      threshold: p.threshold,
      duration_s: p.duration_s,
      gpu_index: null,
      enabled: 0, // installed disabled — user reviews then enables
      notify_browser: 1,
      notify_sound: p.notify_sound as 0 | 1,
      cooldown_s: p.cooldown_s,
    }));
  }
  alertService.invalidateCache();
  res.json({ created });
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
