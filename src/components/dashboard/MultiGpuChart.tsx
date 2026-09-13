import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, MemoryStick, Fan, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GpuSample, HistoryRow } from '../../store/gpuStore';
import { useGpuStore } from '../../store/gpuStore';
import { useHostsStore } from '../../store/hostsStore';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../lib/api';
import { fmtClock, fmtDateTime, historyPollIntervalMs, makeAxisTimeFormatter, rangeToSeconds } from '../../lib/time';
import { shortGpuName } from '../../lib/gpuName';

// Per-GPU palette — eight high-contrast hues so up to eight GPUs stay
// visually distinguishable on the same chart. Past that, we wrap around;
// real-world rigs with 9+ GPUs are rare on this dashboard.
const GPU_COLORS = [
  '#6366f1', '#06b6d4', '#10b981', '#f59e0b',
  '#ef4444', '#a855f7', '#14b8a6', '#f97316',
] as const;

type Metric = 'utilization' | 'temperature' | 'memory' | 'power' | 'fan_speed';

const METRICS: ReadonlyArray<{ key: Metric; labelKey: string; icon: LucideIcon; unit: string; scale: '%' | 'W' }> = [
  { key: 'utilization',  labelKey: 'dashboard.metrics.utilization', icon: Activity,    unit: '%', scale: '%' },
  { key: 'memory',       labelKey: 'dashboard.metrics.memory',      icon: MemoryStick, unit: '%', scale: '%' },
  { key: 'fan_speed',    labelKey: 'dashboard.metrics.fan',         icon: Fan,         unit: '%', scale: '%' },
  { key: 'temperature',  labelKey: 'dashboard.metrics.temperature', icon: Thermometer, unit: '°C', scale: '%' },
  { key: 'power',        labelKey: 'dashboard.metrics.power',       icon: Zap,         unit: 'W', scale: 'W' },
];

