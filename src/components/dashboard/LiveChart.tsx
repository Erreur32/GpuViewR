import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../lib/api';
import { fmtClock, fmtDateTime } from '../../lib/time';

interface Props { gpuIndex: number; }

import type { HistoryRow } from '../../store/gpuStore';

// In "Live" mode the chart shows the last LIVE_WINDOW_S seconds as a
// rolling scope. 90s gives ~90 points at the default 1Hz tick — dense
// enough to see real movement, sparse enough that the line still
// breathes and individual hover targets stay clickable.
const LIVE_WINDOW_S = 90;

interface CursorValues {
  t: number | null;
  utilization: number | null;
  temperature: number | null;
  power: number | null;
  memory: number | null;
}

type ChipProps = Readonly<{
  colorVar: string;
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
  onColorChange: (color: string) => void;
  onColorReset: () => void;
  isCustom: boolean;
}>;

export default function LiveChart({ gpuIndex }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const themeId = useUiStore((s) => s.themeId);
  const range = useUiStore((s) => s.range);
  const chartColors = useUiStore((s) => s.chartColors);
  const setChartColor = useUiStore((s) => s.setChartColor);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const chartThresholds = useUiStore((s) => s.chartThresholds);
  const chartThresholdsEnabled = useUiStore((s) => s.chartThresholdsEnabled);
  const series = useGpuStore((s) => s.series.get(gpuIndex));
  const latestSample = useGpuStore((s) => s.latest.get(gpuIndex));
  const cachedHistory = useGpuStore((s) => s.history.get(`${gpuIndex}|${range}`));
  const setHistoryCache = useGpuStore((s) => s.setHistory);
  const [historic, setHistoric] = useState<HistoryRow[]>(() => cachedHistory?.rows ?? []);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [cursor, setCursor] = useState<CursorValues>({ t: null, utilization: null, temperature: null, power: null, memory: null });
  const [tip, setTip] = useState<{ left: number; top: number; show: boolean }>({ left: 0, top: 0, show: false });
  const [pinned, setPinned] = useState<boolean>(false);
  const [visible, setVisible] = useState<{ util: boolean; temp: boolean; pow: boolean; mem: boolean }>({ util: true, temp: true, pow: true, mem: true });

  // uPlot needs latest props inside its hooks; keep refs to avoid rebuilding the
  // chart on every threshold/visibility/format change.
  const thresholdsRef = useRef(chartThresholds);
  const thresholdsEnabledRef = useRef(chartThresholdsEnabled);
  const visibleRef = useRef(visible);
  const timeFormatRef = useRef(timeFormat);
  useEffect(() => { thresholdsRef.current = chartThresholds; plotRef.current?.redraw(false); }, [chartThresholds]);
  useEffect(() => { thresholdsEnabledRef.current = chartThresholdsEnabled; plotRef.current?.redraw(false); }, [chartThresholdsEnabled]);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => { timeFormatRef.current = timeFormat; plotRef.current?.redraw(false); }, [timeFormat]);

  const toggleSeries = (key: 'util' | 'temp' | 'pow' | 'mem') => {
    setVisible((v) => {
      const next = { ...v, [key]: !v[key] };
      const idxMap = { util: 1, temp: 2, pow: 3, mem: 4 } as const;
      plotRef.current?.setSeries(idxMap[key], { show: next[key] });
      return next;
    });
  };

  // Fetch history when gpu/range changes. We hydrate `historic` from the
  // gpuStore cache synchronously so the chart paints instantly on mount
  // (no flash of empty data while the API call is in flight), then the
  // fetch refreshes the cache and the local state.
  useEffect(() => {
    let cancelled = false;
    const cached = useGpuStore.getState().getHistory(gpuIndex, range);
    if (cached) setHistoric(cached);
    setLoadingHistory(true);
    api<{ history: HistoryRow[] }>(`/gpu/history?gpu=${gpuIndex}&range=${range}`)
      .then((r) => {
        if (cancelled) return;
        setHistoric(r.history);
        setHistoryCache(gpuIndex, range, r.history);
      })
      .catch(() => { if (!cancelled && !cached) setHistoric([]); })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [gpuIndex, range, setHistoryCache]);

  // Build / rebuild chart on theme change
  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const root = getComputedStyle(document.documentElement);
    const grid = root.getPropertyValue('--gv-chart-grid').trim() || 'rgba(148,163,184,0.08)';
    const muted = root.getPropertyValue('--gv-text-muted').trim() || '#94a3b8';
    const accent = chartColors.util ?? (root.getPropertyValue('--gv-accent').trim() || '#2f7bff');
    const warn = chartColors.temp ?? (root.getPropertyValue('--gv-warn').trim() || '#f59e0b');
    const ok = chartColors.pow ?? (root.getPropertyValue('--gv-ok').trim() || '#10b981');
    const info = chartColors.mem ?? (root.getPropertyValue('--gv-info').trim() || '#06b6d4');

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 300,
      pxAlign: 0,
      scales: {
        x: { time: true },
        '%': { auto: false, range: [0, 100] },
        W: { auto: true },
      },
      axes: [
        {
          stroke: muted,
          grid: { stroke: grid },
          values: (_u, vals) => {
            const pad = (n: number) => String(n).padStart(2, '0');
            const step = vals.length > 1 ? Math.abs(vals[1] - vals[0]) : 60;
            const showSeconds = step < 60;
            return vals.map((v) => {
              const d = new Date(v * 1000);
              if (timeFormatRef.current === '24h') {
                return showSeconds
                  ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
                  : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
              }
              let h = d.getHours();
              const ampm = h >= 12 ? 'PM' : 'AM';
              h = h % 12;
              if (h === 0) h = 12;
              return showSeconds
                ? `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`
                : `${pad(h)}:${pad(d.getMinutes())} ${ampm}`;
            });
          },
        },
        { stroke: muted, grid: { stroke: grid }, scale: '%', values: (_u, vals) => vals.map((v) => v + '%') },
        { side: 1, stroke: muted, grid: { show: false }, scale: 'W', values: (_u, vals) => vals.map((v) => v + ' W') },
      ],
      series: [
        {},
        { label: t('dashboard.metrics.utilization'), stroke: accent, width: 2, scale: '%', fill: makeGradient(accent) },
        { label: t('dashboard.metrics.temperature'), stroke: warn, width: 2, scale: '%', fill: makeGradient(warn) },
        { label: t('dashboard.metrics.power'), stroke: ok, width: 2, scale: 'W', fill: makeGradient(ok) },
        { label: t('dashboard.metrics.memory'), stroke: info, width: 2, scale: '%', fill: makeGradient(info) },
      ],
      // We render our own legend chip row below the chart, so disable the
      // built-in legend (which only shows values on hover and clutters the layout).
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const left = u.cursor.left ?? -1;
            const top = u.cursor.top ?? -1;
            if (idx === null || idx === undefined || left < 0 || top < 0) {
              setCursor({ t: null, utilization: null, temperature: null, power: null, memory: null });
              setTip((prev) => (prev.show ? { ...prev, show: false } : prev));
            } else {
              setCursor({
                t: u.data[0]?.[idx] ?? null,
                utilization: (u.data[1]?.[idx] as number | undefined) ?? null,
                temperature: (u.data[2]?.[idx] as number | undefined) ?? null,
                power: (u.data[3]?.[idx] as number | undefined) ?? null,
                memory: (u.data[4]?.[idx] as number | undefined) ?? null,
              });
              setTip({ left, top, show: true });
            }
          },
        ],
        draw: [
          (u) => {
            if (!thresholdsEnabledRef.current) return;
            const th = thresholdsRef.current;
            const vis = visibleRef.current;
            const ctx = u.ctx;
            const { left, top, width, height } = u.bbox;
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.lineWidth = 1;
            const drawLine = (val: number | undefined, scale: string, color: string) => {
              if (val === undefined || !Number.isFinite(val)) return;
              const y = u.valToPos(val, scale, true);
              if (!Number.isFinite(y) || y < top || y > top + height) return;
              ctx.strokeStyle = hexAlpha(color, 0.5);
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + width, y);
              ctx.stroke();
            };
            if (vis.util) drawLine(th.util, '%', accent);
            if (vis.temp) drawLine(th.temp, '%', warn);
            if (vis.pow) drawLine(th.pow, 'W', ok);
            if (vis.mem) drawLine(th.mem, '%', info);
            ctx.restore();
          },
        ],
      },
    };
    plotRef.current = new uPlot(opts, [[], [], [], [], []] as unknown as AlignedData, containerRef.current);

    const ro = new ResizeObserver(() => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 300 });
      }
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, themeId, chartColors.util, chartColors.temp, chartColors.pow, chartColors.mem]);

  // Push merged data (history + live) to chart, computing memory % from
  // memory_used / memory_total. In "Live" mode we keep only the rolling
  // last LIVE_WINDOW_S seconds so old points slide off the left and the
  // chart reads as a true real-time scope.
  useEffect(() => {
    if (!plotRef.current) return;
    const liveT = series?.t ?? [];
    const liveUtil = series?.utilization ?? [];
    const liveTemp = series?.temperature ?? [];
    const livePow = series?.power ?? [];
    const liveMemUsed = series?.memory_used ?? [];
    const memTotalLive = latestSample?.memory_total ?? null;

    const lastHistEpoch = historic.length > 0 ? historic[historic.length - 1].timestamp_epoch : -Infinity;
    const tArr: number[] = [];
    const utilArr: (number | null)[] = [];
    const tempArr: number[] = [];
    const powArr: number[] = [];
    const memArr: (number | null)[] = [];

    const memPct = (used: number, total: number | null): number | null => {
      if (total === null || total <= 0) return null;
      return (used / total) * 100;
    };

    for (const h of historic) {
      tArr.push(h.timestamp_epoch);
      utilArr.push(h.utilization);
      tempArr.push(h.temperature);
      powArr.push(h.power);
      memArr.push(memPct(h.memory_used, h.memory_total));
    }
    for (let i = 0; i < liveT.length; i++) {
      if (liveT[i] > lastHistEpoch) {
        tArr.push(liveT[i]);
        utilArr.push(liveUtil[i]);
        tempArr.push(liveTemp[i]);
        powArr.push(livePow[i]);
        memArr.push(memPct(liveMemUsed[i] ?? 0, memTotalLive));
      }
    }

    if (range === 'live' && tArr.length > 0) {
      const cutoff = tArr[tArr.length - 1] - LIVE_WINDOW_S;
      let drop = 0;
      while (drop < tArr.length && tArr[drop] < cutoff) drop++;
      if (drop > 0) {
        tArr.splice(0, drop);
        utilArr.splice(0, drop);
        tempArr.splice(0, drop);
        powArr.splice(0, drop);
        memArr.splice(0, drop);
      }
    }

    plotRef.current.setData([tArr, utilArr, tempArr, powArr, memArr] as AlignedData);
  }, [historic, series, range, latestSample?.memory_total]);

  // What the legend shows: the cursor value if hovering/pinned, else the live latest sample.
  const display = useMemo<{
    live: boolean;
    t: number | null;
    util: number | null;
    temp: number | null;
    pow: number | null;
    mem: number | null;
  }>(() => {
    if (cursor.t !== null) {
      return { live: false, t: cursor.t, util: cursor.utilization, temp: cursor.temperature, pow: cursor.power, mem: cursor.memory };
    }
    if (latestSample) {
      const memTotal = latestSample.memory_total;
      const memPct = memTotal && memTotal > 0 ? (latestSample.memory_used / memTotal) * 100 : null;
      return {
        live: true,
        t: latestSample.timestamp_epoch,
        util: latestSample.utilization,
        temp: latestSample.temperature,
        pow: latestSample.power,
        mem: memPct,
      };
    }
    return { live: true, t: null, util: null, temp: null, pow: null, mem: null };
  }, [cursor, latestSample]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
          {t('dashboard.history')}
        </h3>
        <div className="flex items-center gap-3 text-xs">
          <Chip
            colorVar={chartColors.util ?? 'var(--gv-accent)'}
            label={t('dashboard.metrics.utilization')}
            value={fmt(display.util, '%')}
            active={visible.util}
            onClick={() => toggleSeries('util')}
            onColorChange={(c) => setChartColor('util', c)}
            onColorReset={() => setChartColor('util', null)}
            isCustom={!!chartColors.util}
          />
          <Chip
            colorVar={chartColors.temp ?? 'var(--gv-warn)'}
            label={t('dashboard.metrics.temperature')}
            value={fmt(display.temp, '°C')}
            active={visible.temp}
            onClick={() => toggleSeries('temp')}
            onColorChange={(c) => setChartColor('temp', c)}
            onColorReset={() => setChartColor('temp', null)}
            isCustom={!!chartColors.temp}
          />
          <Chip
            colorVar={chartColors.pow ?? 'var(--gv-ok)'}
            label={t('dashboard.metrics.power')}
            value={fmt(display.pow, ' W')}
            active={visible.pow}
            onClick={() => toggleSeries('pow')}
            onColorChange={(c) => setChartColor('pow', c)}
            onColorReset={() => setChartColor('pow', null)}
            isCustom={!!chartColors.pow}
          />
          <Chip
            colorVar={chartColors.mem ?? 'var(--gv-info)'}
            label={t('dashboard.metrics.memory')}
            value={fmt(display.mem, '%')}
            active={visible.mem}
            onClick={() => toggleSeries('mem')}
            onColorChange={(c) => setChartColor('mem', c)}
            onColorReset={() => setChartColor('mem', null)}
            isCustom={!!chartColors.mem}
          />
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              color: display.live ? 'var(--gv-ok)' : 'var(--gv-text-muted)',
              background: display.live
                ? 'color-mix(in srgb, var(--gv-ok) 14%, transparent)'
                : 'var(--gv-surface-alt)',
              border: '1px solid ' + (display.live
                ? 'color-mix(in srgb, var(--gv-ok) 30%, transparent)'
                : 'var(--gv-border)'),
            }}
            title={display.t ? fmtDateTime(display.t, timeFormat) : ''}
          >
            {display.live ? t('dashboard.live') : fmtClock(display.t, timeFormat)}
          </span>
        </div>
      </div>
      <div className="relative">
        <div
          ref={containerRef}
          role="button"
          tabIndex={0}
          aria-pressed={pinned}
          className="w-full select-none cursor-pointer"
          onClick={() => setPinned((p) => !p)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setPinned((p) => !p);
            }
          }}
          title={pinned ? t('dashboard.click_unpin') : t('dashboard.click_pin')}
        />
        {tip.show && cursor.t !== null && (
          <div
            className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md text-[11px] shadow-lg backdrop-blur-sm"
            style={{
              // Offset the tooltip clear of the cursor so it never sits
              // behind the mouse pointer (was 12 / -8, too tight on
              // some pointer skins).
              left: tip.left + 22,
              top: Math.max(0, tip.top - 28),
              background: 'color-mix(in srgb, var(--gv-surface) 92%, transparent)',
              border: '1px solid var(--gv-border)',
              color: 'var(--gv-text)',
              minWidth: 160,
            }}
          >
            <div className="font-semibold tabular-nums mb-1" style={{ color: 'var(--gv-text-muted)' }}>
              {fmtDateTime(cursor.t, timeFormat)}
            </div>
            {visible.util && (
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: chartColors.util ?? 'var(--gv-accent)' }} />
                  {t('dashboard.metrics.utilization')}
                </span>
                <span className="font-semibold tabular-nums">{fmt(cursor.utilization, '%')}</span>
              </div>
            )}
            {visible.temp && (
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: chartColors.temp ?? 'var(--gv-warn)' }} />
                  {t('dashboard.metrics.temperature')}
                </span>
                <span className="font-semibold tabular-nums">{fmt(cursor.temperature, '°C')}</span>
              </div>
            )}
            {visible.pow && (
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: chartColors.pow ?? 'var(--gv-ok)' }} />
                  {t('dashboard.metrics.power')}
                </span>
                <span className="font-semibold tabular-nums">{fmt(cursor.power, ' W')}</span>
              </div>
            )}
            {visible.mem && (
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: chartColors.mem ?? 'var(--gv-info)' }} />
                  {t('dashboard.metrics.memory')}
                </span>
                <span className="font-semibold tabular-nums">{fmt(cursor.memory, '%')}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {loadingHistory && (
        <div className="mt-2 text-xs" style={{ color: 'var(--gv-text-dim)' }}>
          {t('common.loading')}
        </div>
      )}
    </div>
  );
}

