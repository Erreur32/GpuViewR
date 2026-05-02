import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu } from 'lucide-react';
import { api } from '../../lib/api';

interface GpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number;
  gpu_index: number | null;
}

interface ApiResp {
  timestamp_epoch: number;
  count: number;
  processes: GpuProcess[];
}

const REFRESH_MS = 2500;

export default function GpuProcessesTable({ gpuIndex }: Readonly<{ gpuIndex: number }>) {
  const { t } = useTranslation();
  const [data, setData] = useState<GpuProcess[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await api<ApiResp>(`/processes?gpu=${gpuIndex}`);
        if (cancelled) return;
        setData(r.processes);
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
  }, [gpuIndex]);

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
        <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>{t('dashboard.processes_empty')}</p>
      )}

      {sorted.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left" style={{ color: 'var(--gv-text-muted)' }}>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider">{t('dashboard.processes_pid')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider">{t('dashboard.processes_name')}</th>
                <th className="py-1.5 pr-3 font-medium uppercase tracking-wider text-right">{t('dashboard.processes_vram')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={`${p.pid}-${p.gpu_uuid}`} className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{p.pid}</td>
                  <td className="py-1.5 pr-3 truncate max-w-[420px]" title={p.process_name}>{p.process_name}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums text-right">
                    {p.used_memory.toLocaleString()} <span style={{ color: 'var(--gv-text-dim)' }}>MiB</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
