import { useEffect, useRef, useState } from 'react';
import uPlot, { type AlignedData } from 'uplot';
import { useTranslation } from 'react-i18next';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import { api } from '../../lib/api';

interface Props { gpuIndex: number; }

interface HistoryRow {
  timestamp_epoch: number;
  temperature: number;
  utilization: number;
  power: number;
}

export default function LiveChart({ gpuIndex }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const themeId = useUiStore((s) => s.themeId);
  const range = useUiStore((s) => s.range);
  const series = useGpuStore((s) => s.series.get(gpuIndex));
  const [historic, setHistoric] = useState<HistoryRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

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
    const accent = root.getPropertyValue('--gv-accent').trim() || '#2f7bff';
    const warn = root.getPropertyValue('--gv-warn').trim() || '#f59e0b';
    const ok = root.getPropertyValue('--gv-ok').trim() || '#10b981';

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
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false } },
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
  }, [t, themeId]);

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

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
          {t('dashboard.history')}
        </h3>
        {loadingHistory && (
          <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>{t('common.loading')}</span>
        )}
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}

function hexAlpha(hex: string, a: number): string {
  // Accepts #rrggbb or named/var fallback
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
