// Combined Fleet chart — overlays one curve per host (averaged across
// the host's GPUs) for the picked metric. Reuses uPlot like the
// Dashboard's LiveChart but with a much simpler config: a rolling
// 60s window, no history fetch, no thresholds, no per-curve toggles.
//
// Reads from gpuStore.seriesByHost directly so every host's curve
// stays live independently of the Dashboard's selectedHostId.

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore } from '../../store/gpuStore';
import { useHostsStore, type HostRecord } from '../../store/hostsStore';

type Metric = 'temperature' | 'utilization' | 'power';

// 12-step palette — host curves cycle through it. Order matches the
// HSL distance so two adjacent enrollments don't pick neighbours.
const HOST_PALETTE = [
  '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#34d399',
  '#fb7185', '#06b6d4', '#f97316', '#6366f1', '#14b8a6', '#ef4444',
];

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

  // All series for this host share the same timestamps (collector ticks
  // in lockstep). Pick the first as the reference t-axis.
  const first = seriesPerGpu.values().next().value;
  if (!first) return { times: [], values: [] };
  const times = first.t.slice(-WINDOW_POINTS);
  const sums: number[] = new Array(times.length).fill(0);
  const counts: number[] = new Array(times.length).fill(0);

  for (const s of seriesPerGpu.values()) {
    const arr = (metric === 'temperature' ? s.temperature
      : metric === 'utilization' ? s.utilization
      : s.power).slice(-WINDOW_POINTS);
    // Right-align in case GPUs have unequal sample lengths.
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

export default function FleetChart() {
  const { t } = useTranslation();
  const hosts = useHostsStore((s) => s.hosts);
  const seriesVersion = useGpuStore((s) => s.latestByHost); // re-renders on each ingest
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [metric, setMetric] = useState<Metric>('temperature');

  // Cap the host list to a sane number — past 12 the chart becomes
  // a rainbow blur. Take the most recently active ones first.
  const hostsToPlot = useMemo<HostRecord[]>(
    () => hosts.slice(0, HOST_PALETTE.length),
    [hosts],
  );

  // Build aligned data: one shared t-axis (the union of all hosts'
  // recent timestamps), one Y series per host (NaN where the host
  // didn't have a sample at that exact tick).
  const data = useMemo<AlignedData>(() => {
    const store = useGpuStore.getState();
    const perHost = hostsToPlot.map((h) => buildHostSeries(h.id, metric, store));
    const tSet = new Set<number>();
    for (const p of perHost) for (const t of p.times) tSet.add(t);
    const sortedT = Array.from(tSet).sort((a, b) => a - b).slice(-WINDOW_POINTS);

    const ySeries: (number | null)[][] = perHost.map((p) => {
      const map = new Map<number, number>();
      for (let i = 0; i < p.times.length; i++) map.set(p.times[i], p.values[i]);
      return sortedT.map((t) => (map.has(t) ? (map.get(t) as number) : null));
    });

    return [sortedT, ...ySeries] as AlignedData;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsToPlot, metric, seriesVersion]);

  // Build / rebuild plot when hosts list or metric change.
  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 240,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke: 'rgba(148,163,184,0.6)',
          grid: { stroke: 'rgba(148,163,184,0.08)' },
        },
        {
          stroke: 'rgba(148,163,184,0.6)',
          grid: { stroke: 'rgba(148,163,184,0.08)' },
          values: (_u, vals) => vals.map((v) => `${Math.round(v)}${METRIC_UNIT[metric]}`),
        },
      ],
      series: [
        {},
        ...hostsToPlot.map((h, i) => ({
          label: h.label,
          stroke: HOST_PALETTE[i % HOST_PALETTE.length],
          width: 1.5,
          points: { show: false },
        })),
      ],
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
  }, [hostsToPlot.length, metric]);

  // Live updates: feed new data without rebuilding the plot.
  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  if (hostsToPlot.length === 0) return null;

  return (
    <section className="card p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold text-sm">{t('fleet.combined_chart_title')}</h2>
        <div className="seg" role="group" aria-label={t('fleet.combined_chart_title')}>
          <button
            type="button"
            className="seg-btn text-xs"
            aria-pressed={metric === 'temperature'}
            onClick={() => setMetric('temperature')}
          >
            {t('dashboard.metrics.temperature')}
          </button>
          <button
            type="button"
            className="seg-btn text-xs"
            aria-pressed={metric === 'utilization'}
            onClick={() => setMetric('utilization')}
          >
            {t('dashboard.metrics.utilization')}
          </button>
          <button
            type="button"
            className="seg-btn text-xs"
            aria-pressed={metric === 'power'}
            onClick={() => setMetric('power')}
          >
            {t('dashboard.metrics.power')}
          </button>
        </div>
      </header>

      <div ref={containerRef} className="w-full" style={{ minHeight: 240 }} />

      {/* Manual legend — uPlot's built-in legend is too noisy in our
          card style. One chip per host with its colour and label. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {hostsToPlot.map((h, i) => (
          <span key={h.id} className="inline-flex items-center gap-1.5" style={{ color: 'var(--gv-text-muted)' }}>
            <span
              className="inline-block w-3 h-1 rounded-full"
              style={{ background: HOST_PALETTE[i % HOST_PALETTE.length] }}
            />
            {h.label}
          </span>
        ))}
      </div>
    </section>
  );
}
