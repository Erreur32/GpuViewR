import { Activity } from 'lucide-react';
import type { MockHost } from '../data/mockHosts';

type Props = Readonly<{ hosts: MockHost[]; onClick?: () => void }>;

export default function FleetIndicator({ hosts, onClick }: Props) {
  const online = hosts.filter((h) => h.status === 'online').length;
  const lagging = hosts.filter((h) => h.status === 'lagging').length;
  const offline = hosts.filter((h) => h.status === 'offline').length;

  let dot: string;
  if (offline > 0) dot = 'var(--gv-danger)';
  else if (lagging > 0) dot = 'var(--gv-warn)';
  else dot = 'var(--gv-ok)';

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm transition-colors"
      style={{ background: 'var(--gv-surface-alt)', color: 'var(--gv-text-muted)' }}
    >
      <Activity size={14} />
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
      />
      <span className="font-medium">
        Fleet <span className="font-mono tabular-nums">{online}/{hosts.length}</span>
      </span>
    </button>
  );
}
