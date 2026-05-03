import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { AlertEventRepo, AlertRuleRepo, type AlertCondition, type AlertMetric } from '../database/models/Alert.js';
import { alertService } from '../services/alertService.js';

const router = Router();
router.use(requireAuth);

const VALID_METRICS: AlertMetric[] = ['temperature', 'utilization', 'memory', 'power', 'fan_speed'];
const VALID_CONDITIONS: ReadonlySet<AlertCondition> = new Set(['above', 'below']);

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
    notify_webhook: body.notify_webhook === false ? 0 : 1,
    cooldown_s: int(body.cooldown_s, 300),
  });
  alertService.invalidateCache();
  res.json({ rule });
});

type RulePatch = Partial<{
  name: string;
  metric: AlertMetric;
  condition: AlertCondition;
  threshold: number;
  duration_s: number;
  gpu_index: number | null;
  enabled: 0 | 1;
  notify_browser: 0 | 1;
  notify_sound: 0 | 1;
  notify_webhook: 0 | 1;
  cooldown_s: number;
}>;

// Field-by-field coercion table. Driving the patch builder from a table
// instead of an `if` chain keeps cognitive complexity low and makes
// adding a future field a one-line change (Sonar S3776).
const RULE_FIELD_COERCERS: Array<{ key: keyof RulePatch; coerce: (v: unknown) => unknown }> = [
  { key: 'name',           coerce: (v) => String(v) },
  { key: 'metric',         coerce: (v) => v },
  { key: 'condition',      coerce: (v) => v },
  { key: 'threshold',      coerce: (v) => Number(v) },
  { key: 'duration_s',     coerce: (v) => int(v, 0) },
  { key: 'gpu_index',      coerce: (v) => (v === null ? null : Number(v)) },
  { key: 'enabled',        coerce: (v) => (v ? 1 : 0) },
  { key: 'notify_browser', coerce: (v) => (v ? 1 : 0) },
  { key: 'notify_sound',   coerce: (v) => (v ? 1 : 0) },
  { key: 'notify_webhook', coerce: (v) => (v ? 1 : 0) },
  { key: 'cooldown_s',     coerce: (v) => int(v, 300) },
];

// Build the typed PATCH body from the raw request, only including keys
// that the caller actually sent so the repo `update()` does a true
// partial update.
function buildRulePatch(body: Record<string, unknown>): RulePatch {
  const patch: Record<string, unknown> = {};
  for (const { key, coerce } of RULE_FIELD_COERCERS) {
    const raw = body[key];
    if (raw !== undefined) patch[key] = coerce(raw);
  }
  return patch as RulePatch;
}

router.patch('/rules/:id', requireAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const body = req.body || {};
  const err = validate(body, true);
  if (err) return res.status(400).json({ error: err });
  const rule = AlertRuleRepo.update(id, buildRulePatch(body));
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
      notify_webhook: 1,
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
  if (body.condition !== undefined && !VALID_CONDITIONS.has(body.condition as AlertCondition)) {
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
