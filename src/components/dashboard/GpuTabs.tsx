import { Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/uiStore';
import type { GpuSample } from '../../store/gpuStore';

export default function GpuTabs({ samples }: { samples: GpuSample[] }) {
  const { t } = useTranslation();
  const selected = useUiStore((s) => s.selectedGpu);
  const setSelected = useUiStore((s) => s.setSelectedGpu);
  const dashboardView = useUiStore((s) => s.dashboardView);
  const setDashboardView = useUiStore((s) => s.setDashboardView);

  if (samples.length <= 1) return null;
  const isAll = dashboardView === 'all';

  return (
    <div className="seg" role="tablist" aria-label="GPU selector">
      <button
        type="button"
        role="tab"
        aria-selected={isAll}
        className="seg-btn inline-flex items-center gap-1.5"
        onClick={() => setDashboardView('all')}
        title={t('dashboard.gpus_all_help')}
      >
        <Layers className="w-3.5 h-3.5" /> {t('dashboard.gpus_all')}
      </button>
      {samples.map((s) => (
        <button
          key={s.gpu_index}
          type="button"
          role="tab"
          aria-selected={!isAll && s.gpu_index === selected}
          className="seg-btn"
          onClick={() => { setDashboardView('single'); setSelected(s.gpu_index); }}
          title={s.name}
        >
          GPU #{s.gpu_index} <span className="opacity-60 ml-1">{shortName(s.name)}</span>
        </button>
      ))}
    </div>
  );
}

function shortName(name: string): string {
  return name
    .replace(/^NVIDIA\s+/i, '')
    .replace(/\s+(?:GeForce|Quadro|Tesla)\s+/i, ' ')
    .trim();
}
