import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, MemoryStick, Server, HardDrive, Activity, RefreshCw, Gauge } from 'lucide-react';
import { api } from '../../lib/api';

type SystemInfo = Readonly<{
  host: {
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    uptime: number;
    loadavg: number[];
    os: { name: string; prettyName: string | null; version: string | null; id: string | null };
  };
  cpu: { model: string; cores: number; speedMHz: number };
  memory: { total: number; free: number; used: number; usedPct: number };
  process: { nodeVersion: string; pid: number; uptime: number; rss: number };
  gpus: Array<{
    gpu_index: number;
    name: string;
    uuid: string | null;
    driver_version: string | null;
    memory_total: number | null;
    memory_used: number;
    temperature: number;
    utilization: number | null;
    power: number;
    fan_speed: number | null;
    clock_graphics: number | null;
    clock_memory: number | null;
  }>;
}>;

export default function SystemPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api<SystemInfo>('/system')
      .then(setInfo)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Server className="w-5 h-5" /> {t('system.title')}
          </h1>
          <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('system.subtitle')}</p>
        </div>
        <button className="btn-ghost" onClick={load} disabled={loading}>
          <RefreshCw className={'w-4 h-4 ' + (loading ? 'animate-spin' : '')} />
          {t('common.refresh')}
        </button>
      </div>

      {error && (
        <div className="card p-3 text-sm" style={{ color: 'var(--gv-warn)' }}>
          {t('common.error')}: {error}
        </div>
      )}

      {info && (
        <>
          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Server className="w-4 h-4" /> {t('system.host')}
            </h2>
            <Grid>
              <KV label={t('system.os')} value={info.host.os.prettyName ?? info.host.os.name} />
              <KV label={t('system.kernel')} value={`${info.host.platform} ${info.host.release}`} />
              <KV label={t('system.arch')} value={info.host.arch} />
              <KV label={t('system.hostname')} value={info.host.hostname} />
              <KV label={t('system.uptime')} value={fmtUptime(info.host.uptime)} />
              <KV label={t('system.loadavg')} value={info.host.loadavg.map((n) => n.toFixed(2)).join(' · ')} />
            </Grid>
          </section>

          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Cpu className="w-4 h-4" /> {t('system.cpu')}
            </h2>
            <Grid>
              <KV label={t('system.cpu_model')} value={info.cpu.model} mono />
              <KV label={t('system.cpu_cores')} value={String(info.cpu.cores)} />
              <KV label={t('system.cpu_speed')} value={`${info.cpu.speedMHz} MHz`} />
            </Grid>
          </section>

          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <MemoryStick className="w-4 h-4" /> {t('system.memory')}
            </h2>
            <Grid>
              <KV label={t('system.mem_total')} value={fmtBytes(info.memory.total)} />
              <KV label={t('system.mem_used')} value={`${fmtBytes(info.memory.used)} (${info.memory.usedPct.toFixed(1)}%)`} />
              <KV label={t('system.mem_free')} value={fmtBytes(info.memory.free)} />
            </Grid>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--gv-surface-alt)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(0, Math.min(100, info.memory.usedPct))}%`,
                  background: 'linear-gradient(90deg, color-mix(in srgb, var(--gv-accent) 55%, transparent), var(--gv-accent))',
                }}
              />
            </div>
          </section>

          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4" /> {t('system.process')}
            </h2>
            <Grid>
              <KV label="Node" value={info.process.nodeVersion} mono />
              <KV label="PID" value={String(info.process.pid)} />
              <KV label={t('system.uptime')} value={fmtUptime(info.process.uptime)} />
              <KV label="RSS" value={fmtBytes(info.process.rss)} />
            </Grid>
          </section>

          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Gauge className="w-4 h-4" /> {t('system.gpus')} ({info.gpus.length})
            </h2>
            {info.gpus.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('system.no_gpu')}</p>
            ) : (
              <div className="space-y-3">
                {info.gpus.map((g) => (
                  <div key={g.gpu_index} className="rounded-xl p-3" style={{ background: 'var(--gv-surface-alt)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <HardDrive className="w-4 h-4" style={{ color: 'var(--gv-accent)' }} />
                      <span className="font-semibold">#{g.gpu_index} · {g.name}</span>
                    </div>
                    <Grid>
                      <KV label={t('system.gpu_uuid')} value={g.uuid ?? '-'} mono />
                      <KV label={t('system.gpu_driver')} value={g.driver_version ?? '-'} />
                      <KV label={t('system.gpu_memory')} value={`${g.memory_used} / ${g.memory_total ?? '?'} MiB`} />
                      <KV label={t('system.gpu_temp')} value={`${g.temperature} °C`} />
                      <KV label={t('system.gpu_util')} value={g.utilization === null ? 'N/A' : `${g.utilization}%`} />
                      <KV label={t('system.gpu_power')} value={`${g.power.toFixed(1)} W`} />
                      <KV label={t('system.gpu_fan')} value={g.fan_speed === null ? '-' : `${g.fan_speed}%`} />
                      <KV label={t('system.gpu_clk_gr')} value={g.clock_graphics === null ? '-' : `${g.clock_graphics} MHz`} />
                      <KV label={t('system.gpu_clk_mem')} value={g.clock_memory === null ? '-' : `${g.clock_memory} MHz`} />
                    </Grid>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Grid({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">{children}</div>;
}

function KV({ label, value, mono }: Readonly<{ label: string; value: string; mono?: boolean }>) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>{label}</div>
      <div className={'tabular-nums ' + (mono ? 'font-mono text-xs' : '')} style={{ color: 'var(--gv-text)' }}>{value}</div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
