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
  // Per-host cumulative stats (simple view): show what's happening
  // across the host's GPUs without unfolding the detailed tiles.
  const utilValues = hostSamples.map((g) => g.utilization).filter((u): u is number => u !== null);
  const avgUtil = utilValues.length > 0
    ? Math.round(utilValues.reduce((a, b) => a + b, 0) / utilValues.length)
    : null;
  const vramUsedMiB = hostSamples.reduce((sum, g) => sum + g.memory_used, 0);
  const vramTotalMiB = hostSamples.reduce((sum, g) => sum + (g.memory_total ?? 0), 0);
  // PCIe throughput is in KiB/s in the sample (when reported); roll up
  // to MiB/s for fleet view since 4-8 GPUs can easily exceed 1 GiB/s.
  const pcieKbps = hostSamples.reduce(
    (sum, g) => sum + (g.pcie_rx_kbps ?? 0) + (g.pcie_tx_kbps ?? 0),
    0,
  );

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

      {/* 4-cell stats grid: GPUs / Power / Util / VRAM. Each cell
          shows the cumulative value across the host's GPUs with a
          unit suffix so the user doesn't have to mentally convert. */}
      <div
        className="grid grid-cols-4 gap-2 text-center rounded-lg p-2"
        style={{ background: 'var(--gv-surface-alt)' }}
      >
        <StatCell
          label={t('fleet.stat_gpus')}
          value={String(hostSamples.length)}
          unit=""
        />
        <StatCell
          label={t('fleet.stat_power')}
          value={isOffline ? '—' : String(Math.round(totalPower))}
          unit="W"
        />
        <StatCell
          label={t('fleet.stat_util')}
          value={isOffline || avgUtil === null ? '—' : String(avgUtil)}
          unit="%"
        />
        <StatCell
          label={t('fleet.stat_vram')}
          value={isOffline || vramTotalMiB === 0
            ? '—'
            : `${(vramUsedMiB / 1024).toFixed(1)}/${(vramTotalMiB / 1024).toFixed(0)}`}
          unit="GiB"
        />
      </div>

      {!isOffline && pcieKbps > 0 && (
        <div
          className="flex items-center justify-between text-[11px]"
          style={{ color: 'var(--gv-text-muted)' }}
        >
          <span className="inline-flex items-center gap-1.5">
            <Zap size={11} /> {t('fleet.stat_pcie')}
          </span>
          <span className="font-mono">{formatPcie(pcieKbps)}</span>
        </div>
      )}

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

function StatCell({ label, value, unit }: Readonly<{ label: string; value: string; unit: string }>) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
        {label}
      </span>
      <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: 'var(--gv-text)' }}>
        {value}
        {unit && <span className="text-[10px] font-normal ml-0.5" style={{ color: 'var(--gv-text-muted)' }}>{unit}</span>}
      </span>
    </div>
  );
}

/** Format a PCIe rate in KiB/s as a human-readable string with auto unit:
 *  < 1 MiB/s shows kB/s, otherwise MiB/s, beyond 1 GiB/s shows GiB/s. */
function formatPcie(kbps: number): string {
  if (kbps < 1024) return `${Math.round(kbps)} KiB/s`;
  const mibps = kbps / 1024;
  if (mibps < 1024) return `${mibps.toFixed(1)} MiB/s`;
  return `${(mibps / 1024).toFixed(2)} GiB/s`;
}
