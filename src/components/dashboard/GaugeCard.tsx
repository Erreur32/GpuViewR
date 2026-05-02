import { ReactNode } from 'react';
import Sparkline from './Sparkline';

interface Props {
  label: string;
  value: number;
  displayValue?: string;
  unit: string;
  max: number;
  warn?: number;
  danger?: number;
  icon?: ReactNode;
  history?: number[];
  variant?: 'arc' | 'bar';
}

export default function GaugeCard({
  label,
  value,
  displayValue,
  unit,
  max,
  warn,
  danger,
  icon,
  history,
  variant = 'arc',
}: Props) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const status: 'ok' | 'warn' | 'danger' =
    danger !== undefined && value >= danger ? 'danger' : warn !== undefined && value >= warn ? 'warn' : 'ok';

  const colorVar = status === 'danger' ? 'var(--gv-danger)' : status === 'warn' ? 'var(--gv-warn)' : 'var(--gv-ok)';

  return (
    <div className="card card-hover p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        <span className="inline-flex items-center gap-1.5 uppercase tracking-wider font-medium">
          {icon}
          <span>{label}</span>
        </span>
        {history && history.length > 1 && (
          <Sparkline
            values={history.slice(-60)}
            max={Math.max(max, ...history)}
            width={80}
            height={22}
            stroke={colorVar}
          />
        )}
      </div>

      {variant === 'arc' ? (
        <ArcGauge pct={pct} colorVar={colorVar} value={value} unit={unit} max={max} displayValue={displayValue} />
      ) : (
        <BarGauge pct={pct} colorVar={colorVar} value={value} unit={unit} max={max} displayValue={displayValue} />
      )}
    </div>
  );
}

function ArcGauge({
  pct, colorVar, value, unit, max, displayValue,
}: { pct: number; colorVar: string; value: number; unit: string; max: number; displayValue?: string }) {
  const radius = 52;
  const circ = 2 * Math.PI * radius * 0.75;
  const offset = circ - (pct / 100) * circ;
  return (
    <div className="relative w-full aspect-square max-w-[160px] mx-auto">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-[135deg]">
        <circle
          cx="60" cy="60" r={radius} fill="none" strokeWidth="9"
          stroke="var(--gv-border)"
          strokeDasharray={`${circ} ${2 * Math.PI * radius}`}
          strokeLinecap="round"
        />
        <circle
          cx="60" cy="60" r={radius} fill="none" strokeWidth="9"
          stroke={colorVar}
          strokeDasharray={`${circ} ${2 * Math.PI * radius}`}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 10px ${colorVar})`, transition: 'stroke-dashoffset 300ms ease-out, stroke 300ms' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="text-2xl font-bold tabular-nums" style={{ color: colorVar }}>
          {displayValue ?? `${value.toFixed(value < 10 ? 1 : 0)}${unit}`}
        </div>
        {!displayValue && (
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--gv-text-dim)' }}>
            / {max}{unit}
          </div>
        )}
      </div>
    </div>
  );
}

function BarGauge({
  pct, colorVar, value, unit, max, displayValue,
}: { pct: number; colorVar: string; value: number; unit: string; max: number; displayValue?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold tabular-nums" style={{ color: colorVar }}>
          {displayValue ?? `${value.toFixed(value < 10 ? 1 : 0)}${unit}`}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--gv-text-dim)' }}>/ {max}{unit}</span>
      </div>
      <div className="relative h-3 w-full rounded-full overflow-hidden" style={{ background: 'var(--gv-surface-alt)' }}>
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, color-mix(in srgb, ${colorVar} 60%, transparent), ${colorVar})`,
            boxShadow: `0 0 14px ${colorVar}`,
            transition: 'width 300ms ease-out, background 300ms',
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] tabular-nums" style={{ color: 'var(--gv-text-dim)' }}>
        <span>0</span>
        <span>{pct.toFixed(0)}%</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}
