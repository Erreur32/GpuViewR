import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, MemoryStick, Zap } from 'lucide-react';
import { api } from '../../lib/api';
import { useUiStore } from '../../store/uiStore';
import { useGpuStore } from '../../store/gpuStore';

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
  const latestEpoch = useGpuStore((s) => s.latest.get(gpuIndex)?.timestamp_epoch);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-fetch when gpu/range changes, AND poll every 5 s so the cards stay
  // in sync with the live samples flushed to SQLite by the collector.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLoading(true);
      api<StatsResponse>(`/gpu/stats?gpu=${gpuIndex}&range=${range}`)
        .then((r) => { if (!cancelled) setData(r); })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    load();
    const id = setInterval(load, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [gpuIndex, range]);

  // The collector flushes its 1-Hz buffer to SQLite once a minute, so the
  // /api/gpu/stats numbers can lag the live gauges. We blend the latest live
  // sample into min/max so the user never sees a "frozen" max while temp keeps
  // climbing on the gauges.
  const live = useGpuStore((s) => s.latest.get(gpuIndex));
  const blend = (db: number | undefined | null, current: number | undefined | null, kind: 'min' | 'max'): number | undefined | null => {
    if (current === undefined || current === null) return db;
    if (db === undefined || db === null) return current;
    return kind === 'min' ? Math.min(db, current) : Math.max(db, current);
  };

  const s = data?.stats ?? null;
  const liveMemPct = live?.memory_total ? (live.memory_used / live.memory_total) * 100 : undefined;
  // We pass the blended values to the rows below; epoch is referenced just so
  // React re-renders this component on every WebSocket tick.
  void latestEpoch;
  const rows = [
    {
      key: 'temperature',
      icon: <Thermometer className="w-4 h-4" />, color: 'var(--gv-warn)', unit: '°C',
      min: blend(s?.temp_min, live?.temperature, 'min'),
      max: blend(s?.temp_max, live?.temperature, 'max'),
      avg: s?.temp_avg ?? live?.temperature,
    },
    {
      key: 'utilization',
      icon: <Activity className="w-4 h-4" />, color: 'var(--gv-accent)', unit: '%',
      min: blend(s?.util_min, live?.utilization, 'min'),
      max: blend(s?.util_max, live?.utilization, 'max'),
      avg: s?.util_avg ?? live?.utilization,
    },
    {
      key: 'memory',
      icon: <MemoryStick className="w-4 h-4" />, color: 'var(--gv-info)', unit: ' MiB',
      min: blend(s?.mem_min, live?.memory_used, 'min'),
      max: blend(s?.mem_max, live?.memory_used, 'max'),
      avg: s?.mem_avg ?? live?.memory_used,
    },
    {
      key: 'power',
      icon: <Zap className="w-4 h-4" />, color: 'var(--gv-ok)', unit: ' W',
      min: blend(s?.pow_min, live?.power, 'min'),
      max: blend(s?.pow_max, live?.power, 'max'),
      avg: s?.pow_avg ?? live?.power,
    },
  ];
  void liveMemPct; // reserved if we add a "% memory" row later

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
