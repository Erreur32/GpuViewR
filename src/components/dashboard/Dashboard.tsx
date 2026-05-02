import { useTranslation } from 'react-i18next';
import { Thermometer, Activity, MemoryStick, Zap, LayoutGrid, BarChart3 } from 'lucide-react';
import { useGpuStream } from '../../lib/useGpuStream';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import GaugeCard from './GaugeCard';
import LiveChart from './LiveChart';
import RangeSelector from './RangeSelector';
import GpuTabs from './GpuTabs';
import StatsSection from './StatsSection';
import UpdateBanner from '../ui/UpdateBanner';

export default function Dashboard() {
  const { t } = useTranslation();
  useGpuStream();

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
          GPU #{active.gpu_index} · driver {active.driver_version || '—'}
        </span>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
        />
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.utilization')}
          value={active.utilization}
          unit="%"
          max={100}
          warn={85}
          danger={95}
          icon={<Activity className="w-4 h-4" />}
          history={series?.utilization}
        />
        <GaugeCard
          variant={gaugeView}
          label={t('dashboard.metrics.memory')}
          value={memPct}
          displayValue={`${fmt(active.memory_used)} / ${active.memory_total ? fmt(active.memory_total) : '?'} MiB`}
          unit=""
          max={100}
          warn={80}
          danger={92}
          icon={<MemoryStick className="w-4 h-4" />}
          history={series?.memory_used}
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
        />
      </div>

      <LiveChart gpuIndex={active.gpu_index} />

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
