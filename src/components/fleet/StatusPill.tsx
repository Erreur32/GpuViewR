import { useTranslation } from 'react-i18next';
import type { HostStatus } from '../../store/hostsStore';
import { formatRelative } from '../../store/hostsStore';

const COLOR: Record<HostStatus, string> = {
  online: 'var(--gv-ok)',
  lagging: 'var(--gv-warn)',
  offline: 'var(--gv-danger)',
  pending: 'var(--gv-text-dim)',
  disabled: 'var(--gv-text-dim)',
};

type Props = Readonly<{
  status: HostStatus;
  lastSeenEpoch: number | null;
  compact?: boolean;
}>;

export default function StatusPill({ status, lastSeenEpoch, compact = false }: Props) {
  const { t } = useTranslation();
  const color = COLOR[status];
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = lastSeenEpoch === null ? null : Math.max(0, now - lastSeenEpoch);
  const ageLabel = ageSeconds === null ? '—' : formatRelative(ageSeconds);
  const label = t(`fleet.status.${status}`);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color }}>
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{
          background: color,
          boxShadow: status === 'online' ? `0 0 8px ${color}` : 'none',
        }}
      />
      {!compact && <span>{label}</span>}
      {lastSeenEpoch !== null && (
        <span style={{ color: 'var(--gv-text-dim)' }}>{ageLabel}</span>
      )}
    </span>
  );
}
