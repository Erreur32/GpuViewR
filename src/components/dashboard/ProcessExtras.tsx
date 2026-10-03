import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, History, Moon } from 'lucide-react';
import { api } from '../../lib/api';

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
    <details className="mt-3 text-xs" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer inline-flex items-center gap-1.5 select-none" style={{ color: 'var(--gv-text-muted)' }}>
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
