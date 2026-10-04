/** Binary byte size for display: "512 B", "3.42 GiB", "18.5 MiB", "128 GiB".
 *  Fewer decimals as the number grows, so the width stays about the same. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  let digits = 0;
  if (v < 10) digits = 2;
  else if (v < 100) digits = 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}