function Chip({ colorVar, label, value, active, onClick, onColorChange, onColorReset, isCustom }: ChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-opacity"
      style={{ opacity: active ? 1 : 0.4 }}
    >
      <label
        className="inline-flex relative cursor-pointer"
        title="Pick color"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span
          className="inline-block w-2.5 h-2.5 rounded-full"
          style={{
            background: colorVar,
            boxShadow: active ? `0 0 6px ${colorVar}` : 'none',
            border: isCustom ? '1px solid var(--gv-text)' : 'none',
          }}
        />
        <input
          type="color"
          aria-label={`${label} color`}
          className="sr-only"
          onChange={(e) => onColorChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      </label>
      {isCustom && (
        <button
          type="button"
          aria-label={`Reset ${label} color`}
          title="Reset color"
          onClick={(e) => { e.stopPropagation(); onColorReset(); }}
          className="text-[9px] leading-none px-1 rounded"
          style={{ color: 'var(--gv-text-dim)', background: 'transparent', border: '1px solid var(--gv-border)' }}
        >
          ×
        </button>
      )}
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className="inline-flex items-center gap-1.5"
        style={{ cursor: 'pointer', background: 'transparent', border: 'none' }}
        title={active ? 'Click to hide' : 'Click to show'}
      >
        <span style={{ color: 'var(--gv-text-muted)', textDecoration: active ? 'none' : 'line-through' }}>{label}</span>
        <span className="font-semibold tabular-nums" style={{ color: 'var(--gv-text)' }}>
          {value}
        </span>
      </button>
    </span>
  );
}

function fmt(v: number | null, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 }) + unit;
}

function hexAlpha(hex: string, a: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function makeGradient(color: string): (u: uPlot) => CanvasGradient | string {
  return (u: uPlot) => {
    const ctx = u.ctx;
    const top = u.bbox.top;
    const bottom = u.bbox.top + u.bbox.height;
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
      return hexAlpha(color, 0.10);
    }
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, hexAlpha(color, 0.32));
    grad.addColorStop(0.6, hexAlpha(color, 0.10));
    grad.addColorStop(1, hexAlpha(color, 0));
    return grad;
  };
}
