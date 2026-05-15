import { useTranslation } from 'react-i18next';
import { type GpuSample } from '../../store/gpuStore';

type Props = Readonly<{
  sample: GpuSample;
}>;

// Same 5-band heat scale as System's UsageArc — keeps the colour
// agreement across the whole app (Dashboard, System, Fleet).
function severityColor(pct: number): string {
  if (pct >= 90) return 'var(--gv-danger, #ef4444)';
  if (pct >= 75) return 'var(--gv-orange, #f97316)';
  if (pct >= 50) return 'var(--gv-warn, #f59e0b)';
  if (pct >= 20) return 'var(--gv-ok, #22c55e)';
  return 'var(--gv-info, #3b82f6)';
}

/** Per-GPU live tile shown on Fleet's "Jauges" view. Four arc gauges
 *  (util / temp / power / memory) in the same speedometer style as
 *  the System page so the visual language stays consistent. Reads
 *  the per-host series from the gpuStore's internal buckets (NOT the
 *  public projection) so each host's tiles update independently of
 *  the selectedHostId. */
export default function GpuMiniTile({ sample }: Props) {
  const { t } = useTranslation();

  const memTotal = sample.memory_total ?? 0;
  const memPct = memTotal > 0 ? (sample.memory_used / memTotal) * 100 : 0;
  // Power normalised against a 450W ceiling (RTX 4090-class). For
  // lower-TDP cards the gauge still reads meaningfully and the danger
  // band kicks in at the right place visually.
  const powerMax = 450;
  const powerPct = Math.max(0, Math.min(100, (sample.power / powerMax) * 100));
  // Temperature normalised against 100°C — same scale as System.
  const tempPct = Math.max(0, Math.min(100, sample.temperature));
  const utilPct = sample.utilization === null ? 0 : Math.max(0, Math.min(100, sample.utilization));

  const tempC = severityColor(tempPct);
  const utilC = severityColor(utilPct);
  const powC = severityColor(powerPct);
  const memC = severityColor(memPct);

  return (
    <div
      className="rounded-xl p-3 flex flex-col gap-2"
      style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium truncate" style={{ color: 'var(--gv-text)' }}>
          GPU #{sample.gpu_index} · {sample.name.replace('NVIDIA ', '')}
        </span>
        <span className="font-mono text-[10px] tabular-nums" style={{ color: tempC }}>
          {sample.temperature}°C
        </span>
      </div>

      {/* 4 mini speedometers: util / temp / power / memory. Single row
          when the host card is wide enough (≥640px viewport), 2x2 on
          very narrow phones so each arc keeps a readable size. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MiniArc
          label={t('dashboard.metrics.utilization')}
          pct={utilPct}
          display={sample.utilization === null ? '—' : `${Math.round(sample.utilization)}%`}
          color={utilC}
        />
        <MiniArc
          label={t('dashboard.metrics.temperature')}
          pct={tempPct}
          display={`${Math.round(sample.temperature)}°C`}
          color={tempC}
        />
        <MiniArc
          label={t('dashboard.metrics.power')}
          pct={powerPct}
          display={`${Math.round(sample.power)} W`}
          color={powC}
        />
        <MiniArc
          label={t('dashboard.metrics.memory')}
          pct={memPct}
          display={memTotal === 0 ? '—' : `${Math.round(memPct)}%`}
          color={memC}
        />
      </div>
    </div>
  );
}

/** Small 180° arc gauge — identical geometry/gradient/glow stack to
 *  the System page's UsageArc, sized down for the Fleet host card.
 *  Kept inline (rather than imported from SystemPage) so the Fleet
 *  visuals stay self-contained. */
function MiniArc({
  label, pct, display, color,
}: Readonly<{ label: string; pct: number; display: string; color: string }>) {
  const clamped = Math.max(0, Math.min(100, pct));
  const cx = 100;
  const cy = 100;
  const radius = 80;
  const fullCirc = 2 * Math.PI * radius;
  const arcLen = fullCirc * 0.5;
  const offset = arcLen - (clamped / 100) * arcLen;
  const danger = clamped >= 90;
  const uid = `${label.replaceAll(/\W+/g, '')}-${Math.round(clamped * 1000)}`;
  const tickCount = 10;
  const tickEvery = arcLen / tickCount;
  return (
    <div className="flex flex-col items-center text-center min-w-0">
      <div className="relative w-full max-w-[110px] aspect-[2/1.1]">
        <svg viewBox="0 0 200 120" className={`w-full h-full ${danger ? 'gauge-pulse' : ''}`}>
          <defs>
            <linearGradient
              id={`mini-grad-${uid}`}
              gradientUnits="userSpaceOnUse"
              x1={cx + radius} y1={cy}
              x2={cx - radius} y2={cy}
            >
              <stop offset="0%"   stopColor="var(--gv-info, #3b82f6)" />
              <stop offset="20%"  stopColor="var(--gv-ok, #22c55e)" />
              <stop offset="50%"  stopColor="var(--gv-warn, #f59e0b)" />
              <stop offset="75%"  stopColor="var(--gv-orange, #f97316)" />
              <stop offset="90%"  stopColor="var(--gv-danger, #ef4444)" />
              <stop offset="100%" stopColor="var(--gv-danger, #ef4444)" />
            </linearGradient>
            <filter id={`mini-glow-${uid}`} x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur stdDeviation="0.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g transform={`rotate(180 ${cx} ${cy})`}>
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="18"
              stroke="var(--gv-surface)"
              strokeDasharray={`${arcLen} ${fullCirc}`}
              strokeLinecap="round"
            />
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="22"
              stroke="var(--gv-border)"
              strokeDasharray={`1.4 ${tickEvery - 1.4}`}
              strokeDashoffset="0"
              opacity="0.55"
              style={{ pointerEvents: 'none' }}
            />
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="22"
              stroke={color}
              strokeDasharray={`${arcLen} ${fullCirc}`}
              strokeDashoffset={offset}
              strokeLinecap="round"
              opacity="0.08"
              style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
            />
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="18"
              stroke={`url(#mini-grad-${uid})`}
              strokeDasharray={`${arcLen} ${fullCirc}`}
              strokeDashoffset={offset}
              strokeLinecap="round"
              filter={`url(#mini-glow-${uid})`}
              style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
            />
          </g>
        </svg>
        <div
          className="absolute inset-x-0 flex flex-col items-center pointer-events-none"
          style={{ bottom: '10%' }}
        >
          <div
            className="text-[11px] font-mono font-bold tabular-nums leading-none truncate max-w-full"
            style={{ color }}
          >
            {display}
          </div>
        </div>
      </div>
      <div className="text-[9px] uppercase tracking-wider mt-0.5 truncate max-w-full" style={{ color: 'var(--gv-text-muted)' }}>
        {label}
      </div>
    </div>
  );
}
