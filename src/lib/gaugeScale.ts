// Gauge ranges for power and temperature. With the card's own limits
// (agent v0.11.9+) the scale is the real hardware range; without them,
// the pre-v0.11.9 guesses are kept so old agents look the same.

export interface GaugeScale {
  max: number;
  warn: number;
  danger: number;
}

export function knownLimit(limit: number | null | undefined): limit is number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
}

/** Full scale = power cap, warn at 80 %, danger at 95 % of it. */
export function powerScale(power: number, limit: number | null | undefined): GaugeScale {
  if (!knownLimit(limit)) return { max: Math.max(300, Math.ceil(power * 1.4)), warn: 250, danger: 350 };
  return { max: Math.max(limit, Math.ceil(power)), warn: Math.round(limit * 0.8), danger: Math.round(limit * 0.95) };
}

/** Danger 5 °C, warn 15 °C below the throttle temperature. */
export function tempScale(limit: number | null | undefined): GaugeScale {
  if (!knownLimit(limit)) return { max: 100, warn: 75, danger: 85 };
  return { max: Math.max(100, limit), warn: limit - 15, danger: limit - 5 };
}

/** Sum of the cards' power caps, 300 W for each card without one. */
export function hostPowerMax(gpus: ReadonlyArray<{ power: number; power_limit?: number | null }>): number {
  let power = 0;
  let caps = 0;
  let allKnown = true;
  for (const g of gpus) {
    power += g.power;
    if (knownLimit(g.power_limit)) caps += g.power_limit;
    else {
      caps += 300;
      allKnown = false;
    }
  }
  return Math.max(caps, Math.ceil(allKnown ? power : power * 1.4));
}
