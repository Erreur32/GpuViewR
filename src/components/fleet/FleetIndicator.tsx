import { Activity } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useHostsStore, effectiveStatus } from '../../store/hostsStore';
import { useGpuStore, liveLastSeenFor } from '../../store/gpuStore';

/** Header widget — hidden entirely on mono-host installs so the user
 *  sees no new UI until they enroll at least one agent. Shows
 *  "Fleet N/M" with a dot whose colour reflects the worst state
 *  across the fleet. */
export default function FleetIndicator() {
  const { t } = useTranslation();
  const hosts = useHostsStore((s) => s.hosts);
  const latestByHost = useGpuStore((s) => s.latestByHost);
  if (hosts.length <= 1) return null;

  let online = 0;
  let lagging = 0;
  let offline = 0;
  for (const h of hosts) {
    const s = effectiveStatus(h, undefined, liveLastSeenFor(latestByHost, h.id));
    if (s === 'online') online++;
    else if (s === 'lagging') lagging++;
    else if (s === 'offline') offline++;
  }
  let dot: string;
  if (offline > 0) dot = 'var(--gv-danger)';
  else if (lagging > 0) dot = 'var(--gv-warn)';
  else dot = 'var(--gv-ok)';

  // Both online and total share the same worst-case digit count (online
  // can never exceed total), so the label at online=total is the widest
  // it will ever get. Reserving that width up front stops the badge
  // from resizing (and shoving every other header badge sideways) each
  // time `online` changes digit count, e.g. 9/10 -> 10/10.
  const label = t('fleet.indicator', { online, total: hosts.length });
  const widestLabel = t('fleet.indicator', { online: hosts.length, total: hosts.length });

  return (
    <NavLink
      to="/fleet"
      className="nav-link inline-flex items-center gap-1.5"
      title={t('fleet.indicator_title')}
    >
      <Activity className="w-4 h-4" />
      <span
        className="inline-block w-2 h-2 rounded-full shrink-0"
        style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
      />
      <span
        className="hidden sm:inline-block tabular-nums"
        style={{ minWidth: `${widestLabel.length}ch` }}
      >
        {label}
      </span>
    </NavLink>
  );
}
