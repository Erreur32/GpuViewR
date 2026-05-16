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

  return (
    <NavLink
      to="/fleet"
      className="nav-link inline-flex items-center gap-1.5"
      title={t('fleet.indicator_title')}
    >
      <Activity className="w-4 h-4" />
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
      />
      <span className="hidden sm:inline">
        {t('fleet.indicator', { online, total: hosts.length })}
      </span>
    </NavLink>
  );
}
