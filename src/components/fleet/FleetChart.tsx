// Combined Fleet chart — overlays one curve per host (averaged across
// the host's GPUs) for each picked metric. Reuses uPlot like the
// Dashboard's LiveChart but with a much simpler config: a rolling
// 60s window, no history fetch, no thresholds.
//
// Reads from gpuStore.seriesByHost directly so every host's curve
// stays live independently of the Dashboard's selectedHostId.
//
// Two orthogonal pickers:
//   - metrics : multi-select (Temp / Util / Power). One mini-chart
//               per selected metric, stacked vertically. Mixing
//               metrics on a single chart wouldn't read well — their
//               units and ranges are unrelated.
//   - mode    : 'per-host' (one curve per host) or 'total' (one
//               aggregate curve = sum for power, max for temp,
//               avg for util).
//
// The legend (chips) is shared across every sub-chart: clicking a
// host toggles its visibility in ALL the active metric charts.

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore } from '../../store/gpuStore';
import { useHostsStore, type HostRecord } from '../../store/hostsStore';

type Metric = 'temperature' | 'utilization' | 'power';
type Mode = 'per-host' | 'total';

const HOST_PALETTE = [
  '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#34d399',
  '#fb7185', '#06b6d4', '#f97316', '#6366f1', '#14b8a6', '#ef4444',
];
const TOTAL_COLOR = '#2f7bff';
const WINDOW_POINTS = 60;

const METRIC_UNIT: Record<Metric, string> = {
  temperature: '°C',
  utilization: '%',
  power: 'W',
};

function buildHostSeries(
  hostId: string,
  metric: Metric,
  store: ReturnType<typeof useGpuStore.getState>,
): { times: number[]; values: number[] } {
  const seriesPerGpu = store.seriesByHost.get(hostId);
  if (!seriesPerGpu || seriesPerGpu.size === 0) return { times: [], values: [] };
  const first = seriesPerGpu.values().next().value;
  if (!first) return { times: [], values: [] };
  const times = first.t.slice(-WINDOW_POINTS);
  const sums: number[] = new Array(times.length).fill(0);
  const counts: number[] = new Array(times.length).fill(0);
  for (const s of seriesPerGpu.values()) {
    const arr = (metric === 'temperature' ? s.temperature
      : metric === 'utilization' ? s.utilization
      : s.power).slice(-WINDOW_POINTS);
    const offset = times.length - arr.length;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null || v === undefined) continue;
      sums[i + offset] += v;
      counts[i + offset] += 1;
    }
  }
  return { times, values: sums.map((s, i) => (counts[i] === 0 ? 0 : s / counts[i])) };
}

function aggregateForTotal(
  perHost: Array<{ times: number[]; values: number[] }>,
  metric: Metric,
): { times: number[]; values: number[] } {
  const tSet = new Set<number>();
  for (const p of perHost) for (const t of p.times) tSet.add(t);
  const sortedT = Array.from(tSet).sort((a, b) => a - b).slice(-WINDOW_POINTS);
  const values = sortedT.map((t) => {
    let sum = 0, max = -Infinity, count = 0;
    for (const p of perHost) {
      const idx = p.times.indexOf(t);
      if (idx < 0) continue;
      const v = p.values[idx];
      sum += v;
      if (v > max) max = v;
      count++;
    }
    if (count === 0) return 0;
    if (metric === 'power') return sum;
    if (metric === 'temperature') return max;
    return sum / count;
  });
  return { times: sortedT, values };
}

