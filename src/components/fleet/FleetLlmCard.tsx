import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { api } from '../../lib/api';
import { pollWhileVisible } from '../../lib/poll';
import { LOCAL_HOST_ID } from '../../store/hostsStore';
import { LlmStateBadge, ContainerBadge } from '../dashboard/ProcessExtras';

interface FleetLlmRow {
  host_id: string;
  host_label: string;
  gpu_index: number | null;
  gpu_name: string | null;
  pid: number;
  gpu_uuid: string;
  process_name: string;
  used_memory: number;
  gtt_memory?: number | null;
  llm_runtime: string;
  llm_model?: string | null;
  llm_state?: 'loaded' | 'idle' | null;
  llm_expires_at?: number | null;
  container_engine?: string | null;
  container_id?: string | null;
}

const REFRESH_MS = 10_000;

/** Same labels as the process table badge. */
const LABELS: Record<string, string> = {
  ollama: 'Ollama',
  vllm: 'vLLM',
  llamacpp: 'llama.cpp',
  koboldcpp: 'KoboldCpp',
  oobabooga: 'oobabooga',
  comfyui: 'ComfyUI',
  sdwebui: 'SD WebUI',
  lmstudio: 'LM Studio',
};

/** Every LLM model the fleet's agents report, one row per process: host,
 *  card, runtime, model, state, GPU memory. Hidden when there is none. */
export default function FleetLlmCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rows, setRows] = useState<FleetLlmRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api<{ processes: FleetLlmRow[] }>('/processes/llm');
        if (!cancelled) setRows(r.processes);
      } catch { /* keep the last list */ }
    };
    void tick();
    const stop = pollWhileVisible(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    a.host_label.localeCompare(b.host_label) || b.used_memory + (b.gtt_memory ?? 0) - (a.used_memory + (a.gtt_memory ?? 0)));

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2 mb-3" style={{ color: 'var(--gv-text-muted)' }}>
        <Bot className="w-4 h-4" /> {t('fleet.llm_title')}
        <span className="text-[10px] px-2 py-0.5 rounded-full normal-case tracking-normal"
              style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
          {rows.length}
        </span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left" style={{ color: 'var(--gv-text-muted)' }}>
              <th className="py-1.5 pr-3 font-medium">{t('fleet.llm_host')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('fleet.llm_runtime')}</th>
              <th className="py-1.5 pr-3 font-medium">{t('fleet.llm_model')}</th>
              <th className="py-1.5 pr-3 font-medium text-right">{t('dashboard.processes_vram')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.host_id}-${r.pid}-${r.gpu_uuid}`} className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
                <td className="py-1.5 pr-3">
                  <button
                    type="button"
                    className="font-semibold hover:underline text-left"
                    onClick={() => navigate(r.host_id === LOCAL_HOST_ID ? '/' : `/host/${r.host_id}`)}
                  >
                    {r.host_label}
                  </button>
                  {r.gpu_index !== null && (
                    <span className="ml-1.5" style={{ color: 'var(--gv-text-dim)' }}>
                      GPU #{r.gpu_index}{r.gpu_name ? ` · ${r.gpu_name}` : ''}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <span className="font-semibold" style={{ color: 'var(--gv-info)' }}>{LABELS[r.llm_runtime] ?? r.llm_runtime}</span>
                </td>
                <td className="py-1.5 pr-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono font-semibold" style={{ color: 'var(--gv-ok)' }}>{r.llm_model ?? r.process_name}</span>
                    <LlmStateBadge state={r.llm_state ?? null} expiresAt={r.llm_expires_at ?? null} />
                    {r.container_id && <ContainerBadge engine={r.container_engine ?? null} id={r.container_id} />}
                  </div>
                </td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                  {(r.used_memory + (r.gtt_memory ?? 0)).toLocaleString()} MiB
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
