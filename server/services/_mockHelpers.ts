// Shared primitives for the dev-only mock paths (mockGpu.ts and
// mockAgentSeeder.ts). Both files build synthetic GPU samples + fake
// processes from the same wave / sweep math; extracting the helpers
// here keeps SonarCloud's duplicate-block detector happy and prevents
// the two paths from drifting apart.

import { randomInt } from 'node:crypto';

/** CSPRNG-backed [0, 1) float. Routed through node:crypto so
 *  SonarCloud's S2245 hotspot stays clean without per-call NOSONAR
 *  comments. randomInt is plenty fast at our 1Hz tick. */
export function rand01(): number {
  return randomInt(0, 1_000_000) / 1_000_000;
}

/** Sinusoidal sweep over [min, max] with a configurable period (sec)
 *  and phase. Used to drive plausible-looking time series in the
 *  dev preview — every gauge / bar visits both extremes within a
 *  session so dev tweaks to gradients/thresholds are exercised. */
export function sweep(min: number, max: number, periodSec: number, phase: number): number {
  const t = Date.now() / 1000;
  const s = Math.sin((t / periodSec) * 2 * Math.PI + phase);
  return min + ((s + 1) / 2) * (max - min);
}

/** Slow sinusoid + noise → smooth, plausible curves on the dashboard.
 *  Equivalent to `sweep` but centred on `base` with explicit
 *  amplitude and a small uniform jitter term. */
export function wave(amp: number, base: number, periodSec: number, phase: number, jitter: number): number {
  const t = Date.now() / 1000;
  const s = Math.sin((t / periodSec) * 2 * Math.PI + phase);
  const n = (rand01() - 0.5) * 2 * jitter;
  return base + amp * s + n;
}

/** Distribute a host's used-VRAM total across its mock processes with
 *  a bit of per-tick churn. Used by both `mockGpu` (local mock host)
 *  and `mockAgentSeeder` (synthetic agent host) — extracted here so
 *  Sonar's duplicate-block detector doesn't flag the shared loop. */
export function distributeVram<P extends { used_memory: number }>(
  procsByGpu: Map<number, P[]>,
  memByGpu: Map<number, number>,
): P[] {
  const out: P[] = [];
  for (const [gpu, procs] of procsByGpu) {
    const total = memByGpu.get(gpu) ?? 0;
    const weights = procs.map(() => 0.5 + rand01());
    const sum = weights.reduce((a, b) => a + b, 0);
    procs.forEach((p, i) => {
      out.push({ ...p, used_memory: Math.round((weights[i] / sum) * total) });
    });
  }
  return out;
}
