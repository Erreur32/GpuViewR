import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cpu, Zap, CheckCircle2, LayoutGrid, Rows3, Activity, MemoryStick, Cable } from 'lucide-react';
import { useHostsStore, effectiveStatus, LOCAL_HOST_ID } from '../../store/hostsStore';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import HostCard from './HostCard';
import FleetChart from './FleetChart';

export default function FleetPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosts = useHostsStore((s) => s.hosts);
  const hydrated = useHostsStore((s) => s.hydrated);
  const setSelected = useHostsStore((s) => s.setSelectedHost);
  const samplesByHost = useGpuStore((s) => s.latestByHost);
  const fleetView = useUiStore((s) => s.fleetView);
  const setFleetView = useUiStore((s) => s.setFleetView);

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
    let pending = 0;
    let totalGpus = 0;
    let totalPower = 0;
    let totalVramUsed = 0;
    let totalVramTotal = 0;
    let utilSum = 0;
    let utilCount = 0;
    let totalPcieKbps = 0;
    for (const h of hosts) {
      const s = effectiveStatus(h);
      if (s === 'online') online++;
      else if (s === 'lagging') lagging++;
      else if (s === 'offline') offline++;
      else if (s === 'pending') pending++;
      const samples = samplesByHost.get(h.id);
      if (samples && s !== 'offline' && s !== 'disabled') {
        totalGpus += samples.size;
        for (const v of samples.values()) {
          totalPower += v.power;
          totalVramUsed += v.memory_used;
          totalVramTotal += v.memory_total ?? 0;
          if (v.utilization !== null) { utilSum += v.utilization; utilCount++; }
          totalPcieKbps += (v.pcie_rx_kbps ?? 0) + (v.pcie_tx_kbps ?? 0);
        }
      }
    }
    return {
      online, lagging, offline, pending,
      total: hosts.length,
      totalGpus, totalPower,
      totalVramUsed, totalVramTotal,
      avgUtil: utilCount > 0 ? utilSum / utilCount : null,
      totalPcieKbps,
    };
  }, [hosts, samplesByHost]);

  // Mono-host install: /fleet is meaningless. Redirect to the regular
  // Dashboard so a bookmark or accidental click never lands on an
  // empty page. BUT only after the first /api/hosts response — otherwise
  // a hard refresh of /fleet bounces to / before the list arrives.
  if (hydrated && hosts.length <= 1) return <Navigate to="/" replace />;

  // Green only if EVERY non-disabled host is online. A pending or
  // lagging or offline host pulls the aggregate to warn so the
  // "1/2 — all good" inconsistency the user reported can't happen.
  const allOnline = agg.online === agg.total;
  const onlineAccent = allOnline ? 'var(--gv-ok)' : 'var(--gv-warn)';

  const hintParts: string[] = [];
  if (agg.offline > 0) hintParts.push(t('fleet.count_offline', { count: agg.offline }));
  if (agg.lagging > 0) hintParts.push(t('fleet.count_lagging', { count: agg.lagging }));
  if (agg.pending > 0) hintParts.push(t('fleet.count_pending', { count: agg.pending }));
  const onlineHint = allOnline
    ? t('fleet.aggregate_online_hint_ok')
    : hintParts.join(' · ');

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('fleet.title')}</h1>
          <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('fleet.subtitle')}</p>
        </div>
        <div className="seg" role="group" aria-label={t('fleet.view_label')}>
          <button
            type="button"
            className="seg-btn inline-flex items-center gap-1.5"
            aria-pressed={fleetView === 'simple'}
            onClick={() => setFleetView('simple')}
            title={t('fleet.view_simple')}
          >
            <LayoutGrid className="w-3.5 h-3.5" /> {t('fleet.view_simple')}
          </button>
          <button
            type="button"
            className="seg-btn inline-flex items-center gap-1.5"
            aria-pressed={fleetView === 'detailed'}
            onClick={() => setFleetView('detailed')}
            title={t('fleet.view_detailed')}
          >
            <Rows3 className="w-3.5 h-3.5" /> {t('fleet.view_detailed')}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
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
          value={agg.totalPower >= 1000
            ? `${(agg.totalPower / 1000).toFixed(2)} kW`
            : `${Math.round(agg.totalPower)} W`}
          accent="var(--gv-accent)"
          hint={t('fleet.aggregate_power_hint', { watts: Math.round(agg.totalPower) })}
        />
        <AggregateCard
          icon={<Activity size={18} />}
          label={t('fleet.aggregate_util')}
          value={agg.avgUtil === null ? '—' : `${Math.round(agg.avgUtil)} %`}
          accent={utilAccent(agg.avgUtil)}
          hint={t('fleet.aggregate_util_hint', { count: agg.totalGpus })}
        />
        <AggregateCard
          icon={<MemoryStick size={18} />}
          label={t('fleet.aggregate_vram')}
          value={agg.totalVramTotal === 0
            ? '—'
            : `${(agg.totalVramUsed / 1024).toFixed(1)} / ${(agg.totalVramTotal / 1024).toFixed(0)} GiB`}
          accent="var(--gv-info)"
          hint={agg.totalVramTotal === 0
            ? t('fleet.no_data')
            : t('fleet.aggregate_vram_hint', {
                pct: Math.round((agg.totalVramUsed / agg.totalVramTotal) * 100),
              })}
        />
        <AggregateCard
          icon={<Cable size={18} />}
          label={t('fleet.aggregate_pcie')}
          value={agg.totalPcieKbps === 0 ? '—' : formatPcieAggregate(agg.totalPcieKbps)}
          accent="var(--gv-orange)"
          hint={t('fleet.aggregate_pcie_hint')}
        />
      </div>

      <FleetChart />

      {/* Detailed view shows per-GPU mini-tiles, so cards are wider —
          drop to 1-2 columns. Simple view keeps the 1/2/3 column grid. */}
      <div className={
        fleetView === 'detailed'
          ? 'grid grid-cols-1 lg:grid-cols-2 gap-4'
          : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
      }>
        {hosts.map((h) => (
          <HostCard
            key={h.id}
            host={h}
            detailed={fleetView === 'detailed'}
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
    <div className="card p-3 flex items-center gap-3 min-w-0">
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
      >
        {icon}
      </div>
      <div className="flex flex-col min-w-0">
        <div className="text-[10px] uppercase tracking-wider truncate" style={{ color: 'var(--gv-text-dim)' }}>{label}</div>
        <div className="font-mono font-bold text-lg tabular-nums leading-tight truncate">{value}</div>
        <div className="text-[10px] truncate" style={{ color: 'var(--gv-text-muted)' }}>{hint}</div>
      </div>
    </div>
  );
}

// Util-level colour: matches the per-GPU thresholds the dashboard uses
// (low ~ info blue, high ~ warn yellow, hot ~ orange/red).
function utilAccent(u: number | null): string {
  if (u === null) return 'var(--gv-text-dim)';
  if (u >= 95) return 'var(--gv-danger)';
  if (u >= 80) return 'var(--gv-orange)';
  if (u >= 50) return 'var(--gv-warn)';
  return 'var(--gv-info)';
}

function formatPcieAggregate(kbps: number): string {
  if (kbps < 1024) return `${Math.round(kbps)} KiB/s`;
  const mibps = kbps / 1024;
  if (mibps < 1024) return `${mibps.toFixed(1)} MiB/s`;
  return `${(mibps / 1024).toFixed(2)} GiB/s`;
}
