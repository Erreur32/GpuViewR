import type { TimeFormat } from '../store/uiStore';

// In "Live" mode every chart shows the last LIVE_WINDOW_S seconds as
// a rolling scope. 90s gives ~90 points at the default 1Hz tick — dense
// enough to read, sparse enough that hover targets stay clickable.
export const LIVE_WINDOW_S = 90;

// Translate a UI range token ("live", "5m", "1h", "3d", …) into the
// matching number of seconds. Mirrors parseRange() in
// server/routes/gpu.ts so the client and the API agree on the
// rolling window.
export function rangeToSeconds(range: string): number {
  if (range === 'live') return LIVE_WINDOW_S;
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(range);
  if (!m) return 3600;
  const n = Number.parseFloat(m[1]);
  switch (m[2]) {
    case 's': return Math.max(1, Math.floor(n));
    case 'm': return Math.floor(n * 60);
    case 'h': return Math.floor(n * 3600);
    case 'd': return Math.floor(n * 86400);
    default: return 3600;
  }
}

// Build the uPlot axis label formatter for the time axis. Reads the
// user's 24h / 12h preference through a ref so the chart can be
// rebuilt without re-reading the store on every tick.
export function makeAxisTimeFormatter(timeFormatRef: { current: TimeFormat }) {
  return (_u: unknown, vals: number[]) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const step = vals.length > 1 ? Math.abs(vals[1] - vals[0]) : 60;
    const showSeconds = step < 60;
    return vals.map((v) => {
      const d = new Date(v * 1000);
      if (timeFormatRef.current === '24h') {
        return showSeconds
          ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
          : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      let h = d.getHours();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12;
      if (h === 0) h = 12;
      return showSeconds
        ? `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`
        : `${pad(h)}:${pad(d.getMinutes())} ${ampm}`;
    });
  };
}

export function fmtClock(epoch: number | null | undefined, format: TimeFormat): string {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch)) return '-';
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (format === '24h') {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
}

export function fmtDateTime(epoch: number | null | undefined, format: TimeFormat): string {
  if (epoch === null || epoch === undefined || !Number.isFinite(epoch)) return '-';
  const d = new Date(epoch * 1000);
  return d.toLocaleString(undefined, { hour12: format === '12h' });
}
