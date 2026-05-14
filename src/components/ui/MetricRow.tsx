// Compact metric row: icon + label · gradient progress bar · numeric value.
// Used by Dashboard's "All GPUs" view AND by the Fleet "simple" view so
// the two pages stay visually consistent.

import { statusFor, colorFor } from '../../lib/status';

interface MetricRowProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  displayValue?: string;
  unit: string;
  max: number;
  warn: number;
  danger: number;
}

export default function MetricRow({
  icon, label, value, displayValue, unit, max, warn, danger,
}: Readonly<MetricRowProps>) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const status = statusFor(value, warn, danger);
  const color = colorFor(status);
  return (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <span
        className="inline-flex items-center gap-1.5 w-[88px] shrink-0 uppercase tracking-wider"
        style={{ color: 'var(--gv-text-muted)' }}
      >
        <span style={{ color }}>{icon}</span>
        <span className="text-[10px] font-medium truncate">{label}</span>
      </span>
      <div
        className="relative flex-1 h-2 rounded-full overflow-hidden"
        style={{ background: 'var(--gv-surface-alt)' }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `linear-gradient(90deg, color-mix(in srgb, ${color} 35%, #000) 0%, ${color} 70%, color-mix(in srgb, ${color} 70%, #fff) 100%)`,
            boxShadow: `0 0 6px color-mix(in srgb, ${color} 35%, transparent)`,
            clipPath: `inset(0 ${100 - pct}% 0 0)`,
            transition: 'clip-path 500ms cubic-bezier(0.2, 0.8, 0.2, 1), background 300ms',
          }}
        />
      </div>
      <span
        className="font-mono tabular-nums text-right shrink-0 text-[11px] whitespace-nowrap min-w-[72px]"
        style={{ color }}
      >
        {displayValue ?? `${value.toFixed(value < 10 ? 1 : 0)}${unit}`}
      </span>
    </div>
  );
}
