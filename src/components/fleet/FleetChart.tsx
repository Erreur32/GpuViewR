// Single combined chart for the Hosts page. Always renders one uPlot
// with multi-axis Y (% for util+temp, W for power) — the older design
// stacked one sub-chart per metric, which was confusing because the
// metric chips appeared to *add* graphs instead of toggling series.
//
// Modes:
//   - per-host : one curve per (visible metric × visible host).
//                Colour = metric, stroke pattern (dash) = host so the
//                three metrics stay visually consistent across the
//                page (util is always blue, temp always orange, etc.).
//   - total    : one curve per visible metric, aggregated across the
//                fleet (avg util, max temp, sum power). No host
//                distinction.
//
// Chips:
//   - metric (top right) : show/hide that metric's series — always
//                          keeps at least one metric visible.
//   - host   (below plot, per-host mode only) : show/hide that host's
//                          curves across every active metric at once.

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore, type HistoryRow } from '../../store/gpuStore';
import { useHostsStore, type HostRecord } from '../../store/hostsStore';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/time';
import RangeSelector from '../dashboard/RangeSelector';

type Metric = 'temperature' | 'utilization' | 'power';
type Mode = 'per-host' | 'total';

const METRICS: readonly Metric[] = ['utilization', 'temperature', 'power'] as const;

// Build the metric → colour map from the user's chartColors store
// (the same source the Dashboard's LiveChart reads). Falls back to
// CSS theme variables so a user who hasn't touched the picker still
// gets sensible defaults that move with the active theme. Keeping the
// fallback chain in one place avoids the FleetChart and LiveChart
// drifting apart again. Returns string keys for util/temp/pow that
// match the ChartSeriesKey contract in uiStore.ts.
function metricColors(chartColors: { util?: string; temp?: string; pow?: string }): Record<Metric, string> {
  const root = typeof globalThis.window === 'object'
    ? getComputedStyle(globalThis.document.documentElement)
    : null;
  const cssVar = (name: string, fallback: string): string =>
    (root?.getPropertyValue(name).trim() || fallback);
  return {
    utilization: chartColors.util ?? cssVar('--gv-accent', '#6366f1'),
    temperature: chartColors.temp ?? cssVar('--gv-warn', '#a855f7'),
    power:       chartColors.pow  ?? cssVar('--gv-ok',     '#3b82f6'),
  };
}

const METRIC_SCALE: Record<Metric, '%' | 'W'> = {
  utilization: '%',
  temperature: '%',
  power: 'W',
};

const METRIC_AGGREGATION: Record<Metric, 'sum' | 'max' | 'avg'> = {
  power: 'sum',
  temperature: 'max',
  utilization: 'avg',
};

// uPlot dash arrays — one per host index. Above HOST_DASH.length we
// repeat patterns; in practice nobody runs a >6-host fleet through a
// single dashboard chart legibly. Solid for host 0 keeps the most
// common (single-host) case clean-looking.
const HOST_DASH: number[][] = [
  [],          // 0: solid
  [6, 4],      // 1: long-dash
  [2, 3],      // 2: dotted
  [8, 4, 2, 4],// 3: dash-dot
  [4, 2],      // 4: short-dash
  [10, 4, 2, 4, 2, 4], // 5: dash-dot-dot
];

const WINDOW_POINTS = 60;

function pickMetricArray(
  series: { temperature: readonly number[]; utilization: readonly (number | null)[]; power: readonly number[] },
  metric: Metric,
): readonly (number | null)[] {
  if (metric === 'temperature') return series.temperature;
  if (metric === 'utilization') return series.utilization;
  return series.power;
}

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
    const arr = pickMetricArray(s, metric).slice(-WINDOW_POINTS);
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

function metricFromHistory(row: HistoryRow, metric: Metric): number | null {
  if (metric === 'temperature') return row.temperature;
  if (metric === 'utilization') return row.utilization;
  return row.power;
}

