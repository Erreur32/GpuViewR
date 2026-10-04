import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';
import { api } from '../../lib/api';
import { pollWhileVisible } from '../../lib/poll';
import { HiddenProcessesNotice, LLM_HINTS, LlmHintIcon, LlmHintPanel, type HiddenProcesses, type LlmHint } from './ProcessHints';
import { ContainerBadge, EmbeddingBadge, LlmOnlySwitch, LlmStateBadge, ProcessFilter, ProcessTop, VramCell, gpuMemoryMib, isEmbeddingProcess, residualGpuPct } from './ProcessExtras';
import { useUiStore } from '../../store/uiStore';

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
  llm_hint?: LlmHint | null;
  llm_state?: 'loaded' | 'idle' | null;
  llm_expires_at?: number | null;
  gtt_memory?: number | null;
  container_engine?: string | null;
  container_id?: string | null;
}

interface ApiResp {
  timestamp_epoch: number;
  count: number;
  processes: GpuProcess[];
  /** Hub-provided hint when a remote host's snapshot is missing or stale. */
  reason?: string;
  /** Set when VRAM in use isn't explained by the listed processes. */
  hidden?: HiddenProcesses;
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
  const [hidden, setHidden] = useState<HiddenProcesses | null>(null);
  // Row whose model-name hint panel is expanded (`${pid}-${gpu_uuid}`).
  const [openHint, setOpenHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await api<ApiResp>(`/processes?gpu=${gpuIndex}&host=${encodeURIComponent(hostId)}`);
        if (cancelled) return;
        setData(r.processes);
        setReason(r.reason ?? null);
        setHidden(r.hidden ?? null);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    void tick();
    const stop = pollWhileVisible(tick, REFRESH_MS);

    return () => {
      cancelled = true;
      stop();
    };
  }, [gpuIndex, hostId]);

  const filterOn = useUiStore((s) => s.processFilterOn);
  const threshold = useUiStore((s) => s.processMinMib);
  const minMib = filterOn ? threshold : 0;
  const llmOnly = useUiStore((s) => s.processLlmOnly);
  // LLMs first (the point of this table), then by VRAM + GTT so APU / iGPU
  // processes rank by what they really use.
  const all = [...data].sort((a, b) =>
    Number(!!b.llm_runtime) - Number(!!a.llm_runtime) || gpuMemoryMib(b) - gpuMemoryMib(a));
  const llmRows = llmOnly ? all.filter((p) => !!p.llm_runtime) : all;
  const sorted = minMib === 0 ? llmRows : llmRows.filter((p) => gpuMemoryMib(p) >= minMib);
  // Each control counts what it hides, the empty-state message the total.
  const hiddenByLlm = all.length - llmRows.length;
  const hiddenByMemory = llmRows.length - sorted.length;
  const hiddenSmall = all.length - sorted.length;
  // The card's utilisation only stands in for the one process without a
  // GPU %, minus what the measured ones use (an Ollama ROCm runner next to
  // a Vulkan llama.cpp). With several unknowns, copying it on
  // every row (3 Ollama runners all at "~100%") says something false.
  const cardFallback = residualGpuPct(all, gpuUtilFallback);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2"
            style={{ color: 'var(--gv-text-muted)' }}>
          <Cpu className="w-4 h-4" />
          {t('dashboard.processes_title')}
        </h3>
        <div className="flex items-center gap-2">
          <ProcessFilter hiddenCount={hiddenByMemory} />
          <span className="text-[10px] px-2 py-0.5 rounded-full"
                style={{ color: 'var(--gv-text-muted)', background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
            {sorted.length} {t('dashboard.processes_count')}
          </span>
        </div>
      </div>

      {error && (
        <p className="text-xs" style={{ color: 'var(--gv-warn)' }}>{t('dashboard.processes_error')}</p>
      )}

      {!error && hidden && <HiddenProcessesNotice hidden={hidden} />}

      {!error && sorted.length === 0 && hiddenSmall > 0 && (
        <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
          {llmOnly ? t('dashboard.llm_only_empty', { count: hiddenSmall }) : t('dashboard.filter_all_hidden', { count: hiddenSmall, mib: minMib.toLocaleString() })}
        </p>
      )}

      {!error && all.length === 0 && !loading && (
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
              {sorted.map((p) => {
                const rowKey = `${p.pid}-${p.gpu_uuid}`;
                const hint = modelHint(p);
                return (
                <tr key={rowKey} className="border-t align-top" style={{ borderColor: 'var(--gv-border)' }}>
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
                      {p.llm_model && (
                        <span className="font-mono text-[11px] font-semibold truncate" style={{ color: MODEL_COLOR }}>
                          {p.llm_model}
                        </span>
                      )}
                      {isEmbeddingProcess(p) && <EmbeddingBadge />}
                      {p.llm_runtime && <LlmStateBadge state={p.llm_state ?? null} expiresAt={p.llm_expires_at ?? null} />}
                      {p.container_id && <ContainerBadge engine={p.container_engine ?? null} id={p.container_id} />}
                      {hint && (
                        <LlmHintIcon
                          hint={hint}
                          open={openHint === rowKey}
                          onToggle={() => setOpenHint(openHint === rowKey ? null : rowKey)}
                        />
                      )}
                    </div>
                    {hint && openHint === rowKey && <LlmHintPanel hint={hint} />}
                    {p.command && p.command !== p.process_name && (
                      <div className="text-[10px] font-mono break-all line-clamp-2" title={p.command}>
                        <CommandLine command={p.command} />
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">
                    <GpuPctCell
                      value={p.gpu_pct}
                      fallback={cardFallback}
                      tooltip={t('dashboard.processes_gpu_pct_approx')}
                      unknownTooltip={t('dashboard.processes_gpu_pct_unknown')}
                    />
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">
                    <VramCell vram={p.used_memory} gtt={p.gtt_memory ?? null} />
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">{fmtPct(p.cpu_pct)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-start justify-between gap-3 flex-wrap">
        <ProcessTop hostId={hostId} gpuIndex={gpuIndex} />
        <LlmOnlySwitch hiddenCount={hiddenByLlm} />
      </div>
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

const MODEL_COLOR = 'var(--gv-ok)';

/** Agent-provided hint, or derived for agents older than llm_hint
 *  whose unresolved Ollama names still arrive as `sha256:<prefix>`. */
function modelHint(p: GpuProcess): LlmHint | null {
  // Allow-list: the value picks an i18n key, ignore anything unknown.
  if (p.llm_hint) return LLM_HINTS.includes(p.llm_hint) ? p.llm_hint : null;
  return p.llm_runtime && p.llm_model?.startsWith('sha256:') ? 'ollama_manifests' : null;
}

/** Flags whose value names the loaded model (llama.cpp, vLLM, ollama
 *  runner, KoboldCpp). Mirrors the agent's llmClassifier lookups. */
const MODEL_FLAGS = new Set(['-m', '--model', '-hf', '--hf-repo', '--alias']);

const TOKEN_COLORS = {
  flag: 'var(--gv-text-muted)',
  model: MODEL_COLOR,
  value: 'var(--gv-text)',
} as const;
type TokenRole = keyof typeof TOKEN_COLORS;

/** Command line split on spaces and coloured by role: flags dim, values
 *  and the executable in the regular text colour, model values in
 *  MODEL_COLOR. Plain space scan, no regex (see SonarCloud S5852). */
function CommandLine({ command }: Readonly<{ command: string }>) {
  const tokens: { text: string; offset: number; role: TokenRole }[] = [];
  let offset = 0;
  let prev = '';
  for (const text of command.split(' ')) {
    if (text) {
      let role: TokenRole = 'value';
      if (text.startsWith('-')) role = 'flag';
      else if (MODEL_FLAGS.has(prev)) role = 'model';
      tokens.push({ text, offset, role });
      prev = text;
    }
    offset += text.length + 1;
  }
  return (
    <>
      {tokens.map((tok) => (
        <span
          key={tok.offset}
          className={tok.role === 'model' ? 'font-semibold' : undefined}
          style={{ color: TOKEN_COLORS[tok.role] }}
        >
          {tok.text}{' '}
        </span>
      ))}
    </>
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
function GpuPctCell({ value, fallback, tooltip, unknownTooltip }: Readonly<{
  value: number | null | undefined;
  fallback: number | null;
  tooltip: string;
  unknownTooltip: string;
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
  return <span style={{ color: 'var(--gv-text-dim)' }} title={unknownTooltip}>-</span>;
}
