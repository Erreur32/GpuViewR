import { Cpu, Server, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGpuStore, type GpuSample } from '../../store/gpuStore';
import { useHostsStore, effectiveStatus, type HostRecord } from '../../store/hostsStore';
import StatusPill from './StatusPill';
import GpuMiniTile from './GpuMiniTile';

type Props = Readonly<{
  host: HostRecord;
  onOpen?: () => void;
  /** Toggle from FleetPage's view selector. Detailed mode unfolds a
   *  per-GPU mini-tile (util/temp/power/mem + sparkline) below the
   *  hostname header. Default 'simple' keeps the existing compact
   *  "hottest GPU" tile. */
  detailed?: boolean;
}>;

function tempColor(t: number): string {
  if (t === 0) return 'var(--gv-text-dim)';
  if (t >= 80) return 'var(--gv-danger)';
  if (t >= 75) return 'var(--gv-orange)';
  if (t >= 70) return 'var(--gv-warn)';
  return 'var(--gv-ok)';
}

export default function HostCard({ host, onOpen, detailed = false }: Props) {
  const { t } = useTranslation();
  // Live samples for this host come from the gpuStore's internal
  // per-host map. We DON'T use the public `latest` projection here
  // because that one only mirrors the currently-selected host; the
  // Fleet view needs every host's latest at once.
  const samplesByHost = useGpuStore((s) => s.latestByHost);
  const hostSamples: GpuSample[] = Array.from(samplesByHost.get(host.id)?.values() ?? [])
    .sort((a, b) => a.gpu_index - b.gpu_index);

  const status = effectiveStatus(host);
  const isOffline = status === 'offline' || status === 'disabled' || status === 'pending';

  const hottest = hostSamples.reduce<GpuSample | null>(
    (max, g) => (max === null || g.temperature > max.temperature ? g : max),
    null,
  );
  const totalPower = hostSamples.reduce((sum, g) => sum + g.power, 0);

  const color = hottest ? tempColor(hottest.temperature) : 'var(--gv-text-dim)';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="card card-hover p-5 flex flex-col gap-4 text-left w-full"
      style={{ opacity: isOffline ? 0.55 : 1 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Server size={18} style={{ color: 'var(--gv-text-muted)', flexShrink: 0 }} />
          <div className="min-w-0">
            <div className="font-semibold text-base truncate">{host.label}</div>
            <div className="text-xs font-mono truncate" style={{ color: 'var(--gv-text-dim)' }}>
              {host.hostname ?? host.id.slice(0, 13)}
            </div>
          </div>
        </div>
        <StatusPill status={status} lastSeenEpoch={host.last_seen} />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
          <Cpu size={14} />
          <span>{t('fleet.gpus_count', { count: hostSamples.length })}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
          <Zap size={14} />
          <span className="font-mono">{isOffline ? '—' : `${Math.round(totalPower)} W`}</span>
        </div>
      </div>

      {!detailed && (
        <div
          className="rounded-xl p-3 flex items-center justify-between gap-3"
          style={{ background: 'var(--gv-surface-alt)' }}
        >
          <div className="flex flex-col min-w-0">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
              {t('fleet.hottest_gpu')}
            </div>
            <div className="text-xs font-mono truncate max-w-[14ch]" style={{ color: 'var(--gv-text-muted)' }}>
              {hottest?.name.replace('NVIDIA ', '') ?? '—'}
            </div>
          </div>
          <div className="flex flex-col items-end">
            <div className="font-mono font-bold text-xl tabular-nums" style={{ color }}>
              {hottest && !isOffline ? `${hottest.temperature}°C` : '—'}
            </div>
          </div>
        </div>
      )}

      {detailed && !isOffline && hostSamples.length > 0 && (
        <div className="flex flex-col gap-2">
          {hostSamples.map((s) => (
            <GpuMiniTile key={s.gpu_index} hostId={host.id} sample={s} />
          ))}
        </div>
      )}

      {detailed && (isOffline || hostSamples.length === 0) && (
        <div
          className="rounded-xl p-3 text-center text-xs"
          style={{
            background: 'var(--gv-surface-alt)',
            color: 'var(--gv-text-dim)',
          }}
        >
          {isOffline ? t('fleet.host_offline') : t('fleet.no_samples_yet')}
        </div>
      )}

      <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--gv-text-dim)' }}>
        <span className="font-mono">
          {host.agent_version ? `agent v${host.agent_version}` : host.kind}
        </span>
        <span className="font-mono">{host.id.slice(0, 8)}…</span>
      </div>
    </button>
  );
}
