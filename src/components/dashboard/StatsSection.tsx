import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, MemoryStick, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useUiStore } from '../../store/uiStore';

interface StatsResponse {
  gpuIndex: number;
  range: string;
  stats: {
    temp_min: number; temp_max: number; temp_avg: number;
    util_min: number; util_max: number; util_avg: number;
    mem_min: number; mem_max: number; mem_avg: number;
    pow_min: number; pow_max: number; pow_avg: number;
  } | null;
}

interface Props {
  gpuIndex: number;
}

export default function StatsSection({ gpuIndex }: Props) {
  const { t } = useTranslation();
  const range = useUiStore((s) => s.range);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<StatsResponse>(`/gpu/stats?gpu=${gpuIndex}&range=${range}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gpuIndex, range]);

  const s = data?.stats;
  const rows = [
    { key: 'temperature', icon: <Thermometer className="w-4 h-4" />, color: 'var(--gv-warn)', unit: '°C', min: s?.temp_min, max: s?.temp_max, avg: s?.temp_avg },
    { key: 'utilization', icon: <Activity className="w-4 h-4" />, color: 'var(--gv-accent)', unit: '%', min: s?.util_min, max: s?.util_max, avg: s?.util_avg },
    { key: 'memory',      icon: <MemoryStick className="w-4 h-4" />, color: 'var(--gv-info)', unit: ' MiB', min: s?.mem_min, max: s?.mem_max, avg: s?.mem_avg },
    { key: 'power',       icon: <Zap className="w-4 h-4" />, color: 'var(--gv-ok)', unit: ' W', min: s?.pow_min, max: s?.pow_max, avg: s?.pow_avg },
  ];

  return (
    <div className="space-y-4">
      {/* Cards (always visible) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {rows.map((row) => (
          <div
            key={row.key}
            className="card p-3"
            style={{
              background: `color-mix(in srgb, ${row.color} 8%, var(--gv-surface))`,
              borderColor: `color-mix(in srgb, ${row.color} 25%, var(--gv-border))`,
            }}
          >
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider mb-2" style={{ color: row.color }}>
              {row.icon}
              <span>{t(`dashboard.metrics.${row.key}`)}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-xs">
              <Cell label={t('dashboard.min')} value={row.min} unit={row.unit} loading={loading} />
              <Cell label={t('dashboard.avg')} value={row.avg} unit={row.unit} loading={loading} bold />
              <Cell label={t('dashboard.max')} value={row.max} unit={row.unit} loading={loading} />
            </div>
          </div>
        ))}
      </div>

      {/* Detail table */}
      <details className="card p-0 overflow-hidden">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium flex items-center justify-between" style={{ color: 'var(--gv-text-muted)' }}>
          <span>{t('dashboard.stats_details')}</span>
          <span className="text-xs">{t(`dashboard.ranges.${range}`)}</span>
        </summary>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--gv-surface-alt)', color: 'var(--gv-text-muted)' }}>
              <th className="text-left py-2 px-4 font-medium uppercase text-xs tracking-wider">{t('dashboard.metric')}</th>
              <th className="text-right py-2 px-4 font-medium uppercase text-xs tracking-wider">{t('dashboard.min')}</th>
              <th className="text-right py-2 px-4 font-medium uppercase text-xs tracking-wider">{t('dashboard.avg')}</th>
              <th className="text-right py-2 px-4 font-medium uppercase text-xs tracking-wider">{t('dashboard.max')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={{ borderTop: '1px solid var(--gv-border)' }}>
                <td className="py-2 px-4 flex items-center gap-2" style={{ color: row.color }}>
                  {row.icon}
                  <span style={{ color: 'var(--gv-text)' }}>{t(`dashboard.metrics.${row.key}`)}</span>
                </td>
                <td className="text-right py-2 px-4 tabular-nums">{fmt(row.min, row.unit)}</td>
                <td className="text-right py-2 px-4 tabular-nums font-semibold">{fmt(row.avg, row.unit)}</td>
                <td className="text-right py-2 px-4 tabular-nums">{fmt(row.max, row.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Cell({ label, value, unit, loading, bold }: { label: string; value: number | undefined | null; unit: string; loading: boolean; bold?: boolean }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>{label}</div>
      <div className={'tabular-nums ' + (bold ? 'font-bold text-sm' : 'text-xs')} style={{ color: 'var(--gv-text)' }}>
        {loading ? '…' : fmt(value, unit)}
      </div>
    </div>
  );
}

function fmt(v: number | undefined | null, unit: string): string {
  if (v === undefined || v === null) return '-';
  return v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 }) + unit;
}
