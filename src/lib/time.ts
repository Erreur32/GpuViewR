import type { TimeFormat } from '../store/uiStore';

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
