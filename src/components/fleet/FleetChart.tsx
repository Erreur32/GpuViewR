// Single combined chart for the Hosts page. Always renders one uPlot
// with multi-axis Y (% for util+temp, W for power) — the older design
// stacked one sub-chart per metric, which was confusing because the
// metric chips appeared to *add* graphs instead of toggling series.
//
// One curve per (visible metric × visible host). Colour comes from a
// per-host palette base, SHADED per metric (utilization on the base
// hue, temperature ~18% lighter, power ~18% darker) so the three
// metrics for the same host read as a colour family. Line WIDTH adds
// a second axis of distinction: utilization thickest, temperature
// medium, power thinnest.
//
// Pre-v0.8 used color=metric + dashed patterns for hosts, which got
// ugly above 2 hosts. v0.8.0 → host palette + width. v0.8.1 → per-
// metric lightness shift on top. v0.8.2 dropped the "Tous hôtes"
// total-mode toggle (user feedback: not useful enough to justify
// the UI real estate).
//
// Chips:
//   - metric (top right) : show/hide that metric's series — always
//                          keeps at least one metric visible. Width
//                          preview swatch in neutral colour (curves
//                          use host colours, not metric colours).
//   - host   (below plot) : show/hide that host's curves across
//                           every active metric at once. Swatch is
//                           the host's own colour.

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

// Per-host palette. Solid colours, picked to be distinguishable on
// both light and dark themes (no near-pure-yellow, no near-pure-cyan,
// no >50% luminance). Pre-v0.8 we used a metric × dash-pattern
// scheme which got unreadable above 2 hosts; user feedback was
// explicit: "les traits tillés ça fait moche, uniformise couleur par
// machine". Cycle past 10 hosts — unrealistic on a single dashboard,
// but keeps the assignment deterministic.
const HOST_PALETTE: readonly string[] = [
  '#3b82f6', // blue 500
  '#22c55e', // green 500
  '#f97316', // orange 500
  '#a855f7', // purple 500
  '#ef4444', // red 500
  '#14b8a6', // teal 500
  '#eab308', // yellow 500 (used past index 6 only — lowest contrast)
  '#ec4899', // pink 500
  '#6366f1', // indigo 500
  '#84cc16', // lime 500
];

function hostColor(idx: number): string {
  return HOST_PALETTE[idx % HOST_PALETTE.length];
}

// Per-metric stroke width. utilization is the headline number so it
// gets the boldest stroke; power the thinnest. Same width applied
// across every host of a given metric, so when the user scans
// vertically through hosts the metric mapping stays consistent.
const METRIC_WIDTH: Record<Metric, number> = {
  utilization: 2.25,
  temperature: 1.5,
  power: 1.0,
};

// HSL lightness offset per metric, applied on top of the host's base
// palette color. Utilization keeps the base hue (the headline
// number); temperature is shifted brighter; power darker. Combined
// with the per-metric stroke width above, this gives every metric
// for the same host a visually distinct rendering while keeping the
// "same host = same color family" gestalt the v0.8.0 redesign aimed
// for. Sat shift is small (-0.1 for power) so the darker shade
// doesn't go muddy on dim themes.
const METRIC_LIGHTNESS_DELTA: Record<Metric, number> = {
  utilization: 0,
  temperature: 0.18,   // ~18% lighter
  power: -0.18,        // ~18% darker
};

// Parse #RRGGBB → [r, g, b] in [0,1].
function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1 / 3),
  ];
}

/** Shade a host's base color by the metric's lightness delta. The
 *  result is the actual stroke color drawn for that (host, metric)
 *  pair. Pre-computed to a Map at module scope to avoid touching
 *  color math on every render — 10 hosts × 3 metrics = 30 entries. */
