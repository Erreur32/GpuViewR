import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Filter, History, Moon, Waypoints } from 'lucide-react';
import { api } from '../../lib/api';
import { useDropdown } from '../../lib/useDropdown';
import { useUiStore, PROCESS_MIN_MIB_MAX } from '../../store/uiStore';

const pill = (color: string) => ({
  color,
  background: `color-mix(in srgb, ${color} 12%, transparent)`,
  border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
});

/** "in 21 min" / "dans 21 min" until an Ollama model unloads. */
function untilText(epoch: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const min = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  return min >= 60 ? t('dashboard.llm_unloads_h', { h: Math.round(min / 60) }) : t('dashboard.llm_unloads_min', { min });
}

/** "asleep" pill for a llama.cpp server holding no weights, unload
 *  countdown for an Ollama model. Nothing for a plain loaded model. */
export function LlmStateBadge({ state, expiresAt }: Readonly<{ state: 'loaded' | 'idle' | null; expiresAt: number | null }>) {
  const { t } = useTranslation();
  if (state === 'idle') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
        style={pill('var(--gv-text-muted)')}
        title={t('dashboard.llm_idle_help')}
      >
        <Moon className="w-2.5 h-2.5" /> {t('dashboard.llm_idle')}
      </span>
    );
  }
  if (expiresAt) {
    return (
      <span className="text-[10px]" style={{ color: 'var(--gv-text-dim)' }} title={new Date(expiresAt * 1000).toLocaleString()}>
        {untilText(expiresAt, t)}
      </span>
    );
  }
  return null;
}

/** `docker 9692a12e`: the container the process runs in (from its
 *  cgroup). The tooltip gives the command that names it. */
export function ContainerBadge({ engine, id }: Readonly<{ engine: string | null; id: string }>) {
  const { t } = useTranslation();
  const short = id.slice(0, 8);
  const cmd = engine === 'podman' ? `podman ps | grep ${short}` : `docker ps | grep ${short}`;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono"
      style={pill('var(--gv-text-muted)')}
      title={t('dashboard.container_help', { engine: engine ?? 'container', id, cmd })}
    >
      <Box className="w-2.5 h-2.5" /> {engine ?? 'ctr'} {short}
    </span>
  );
}

/** VRAM, plus the system memory mapped to the GPU (GTT) when there is
 *  some: on AMD APUs and Intel iGPUs that is where a model often lives. */
export function VramCell({ vram, gtt }: Readonly<{ vram: number; gtt: number | null }>) {
  const { t } = useTranslation();
  return (
    <>
      {vram.toLocaleString()} <span style={{ color: 'var(--gv-text-dim)' }}>MiB</span>
      {gtt !== null && gtt > 0 && (
        <div className="text-[10px]" style={{ color: 'var(--gv-text-dim)' }} title={t('dashboard.gtt_help')}>
          + {gtt.toLocaleString()} MiB GTT
        </div>
      )}
    </>
  );
}

interface TopRow {
  pkey: string;
  name: string;
  runtime: string | null;
  model: string | null;
  gpu_index: number | null;
  vram_max: number;
  vram_avg: number;
  gpu_avg: number | null;
  minutes: number;
  last_seen: number;
}

const HOURS = 24;

/** Collapsible "Top 24 h" under the process table: per process (or LLM
 *  model), peak and mean GPU memory, mean GPU %, time seen. Fetched when
 *  opened. */
