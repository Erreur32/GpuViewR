import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, MemoryStick, Zap, Fan, LayoutGrid, BarChart3, ArrowDownToLine, ArrowUpFromLine, Cable } from 'lucide-react';
import type { GpuSample } from '../../store/gpuStore';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import GaugeCard from './GaugeCard';
import LiveChart from './LiveChart';
import RangeSelector from './RangeSelector';
import GpuTabs from './GpuTabs';
import StatsSection from './StatsSection';
import GpuProcessesTable from './GpuProcessesTable';
import UpdateBanner from '../ui/UpdateBanner';

export default function Dashboard() {
  const { t } = useTranslation();
  const latest = useGpuStore((s) => s.latest);
  const seriesMap = useGpuStore((s) => s.series);
  const samples = Array.from(latest.values()).sort((a, b) => a.gpu_index - b.gpu_index);
  const selectedGpu = useUiStore((s) => s.selectedGpu);
  const gaugeView = useUiStore((s) => s.gaugeView);
  const setGaugeView = useUiStore((s) => s.setGaugeView);

  if (samples.length === 0) {
    return (
      <>
        <UpdateBanner />
        <div className="card p-8 text-center" style={{ color: 'var(--gv-text-muted)' }}>
          {t('dashboard.no_gpu')}
        </div>
      </>
    );
  }

  const active = samples.find((s) => s.gpu_index === selectedGpu) ?? samples[0];
  const series = seriesMap.get(active.gpu_index);

  const memPct = active.memory_total ? (active.memory_used / active.memory_total) * 100 : 0;

  return (
    <div className="space-y-6">
      <UpdateBanner />
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <GpuTabs samples={samples} />

        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <div className="seg" role="group" aria-label="Gauge view">
            <button
              className="seg-btn inline-flex items-center gap-1"
              aria-pressed={gaugeView === 'arc'}
              onClick={() => setGaugeView('arc')}
              title={t('dashboard.view_arc')}
            >
              <LayoutGrid className="w-3.5 h-3.5" /> {t('dashboard.view_arc')}
            </button>
            <button
              className="seg-btn inline-flex items-center gap-1"
              aria-pressed={gaugeView === 'bar'}
              onClick={() => setGaugeView('bar')}
              title={t('dashboard.view_bar')}
            >
              <BarChart3 className="w-3.5 h-3.5" /> {t('dashboard.view_bar')}
            </button>
          </div>
          <RangeSelector />
        </div>
      </div>

      <header className="flex items-baseline gap-3 flex-wrap">
        <h2 className="text-xl font-semibold" style={{ color: 'var(--gv-text)' }}>{active.name}</h2>
        <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
          GPU #{active.gpu_index} · driver {active.driver_version || '-'}
        </span>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.temperature')}
          value={active.temperature}
          unit="°C"
          max={100}
          warn={75}
          danger={85}
          icon={<Thermometer className="w-4 h-4" />}
          history={series?.temperature}
          ts={active.timestamp_epoch}
        />
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.utilization')}
          value={active.utilization ?? 0}
          displayValue={active.utilization === null ? 'N/A' : undefined}
          unit="%"
          max={100}
          warn={85}
          danger={95}
          icon={<Activity className="w-4 h-4" />}
          history={series?.utilization?.map((v) => v ?? 0)}
          ts={active.timestamp_epoch}
        />
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.memory')}
          value={memPct}
          displayValue={`${fmt(active.memory_used)} MiB`}
          displaySubValue={`/ ${active.memory_total ? fmt(active.memory_total) : '?'} MiB`}
          unit=""
          max={100}
          warn={80}
          danger={92}
          icon={<MemoryStick className="w-4 h-4" />}
          history={series?.memory_used}
          ts={active.timestamp_epoch}
        />
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.fan')}
          value={active.fan_speed ?? 0}
          displayValue={active.fan_speed === null || active.fan_speed === undefined ? 'N/A' : undefined}
          unit="%"
          max={100}
          warn={75}
          danger={90}
          icon={<Fan className="w-4 h-4" />}
          history={series?.fan_speed?.map((v) => v ?? 0)}
          ts={active.timestamp_epoch}
        />
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.power')}
          value={active.power}
          unit="W"
          max={Math.max(300, Math.ceil(active.power * 1.4))}
          warn={250}
          danger={350}
          icon={<Zap className="w-4 h-4" />}
          history={series?.power}
          ts={active.timestamp_epoch}
        />
      </div>

      <LiveChart gpuIndex={active.gpu_index} />

      <PcieBandwidthCard sample={active} />

      <GpuProcessesTable gpuIndex={active.gpu_index} />

      <h3 className="text-sm font-semibold uppercase tracking-wider pt-2" style={{ color: 'var(--gv-text-muted)' }}>
        {t('dashboard.stats_24h')}
      </h3>
      <StatsSection gpuIndex={active.gpu_index} />
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// PCIe per-lane bandwidth (GB/s) — PCI-SIG figures.
const PCIE_PER_LANE_GBPS: Record<number, number> = {
  1: 0.25, 2: 0.5, 3: 0.985, 4: 1.969, 5: 3.938, 6: 7.563,
};

function pcieBandwidth(gen: number | null | undefined, width: number | null | undefined): number | null {
  if (!gen || !width) return null;
  const perLane = PCIE_PER_LANE_GBPS[gen];
  if (!perLane) return null;
  return Math.round(perLane * width * 100) / 100;
}

function PcieBandwidthCard({ sample }: Readonly<{ sample: GpuSample }>) {
  const { t } = useTranslation();
  const rxTx = pcieBandwidth(sample.pcie_gen_current, sample.pcie_width_current);
  const max = pcieBandwidth(sample.pcie_gen_max, sample.pcie_width_max);
  // Hide the card entirely when the driver doesn't expose anything useful.
  if (rxTx === null && !sample.pci_bus_id) return null;

  const link = sample.pcie_gen_current && sample.pcie_width_current
    ? `PCIe ${sample.pcie_gen_current}.0 ×${sample.pcie_width_current}`
    : '-';

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2"
            style={{ color: 'var(--gv-text-muted)' }}>
          <Cable className="w-4 h-4" />
          {t('dashboard.pcie_title')}
        </h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-mono tabular-nums"
              style={{ color: 'var(--gv-text-muted)', background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
          {sample.pci_bus_id ?? '-'}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <PcieMetric
          icon={<ArrowDownToLine className="w-4 h-4" />}
          label={t('dashboard.pcie_rx')}
          value={rxTx}
          max={max}
        />
        <PcieMetric
          icon={<ArrowUpFromLine className="w-4 h-4" />}
          label={t('dashboard.pcie_tx')}
          value={rxTx}
          max={max}
        />
        <div className="rounded-lg p-2.5"
             style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
            {t('dashboard.pcie_link')}
          </div>
          <div className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: 'var(--gv-text)' }}>
            {link}
          </div>
        </div>
      </div>
      <p className="text-[10px] mt-2" style={{ color: 'var(--gv-text-dim)' }}>
        {t('dashboard.pcie_help')}
      </p>
    </div>
  );
}

function PcieMetric({ icon, label, value, max }: Readonly<{
  icon: React.ReactNode; label: string; value: number | null; max: number | null;
}>) {
  return (
    <div
      className="rounded-lg p-2.5"
      style={{
        background: 'color-mix(in srgb, var(--gv-info) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-info) 25%, transparent)',
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider"
           style={{ color: 'var(--gv-info)' }}>
        {icon}
        {label}
      </div>
      <div className="flex items-baseline gap-1.5 mt-1">
        <span className="text-lg font-semibold tabular-nums" style={{ color: 'var(--gv-info)' }}>
          {value !== null ? value.toFixed(2) : '-'}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--gv-text-dim)' }}>GB/s</span>
      </div>
      {max !== null && value !== null && max > value && (
        <div className="text-[10px] tabular-nums mt-0.5" style={{ color: 'var(--gv-text-dim)' }}>
          / max {max.toFixed(2)} GB/s
        </div>
      )}
    </div>
  );
}