const HOST_METRIC_COLOR_CACHE = new Map<string, string>();
function hostMetricColor(hostIdx: number, metric: Metric): string {
  const key = `${hostIdx}|${metric}`;
  const hit = HOST_METRIC_COLOR_CACHE.get(key);
  if (hit) return hit;
  const base = hostColor(hostIdx);
  const delta = METRIC_LIGHTNESS_DELTA[metric];
  if (delta === 0) {
    HOST_METRIC_COLOR_CACHE.set(key, base);
    return base;
  }
  const [r, g, b] = hexToRgb(base);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s, Math.min(0.92, Math.max(0.08, l + delta)));
  const shaded = rgbToHex(nr, ng, nb);
  HOST_METRIC_COLOR_CACHE.set(key, shaded);
  return shaded;
}

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

// (aggregateForTotal removed in v0.8.2 along with the "Tous hôtes"
// mode toggle — user feedback: "je ne vois pas l'intérêt". The
// per-host view with color-shaded metrics already conveys per-host
// detail; the fleet-wide aggregate was rarely consulted.)

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
  }, [hostsToPlot, hostsWithData, hiddenHosts, activeMetrics, seriesVersion, range, historyByMetric]);

  const data = useMemo<AlignedData>(() => {
    if (entries.length === 0) return [[]] as AlignedData;
    const tSet = new Set<number>();
    for (const e of entries) for (const t of e.data.times) tSet.add(t);
    let sortedT = Array.from(tSet).sort((a, b) => a - b);
    if (range === 'live') sortedT = sortedT.slice(-WINDOW_POINTS);
    // Forward-fill across the unified timeline. When multiple hosts
    // push at slightly different sub-second offsets (host A at
    // t=10.0, host B at t=10.3, etc.), the unioned `sortedT` has
    // points where each individual host has no sample. Pre-fix, we
    // wrote `null` at those positions, which made uPlot BREAK the
    // line — visible as "graph advances, host's new segment shows up
    // ~1s later when its next sample lands on a real timestamp".
    // Forward-fill holds the host's last-known value across the
    // gap, drawing a continuous line. Leading nulls (no sample yet
    // for that host at chart open) stay null — those are honest
    // "no data yet" pixels, not lag.
    const ySeries = entries.map((e) => {
      const map = new Map<number, number>();
      for (let i = 0; i < e.data.times.length; i++) map.set(e.data.times[i], e.data.values[i]);
      let last: number | null = null;
      return sortedT.map((t) => {
        const v = map.get(t);
        if (v !== undefined) {
          last = v;
          return v;
        }
        return last;
      });
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
          {t('fleet.combined_chart_title')}
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
                {/* Width preview swatch — matches the per-host
                    stroke-width convention (utilization thickest,
                    power thinnest). Neutral colour: per-host curves
                    use the host palette, not the metric colour. */}
                <svg width="14" height="6" aria-hidden="true">
                  <line
                    x1="0" y1="3" x2="14" y2="3"
                    stroke="currentColor"
                    strokeWidth={metrics.has(m) ? METRIC_WIDTH[m] : 1}
                    strokeOpacity={metrics.has(m) ? 1 : 0.35}
                  />
                </svg>
                {t(`dashboard.metrics.${m}`)}
              </button>
            ))}
          </div>
          <RangeSelector />
        </div>
      </header>

      <ChartPlot entries={entries} data={data} metricColor={METRIC_COLOR} range={range} />

      {/* Per-host legend. Renders EVERY enrolled host — including
          those without live samples — so the admin sees at a glance
          which row is "missing" data. The colour swatch matches the
          host's chart curve; empty hosts get a muted "no data" pill
          so the legend stays honest about what's drawn. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
        {hostsToPlot.map((h) => {
          const hidden = hiddenHosts.has(h.id);
          const dataIdx = hostsWithData.findIndex((x) => x.id === h.id);
          const hasData = dataIdx >= 0;
          const color = hasData ? hostColor(dataIdx) : 'var(--gv-text-dim)';
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
              <HostColorSwatch color={color} hasData={hasData} />
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
    </section>
  );
}

/** Solid-colour line swatch for the per-host legend. `hasData=false`
 *  hosts get a hollow swatch instead — keeps the legend honest about
 *  which hosts are actually drawing on the chart. */
function HostColorSwatch({ color, hasData }: Readonly<{ color: string; hasData: boolean }>) {
  if (!hasData) {
    return (
      <svg width="20" height="4" aria-hidden="true">
        <line x1="0" y1="2" x2="20" y2="2" stroke={color} strokeWidth="2" strokeDasharray="2,3" />
      </svg>
    );
  }
  return (
    <svg width="20" height="4" aria-hidden="true">
      <line x1="0" y1="2" x2="20" y2="2" stroke={color} strokeWidth="2.5" />
    </svg>
  );
}

interface ChartPlotProps {
  entries: SeriesEntry[];
  data: AlignedData;
  metricColor: Record<Metric, string>;
  range: string;
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
function ChartPlot({ entries, data, metricColor, range }: Readonly<ChartPlotProps>) {
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
  // range + timeFormat baked into the rebuild key so a switch from
  // live → 24h (or 24h → live) forces a uPlot rebuild and the X-axis
  // formatter closure re-captures the new value. Without this the
  // axis labels stayed in their initial format (the user reported
  // seeing 24h-style HH:MM ticks in live mode after switching back).
  const seriesShape = `${entries.map((e) => e.key).join('|')}#${colorSig}#${range}#${timeFormat}`;

  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const seriesDefs: uPlot.Series[] = [{}];
    for (const e of entries) {
      const metricLabel = t(`dashboard.metrics.${e.metric}`);
      const label = e.host ? `${e.host.label} · ${metricLabel}` : metricLabel;
      // per-host mode: color = host base shaded by metric (util on
      // base hue, temp lighter, power darker), width = metric.
      // total mode: color = metric (single curve per metric, no host
      // distinction — keeps the visual association with the metric
      // chip).
      const stroke = e.host ? hostMetricColor(e.hostIdx, e.metric) : metricColor[e.metric];
      seriesDefs.push({
        label,
        stroke,
        width: e.host ? METRIC_WIDTH[e.metric] : 2,
        scale: METRIC_SCALE[e.metric],
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
        {
          stroke: 'rgba(148,163,184,0.6)',
          grid: { stroke: 'rgba(148,163,184,0.08)' },
          // Time-axis tick formatter. uPlot's default picks a format
          // based on the visible range, but on live mode (60 s of
          // data) it sometimes shows just HH:MM, identical across
          // ticks. We force HH:MM:SS for live (always meaningful
          // sub-minute movement) and let the default handle longer
          // ranges. 12h timeFormat falls back to HH-style with am/pm
          // suffix via toLocaleTimeString — keeps the user's option
          // honored.
          values: (_u, vals) => {
            const useSec = range === 'live';
            const useHour12 = timeFormat === '12h';
            return vals.map((v) => {
              const d = new Date(v * 1000);
              if (useSec) {
                return d.toLocaleTimeString(undefined, {
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                  hour12: useHour12,
                });
              }
              return d.toLocaleTimeString(undefined, {
                hour: '2-digit', minute: '2-digit',
                hour12: useHour12,
              });
            });
          },
        },
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
              const metricLabel = t(`dashboard.metrics.${e.metric}`);
              const label = e.host ? `${e.host.label} · ${metricLabel}` : metricLabel;
              // Match the chart: per-host curves use the host base
              // colour shaded per metric (util base / temp lighter /
              // power darker); total mode uses metric colour.
              const stroke = e.host ? hostMetricColor(e.hostIdx, e.metric) : metricColor[e.metric];
              const width = e.host ? METRIC_WIDTH[e.metric] : 2;
              return (
                <div key={e.key} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 truncate" style={{ color: stroke }}>
                    <svg width="14" height="4" aria-hidden="true">
                      <line x1="0" y1="2" x2="14" y2="2" stroke="currentColor" strokeWidth={width} />
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
