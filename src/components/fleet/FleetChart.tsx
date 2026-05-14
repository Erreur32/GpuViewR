// Combined Fleet chart — overlays one curve per host (averaged across
// the host's GPUs) for the picked metric. Reuses uPlot like the
// Dashboard's LiveChart but with a much simpler config: a rolling
// 60s window, no history fetch, no thresholds, no per-curve toggles.
//
// Reads from gpuStore.seriesByHost directly so every host's curve
// stays live independently of the Dashboard's selectedHostId.
//
// Two view modes:
//   - per-host  : one curve per host (default)
//   - total     : single curve aggregating the whole fleet
//                 (sum for power, max for temperature, avg for util)
//
// Clicking a legend chip in per-host mode toggles that host's curve
// without rebuilding the plot.

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore } from '../../store/gpuStore';
import { useHostsStore, type HostRecord } from '../../store/hostsStore';

type Metric = 'temperature' | 'utilization' | 'power';
type Mode = 'per-host' | 'total';

// 12-step palette — host curves cycle through it. Order matches the
// HSL distance so two adjacent enrollments don't pick neighbours.
const HOST_PALETTE = [
  '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#34d399',
  '#fb7185', '#06b6d4', '#f97316', '#6366f1', '#14b8a6', '#ef4444',
];
const TOTAL_COLOR = '#2f7bff';

const WINDOW_POINTS = 60; // ~1 min at 1Hz

/** Average a metric across one host's GPUs at each tick, returning a
 *  fixed-length array of WINDOW_POINTS values (newest at the end). */
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

  const values = sums.map((s, i) => (counts[i] === 0 ? 0 : s / counts[i]));
  return { times, values };
}

const METRIC_UNIT: Record<Metric, string> = {
  temperature: '°C',
  utilization: '%',
  power: 'W',
};

/** Aggregate per-host series into one fleet-wide curve. Domain choice:
 *  - power      → sum (total fleet wattage)
 *  - temperature → max (hottest GPU on the hottest host)
 *  - utilization → average (mean GPU load across the fleet) */
function aggregateForTotal(
  perHost: Array<{ times: number[]; values: number[] }>,
  metric: Metric,
): { times: number[]; values: number[] } {
  const tSet = new Set<number>();
  for (const p of perHost) for (const t of p.times) tSet.add(t);
  const sortedT = Array.from(tSet).sort((a, b) => a - b).slice(-WINDOW_POINTS);

  const values = sortedT.map((t) => {
    let sum = 0;
    let max = -Infinity;
    let count = 0;
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
    return sum / count; // utilization
  });

  return { times: sortedT, values };
}

export default function FleetChart() {
  const { t } = useTranslation();
  const hosts = useHostsStore((s) => s.hosts);
  const seriesVersion = useGpuStore((s) => s.latestByHost);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [metric, setMetric] = useState<Metric>('temperature');
  const [mode, setMode] = useState<Mode>('per-host');
  // Per-host visibility — clicking a legend chip toggles. Always-true
  // until the user explicitly hides one, so adding a new host doesn't
  // require any state migration.
  const [hiddenHosts, setHiddenHosts] = useState<Set<string>>(() => new Set());

  const hostsToPlot = useMemo<HostRecord[]>(
    () => hosts.slice(0, HOST_PALETTE.length),
    [hosts],
  );

  // Build data: when mode='total', one aggregate Y series; when
  // mode='per-host', one Y series per visible host.
  const { data, plottedHosts } = useMemo<{
    data: AlignedData;
    plottedHosts: HostRecord[];
  }>(() => {
    const store = useGpuStore.getState();
    const allPerHost = hostsToPlot.map((h) => buildHostSeries(h.id, metric, store));

    if (mode === 'total') {
      const agg = aggregateForTotal(allPerHost, metric);
      return { data: [agg.times, agg.values] as AlignedData, plottedHosts: [] };
    }

    // per-host: only emit curves for hosts the user hasn't hidden.
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

  // Build / rebuild plot when the set of plotted series changes (host
  // count, mode flip, or visibility toggle).
  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const series: uPlot.Series[] = [{}];
    if (mode === 'total') {
      series.push({
        label: t('fleet.legend_total'),
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
      height: 240,
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
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 240 });
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

  if (hostsToPlot.length === 0) return null;

  const toggleHost = (id: string) => {
    setHiddenHosts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Mode is conceptually orthogonal to "which hosts are visible" — when
  // we're in total mode, the legend just shows a single aggregate chip.
  return (
    <section className="card p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold text-sm">
          {mode === 'total'
            ? t('fleet.combined_chart_title_total', { metric: t(`dashboard.metrics.${metric === 'temperature' ? 'temperature' : metric === 'utilization' ? 'utilization' : 'power'}`) })
            : t('fleet.combined_chart_title')}
        </h2>
        <div className="flex flex-wrap gap-2">
          <div className="seg" role="group">
            <button type="button" className="seg-btn text-xs" aria-pressed={metric === 'temperature'} onClick={() => setMetric('temperature')}>
              {t('dashboard.metrics.temperature')}
            </button>
            <button type="button" className="seg-btn text-xs" aria-pressed={metric === 'utilization'} onClick={() => setMetric('utilization')}>
              {t('dashboard.metrics.utilization')}
            </button>
            <button type="button" className="seg-btn text-xs" aria-pressed={metric === 'power'} onClick={() => setMetric('power')}>
              {t('dashboard.metrics.power')}
            </button>
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

      <div ref={containerRef} className="w-full" style={{ minHeight: 240 }} />

      {/* Interactive legend — clicking a chip in per-host mode toggles
          that host's visibility without rebuilding the plot. In total
          mode the legend collapses to a single aggregate chip. */}
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
        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--gv-text-muted)' }}>
          <span className="inline-block w-3 h-1 rounded-full" style={{ background: TOTAL_COLOR }} />
          {t('fleet.legend_total_hint', { mode: metric === 'power' ? 'sum' : metric === 'temperature' ? 'max' : 'avg' })}
        </div>
      )}
    </section>
  );
}
