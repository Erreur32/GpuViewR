// Chart threshold lines: one global set plus per-GPU overrides, stored on
// the hub (server/services/chartThresholds.ts). Per metric, a number
// draws the line, null draws none; in a GPU override a missing metric
// falls back to the global value.

export const THRESHOLD_KEYS = ['util', 'temp', 'pow', 'mem', 'fan'] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];
export type ThresholdValues = Partial<Record<ThresholdKey, number | null>>;
/** What the chart draws: one number per metric that has a line. */
export type EffectiveThresholds = Partial<Record<ThresholdKey, number>>;

export const DEFAULT_THRESHOLDS: Required<EffectiveThresholds> = {
  util: 95,
  temp: 83,
  pow: 350,
  mem: 90,
  fan: 90,
};

export function gpuKey(hostId: string, gpuIndex: number): string {
  return `${hostId}:${gpuIndex}`;
}

/** Lines for one GPU: its own value or "none" when set, else the global. */
export function resolveThresholds(global: ThresholdValues, gpu: ThresholdValues | undefined): EffectiveThresholds {
  const out: EffectiveThresholds = {};
  for (const k of THRESHOLD_KEYS) {
    const v = gpu && k in gpu ? gpu[k] : global[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Pre-hub thresholds kept in this browser's localStorage (empty field =
 *  no line, so a missing metric means null here). Used once, to seed the
 *  shared global set. */
export function readBrowserThresholds(raw: string | null): ThresholdValues {
  if (!raw) return { ...DEFAULT_THRESHOLDS };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return { ...DEFAULT_THRESHOLDS };
    const out: ThresholdValues = {};
    for (const k of THRESHOLD_KEYS) {
      const v = obj[k];
      out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    return out;
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}