export default function FleetChart() {
  const { t } = useTranslation();
  const hosts = useHostsStore((s) => s.hosts);
  // Default: temperature only. The user toggles more in.
  const [metrics, setMetrics] = useState<Set<Metric>>(() => new Set(['temperature']));
  const [mode, setMode] = useState<Mode>('per-host');
  const [hiddenHosts, setHiddenHosts] = useState<Set<string>>(() => new Set());

  const hostsToPlot = useMemo<HostRecord[]>(
    () => hosts.slice(0, HOST_PALETTE.length),
    [hosts],
  );

  if (hostsToPlot.length === 0) return null;

  // Never allow ALL metrics off — keep at least the last one toggled.
  const toggleMetric = (m: Metric) => {
    setMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        if (next.size === 1) return prev; // keep at least one
        next.delete(m);
      } else {
        next.add(m);
      }
      return next;
    });
  };

  const toggleHost = (id: string) => {
    setHiddenHosts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeMetrics: Metric[] = ['temperature', 'utilization', 'power'].filter(
    (m) => metrics.has(m as Metric),
  ) as Metric[];

  const aggHint = (m: Metric) =>
    m === 'power' ? 'sum'
      : m === 'temperature' ? 'max'
      : 'avg';

  return (
    <section className="card p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold text-sm">
          {mode === 'total' ? t('fleet.combined_chart_title_total_multi') : t('fleet.combined_chart_title')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {/* Multi-select metric chips — aria-pressed pattern, click to toggle. */}
          <div className="seg" role="group" aria-label={t('fleet.metrics_label')}>
            {(['temperature', 'utilization', 'power'] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                className="seg-btn text-xs"
                aria-pressed={metrics.has(m)}
                onClick={() => toggleMetric(m)}
                title={metrics.has(m) ? t('fleet.metric_hide', { metric: t(`dashboard.metrics.${m}`) }) : t('fleet.metric_show', { metric: t(`dashboard.metrics.${m}`) })}
              >
                {t(`dashboard.metrics.${m}`)}
              </button>
            ))}
          </div>
          <div className="seg" role="group">
            <button type="button" className="seg-btn text-xs" aria-pressed={mode === 'per-host'} onClick={() => setMode('per-host')}>
              {t('fleet.mode_per_host')}
            </button>
            <button type="button" className="seg-btn text-xs" aria-pressed={mode === 'total'} onClick={() => setMode('total')}>
              {t('fleet.mode_total')}
            </button>
          </div>
        </div>
      </header>

      {/* One sub-chart per active metric. They share the host palette
          + hidden-hosts set, so toggling a host in the legend hides
          it on every chart at once. */}
      <div className="flex flex-col gap-3">
        {activeMetrics.map((m) => (
          <MetricChart
            key={m}
            metric={m}
            mode={mode}
            hostsToPlot={hostsToPlot}
            hiddenHosts={hiddenHosts}
          />
        ))}
      </div>

      {/* Shared legend at the bottom. In total mode the chips become
          a single aggregate descriptor. */}
      {mode === 'per-host' ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
          {hostsToPlot.map((h, i) => {
            const hidden = hiddenHosts.has(h.id);
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => toggleHost(h.id)}
                className="inline-flex items-center gap-1.5 transition-opacity"
                style={{
                  color: 'var(--gv-text-muted)',
                  opacity: hidden ? 0.4 : 1,
                  textDecoration: hidden ? 'line-through' : 'none',
                }}
                title={hidden ? t('fleet.legend_show', { label: h.label }) : t('fleet.legend_hide', { label: h.label })}
              >
                <span
                  className="inline-block w-3 h-1 rounded-full"
                  style={{ background: HOST_PALETTE[i % HOST_PALETTE.length] }}
                />
                {h.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 text-xs" style={{ color: 'var(--gv-text-muted)' }}>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-1 rounded-full" style={{ background: TOTAL_COLOR }} />
            {t('fleet.legend_total')}
          </span>
          {activeMetrics.map((m) => (
            <span key={m} className="font-mono" style={{ color: 'var(--gv-text-dim)' }}>
              {t(`dashboard.metrics.${m}`)} = {aggHint(m)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

interface MetricChartProps {
  metric: Metric;
  mode: Mode;
  hostsToPlot: HostRecord[];
  hiddenHosts: Set<string>;
}

function MetricChart({ metric, mode, hostsToPlot, hiddenHosts }: Readonly<MetricChartProps>) {
  const { t } = useTranslation();
  const seriesVersion = useGpuStore((s) => s.latestByHost);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  const { data, plottedHosts } = useMemo<{ data: AlignedData; plottedHosts: HostRecord[] }>(() => {
    const store = useGpuStore.getState();
    const allPerHost = hostsToPlot.map((h) => buildHostSeries(h.id, metric, store));

    if (mode === 'total') {
      const agg = aggregateForTotal(allPerHost, metric);
      return { data: [agg.times, agg.values] as AlignedData, plottedHosts: [] };
    }

    const visible = hostsToPlot.filter((h) => !hiddenHosts.has(h.id));
    const visiblePerHost = visible.map((h) => {
      const i = hostsToPlot.findIndex((x) => x.id === h.id);
      return allPerHost[i];
    });
    const tSet = new Set<number>();
    for (const p of visiblePerHost) for (const t of p.times) tSet.add(t);
    const sortedT = Array.from(tSet).sort((a, b) => a - b).slice(-WINDOW_POINTS);
    const ySeries: (number | null)[][] = visiblePerHost.map((p) => {
      const map = new Map<number, number>();
      for (let i = 0; i < p.times.length; i++) map.set(p.times[i], p.values[i]);
      return sortedT.map((t) => (map.has(t) ? (map.get(t) as number) : null));
    });
    return { data: [sortedT, ...ySeries] as AlignedData, plottedHosts: visible };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsToPlot, metric, mode, hiddenHosts, seriesVersion]);

  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const series: uPlot.Series[] = [{}];
    if (mode === 'total') {
      series.push({
        label: t(`dashboard.metrics.${metric}`),
        stroke: TOTAL_COLOR,
        width: 2,
        points: { show: false },
      });
    } else {
      for (const h of plottedHosts) {
        const colorIdx = hostsToPlot.findIndex((x) => x.id === h.id);
        series.push({
          label: h.label,
          stroke: HOST_PALETTE[colorIdx % HOST_PALETTE.length],
          width: 1.5,
          points: { show: false },
        });
      }
    }

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 180,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        { stroke: 'rgba(148,163,184,0.6)', grid: { stroke: 'rgba(148,163,184,0.08)' } },
        {
          stroke: 'rgba(148,163,184,0.6)',
          grid: { stroke: 'rgba(148,163,184,0.08)' },
          values: (_u, vals) => vals.map((v) => `${Math.round(v)}${METRIC_UNIT[metric]}`),
        },
      ],
      series,
    };

    plotRef.current = new uPlot(opts, data, containerRef.current);

    const onResize = () => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 180 });
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, metric, plottedHosts.length, plottedHosts.map((h) => h.id).join(',')]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wider flex items-center justify-between" style={{ color: 'var(--gv-text-dim)' }}>
        <span>{t(`dashboard.metrics.${metric}`)}</span>
        <span className="font-mono">{METRIC_UNIT[metric]}</span>
      </div>
      <div ref={containerRef} className="w-full" style={{ minHeight: 180 }} />
    </div>
  );
}