export function ProcessTop({ hostId, gpuIndex }: Readonly<{ hostId: string; gpuIndex: number }>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TopRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRows(null);
    setFailed(false);
    api<{ top: TopRow[] }>(`/processes/history?host=${encodeURIComponent(hostId)}&hours=${HOURS}`)
      .then((r) => { if (!cancelled) setRows(r.top.filter((x) => x.gpu_index === null || x.gpu_index === gpuIndex)); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, hostId, gpuIndex]);

  return (
    <details className={`text-xs ${open ? 'basis-full order-last' : ''}`} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="gv-link-hover cursor-pointer inline-flex items-center gap-1.5 select-none">
        <History className="w-3.5 h-3.5" /> {t('dashboard.top_title', { hours: HOURS })}
      </summary>
      <div className="mt-2">
        {failed && <p style={{ color: 'var(--gv-warn)' }}>{t('dashboard.processes_error')}</p>}
        {!failed && rows === null && <p style={{ color: 'var(--gv-text-dim)' }}>…</p>}
        {rows?.length === 0 && <p style={{ color: 'var(--gv-text-dim)' }}>{t('dashboard.top_empty')}</p>}
        {rows && rows.length > 0 && (
          <table className="w-full">
            <thead>
              <tr className="text-left" style={{ color: 'var(--gv-text-muted)' }}>
                <th className="py-1 pr-3 font-medium">{t('dashboard.processes_name')}</th>
                <th className="py-1 pr-3 font-medium text-right">{t('dashboard.top_vram_max')}</th>
                <th className="py-1 pr-3 font-medium text-right">{t('dashboard.top_vram_avg')}</th>
                <th className="py-1 pr-3 font-medium text-right">{t('dashboard.top_gpu_avg')}</th>
                <th className="py-1 pr-3 font-medium text-right">{t('dashboard.top_seen')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pkey} className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
                  <td className="py-1 pr-3">
                    <span className="font-semibold">{r.name}</span>
                    {r.model && <span className="ml-1.5 font-mono" style={{ color: 'var(--gv-ok)' }}>{r.model}</span>}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">{r.vram_max.toLocaleString()} MiB</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">{r.vram_avg.toLocaleString()} MiB</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">{r.gpu_avg === null ? '-' : `${r.gpu_avg}%`}</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums" title={new Date(r.last_seen * 1000).toLocaleString()}>
                    {r.minutes >= 60 ? `${Math.round(r.minutes / 6) / 10} h` : `${r.minutes} min`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

/** GPU memory a process holds: VRAM plus GTT (APUs and iGPUs). */
export function gpuMemoryMib(p: Readonly<{ used_memory: number; gtt_memory?: number | null }>): number {
  return p.used_memory + (p.gtt_memory ?? 0);
}

/** Embedding model (vectors for search / RAG, not chat): a runner started
 *  with --embedding(s) (Ollama, llama.cpp) or vLLM's embed task, or a
 *  model whose name says so (bge-*, *embed*). Plain token scan, no regex
 *  over the command line. */
export function isEmbeddingProcess(p: Readonly<{ command?: string | null; llm_model?: string | null; llm_runtime?: string | null }>): boolean {
  if (!p.llm_runtime) return false;
  const tokens = (p.command ?? '').split(' ');
  if (tokens.includes('--embedding') || tokens.includes('--embeddings')) return true;
  const task = tokens.indexOf('--task');
  if (task >= 0 && (tokens[task + 1] === 'embed' || tokens[task + 1] === 'embedding')) return true;
  const model = (p.llm_model ?? '').toLowerCase();
  return model.includes('embed') || model.startsWith('bge-') || model.includes('/bge-');
}

export function EmbeddingBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
      style={pill('var(--gv-text-muted)')}
      title={t('dashboard.embedding_help')}
    >
      <Waypoints className="w-2.5 h-2.5" /> {t('dashboard.embedding')}
    </span>
  );
}

const FILTER_PRESETS = [0, 64, 256, 1024] as const;

/** Header control of the process table: hide processes below N MiB of GPU
 *  memory. Remembered per browser (uiStore). Shows how many rows the
 *  filter hides, so nothing disappears silently. */
export function ProcessFilter({ hiddenCount }: Readonly<{ hiddenCount: number }>) {
  const { t } = useTranslation();
  const threshold = useUiStore((s) => s.processMinMib);
  const active = useUiStore((s) => s.processFilterOn);
  const setMinMib = useUiStore((s) => s.setProcessMinMib);
  const { open, setOpen, rootRef } = useDropdown();
  const minMib = active ? threshold : 0;
  const color = active ? 'var(--gv-accent)' : 'var(--gv-text-muted)';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
        style={{ color, background: 'var(--gv-surface-alt)', border: `1px solid ${active ? 'color-mix(in srgb, var(--gv-accent) 45%, transparent)' : 'var(--gv-border)'}` }}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('dashboard.filter_title')}
      >
        <Filter className="w-3 h-3" />
        {active ? t('dashboard.filter_active', { mib: threshold.toLocaleString() }) : t('dashboard.filter_off')}
        {hiddenCount > 0 && (
          <span className="font-semibold">· {t('dashboard.filter_hidden', { count: hiddenCount })}</span>
        )}
      </button>
      {open && (
        // Non-modal <dialog open>: reset the UA styles (centered, margin, colours).
        <dialog
          open
          aria-label={t('dashboard.filter_title')}
          className="absolute right-0 left-auto top-full m-0 mt-1 z-20 w-64 p-3 rounded-lg text-xs space-y-2"
          style={{ color: 'inherit', background: 'var(--gv-bg2)', border: '1px solid var(--gv-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}
        >
          <div className="font-semibold" style={{ color: 'var(--gv-text)' }}>{t('dashboard.filter_title')}</div>
          <p style={{ color: 'var(--gv-text-dim)' }}>{t('dashboard.filter_help')}</p>
          <div className="flex flex-wrap gap-1">
            {FILTER_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                className="px-2 py-0.5 rounded"
                style={{
                  color: v === minMib ? 'var(--gv-accent-fg)' : 'var(--gv-text)',
                  background: v === minMib ? 'var(--gv-accent)' : 'var(--gv-surface-alt)',
                  border: '1px solid var(--gv-border)',
                }}
                onClick={() => setMinMib(v)}
              >
                {v === 0 ? t('dashboard.filter_none') : `${v.toLocaleString()} MiB`}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2" style={{ color: 'var(--gv-text-muted)' }}>
            {t('dashboard.filter_custom')}
            <input
              type="number"
              min={0}
              max={PROCESS_MIN_MIB_MAX}
              step={16}
              className="input !py-0.5 !px-1.5 w-24"
              value={threshold}
              onChange={(e) => setMinMib(Number.parseInt(e.target.value, 10) || 0)}
            />
            <span>MiB</span>
          </label>
        </dialog>
      )}
    </div>
  );
}

/** Switch under the process table (next to "Top over 24 h"): show only
 *  LLM processes, the main thing this table is for. The memory threshold
 *  stays in the header filter. */
export function LlmOnlySwitch({ hiddenCount }: Readonly<{ hiddenCount: number }>) {
  const { t } = useTranslation();
  const on = useUiStore((s) => s.processLlmOnly);
  const setOn = useUiStore((s) => s.setProcessLlmOnly);
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-xs select-none" style={{ color: 'var(--gv-text-muted)' }}
           title={t('dashboard.llm_only_help')}>
      <input type="checkbox" className="sr-only" checked={on} onChange={(e) => setOn(e.target.checked)} />
      <span className="w-8 h-4 rounded-full transition-colors relative shrink-0" aria-hidden="true"
            style={{ background: on ? 'var(--gv-accent)' : 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
        <span className="absolute top-px left-px w-3 h-3 rounded-full bg-white transition-transform"
              style={{ transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
      </span>
      {t('dashboard.llm_only')}
      {hiddenCount > 0 && (
        <span style={{ color: 'var(--gv-accent)' }}>· {t('dashboard.filter_hidden', { count: hiddenCount })}</span>
      )}
    </label>
  );
}
