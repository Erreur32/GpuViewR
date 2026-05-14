import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cpu, Zap, CheckCircle2 } from 'lucide-react';
import { useHostsStore, effectiveStatus, LOCAL_HOST_ID } from '../../store/hostsStore';
import { useGpuStore } from '../../store/gpuStore';
import HostCard from './HostCard';

export default function FleetPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosts = useHostsStore((s) => s.hosts);
  const setSelected = useHostsStore((s) => s.setSelectedHost);
  const samplesByHost = useGpuStore((s) => s.latestByHost);

  // Hydrate at mount — covers a deep-link refresh before any other
  // page has triggered a list fetch.
  const refresh = useHostsStore((s) => s.refresh);
  useEffect(() => { void refresh(); }, [refresh]);

  // Aggregates depend on hosts AND the live samples (power, gpus
  // count). Recompute when either changes.
  const agg = useMemo(() => {
    let online = 0;
    let lagging = 0;
    let offline = 0;
    let totalGpus = 0;
    let totalPower = 0;
    for (const h of hosts) {
      const s = effectiveStatus(h);
      if (s === 'online') online++;
      else if (s === 'lagging') lagging++;
      else if (s === 'offline') offline++;
      const samples = samplesByHost.get(h.id);
      if (samples && s !== 'offline' && s !== 'disabled') {
        totalGpus += samples.size;
        for (const v of samples.values()) totalPower += v.power;
      }
    }
    return { online, lagging, offline, total: hosts.length, totalGpus, totalPower };
  }, [hosts, samplesByHost]);

  // Mono-host install: /fleet is meaningless. Redirect to the regular
  // Dashboard so a bookmark or accidental click never lands on an
  // empty page. Multi-host installs get the proper fleet view.
  if (hosts.length <= 1) return <Navigate to="/" replace />;

  let onlineAccent: string;
  if (agg.offline > 0) onlineAccent = 'var(--gv-warn)';
  else if (agg.lagging > 0) onlineAccent = 'var(--gv-warn)';
  else onlineAccent = 'var(--gv-ok)';

  const onlineHint = (agg.offline > 0 || agg.lagging > 0)
    ? t('fleet.aggregate_online_hint_warn', { offline: agg.offline, lagging: agg.lagging })
    : t('fleet.aggregate_online_hint_ok');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('fleet.title')}</h1>
        <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('fleet.subtitle')}</p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <AggregateCard
          icon={<CheckCircle2 size={18} />}
          label={t('fleet.aggregate_online')}
          value={`${agg.online}/${agg.total}`}
          accent={onlineAccent}
          hint={onlineHint}
        />
        <AggregateCard
          icon={<Cpu size={18} />}
          label={t('fleet.aggregate_gpus')}
          value={String(agg.totalGpus)}
          accent="var(--gv-info)"
          hint={t('fleet.aggregate_gpus_hint')}
        />
        <AggregateCard
          icon={<Zap size={18} />}
          label={t('fleet.aggregate_power')}
          value={`${(agg.totalPower / 1000).toFixed(2)} kW`}
          accent="var(--gv-accent)"
          hint={t('fleet.aggregate_power_hint', { watts: Math.round(agg.totalPower) })}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {hosts.map((h) => (
          <HostCard
            key={h.id}
            host={h}
            onOpen={() => {
              setSelected(h.id);
              navigate(h.id === LOCAL_HOST_ID ? '/' : `/host/${h.id}`);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function AggregateCard({
  icon, label, value, accent, hint,
}: Readonly<{ icon: React.ReactNode; label: string; value: string; accent: string; hint: string }>) {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center"
        style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
      >
        {icon}
      </div>
      <div className="flex flex-col">
        <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>{label}</div>
        <div className="font-mono font-bold text-2xl tabular-nums leading-tight">{value}</div>
        <div className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{hint}</div>
      </div>
    </div>
  );
}
