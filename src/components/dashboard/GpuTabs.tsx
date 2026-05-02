import { useUiStore } from '../../store/uiStore';
import type { GpuSample } from '../../store/gpuStore';

export default function GpuTabs({ samples }: { samples: GpuSample[] }) {
  const selected = useUiStore((s) => s.selectedGpu);
  const setSelected = useUiStore((s) => s.setSelectedGpu);

  if (samples.length <= 1) return null;

  return (
    <div className="seg" role="tablist" aria-label="GPU selector">
      {samples.map((s) => (
        <button
          key={s.gpu_index}
          role="tab"
          aria-pressed={s.gpu_index === selected}
          className="seg-btn"
          onClick={() => setSelected(s.gpu_index)}
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
