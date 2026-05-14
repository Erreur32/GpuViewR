import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, Zap, MemoryStick } from 'lucide-react';
import { useGpuStore, type GpuSample } from '../../store/gpuStore';
import Sparkline from '../dashboard/Sparkline';

type Props = Readonly<{
  hostId: string;
  sample: GpuSample;
}>;

function tempColor(t: number): string {
  if (t >= 80) return 'var(--gv-danger)';
  if (t >= 75) return 'var(--gv-orange)';
  if (t >= 70) return 'var(--gv-warn)';
  return 'var(--gv-ok)';
}

function utilColor(u: number | null): string {
  if (u === null) return 'var(--gv-text-dim)';
  if (u >= 95) return 'var(--gv-danger)';
  if (u >= 80) return 'var(--gv-warn)';
  return 'var(--gv-info)';
}

function powerColor(p: number, max = 450): string {
  const pct = (p / max) * 100;
  if (pct >= 90) return 'var(--gv-danger)';
  if (pct >= 70) return 'var(--gv-warn)';
  return 'var(--gv-accent)';
}

/** Compact per-GPU live tile shown on Fleet's detailed view. Reads the
 *  per-host series from the gpuStore's internal buckets (NOT the public
 *  projection) so each host's tiles update independently of the
 *  selectedHostId. */
export default function GpuMiniTile({ hostId, sample }: Props) {
  const { t } = useTranslation();
  const series = useGpuStore((s) => s.seriesByHost.get(hostId)?.get(sample.gpu_index));

  const memTotal = sample.memory_total ?? 0;
  const memPct = memTotal > 0 ? (sample.memory_used / memTotal) * 100 : 0;
  const tempC = tempColor(sample.temperature);
  const utilC = utilColor(sample.utilization);
  const powC = powerColor(sample.power);

  // Cap sparkline history to ~30 points (last 30s at 1Hz) so the
  // detailed tile stays compact.
  const tempHistory = series?.temperature.slice(-30) ?? [];

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

      {/* 4 mini-bars: util / temp-as-pct-of-100 / power / memory */}
      <div className="grid grid-cols-2 gap-1.5">
        <MiniBar
          icon={<Activity size={11} />}
          label={t('dashboard.metrics.utilization')}
          value={sample.utilization}
          unit="%"
          max={100}
          color={utilC}
        />
        <MiniBar
          icon={<Thermometer size={11} />}
          label={t('dashboard.metrics.temperature')}
          value={sample.temperature}
          unit="°C"
          max={100}
          color={tempC}
        />
        <MiniBar
          icon={<Zap size={11} />}
          label={t('dashboard.metrics.power')}
          value={Math.round(sample.power)}
          unit="W"
          max={450}
          color={powC}
        />
        <MiniBar
          icon={<MemoryStick size={11} />}
          label={t('dashboard.metrics.memory')}
          value={Math.round(memPct)}
          unit="%"
          max={100}
          color="var(--gv-info)"
        />
      </div>

      {tempHistory.length > 1 && (
        <div className="-mx-1 -mb-1">
          <Sparkline values={tempHistory} max={Math.max(100, ...tempHistory)} height={20} width={220} stroke={tempC} />
        </div>
      )}
    </div>
  );
}

function MiniBar({
  icon, label, value, unit, max, color,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  value: number | null;
  unit: string;
  max: number;
  color: string;
}>) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-1.5 text-[10px]" title={label}>
      <span style={{ color: 'var(--gv-text-dim)' }}>{icon}</span>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--gv-border)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="font-mono tabular-nums w-12 text-right" style={{ color }}>
        {value === null ? '—' : `${value}${unit}`}
      </span>
    </div>
  );
}
