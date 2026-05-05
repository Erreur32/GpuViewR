// Shared 3-band status mapping used by every gauge / metric tile so
// the colour palette stays consistent (green / amber / red) across
// the Dashboard, the All-GPUs grid and the System page.
export type Status = 'ok' | 'warn' | 'danger';

export function statusFor(value: number, warn: number, danger: number): Status {
  if (value >= danger) return 'danger';
  if (value >= warn) return 'warn';
  return 'ok';
}

export function colorFor(status: Status): string {
  if (status === 'danger') return 'var(--gv-danger)';
  if (status === 'warn') return 'var(--gv-warn)';
  return 'var(--gv-ok)';
}
