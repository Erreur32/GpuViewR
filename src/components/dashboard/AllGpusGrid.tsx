import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, MemoryStick, Fan, Zap, Cable, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import type { GpuSample } from '../../store/gpuStore';
import { useGpuStore } from '../../store/gpuStore';
import { statusFor, colorFor } from '../../lib/status';
import Sparkline from './Sparkline';
import MetricRow from '../ui/MetricRow';

const PCIE_PER_LANE_GBPS: Record<number, number> = {
  1: 0.25, 2: 0.5, 3: 0.985, 4: 1.969, 5: 3.938, 6: 7.563,
};

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtBitsPerSec(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined) return '-';
  const bps = kbps * 1000;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kb/s`;
  return `${bps.toFixed(0)} b/s`;
}

export default function AllGpusGrid({ samples }: Readonly<{ samples: GpuSample[] }>) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
      {samples.map((s) => <CompactGpuTile key={s.gpu_index} sample={s} />)}
    </div>
  );
}

function CompactGpuTile({ sample }: Readonly<{ sample: GpuSample }>) {
  const { t } = useTranslation();
  const series = useGpuStore((s) => s.series.get(sample.gpu_index));

  const memPct = sample.memory_total ? (sample.memory_used / sample.memory_total) * 100 : 0;
  const utilStatus = statusFor(sample.utilization ?? 0, 85, 95);
  const utilColor = colorFor(utilStatus);

  const link = sample.pcie_gen_current && sample.pcie_width_current
    ? `PCIe ${sample.pcie_gen_current}.0 ×${sample.pcie_width_current}`
    : null;
  const linkBw = sample.pcie_gen_current && sample.pcie_width_current
    ? Math.round((PCIE_PER_LANE_GBPS[sample.pcie_gen_current] ?? 0) * sample.pcie_width_current * 100) / 100
    : null;

  return (
    <div className="card card-hover p-4 flex flex-col gap-3 min-w-0">
      <header className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-tight truncate" style={{ color: 'var(--gv-text)' }} title={sample.name}>
            {sample.name}
          </h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gv-text-dim)' }}>
            GPU #{sample.gpu_index} · driver {sample.driver_version || '-'}
          </p>
        </div>
        {series?.utilization && series.utilization.length > 1 && (
          <Sparkline
            values={series.utilization.slice(-60).map((v) => v ?? 0)}
            max={100}
            width={80}
            height={26}
            stroke={utilColor}
            className="shrink-0"
          />
        )}
      </header>

      <div className="grid grid-cols-1 gap-1.5">
        <MetricRow
          icon={<Activity className="w-3.5 h-3.5" />}
          label={t('dashboard.metrics.utilization')}
          value={sample.utilization ?? 0}
          displayValue={sample.utilization === null ? 'N/A' : undefined}
          max={100}
          warn={85}
          danger={95}
          unit="%"
        />
        <MetricRow
          icon={<MemoryStick className="w-3.5 h-3.5" />}
          label={t('dashboard.metrics.memory')}
          value={memPct}
          displayValue={`${fmt(sample.memory_used)} / ${sample.memory_total ? fmt(sample.memory_total) : '?'} MiB`}
          max={100}
          warn={80}
          danger={92}
          unit=""
        />
        <MetricRow
          icon={<Fan className="w-3.5 h-3.5" />}
          label={t('dashboard.metrics.fan')}
          value={sample.fan_speed ?? 0}
          displayValue={sample.fan_speed === null || sample.fan_speed === undefined ? 'N/A' : undefined}
          max={100}
          warn={75}
          danger={90}
          unit="%"
        />
        <MetricRow
          icon={<Thermometer className="w-3.5 h-3.5" />}
          label={t('dashboard.metrics.temperature')}
          value={sample.temperature}
          max={100}
          warn={75}
          danger={85}
          unit="°C"
        />
        <MetricRow
          icon={<Zap className="w-3.5 h-3.5" />}
          label={t('dashboard.metrics.power')}
          value={sample.power}
          max={Math.max(300, Math.ceil(sample.power * 1.4))}
          warn={250}
          danger={350}
          unit="W"
        />
      </div>

      {link && (
        <footer className="flex items-center justify-between text-[11px] pt-1.5 border-t flex-wrap gap-2"
                style={{ borderColor: 'var(--gv-border)', color: 'var(--gv-text-muted)' }}>
          <span className="inline-flex items-center gap-1.5">
            <Cable className="w-3.5 h-3.5" style={{ color: 'var(--gv-info)' }} />
            <span className="font-mono">{link}</span>
            {linkBw !== null && <span style={{ color: 'var(--gv-text-dim)' }}>· {linkBw} GB/s</span>}
          </span>
          <span className="inline-flex items-center gap-3 tabular-nums">
            <span className="inline-flex items-center gap-1" title="RX">
              <ArrowDownToLine className="w-3 h-3" style={{ color: 'var(--gv-ok)' }} />
              {fmtBitsPerSec(sample.pcie_rx_kbps)}
            </span>
            <span className="inline-flex items-center gap-1" title="TX">
              <ArrowUpFromLine className="w-3 h-3" style={{ color: 'var(--gv-warn)' }} />
              {fmtBitsPerSec(sample.pcie_tx_kbps)}
            </span>
          </span>
        </footer>
      )}
    </div>
  );
}

