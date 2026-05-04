import type { ReactNode } from 'react';

// nvidia-smi reports PCIe throughput in KiB/s. Humanize so the tile
// shows "50 KiB/s", "1.20 MiB/s", "3.40 GiB/s" instead of a five-digit
// raw number. null collapses to "0 KiB/s": when the driver/runtime
// returns nothing, render an idle reading rather than a generic dash —
// matches nvtop's behaviour on cards where the counter is unsupported
// or quiescent.
export function formatThroughput(kbps: number | null): { value: string; unit: string } {
  const v = kbps !== null && Number.isFinite(kbps) ? kbps : 0;
  if (v < 1024) return { value: v.toFixed(0), unit: 'KiB/s' };
  const mib = v / 1024;
  if (mib < 1024) return { value: mib.toFixed(2), unit: 'MiB/s' };
  return { value: (mib / 1024).toFixed(2), unit: 'GiB/s' };
}

export interface PcieThroughputTileProps {
  icon?: ReactNode;
  label: string;
  kbps: number | null;
  linkBwGBps: number | null;
}

// Glass-style PCIe RX/TX tile shared by the dashboard PCIe panel and
// the System page GPU cards. Fill is log-scaled against the link's
// theoretical bandwidth so idle traffic stays visible without losing
// the ability to saturate at 100%.
export default function PcieThroughputTile({ icon, label, kbps, linkBwGBps }: PcieThroughputTileProps) {
  const fmt = formatThroughput(kbps);
  const maxKbps = linkBwGBps !== null && linkBwGBps > 0 ? (linkBwGBps * 1e9) / 1024 : null;
  const pct = maxKbps !== null && kbps !== null && Number.isFinite(kbps) && kbps > 0
    ? Math.max(0, Math.min(1, Math.log10(kbps + 1) / Math.log10(maxKbps + 1))) * 100
    : 0;
  return (
    <div
      className="relative overflow-hidden rounded-lg px-2.5 py-1.5"
      style={{
        background: 'color-mix(in srgb, var(--gv-info) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-info) 25%, transparent)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          // Gradient anchored to the full tile width (sombre at left,
          // clair at right) and revealed via clip-path as pct grows so
          // the dark band stays fixed in space.
          background:
            'linear-gradient(90deg, color-mix(in srgb, var(--gv-info) 8%, var(--gv-bg)) 0%, color-mix(in srgb, var(--gv-info) 55%, transparent) 60%, var(--gv-info) 100%)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          boxShadow:
            'inset 0 0 12px color-mix(in srgb, var(--gv-info) 22%, transparent)',
          clipPath: `inset(0 ${100 - pct}% 0 0)`,
          transition: 'clip-path 320ms ease-out',
        }}
      />
      <div className="relative flex items-center gap-1.5 text-[10px] uppercase tracking-wider"
           style={{ color: 'var(--gv-info)' }}>
        {icon}
        {label}
      </div>
      <div className="relative flex items-baseline gap-1.5">
        <span className="text-base font-semibold tabular-nums" style={{ color: 'var(--gv-info)' }}>
          {fmt.value}
        </span>
        <span
          className="text-[10px] font-medium"
          style={{ color: 'color-mix(in srgb, var(--gv-info) 70%, var(--gv-text))' }}
        >
          {fmt.unit}
        </span>
      </div>
    </div>
  );
}
