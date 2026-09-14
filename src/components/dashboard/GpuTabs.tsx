import { Layers, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/uiStore';
import type { GpuSample } from '../../store/gpuStore';
import { shortGpuName } from '../../lib/gpuName';
import { useDropdown } from '../../lib/useDropdown';
import DropdownPanel from '../ui/DropdownPanel';

// Collapsed dropdown instead of one tab per GPU: a host with many cards
// used to blow out the header width with an ever-growing .seg strip.
export default function GpuTabs({ samples }: { samples: GpuSample[] }) {
  const { t } = useTranslation();
  const selected = useUiStore((s) => s.selectedGpu);
  const setSelected = useUiStore((s) => s.setSelectedGpu);
  const dashboardView = useUiStore((s) => s.dashboardView);
  const setDashboardView = useUiStore((s) => s.setDashboardView);
  const { open, setOpen, rootRef } = useDropdown();

  if (samples.length <= 1) return null;
  const isAll = dashboardView === 'all';
  const active = samples.find((s) => s.gpu_index === selected) ?? samples[0];

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="seg-btn inline-flex items-center gap-1.5"
        style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t('dashboard.gpus_all_help')}
      >
        {isAll ? (
          <>
            <Layers className="w-3.5 h-3.5" /> {t('dashboard.gpus_all')}
          </>
        ) : (
          <>GPU #{active.gpu_index} <span className="opacity-60">{shortGpuName(active.name)}</span></>
        )}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <DropdownPanel label={t('dashboard.gpus_all_help')}>
          <button
            type="button"
            role="option"
            aria-selected={isAll}
            aria-pressed={isAll}
            className="seg-btn inline-flex items-center gap-1.5 text-left"
            onClick={() => { setDashboardView('all'); setOpen(false); }}
          >
            <Layers className="w-3.5 h-3.5" /> {t('dashboard.gpus_all')}
          </button>
          {samples.map((s) => (
            <button
              key={s.gpu_index}
              type="button"
              role="option"
              aria-selected={!isAll && s.gpu_index === selected}
              aria-pressed={!isAll && s.gpu_index === selected}
              className="seg-btn text-left"
              onClick={() => {
                setDashboardView('single');
                setSelected(s.gpu_index);
                setOpen(false);
              }}
              title={s.name}
            >
              GPU #{s.gpu_index} <span className="opacity-60 ml-1">{shortGpuName(s.name)}</span>
            </button>
          ))}
        </DropdownPanel>
      )}
    </div>
  );
}
