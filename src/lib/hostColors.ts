import type { HostRecord } from '../store/hostsStore';

// Per-host palette. Solid colours, picked to be distinguishable on
// both light and dark themes (no near-pure-yellow, no near-pure-cyan,
// no >50% luminance). Shared by FleetChart.tsx (default assignment)
// and the Settings → Hosts color picker (swatch choices + the "Auto"
// reset option's underlying value) so both agree on the same palette.
export const HOST_PALETTE: readonly string[] = [
  '#3b82f6', // blue 500
  '#22c55e', // green 500
  // Deliberate change, user request: index 2 (3rd host) was orange
  // 500 (#f97316), swapped for a mauve/pourpre. Sits closer in hue to
  // the neighboring purple 500 below than orange did, but both remain
  // visually distinguishable in practice (magenta-leaning vs
  // blue-leaning purple) — flagged during review, kept per explicit
  // request rather than picking a hue further from index 3.
  '#c026d3', // fuchsia 600 (mauve/pourpre) — was orange 500
  '#a855f7', // purple 500
  '#ef4444', // red 500
  '#14b8a6', // teal 500
  '#eab308', // yellow 500 (used past index 6 only — lowest contrast)
  '#ec4899', // pink 500
  '#6366f1', // indigo 500
  '#84cc16', // lime 500
];

export function hostColor(idx: number): string {
  return HOST_PALETTE[idx % HOST_PALETTE.length];
}

/** A host's identity color: its own admin-picked override (Settings →
 *  Hosts) if set, else the index-based palette. Centralizing this
 *  means every render site (legend swatch, chart stroke, tooltip)
 *  agrees on the same color for a given host. */
export function resolveHostColor(host: HostRecord | null | undefined, idx: number): string {
  // Deliberately `||`, not `??`: an empty string is never a valid CSS
  // color, and the PATCH validation in routes/hosts.ts only ever
  // persists a strict #rrggbb hex string or null — but should that
  // invariant ever be violated (direct DB edit, future migration bug),
  // falling back to the palette renders something valid instead of an
  // empty/invalid color value reaching a style attribute.
  return host?.color || hostColor(idx);
}
