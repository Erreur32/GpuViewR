import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { useGpuStore } from '../../store/gpuStore';
import { useHostsStore } from '../../store/hostsStore';
import { useUiStore } from '../../store/uiStore';
import { notify } from '../../store/toastStore';
import { api } from '../../lib/api';
import { fmtClock, fmtDateTime, makeAxisTimeFormatter, rangeToSeconds } from '../../lib/time';

interface Props { gpuIndex: number; }

import type { HistoryRow } from '../../store/gpuStore';

interface CursorValues {
  t: number | null;
  utilization: number | null;
  temperature: number | null;
  power: number | null;
  memory: number | null;
  fan: number | null;
}

type ChipProps = Readonly<{
  colorVar: string;
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
  onColorChange: (color: string) => void;
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
  // Track which host's data we're charting so we can scope history
  // fetches + cache keys correctly. Defaults to 'local' for mono-host
  // installs (the only situation pre-v0.3.0).
  const selectedHostId = useHostsStore((s) => s.selectedHostId);
  const [historic, setHistoric] = useState<HistoryRow[]>(() => cachedHistory?.rows ?? []);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [cursor, setCursor] = useState<CursorValues>({ t: null, utilization: null, temperature: null, power: null, memory: null, fan: null });
  const [tip, setTip] = useState<{ left: number; top: number; flipX: boolean; flipY: boolean; show: boolean }>(
    { left: 0, top: 0, flipX: false, flipY: false, show: false },
  );
  const [visible, setVisible] = useState<{ util: boolean; temp: boolean; pow: boolean; mem: boolean; fan: boolean }>({ util: true, temp: true, pow: true, mem: true, fan: true });

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

  const toggleSeries = (key: 'util' | 'temp' | 'pow' | 'mem' | 'fan') => {
    setVisible((v) => {
      const next = { ...v, [key]: !v[key] };
      const idxMap = { util: 1, mem: 2, fan: 3, temp: 4, pow: 5 } as const;
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
    const cached = useGpuStore.getState().getHistory(selectedHostId, gpuIndex, range);
    if (cached) setHistoric(cached);
    setLoadingHistory(true);
    api<{ history: HistoryRow[] }>(`/gpu/history?host=${encodeURIComponent(selectedHostId)}&gpu=${gpuIndex}&range=${range}`)
      .then((r) => {
        if (cancelled) return;
        setHistoric(r.history);
        setHistoryCache(selectedHostId, gpuIndex, range, r.history);
      })
      .catch(() => { if (!cancelled && !cached) setHistoric([]); })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [selectedHostId, gpuIndex, range, setHistoryCache]);

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
    const fanColor = chartColors.fan ?? '#14b8a6';

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
        { stroke: muted, grid: { stroke: grid }, values: makeAxisTimeFormatter(timeFormatRef) },
        { stroke: muted, grid: { stroke: grid }, scale: '%', values: (_u, vals) => vals.map((v) => v + '%') },
        { side: 1, stroke: muted, grid: { show: false }, scale: 'W', values: (_u, vals) => vals.map((v) => v + ' W') },
      ],
      series: [
        {},
        { label: t('dashboard.metrics.utilization'), stroke: accent, width: 2, scale: '%', fill: makeGradient(accent) },
        { label: t('dashboard.metrics.memory'), stroke: info, width: 2, scale: '%', fill: makeGradient(info) },
        { label: t('dashboard.metrics.fan'), stroke: fanColor, width: 2, scale: '%', fill: makeGradient(fanColor) },
        { label: t('dashboard.metrics.temperature'), stroke: warn, width: 2, scale: '%', fill: makeGradient(warn) },
        { label: t('dashboard.metrics.power'), stroke: ok, width: 2, scale: 'W', fill: makeGradient(ok) },
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
              setCursor({ t: null, utilization: null, temperature: null, power: null, memory: null, fan: null });
              setTip((prev) => (prev.show ? { ...prev, show: false } : prev));
            } else {
              setCursor({
                t: u.data[0]?.[idx] ?? null,
                utilization: (u.data[1]?.[idx] as number | undefined) ?? null,
                memory: (u.data[2]?.[idx] as number | undefined) ?? null,
                fan: (u.data[3]?.[idx] as number | undefined) ?? null,
                temperature: (u.data[4]?.[idx] as number | undefined) ?? null,
                power: (u.data[5]?.[idx] as number | undefined) ?? null,
              });
              // Flip the tooltip horizontally / vertically when it would
              // overflow the chart, so it sticks naturally next to the
              // cursor instead of being clipped or placed far from it.
              const w = u.over.clientWidth;
              const h = u.over.clientHeight;
              setTip({
                left,
                top,
                flipX: left > w - 200,
                flipY: top < 110,
                show: true,
              });
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
            if (vis.fan) drawLine(th.fan, '%', fanColor);
            ctx.restore();
          },
        ],
      },
    };
    plotRef.current = new uPlot(opts, [[], [], [], [], [], []] as unknown as AlignedData, containerRef.current);

    const ro = new ResizeObserver(() => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 300 });
      }
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, themeId, chartColors.util, chartColors.temp, chartColors.pow, chartColors.mem, chartColors.fan]);

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
    const liveFan = series?.fan_speed ?? [];
    const memTotalLive = latestSample?.memory_total ?? null;

    const lastHistEpoch = historic.length > 0 ? historic[historic.length - 1].timestamp_epoch : -Infinity;
    const tArr: number[] = [];
    const utilArr: (number | null)[] = [];
    const tempArr: number[] = [];
    const powArr: number[] = [];
    const memArr: (number | null)[] = [];
    const fanArr: (number | null)[] = [];

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
      fanArr.push(h.fan_speed);
    }
    for (let i = 0; i < liveT.length; i++) {
      if (liveT[i] > lastHistEpoch) {
        tArr.push(liveT[i]);
        utilArr.push(liveUtil[i]);
        tempArr.push(liveTemp[i]);
        powArr.push(livePow[i]);
        memArr.push(memPct(liveMemUsed[i] ?? 0, memTotalLive));
        fanArr.push(liveFan[i] ?? null);
      }
    }

    if (tArr.length > 0) {
      const cutoff = tArr[tArr.length - 1] - rangeToSeconds(range);
      let drop = 0;
      while (drop < tArr.length && tArr[drop] < cutoff) drop++;
      if (drop > 0) {
        tArr.splice(0, drop);
        utilArr.splice(0, drop);
        tempArr.splice(0, drop);
        powArr.splice(0, drop);
        memArr.splice(0, drop);
        fanArr.splice(0, drop);
      }
    }

    plotRef.current.setData([tArr, utilArr, memArr, fanArr, tempArr, powArr] as AlignedData);
  }, [historic, series, range, latestSample?.memory_total]);

  // What the legend shows: the cursor value if hovering, else the live latest sample.
  const display = useMemo<{
    live: boolean;
    t: number | null;
    util: number | null;
    temp: number | null;
    pow: number | null;
    mem: number | null;
    fan: number | null;
  }>(() => {
    if (cursor.t !== null) {
      return { live: false, t: cursor.t, util: cursor.utilization, temp: cursor.temperature, pow: cursor.power, mem: cursor.memory, fan: cursor.fan };
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
        fan: latestSample.fan_speed,
      };
    }
    return { live: true, t: null, util: null, temp: null, pow: null, mem: null, fan: null };
  }, [cursor, latestSample]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
            {t('dashboard.history')}
          </h3>
          <CsvExportButton gpuIndex={gpuIndex} range={range} />
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Chip
            colorVar={chartColors.util ?? 'var(--gv-accent)'}
            label={t('dashboard.metrics.utilization')}
            value={fmt(display.util, '%')}
            active={visible.util}
            onClick={() => toggleSeries('util')}
            onColorChange={(c) => setChartColor('util', c)}
            isCustom={!!chartColors.util}
          />
          <Chip
            colorVar={chartColors.mem ?? 'var(--gv-info)'}
            label={t('dashboard.metrics.memory')}
            value={fmt(display.mem, '%')}
            active={visible.mem}
            onClick={() => toggleSeries('mem')}
            onColorChange={(c) => setChartColor('mem', c)}
            isCustom={!!chartColors.mem}
          />
          <Chip
            colorVar={chartColors.fan ?? '#14b8a6'}
            label={t('dashboard.metrics.fan')}
            value={fmt(display.fan, '%')}
            active={visible.fan}
            onClick={() => toggleSeries('fan')}
            onColorChange={(c) => setChartColor('fan', c)}
            isCustom={!!chartColors.fan}
          />
          <Chip
            colorVar={chartColors.temp ?? 'var(--gv-warn)'}
            label={t('dashboard.metrics.temperature')}
            value={fmt(display.temp, '°C')}
            active={visible.temp}
            onClick={() => toggleSeries('temp')}
            onColorChange={(c) => setChartColor('temp', c)}
            isCustom={!!chartColors.temp}
          />
          <Chip
            colorVar={chartColors.pow ?? 'var(--gv-ok)'}
            label={t('dashboard.metrics.power')}
            value={fmt(display.pow, ' W')}
            active={visible.pow}
            onClick={() => toggleSeries('pow')}
            onColorChange={(c) => setChartColor('pow', c)}
            isCustom={!!chartColors.pow}
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
          className="w-full select-none"
        />
        {tip.show && cursor.t !== null && (
          <div
            className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md text-[11px] shadow-lg backdrop-blur-sm"
            style={{
              // Anchor the tooltip on the cursor and use translate to
              // place it diagonally clear of the pointer. flipX/flipY
              // mirror it when close to the right / top edges.
              left: tip.left,
              top: tip.top,
              transform: `translate(${tip.flipX ? 'calc(-100% - 14px)' : '14px'}, ${tip.flipY ? '14px' : 'calc(-100% - 14px)'})`,
              background: 'color-mix(in srgb, var(--gv-surface) 92%, transparent)',
              border: '1px solid var(--gv-border)',
              color: 'var(--gv-text)',
              minWidth: 180,
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
            {visible.mem && (
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: chartColors.mem ?? 'var(--gv-info)' }} />
                  {t('dashboard.metrics.memory')}
                </span>
                <span className="font-semibold tabular-nums">{fmt(cursor.memory, '%')}</span>
              </div>
            )}
            {visible.fan && (
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: chartColors.fan ?? '#14b8a6' }} />
                  {t('dashboard.metrics.fan')}
                </span>
                <span className="font-semibold tabular-nums">{fmt(cursor.fan, '%')}</span>
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

function CsvExportButton({ gpuIndex, range }: Readonly<{ gpuIndex: number; range: string }>) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      const token = localStorage.getItem('gpuviewr.token') || '';
      const res = await fetch(`/api/gpu/history.csv?gpu=${gpuIndex}&range=${encodeURIComponent(range)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Prefer the server-suggested filename so date/range/gpu are preserved.
      const dispo = res.headers.get('content-disposition') || '';
      const m = /filename="([^"]+)"/.exec(dispo);
      const fallback = `gpuviewr-gpu${gpuIndex}-${range}.csv`;
      const filename = m ? m[1] : fallback;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Surface failures via the global toast store so the user gets feedback
      // instead of a silent broken click.
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="btn-ghost text-xs inline-flex items-center gap-1"
      onClick={onClick}
      disabled={busy}
      title={t('dashboard.export_csv_help')}
    >
      <Download className="w-3.5 h-3.5" />
      {busy ? '…' : 'CSV'}
    </button>
  );
}

function Chip({ colorVar, label, value, active, onClick, onColorChange, isCustom }: ChipProps) {
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
