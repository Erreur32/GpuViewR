// Chart threshold lines (Settings > Chart thresholds), shared by every
// browser. One global set plus optional per-GPU overrides, because a
// 350 W line means nothing on a 200 W card or a 120 W APU.
//
// Per metric, a value is a number (draw the line there) or null (no line).
// In a GPU override a missing metric means "use the global value".
// Stored as one JSON document in app_config. `global` stays null until an
// admin saves once: the browser then keeps its own pre-v0.11.5 values.

import { AppConfigRepo, ensureAppConfigSchema } from '../database/models/AppConfig.js';

export const THRESHOLD_KEYS = ['util', 'temp', 'pow', 'mem', 'fan'] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];
export type ThresholdValues = Partial<Record<ThresholdKey, number | null>>;

export interface ChartThresholdsDoc {
  global: ThresholdValues | null;
  /** Keyed by `${hostId}:${gpuIndex}`. */
  gpus: Record<string, ThresholdValues>;
}

export const THRESHOLD_LIMITS = { value: 10_000, gpus: 256, hostId: 128, gpuIndex: 63 } as const;

const KEY = 'chart.thresholds';

export class ChartThresholdsError extends Error {}

function parseValues(raw: unknown, where: string): ThresholdValues {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChartThresholdsError(`${where} must be an object`);
  }
  const out: ThresholdValues = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(THRESHOLD_KEYS as readonly string[]).includes(k)) {
      throw new ChartThresholdsError(`${where}: unknown metric "${k}"`);
    }
    if (v === null) {
      out[k as ThresholdKey] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > THRESHOLD_LIMITS.value) {
      throw new ChartThresholdsError(`${where}.${k} must be a number between 0 and ${THRESHOLD_LIMITS.value}, or null`);
    }
    out[k as ThresholdKey] = v;
  }
  return out;
}

/** `${hostId}:${gpuIndex}`: the host id may itself contain ':', the
 *  index is whatever follows the last one. */
function checkGpuKey(key: string): void {
  const at = key.lastIndexOf(':');
  const host = key.slice(0, at);
  const index = key.slice(at + 1);
  const okHost = at > 0 && host.length <= THRESHOLD_LIMITS.hostId && !/[\u0000-\u001f\u007f]/.test(host);
  const n = Number(index);
  const okIndex = /^\d{1,2}$/.test(index) && n <= THRESHOLD_LIMITS.gpuIndex;
  if (!okHost || !okIndex) throw new ChartThresholdsError(`invalid GPU key "${key.slice(0, 40)}"`);
}

/** Validates a full document, throws ChartThresholdsError with a readable
 *  reason. GPU entries left without any metric are dropped. */
export function parseChartThresholds(raw: unknown): ChartThresholdsDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChartThresholdsError('body must be an object');
  }
  const body = raw as { global?: unknown; gpus?: unknown };
  const global = body.global === null || body.global === undefined ? null : parseValues(body.global, 'global');
  const gpusRaw = body.gpus ?? {};
  if (typeof gpusRaw !== 'object' || gpusRaw === null || Array.isArray(gpusRaw)) {
    throw new ChartThresholdsError('gpus must be an object');
  }
  const entries = Object.entries(gpusRaw);
  if (entries.length > THRESHOLD_LIMITS.gpus) {
    throw new ChartThresholdsError(`at most ${THRESHOLD_LIMITS.gpus} GPUs`);
  }
  const gpus: Record<string, ThresholdValues> = {};
  for (const [key, values] of entries) {
    checkGpuKey(key);
    const parsed = parseValues(values, `gpus["${key.slice(0, 40)}"]`);
    if (Object.keys(parsed).length > 0) gpus[key] = parsed;
  }
  return { global, gpus };
}

export const chartThresholds = {
  get(): ChartThresholdsDoc {
    ensureAppConfigSchema();
    const stored = AppConfigRepo.getJson<unknown>(KEY);
    if (stored === null) return { global: null, gpus: {} };
    try {
      return parseChartThresholds(stored);
    } catch {
      // A hand-edited or older row that no longer validates: start over
      // rather than serving garbage to every dashboard.
      return { global: null, gpus: {} };
    }
  },

  set(raw: unknown): ChartThresholdsDoc {
    const doc = parseChartThresholds(raw);
    ensureAppConfigSchema();
    AppConfigRepo.setJson(KEY, doc);
    return doc;
  },
};