async function fetchHostHistory(
  hostId: string,
  gpuIndices: number[],
  metric: Metric,
  range: string,
): Promise<{ times: number[]; values: number[] }> {
  if (gpuIndices.length === 0) return { times: [], values: [] };
  const fetches = gpuIndices.map((gpu) =>
    api<{ history: HistoryRow[] }>(`/gpu/history?host=${encodeURIComponent(hostId)}&gpu=${gpu}&range=${range}`)
      .then((r) => r.history)
      .catch(() => [] as HistoryRow[]),
  );
  const allHistories = await Promise.all(fetches);
  const tSet = new Set<number>();
  for (const rows of allHistories) for (const r of rows) tSet.add(r.timestamp_epoch);
  const sortedT = Array.from(tSet).sort((a, b) => a - b);
  const sums: number[] = new Array(sortedT.length).fill(0);
  const counts: number[] = new Array(sortedT.length).fill(0);
  for (const rows of allHistories) {
    const map = new Map<number, HistoryRow>();
    for (const r of rows) map.set(r.timestamp_epoch, r);
    for (let i = 0; i < sortedT.length; i++) {
      const r = map.get(sortedT[i]);
      if (!r) continue;
      const v = metricFromHistory(r, metric);
      if (v === null || v === undefined) continue;
      sums[i] += v;
      counts[i] += 1;
    }
  }
  return {
    times: sortedT,
    values: sums.map((s, i) => (counts[i] === 0 ? 0 : s / counts[i])),
  };
}

interface SeriesEntry {
  key: string;
  metric: Metric;
  host: HostRecord | null;
  hostIdx: number;
  data: { times: number[]; values: number[] };
}

