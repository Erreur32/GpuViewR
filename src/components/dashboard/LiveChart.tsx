import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../lib/api';
import { fmtClock, fmtDateTime } from '../../lib/time';

interface Props { gpuIndex: number; }

interface HistoryRow {
  timestamp_epoch: number;
  temperature: number;
  utilization: number | null;
  power: number;
}

interface CursorValues {
  t: number | null;
  utilization: number | null;
  temperature: number | null;
  power: number | null;
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
  const series = useGpuStore((s) => s.series.get(gpuIndex));
  const latestSample = useGpuStore((s) => s.latest.get(gpuIndex));
  const [historic, setHistoric] = useState<HistoryRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [cursor, setCursor] = useState<CursorValues>({ t: null, utilization: null, temperature: null, power: null });
  const [pinned, setPinned] = useState<boolean>(false);
  const [visible, setVisible] = useState<{ util: boolean; temp: boolean; pow: boolean }>({ util: true, temp: true, pow: true });

  const toggleSeries = (key: 'util' | 'temp' | 'pow') => {
    setVisible((v) => {
      const next = { ...v, [key]: !v[key] };
      const idxMap = { util: 1, temp: 2, pow: 3 } as const;
      plotRef.current?.setSeries(idxMap[key], { show: next[key] });
      return next;
    });
  };

  // Fetch history when range changes
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    api<{ history: HistoryRow[] }>(`/gpu/history?gpu=${gpuIndex}&range=${range}`)
      .then((r) => { if (!cancelled) setHistoric(r.history); })
      .catch(() => { if (!cancelled) setHistoric([]); })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [gpuIndex, range]);

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
        { stroke: muted, grid: { stroke: grid } },
        { stroke: muted, grid: { stroke: grid }, scale: '%', values: (_u, vals) => vals.map((v) => v + '%') },
        { side: 1, stroke: muted, grid: { show: false }, scale: 'W', values: (_u, vals) => vals.map((v) => v + ' W') },
      ],
      series: [
        {},
        { label: t('dashboard.metrics.utilization'), stroke: accent, width: 2, scale: '%', fill: hexAlpha(accent, 0.10) },
        { label: t('dashboard.metrics.temperature'), stroke: warn, width: 2, scale: '%' },
        { label: t('dashboard.metrics.power'), stroke: ok, width: 2, scale: 'W' },
      ],
      // We render our own legend chip row below the chart, so disable the
      // built-in legend (which only shows values on hover and clutters the layout).
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            if (idx === null || idx === undefined) {
              // Mouse left the plot, fall back to "live" mode (latest values).
              setCursor({ t: null, utilization: null, temperature: null, power: null });
            } else {
              setCursor({
                t: u.data[0]?.[idx] ?? null,
                utilization: (u.data[1]?.[idx] as number | undefined) ?? null,
                temperature: (u.data[2]?.[idx] as number | undefined) ?? null,
                power: (u.data[3]?.[idx] as number | undefined) ?? null,
              });
            }
          },
        ],
      },
    };
    plotRef.current = new uPlot(opts, [[], [], [], []] as unknown as AlignedData, containerRef.current);

    const ro = new ResizeObserver(() => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 300 });
      }
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, themeId, chartColors.util, chartColors.temp, chartColors.pow]);

  // Push merged data (history + live) to chart
  useEffect(() => {
    if (!plotRef.current) return;
    const liveT = series?.t ?? [];
    const liveUtil = series?.utilization ?? [];
    const liveTemp = series?.temperature ?? [];
    const livePow = series?.power ?? [];

    const lastHistEpoch = historic.length > 0 ? historic[historic.length - 1].timestamp_epoch : -Infinity;
    const tArr: number[] = [];
    const utilArr: number[] = [];
    const tempArr: number[] = [];
    const powArr: number[] = [];

    for (const h of historic) {
      tArr.push(h.timestamp_epoch);
      utilArr.push(h.utilization);
      tempArr.push(h.temperature);
      powArr.push(h.power);
    }
    for (let i = 0; i < liveT.length; i++) {
      if (liveT[i] > lastHistEpoch) {
        tArr.push(liveT[i]);
        utilArr.push(liveUtil[i]);
        tempArr.push(liveTemp[i]);
        powArr.push(livePow[i]);
      }
    }
    plotRef.current.setData([tArr, utilArr, tempArr, powArr] as AlignedData);
  }, [historic, series]);

  // What the legend shows: the cursor value if hovering/pinned, else the live latest sample.
  const display = useMemo<{ live: boolean; t: number | null; util: number | null; temp: number | null; pow: number | null }>(() => {
    if (cursor.t !== null) {
      return { live: false, t: cursor.t, util: cursor.utilization, temp: cursor.temperature, pow: cursor.power };
    }
    if (latestSample) {
      return {
        live: true,
        t: latestSample.timestamp_epoch,
        util: latestSample.utilization,
        temp: latestSample.temperature,
        pow: latestSample.power,
      };
    }
    return { live: true, t: null, util: null, temp: null, pow: null };
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
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