export default function MultiGpuChart({ samples }: Readonly<{ samples: GpuSample[] }>) {
  const { t } = useTranslation();
  const seriesMap = useGpuStore((s) => s.series);
  const selectedHostId = useHostsStore((s) => s.selectedHostId);
  const range = useUiStore((s) => s.range);
  const timeFormat = useUiStore((s) => s.timeFormat);
  const themeId = useUiStore((s) => s.themeId);
  const [metric, setMetric] = useState<Metric>('utilization');
  const [historyByGpu, setHistoryByGpu] = useState<Map<number, HistoryRow[]>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);
  const [tip, setTip] = useState<{ left: number; top: number; flipX: boolean; flipY: boolean; show: boolean }>(
    { left: 0, top: 0, flipX: false, flipY: false, show: false },
  );

  const meta = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  const timeFormatRef = useRef(timeFormat);
  useEffect(() => { timeFormatRef.current = timeFormat; plotRef.current?.redraw(false); }, [timeFormat]);

  // Build / rebuild plot when GPU list, metric or theme changes.
  useEffect(() => {
    if (!containerRef.current) return;
    plotRef.current?.destroy();

    const root = getComputedStyle(document.documentElement);
    const grid = root.getPropertyValue('--gv-chart-grid').trim() || 'rgba(148,163,184,0.08)';
    const muted = root.getPropertyValue('--gv-text-muted').trim() || '#94a3b8';

    const seriesDefs: uPlot.Series[] = [{}];
    samples.forEach((sample, i) => {
      seriesDefs.push({
        label: `GPU #${sample.gpu_index}`,
        stroke: GPU_COLORS[i % GPU_COLORS.length],
        width: 2,
        scale: meta.scale,
      });
    });

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 260,
      pxAlign: 0,
      scales: {
        x: { time: true },
        '%': { auto: false, range: [0, 100] },
        W: { auto: true },
      },
      axes: [
        { stroke: muted, grid: { stroke: grid }, values: makeAxisTimeFormatter(timeFormatRef) },
        {
          stroke: muted,
          grid: { stroke: grid },
          scale: meta.scale,
          values: (_u, vals) => vals.map((v) => `${v}${meta.scale === 'W' ? ' W' : '%'}`),
        },
      ],
      series: seriesDefs,
      legend: { show: false },
      cursor: { drag: { x: true, y: false } },
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const left = u.cursor.left ?? -1;
            const top = u.cursor.top ?? -1;
            if (idx === null || idx === undefined || left < 0 || top < 0) {
              setCursorIdx(null);
              setTip((prev) => (prev.show ? { ...prev, show: false } : prev));
            } else {
              setCursorIdx(idx);
              const w = u.over.clientWidth;
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
      },
    };
    plotRef.current = new uPlot(opts, [[]] as unknown as AlignedData, containerRef.current);
    const ro = new ResizeObserver(() => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({ width: containerRef.current.clientWidth, height: 260 });
      }
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
  }, [samples, metric, meta.scale, themeId]);

  // Fetch per-GPU history for non-live ranges and keep polling in the
  // background. The live buffer in gpuStore only holds a rolling ~10 min
  // window, so without this the chart used to plateau past that mark for
  // every range longer than "live".
  const gpuIndicesKey = samples.map((s) => s.gpu_index).join(',');
  useEffect(() => {
    if (range === 'live' || samples.length === 0) {
      setHistoryByGpu(new Map());
      return;
    }
    let cancelled = false;
    const gpuIndices = samples.map((s) => s.gpu_index);
    const fetchAll = async () => {
      const entries = await Promise.all(
        gpuIndices.map((gpu) =>
          api<{ history: HistoryRow[] }>(`/gpu/history?host=${encodeURIComponent(selectedHostId)}&gpu=${gpu}&range=${range}`)
            .then((r): readonly [number, HistoryRow[]] => [gpu, r.history])
            .catch((): readonly [number, HistoryRow[]] => [gpu, []]),
        ),
      );
      return new Map(entries);
    };
    const run = () => { fetchAll().then((m) => { if (!cancelled) setHistoryByGpu(m); }); };
    run();
    const id = setInterval(run, historyPollIntervalMs(range));
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHostId, range, gpuIndicesKey]);

  // Push merged data on every store update / history refresh. For each
  // GPU we concatenate its periodically-refetched history with the live
  // buffer's tail (points newer than the history's last timestamp) so
  // the chart both covers the full selected range and keeps animating
  // between two background polls.
  useEffect(() => {
    if (!plotRef.current) return;
    if (samples.length === 0) return;

    const merged = new Map<number, {
      t: number[];
      util: (number | null)[];
      temp: number[];
      pow: number[];
      mem: (number | null)[];
      fan: (number | null)[];
    }>();
    for (const sample of samples) {
      const hist = historyByGpu.get(sample.gpu_index) ?? [];
      const t: number[] = [];
      const util: (number | null)[] = [];
      const temp: number[] = [];
      const pow: number[] = [];
      const mem: (number | null)[] = [];
      const fan: (number | null)[] = [];
      for (const h of hist) {
        t.push(h.timestamp_epoch);
        util.push(h.utilization);
        temp.push(h.temperature);
        pow.push(h.power);
        mem.push(h.memory_total ? (h.memory_used / h.memory_total) * 100 : null);
        fan.push(h.fan_speed);
      }
      const lastHistT = t.at(-1) ?? -Infinity;
      const live = seriesMap.get(sample.gpu_index);
      if (live) {
        const total = sample.memory_total ?? 0;
        for (let i = 0; i < live.t.length; i++) {
          if (live.t[i] <= lastHistT) continue;
          t.push(live.t[i]);
          util.push(live.utilization[i] ?? null);
          temp.push(live.temperature[i]);
          pow.push(live.power[i]);
          const used = live.memory_used[i];
          mem.push(used !== undefined && total > 0 ? (used / total) * 100 : null);
          fan.push(live.fan_speed[i] ?? null);
        }
      }
      merged.set(sample.gpu_index, { t, util, temp, pow, mem, fan });
    }

    // Build a unified time axis from the longest GPU's timeline so all
    // lines stay aligned; sparse GPUs simply contribute null at missing
    // ticks.
    let longest: number[] = [];
    for (const m of merged.values()) if (m.t.length > longest.length) longest = m.t;
    const last = longest.at(-1);
    if (last === undefined) {
      plotRef.current.setData([[]] as unknown as AlignedData);
      return;
    }
    const cutoff = last - rangeToSeconds(range);
    const tArr: number[] = [];
    for (const ts of longest) if (ts >= cutoff) tArr.push(ts);

    const byTimeIndex = new Map<number, number>();
    tArr.forEach((ts, i) => byTimeIndex.set(ts, i));

    const lines: (number | null)[][] = samples.map((sample) => {
      const m = merged.get(sample.gpu_index);
      const arr: (number | null)[] = new Array(tArr.length).fill(null);
      if (!m) return arr;
      for (let i = 0; i < m.t.length; i++) {
        const targetIdx = byTimeIndex.get(m.t[i]);
        if (targetIdx === undefined) continue;
        switch (metric) {
          case 'utilization': arr[targetIdx] = m.util[i]; break;
          case 'temperature': arr[targetIdx] = m.temp[i]; break;
          case 'fan_speed':   arr[targetIdx] = m.fan[i];  break;
          case 'power':       arr[targetIdx] = m.pow[i];  break;
          case 'memory':      arr[targetIdx] = m.mem[i];  break;
        }
      }
      return arr;
    });

    plotRef.current.setData([tArr, ...lines] as unknown as AlignedData);
  }, [samples, seriesMap, historyByGpu, metric, range]);

  // Tooltip rows for the current cursor index.
  const tipRows = useMemo(() => {
    if (cursorIdx === null || !plotRef.current) return [];
    const data = plotRef.current.data;
    return samples.map((sample, i) => ({
      gpu: sample.gpu_index,
      name: sample.name,
      color: GPU_COLORS[i % GPU_COLORS.length],
      value: (data[i + 1]?.[cursorIdx] as number | undefined) ?? null,
    }));
  }, [cursorIdx, samples]);

  const cursorTime = cursorIdx !== null && plotRef.current
    ? (plotRef.current.data[0]?.[cursorIdx] as number | undefined) ?? null
    : null;

  const unitSuffix = meta.scale === 'W' ? ' W' : meta.unit;
  const fmt = (v: number | null) => {
    if (v === null || !Number.isFinite(v)) return '-';
    const decimals = v < 10 ? 1 : 0;
    return `${v.toFixed(decimals)}${unitSuffix}`;
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
          {t('dashboard.gpus_combined_chart')}
        </h3>
        <fieldset className="seg flex-wrap">
          <legend className="sr-only">{t('dashboard.metric')}</legend>
          {METRICS.map((m) => {
            const Icon = m.icon;
            return (
              <button
                key={m.key}
                type="button"
                className="seg-btn inline-flex items-center gap-1.5"
                aria-pressed={metric === m.key}
                onClick={() => setMetric(m.key)}
              >
                <Icon className="w-3.5 h-3.5" /> {t(m.labelKey)}
              </button>
            );
          })}
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs mb-2">
        {samples.map((s, i) => (
          <span key={s.gpu_index} className="inline-flex items-center gap-1.5"
                style={{ color: 'var(--gv-text-muted)' }}>
            <span className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{ background: GPU_COLORS[i % GPU_COLORS.length] }} />
            <span>GPU #{s.gpu_index}</span>
            <span className="opacity-60">{shortGpuName(s.name)}</span>
          </span>
        ))}
      </div>

      <div className="relative">
        <div ref={containerRef} className="w-full select-none" />
        {tip.show && cursorTime !== null && (
          <div
            className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md text-[11px] shadow-lg backdrop-blur-sm"
            style={{
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
              {fmtDateTime(cursorTime, timeFormat)}
            </div>
            {tipRows.map((row) => (
              <div key={row.gpu} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: row.color }} />
                  GPU #{row.gpu}
                </span>
                <span className="font-semibold tabular-nums">{fmt(row.value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-[10px] mt-1.5" style={{ color: 'var(--gv-text-dim)' }}>
        {cursorTime === null
          ? t('dashboard.gpus_combined_help')
          : fmtClock(cursorTime, timeFormat)}
      </div>
    </div>
  );
}