export default function FleetChart() {
  const { t } = useTranslation();
  const hosts = useHostsStore((s) => s.hosts);
  const range = useUiStore((s) => s.range);
  const chartColors = useUiStore((s) => s.chartColors);
  const seriesVersion = useGpuStore((s) => s.latestByHost);

  // Memoised so the JSX below can read METRIC_COLOR[m] like before
  // without rebuilding the map on every nested chip/label render.
  // Re-derives when the user changes a preset in Settings → Charts.
  const METRIC_COLOR = useMemo(() => metricColors(chartColors), [chartColors]);

  // Default: all three metrics on at once — that's the whole point of
  // the multi-axis chart. Users who want a single metric uncheck the
  // other two.
  const [metrics, setMetrics] = useState<Set<Metric>>(() => new Set(METRICS));
  const [mode, setMode] = useState<Mode>('per-host');
  const [hiddenHosts, setHiddenHosts] = useState<Set<string>>(() => new Set());

  // History cache for non-live ranges. Outer key = metric, inner array
  // is per-host (parallel to hostsToPlot).
  const [historyByMetric, setHistoryByMetric] = useState<Record<Metric, { times: number[]; values: number[] }[]> | null>(null);
  const [loading, setLoading] = useState(false);

  const hostsToPlot = useMemo<HostRecord[]>(() => hosts.slice(0, 12), [hosts]);

  // Hosts that have actually pushed samples since the page loaded.
  // /api/hosts returns rows in enrolled_at ASC order, so the local hub
  // (created at first boot) is almost always hostsToPlot[0] — and on
  // hub-only deployments it never receives samples. Without this split
  // the local row "burns" the solid-line slot, leaving its curve
  // invisible while still appearing in the legend.
  //
  // We keep hostsToPlot for the legend (the user must see every
  // enrolled host so they understand the missing data) but drive the
  // chart off this filtered list so the dash patterns assign sensibly:
  // first-with-data → solid, second → long-dash, etc.
  const seriesByHost = useGpuStore((s) => s.seriesByHost);
  const hostsWithData = useMemo<HostRecord[]>(() => {
    if (range !== 'live') return hostsToPlot;
    return hostsToPlot.filter((h) => {
      const series = seriesByHost.get(h.id);
      return series !== undefined && series.size > 0;
    });
  }, [hostsToPlot, seriesByHost, range]);

  useEffect(() => {
    if (range === 'live') {
      setHistoryByMetric(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const store = useGpuStore.getState();
    const fetchAll = async () => {
      const out = {} as Record<Metric, { times: number[]; values: number[] }[]>;
      for (const m of METRICS) {
        const fetches = hostsToPlot.map((h) => {
          const samples = store.latestByHost.get(h.id);
          const gpuIndices = samples ? Array.from(samples.keys()) : [0];
          return fetchHostHistory(h.id, gpuIndices, m, range);
        });
        out[m] = await Promise.all(fetches);
      }
      return out;
    };
    fetchAll()
      .then((all) => { if (!cancelled) setHistoryByMetric(all); })
      .catch(() => { if (!cancelled) setHistoryByMetric(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, hostsToPlot.map((h) => h.id).join(',')]);

  const activeMetrics = useMemo<Metric[]>(
    () => METRICS.filter((m) => metrics.has(m)),
    [metrics],
  );

  // Build the flat list of series to plot. Per-host mode produces
  // metric × visibleHostWithData entries; total mode produces one per
  // metric aggregated across hostsWithData.
  const entries = useMemo<SeriesEntry[]>(() => {
    const store = useGpuStore.getState();
    const visibleHostsWithData = hostsWithData.filter((h) => !hiddenHosts.has(h.id));
    const out: SeriesEntry[] = [];
    for (const m of activeMetrics) {
      const perHost = (range === 'live' || historyByMetric === null)
        ? hostsWithData.map((h) => buildHostSeries(h.id, m, store))
        : (() => {
            // historyByMetric is indexed against hostsToPlot, not
            // hostsWithData. Project it down by mapping each
            // hostsWithData index → its hostsToPlot index.
            const hb = historyByMetric[m] ?? [];
            return hostsWithData.map((h) => {
              const fullIdx = hostsToPlot.findIndex((x) => x.id === h.id);
              return hb[fullIdx] ?? { times: [], values: [] };
            });
          })();
      if (mode === 'total') {
        out.push({
          key: `total-${m}`,
          metric: m,
          host: null,
          hostIdx: 0,
          data: aggregateForTotal(perHost, m),
        });
        continue;
      }
      for (const h of visibleHostsWithData) {
        const idx = hostsWithData.findIndex((x) => x.id === h.id);
        out.push({
          key: `${h.id}-${m}`,
          metric: m,
          host: h,
          hostIdx: idx,
          data: perHost[idx] ?? { times: [], values: [] },
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsToPlot, hostsWithData, mode, hiddenHosts, activeMetrics, seriesVersion, range, historyByMetric]);

  const data = useMemo<AlignedData>(() => {
    if (entries.length === 0) return [[]] as AlignedData;
    const tSet = new Set<number>();
    for (const e of entries) for (const t of e.data.times) tSet.add(t);
    let sortedT = Array.from(tSet).sort((a, b) => a - b);
    if (range === 'live') sortedT = sortedT.slice(-WINDOW_POINTS);
    const ySeries = entries.map((e) => {
      const map = new Map<number, number>();
      for (let i = 0; i < e.data.times.length; i++) map.set(e.data.times[i], e.data.values[i]);
      return sortedT.map((t) => map.get(t) ?? null);
    });
    return [sortedT, ...ySeries] as AlignedData;
  }, [entries, range]);

  if (hostsToPlot.length === 0) return null;

  // Never allow ALL metrics off — keep at least the last one visible.
  const toggleMetric = (m: Metric) => {
    setMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        if (next.size === 1) return prev;
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

  return (
    <section className="card p-4 flex flex-col gap-3">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold text-sm inline-flex items-center gap-2">
          {mode === 'total' ? t('fleet.combined_chart_title_total_multi') : t('fleet.combined_chart_title')}
          {mode === 'total' && hostsToPlot.length > 0 && (
            <span
              className="text-[10px] font-normal font-mono px-1.5 py-0.5 rounded-md"
              style={{ background: 'var(--gv-surface-alt)', color: 'var(--gv-text-dim)' }}
              title={t('fleet.total_hosts_count_help')}
            >
              {t('fleet.total_hosts_count', { n: hostsWithData.length, m: hostsToPlot.length })}
            </span>
          )}
          {loading && (
            <span className="text-[10px] font-normal" style={{ color: 'var(--gv-text-dim)' }}>
              {t('common.loading')}
            </span>
          )}
        </h2>
        <div className="flex flex-wrap gap-2">
          <div className="seg" role="toolbar" aria-label={t('fleet.metrics_label')}>
            {METRICS.map((m) => (
              <button
                key={m}
                type="button"
                className="seg-btn text-xs inline-flex items-center gap-1.5"
                aria-pressed={metrics.has(m)}
                onClick={() => toggleMetric(m)}
                title={metrics.has(m)
                  ? t('fleet.metric_hide', { metric: t(`dashboard.metrics.${m}`) })
                  : t('fleet.metric_show', { metric: t(`dashboard.metrics.${m}`) })}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{
                    background: metrics.has(m) ? METRIC_COLOR[m] : 'transparent',
                    border: `1px solid ${METRIC_COLOR[m]}`,
                  }}
                />
                {t(`dashboard.metrics.${m}`)}
              </button>
            ))}
          </div>
          <div className="seg" role="toolbar" aria-label={t('fleet.mode_label')}>
            <button type="button" className="seg-btn text-xs" aria-pressed={mode === 'per-host'} onClick={() => setMode('per-host')}>
              {t('fleet.mode_per_host')}
            </button>
            <button type="button" className="seg-btn text-xs" aria-pressed={mode === 'total'} onClick={() => setMode('total')}>
              {t('fleet.mode_total')}
            </button>
          </div>
          <RangeSelector />
        </div>
      </header>

      <ChartPlot entries={entries} data={data} metricColor={METRIC_COLOR} />

      {/* Legend: host chips when per-host mode (toggle each host across
          all visible metrics at once). We render EVERY enrolled host —
          including those without live samples — so the admin sees at a
          glance which row is "missing" data. The dash swatch only
          matches the chart pattern for hosts that actually draw a
          curve (i.e. are in hostsWithData); empty hosts get a muted
          "no data" pill so the legend stays honest about what's drawn.
          Total mode keeps the per-metric aggregation hint per metric. */}
      {mode === 'per-host' ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
          {hostsToPlot.map((h) => {
            const hidden = hiddenHosts.has(h.id);
            const dataIdx = hostsWithData.findIndex((x) => x.id === h.id);
            const hasData = dataIdx >= 0;
            const dash = hasData ? HOST_DASH[dataIdx % HOST_DASH.length] : [];
            const titleKey = hasData
              ? (hidden ? 'fleet.legend_show' : 'fleet.legend_hide')
              : 'fleet.legend_no_data';
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => { if (hasData) toggleHost(h.id); }}
                disabled={!hasData}
                className="inline-flex items-center gap-1.5 transition-opacity"
                style={{
                  color: 'var(--gv-text-muted)',
                  opacity: !hasData ? 0.45 : (hidden ? 0.4 : 1),
                  textDecoration: hidden ? 'line-through' : 'none',
                  cursor: hasData ? 'pointer' : 'not-allowed',
                }}
                title={t(titleKey, { label: h.label })}
              >
                <HostDashSwatch dash={dash} />
                {h.label}
                {!hasData && (
                  <span
                    className="ml-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono"
                    style={{
                      background: 'var(--gv-surface-alt)',
                      color: 'var(--gv-text-dim)',
                    }}
                  >
                    {t('fleet.legend_no_data_badge')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 text-xs" style={{ color: 'var(--gv-text-muted)' }}>
          {activeMetrics.map((m) => (
            <span key={m} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-1 rounded-full"
                style={{ background: METRIC_COLOR[m] }}
              />
              {t(`dashboard.metrics.${m}`)}
              <span className="font-mono" style={{ color: 'var(--gv-text-dim)' }}>
                ({METRIC_AGGREGATION[m]})
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// Inline SVG matching the line dash pattern, so each host's swatch in
// the legend visually matches its curve. 32×4 with stroke-dasharray
// scaled to roughly look like the uPlot dash at chart resolution.
function HostDashSwatch({ dash }: Readonly<{ dash: number[] }>) {
  const dasharray = dash.length === 0 ? undefined : dash.join(',');
  return (
    <svg width="20" height="4" aria-hidden="true">
      <line
        x1="0"
        y1="2"
        x2="20"
        y2="2"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={dasharray}
      />
    </svg>
  );
}

interface ChartPlotProps {
  entries: SeriesEntry[];
  data: AlignedData;
  metricColor: Record<Metric, string>;
}

interface CursorState {
  t: number | null;
  // Values per entry index, parallel to `entries`. null when the cursor
  // is outside the chart or the series has no point at that index.
  values: (number | null)[];
}

interface TipState {
  left: number;
  top: number;
  flipX: boolean;
  flipY: boolean;
  show: boolean;
}

const EMPTY_TIP: TipState = { left: 0, top: 0, flipX: false, flipY: false, show: false };

function metricUnit(metric: Metric): string {
  if (metric === 'temperature') return '°C';
  if (metric === 'power') return 'W';
  return '%';
}

function fmtValue(v: number | null, unit: string): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return unit === 'W' ? `${Math.round(v)} ${unit}` : `${Math.round(v)}${unit}`;
}

// Wraps the uPlot instance and rebuilds it whenever the series shape
// changes (entries' key list). Data-only updates use setData for
// efficiency. The cursor-following tooltip is a portal-free absolute
// div, positioned via the setCursor hook so all visible series values
// at the hovered x show up at once.
function ChartPlot({ entries, data, metricColor }: Readonly<ChartPlotProps>) {
  const { t } = useTranslation();
  const timeFormat = useUiStore((s) => s.timeFormat);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const entriesRef = useRef<SeriesEntry[]>(entries);
  entriesRef.current = entries;

  const [cursor, setCursor] = useState<CursorState>({ t: null, values: [] });
  const [tip, setTip] = useState<TipState>(EMPTY_TIP);

  // React's hook deps want a stable primitive — the entries' key joined
  // captures both the count AND the order of series, which is what
  // triggers a uPlot rebuild. We append the metric-colour signature so
  // a Settings → Chart palette change also rebuilds the uPlot (its
  // stroke colours are baked into the series defs and can't be updated
  // in place without destroy + recreate).
  const colorSig = `${metricColor.utilization}|${metricColor.temperature}|${metricColor.power}`;
  const seriesShape = `${entries.map((e) => e.key).join('|')}#${colorSig}`;

  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const seriesDefs: uPlot.Series[] = [{}];
    for (const e of entries) {
      const dash = HOST_DASH[e.hostIdx % HOST_DASH.length];
      const metricLabel = t(`dashboard.metrics.${e.metric}`);
      const label = e.host ? `${e.host.label} · ${metricLabel}` : metricLabel;
      seriesDefs.push({
        label,
        stroke: metricColor[e.metric],
        width: e.host ? 1.5 : 2,
        scale: METRIC_SCALE[e.metric],
        dash: dash.length > 0 ? dash : undefined,
        points: { show: false },
      });
    }

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 240,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: {
        x: { time: true },
        '%': { auto: false, range: [0, 100] },
        W: { auto: true },
      },
      axes: [
        { stroke: 'rgba(148,163,184,0.6)', grid: { stroke: 'rgba(148,163,184,0.08)' } },
        {
          stroke: 'rgba(148,163,184,0.6)',
          grid: { stroke: 'rgba(148,163,184,0.08)' },
          scale: '%',
          values: (_u, vals) => vals.map((v) => `${v}%`),
        },
        {
          side: 1,
          stroke: 'rgba(148,163,184,0.6)',
          grid: { show: false },
          scale: 'W',
          values: (_u, vals) => vals.map((v) => `${Math.round(v)} W`),
        },
      ],
      series: seriesDefs,
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const left = u.cursor.left ?? -1;
            const top = u.cursor.top ?? -1;
            if (idx === null || idx === undefined || left < 0 || top < 0) {
              setCursor({ t: null, values: [] });
              setTip((prev) => (prev.show ? { ...prev, show: false } : prev));
              return;
            }
            const ts = (u.data[0]?.[idx] as number | undefined) ?? null;
            // u.data[1..] is parallel to entriesRef.current; each entry's
            // value at the current index. null when the series has no
            // point at that x (sparse data, fresh hosts catching up).
            const values: (number | null)[] = entriesRef.current.map((_, i) => {
              const v = u.data[i + 1]?.[idx];
              return typeof v === 'number' && Number.isFinite(v) ? v : null;
            });
            setCursor({ t: ts, values });
            const w = u.over.clientWidth;
            setTip({
              left,
              top,
              flipX: left > w - 220,
              flipY: top < 120,
              show: true,
            });
          },
        ],
      },
    };

    plotRef.current = new uPlot(opts, data, containerRef.current);

    const onResize = () => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 240 });
      }
    };
    globalThis.addEventListener('resize', onResize);
    return () => {
      globalThis.removeEventListener('resize', onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesShape]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return (
    <div className="relative">
      <div ref={containerRef} className="w-full" style={{ minHeight: 240 }} />
      {tip.show && cursor.t !== null && entries.length > 0 && (
        <div
          className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md text-[11px] shadow-lg backdrop-blur-sm"
          style={{
            left: tip.left,
            top: tip.top,
            transform: `translate(${tip.flipX ? 'calc(-100% - 14px)' : '14px'}, ${tip.flipY ? '14px' : 'calc(-100% - 14px)'})`,
            background: 'color-mix(in srgb, var(--gv-surface) 92%, transparent)',
            border: '1px solid var(--gv-border)',
            color: 'var(--gv-text)',
            minWidth: 200,
            maxWidth: 320,
          }}
        >
          <div className="font-semibold tabular-nums mb-1" style={{ color: 'var(--gv-text-muted)' }}>
            {fmtDateTime(cursor.t, timeFormat)}
          </div>
          <div className="flex flex-col gap-0.5">
            {entries.map((e, i) => {
              const dash = HOST_DASH[e.hostIdx % HOST_DASH.length];
              const metricLabel = t(`dashboard.metrics.${e.metric}`);
              const label = e.host ? `${e.host.label} · ${metricLabel}` : metricLabel;
              return (
                <div key={e.key} className="flex items-center justify-between gap-3">
                  <span
                    className="inline-flex items-center gap-1.5 truncate"
                    style={{ color: metricColor[e.metric] }}
                  >
                    <svg width="14" height="4" aria-hidden="true">
                      <line
                        x1="0" y1="2" x2="14" y2="2"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray={dash.length === 0 ? undefined : dash.join(',')}
                      />
                    </svg>
                    <span className="truncate" style={{ color: 'var(--gv-text)' }}>{label}</span>
                  </span>
                  <span className="font-semibold tabular-nums shrink-0">
                    {fmtValue(cursor.values[i] ?? null, metricUnit(e.metric))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
