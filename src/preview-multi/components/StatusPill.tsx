import type { HostStatus } from '../data/mockHosts';
import { formatRelative } from '../data/mockHosts';

const COLOR: Record<HostStatus, string> = {
  online: 'var(--gv-ok)',
  lagging: 'var(--gv-warn)',
  offline: 'var(--gv-danger)',
};

const LABEL: Record<HostStatus, string> = {
  online: 'Online',
  lagging: 'Lagging',
  offline: 'Offline',
};

type Props = Readonly<{ status: HostStatus; lastSeenSecondsAgo: number; compact?: boolean }>;

export default function StatusPill({ status, lastSeenSecondsAgo, compact = false }: Props) {
  const color = COLOR[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color }}>
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{
          background: color,
          boxShadow: status === 'online' ? `0 0 8px ${color}` : 'none',
        }}
      />
      {!compact && <span>{LABEL[status]}</span>}
      <span style={{ color: 'var(--gv-text-dim)' }}>{formatRelative(lastSeenSecondsAgo)}</span>
    </span>
  );
}
