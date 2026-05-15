import { useTranslation } from 'react-i18next';
import { type GpuSample } from '../../store/gpuStore';
import UsageArc from '../ui/UsageArc';

type Props = Readonly<{
  sample: GpuSample;
}>;

// Same 5-band heat scale as System's UsageBar — keeps the colour
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
 *  the System page — same shared UsageArc component so the visual
 *  language stays consistent and SonarCloud doesn't flag a duplicate. */
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

  // Smaller arcs + smaller centre text so 4 fit side-by-side from sm:
  // upward without truncating. Below sm:, the grid drops to 2×2 (the
  // wrapper div around <UsageArc/>).
  const arcOpts = { maxWidthPx: 110, displayClassName: 'text-[11px] font-mono font-bold tabular-nums' };

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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <UsageArc
          {...arcOpts}
          label={t('dashboard.metrics.utilization')}
          pct={utilPct}
          display={sample.utilization === null ? '—' : `${Math.round(sample.utilization)}%`}
          color={utilC}
        />
        <UsageArc
          {...arcOpts}
          label={t('dashboard.metrics.temperature')}
          pct={tempPct}
          display={`${Math.round(sample.temperature)}°C`}
          color={tempC}
        />
        <UsageArc
          {...arcOpts}
          label={t('dashboard.metrics.power')}
          pct={powerPct}
          display={`${Math.round(sample.power)} W`}
          color={powC}
        />
        <UsageArc
          {...arcOpts}
          label={t('dashboard.metrics.memory')}
          pct={memPct}
          display={memTotal === 0 ? '—' : `${Math.round(memPct)}%`}
          color={memC}
        />
      </div>
    </div>
  );
}
