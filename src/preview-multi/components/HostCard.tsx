import { Cpu, Server, Zap } from 'lucide-react';
import type { MockHost } from '../data/mockHosts';
import StatusPill from './StatusPill';
import Sparkline from './Sparkline';

type Props = Readonly<{ host: MockHost; onClick?: () => void }>;

function tempColor(t: number): string {
  if (t === 0) return 'var(--gv-text-dim)';
  if (t >= 80) return 'var(--gv-danger)';
  if (t >= 75) return 'var(--gv-orange)';
  if (t >= 70) return 'var(--gv-warn)';
  return 'var(--gv-ok)';
}

export default function HostCard({ host, onClick }: Props) {
  const hottest = host.gpus.reduce((max, g) => (g.temperature > max.temperature ? g : max), host.gpus[0]);
  const totalPower = host.gpus.reduce((sum, g) => sum + g.power, 0);
  const isOffline = host.status === 'offline';
  const color = tempColor(hottest.temperature);

  return (
    <button
      type="button"
      onClick={onClick}
      className="card card-hover p-5 flex flex-col gap-4 text-left w-full"
      style={{ opacity: isOffline ? 0.55 : 1 }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <Server size={18} style={{ color: 'var(--gv-text-muted)' }} />
          <div>
            <div className="font-semibold text-base">{host.label}</div>
            <div className="text-xs font-mono" style={{ color: 'var(--gv-text-dim)' }}>{host.hostname}</div>
          </div>
        </div>
        <StatusPill status={host.status} lastSeenSecondsAgo={host.last_seen_seconds_ago} />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
          <Cpu size={14} />
          <span>{host.gpus.length} GPU{host.gpus.length > 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
          <Zap size={14} />
          <span className="font-mono">{isOffline ? '—' : `${totalPower} W`}</span>
        </div>
      </div>

      <div
        className="rounded-xl p-3 flex items-center justify-between gap-3"
        style={{ background: 'var(--gv-surface-alt)' }}
      >
        <div className="flex flex-col">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
            Hottest GPU
          </div>
          <div className="text-xs font-mono truncate max-w-[14ch]" style={{ color: 'var(--gv-text-muted)' }}>
            {hottest.name.replace('NVIDIA ', '')}
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className="font-mono font-bold text-xl tabular-nums" style={{ color }}>
            {isOffline ? '—' : `${hottest.temperature}°C`}
          </div>
          {!isOffline && <Sparkline values={hottest.history} stroke={color} width={100} height={24} />}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--gv-text-dim)' }}>
        <span className="font-mono">agent v{host.agent_version}</span>
        <span className="font-mono">{host.id.slice(0, 8)}…</span>
      </div>
    </button>
  );
}
