import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';
import { api } from '../../lib/api';

type GpuProcessType = 'C' | 'G' | 'G+C' | null;

interface GpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number;
  gpu_index: number | null;
  type?: GpuProcessType;
  command?: string | null;
  cpu_pct?: number | null;
  gpu_pct?: number | null;
  llm_runtime?: string | null;
  llm_model?: string | null;
}

interface ApiResp {
  timestamp_epoch: number;
  count: number;
  processes: GpuProcess[];
  /** Hub-provided hint when a remote host's snapshot is missing or stale. */
  reason?: string;
}

const REFRESH_MS = 2500;

interface Props {
  gpuIndex: number;
  hostId: string;
  /** Latest card-level GPU utilization. Used as a fallback for the
   *  per-process gpu_pct column when the underlying driver doesn't
   *  expose per-PID compute share — this is the case on AMD / ROCm
   *  on many kernels (rocm-smi returns cu_occupancy="unknown") and
   *  on NVIDIA when nvidia-smi pmon doesn't see the process. We
   *  paint the value italic+dim and surface a tooltip so the user
   *  understands it's an approximation, not a per-PID metric. */
  gpuUtilFallback?: number | null;
}

export default function GpuProcessesTable({ gpuIndex, hostId, gpuUtilFallback = null }: Readonly<Props>) {
  const { t } = useTranslation();
  const [data, setData] = useState<GpuProcess[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await api<ApiResp>(`/processes?gpu=${gpuIndex}&host=${encodeURIComponent(hostId)}`);
        if (cancelled) return;
        setData(r.processes);
        setReason(r.reason ?? null);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
    };

    setLoading(true);
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [gpuIndex, hostId]);

  const sorted = [...data].sort((a, b) => b.used_memory - a.used_memory);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2"
            style={{ color: 'var(--gv-text-muted)' }}>
          <Cpu className="w-4 h-4" />
          {t('dashboard.processes_title')}
        </h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full"
              style={{ color: 'var(--gv-text-muted)', background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
          {sorted.length} {t('dashboard.processes_count')}
        </span>
      </div>

      {error && (
        <p className="text-xs" style={{ color: 'var(--gv-warn)' }}>{t('dashboard.processes_error')}</p>
      )}

      {!error && sorted.length === 0 && !loading && (
        <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
          {reason ? t('dashboard.processes_unavailable') : t('dashboard.processes_empty')}
          {reason && (
            <span className="block mt-0.5 opacity-70" title={reason}>
              {reason}
            </span>
          )}
        </p>
      )}

      {sorted.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left" style={{ color: 'var(--gv-text-muted)' }}>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider">{t('dashboard.processes_pid')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider">{t('dashboard.processes_type')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider">{t('dashboard.processes_name')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider text-right">{t('dashboard.processes_gpu_pct')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider text-right">{t('dashboard.processes_vram')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider text-right">{t('dashboard.processes_cpu_pct')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={`${p.pid}-${p.gpu_uuid}`} className="border-t align-top" style={{ borderColor: 'var(--gv-border)' }}>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{p.pid}</td>
                  <td className="py-1.5 pr-3"><TypeBadge type={p.type ?? null} /></td>
                  <td className="py-1.5 pr-3 max-w-[480px]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className="font-semibold truncate"
                        style={{ color: 'var(--gv-warn)' }}
                        title={p.command ?? p.process_name}
                      >
                        {p.process_name}
                      </span>
                      {p.llm_runtime && <LlmBadge runtime={p.llm_runtime} model={p.llm_model ?? null} />}
                    </div>
                    {p.command && p.command !== p.process_name && (
                      <div
                        className="text-[10px] font-mono truncate opacity-80"
                        style={{ color: 'var(--gv-text-dim)' }}
                        title={p.command}
                      >
                        {p.command}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">
                    <GpuPctCell value={p.gpu_pct} fallback={gpuUtilFallback} tooltip={t('dashboard.processes_gpu_pct_approx')} />
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">
                    {p.used_memory.toLocaleString()} <span style={{ color: 'var(--gv-text-dim)' }}>MiB</span>
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">{fmtPct(p.cpu_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TypeBadge({ type }: Readonly<{ type: 'C' | 'G' | 'G+C' | null }>) {
  if (!type) return <span style={{ color: 'var(--gv-text-dim)' }}>-</span>;
  // Compute → accent (blue), Graphics → info (cyan), G+C → warn (amber).
  // Same colour family as the metric chips so the eye groups them.
  const palette: Record<'C' | 'G' | 'G+C', { fg: string; label: string }> = {
    C:   { fg: 'var(--gv-accent)', label: 'Compute'  },
    G:   { fg: 'var(--gv-info)',   label: 'Graphics' },
    'G+C': { fg: 'var(--gv-warn)', label: 'G+C'      },
  };
  const p = palette[type];
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
      style={{
        color: p.fg,
        background: `color-mix(in srgb, ${p.fg} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${p.fg} 30%, transparent)`,
      }}
      title={p.label}
    >
      {type}
    </span>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return `${v.toFixed(v < 10 ? 1 : 0)}%`;
}

/** Small badge rendered next to the process name when the agent's
 *  classifier (agent/src/collectors/llmClassifier.ts) recognises the
 *  command line as a known local-inference stack — Ollama, llama.cpp,
 *  vLLM, ComfyUI, KoboldCpp, oobabooga, etc. The label is the runtime
 *  key (lowercase short id); the tooltip carries the resolved model
 *  identifier when present. Color comes from var(--gv-info) so it
 *  reads as informational, not warning. */
function LlmBadge({ runtime, model }: Readonly<{ runtime: string; model: string | null }>) {
  const label = LLM_LABELS[runtime] ?? runtime;
  const tooltip = model ? `${label} — ${model}` : label;
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
      style={{
        color: 'var(--gv-info)',
        background: 'color-mix(in srgb, var(--gv-info) 14%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-info) 30%, transparent)',
      }}
      title={tooltip}
    >
      {label}
    </span>
  );
}

/** Display labels for the runtime keys the agent's classifier emits.
 *  Keeping the mapping in the UI lets us show vendor-correct casing
 *  ("vLLM" not "vllm", "ComfyUI" not "comfyui") without coupling the
 *  agent code to display formatting. Unknown keys fall back to the
 *  raw id so adding a runtime in the classifier is non-breaking. */
const LLM_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  vllm: 'vLLM',
  llamacpp: 'llama.cpp',
  koboldcpp: 'KoboldCpp',
  oobabooga: 'oobabooga',
  comfyui: 'ComfyUI',
  sdwebui: 'SD WebUI',
  lmstudio: 'LM Studio',
};

/** Per-process GPU% cell. Falls back to the card-level utilization
 *  (passed in via `fallback`) when the agent couldn't get a per-PID
 *  reading from the driver (AMD/ROCm cu_occupancy=unknown, NVIDIA
 *  pmon non-match). The fallback value is rendered italic + dim with
 *  a `~` prefix and a tooltip so it's clearly distinguishable from
 *  an authoritative per-PID number. Returns "-" only when both
 *  primary AND fallback are unavailable. */
function GpuPctCell({ value, fallback, tooltip }: Readonly<{
  value: number | null | undefined;
  fallback: number | null;
  tooltip: string;
}>) {
  const hasReal = value !== null && value !== undefined && Number.isFinite(value);
  if (hasReal) return <span>{fmtPct(value)}</span>;
  if (fallback !== null && Number.isFinite(fallback)) {
    return (
      <span
        className="italic"
        style={{ color: 'var(--gv-text-dim)' }}
        title={tooltip}
      >
        ~{fmtPct(fallback)}
      </span>
    );
  }
  return <span>-</span>;
}
