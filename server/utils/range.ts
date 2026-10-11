/** "90s", "15m", "6h", "7d" or "live" to seconds, 1 hour when unparsable. */
export function parseRange(input: string): number {
  // "live" = the rolling 90-second window shown by default on the chart.
  // Kept in sync with LIVE_WINDOW_S in src/components/dashboard/LiveChart.tsx
  // so the history fetch returns just enough rows to seed the rolling
  // scope without overshooting.
  if (input === 'live') return 90;
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(input);
  if (!m) return 3600;
  const n = Number.parseFloat(m[1]);
  switch (m[2]) {
    case 's':
      return Math.max(1, Math.floor(n));
    case 'm':
      return Math.floor(n * 60);
    case 'h':
      return Math.floor(n * 3600);
    case 'd':
      return Math.floor(n * 86400);
    default:
      return 3600;
  }
}
