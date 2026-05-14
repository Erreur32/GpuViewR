import { Cpu, Zap, CheckCircle2 } from 'lucide-react';
import { MOCK_HOSTS, aggregates } from '../data/mockHosts';
import HostCard from '../components/HostCard';

type Props = Readonly<{ onHostClick?: (id: string) => void }>;

export default function FleetView({ onHostClick }: Props) {
  const agg = aggregates(MOCK_HOSTS);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Fleet</h1>
        <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
          All registered hosts. Click a card to drill down into per-GPU dashboard.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <AggregateCard
          icon={<CheckCircle2 size={18} />}
          label="Online"
          value={`${agg.online}/${agg.total}`}
          accent={agg.offline > 0 ? 'var(--gv-warn)' : 'var(--gv-ok)'}
          hint={agg.offline > 0 ? `${agg.offline} offline` : agg.lagging > 0 ? `${agg.lagging} lagging` : 'all good'}
        />
        <AggregateCard
          icon={<Cpu size={18} />}
          label="GPUs"
          value={`${agg.totalGpus}`}
          accent="var(--gv-info)"
          hint="across active hosts"
        />
        <AggregateCard
          icon={<Zap size={18} />}
          label="Power"
          value={`${(agg.totalPower / 1000).toFixed(2)} kW`}
          accent="var(--gv-accent)"
          hint={`${agg.totalPower} W total`}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {MOCK_HOSTS.map((h) => (
          <HostCard key={h.id} host={h} onClick={onHostClick ? () => onHostClick(h.id) : undefined} />
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
