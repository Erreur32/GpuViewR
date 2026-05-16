import { Activity, MemoryStick, Thermometer, Zap, Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGpuStore, type GpuSample } from '../../store/gpuStore';
import { effectiveStatus, type HostRecord } from '../../store/hostsStore';
import { statusFor, colorFor } from '../../lib/status';
import StatusPill from './StatusPill';
import GpuMiniTile from './GpuMiniTile';
import MetricRow from '../ui/MetricRow';
import Sparkline from '../dashboard/Sparkline';
import VendorIcon, { detectVendor } from '../ui/VendorIcon';

type Props = Readonly<{
  host: HostRecord;
  onOpen?: () => void;
  /** Toggle from FleetPage's view selector. Detailed mode unfolds a
   *  per-GPU mini-tile (util/temp/power/mem + sparkline) below the
   *  hostname header. Default 'simple' keeps the compact tile look —
   *  same metric-row layout as the Dashboard's "All GPUs" view. */
  detailed?: boolean;
}>;

export default function HostCard({ host, onOpen, detailed = false }: Props) {
  const { t } = useTranslation();
  // Live samples for this host come from the gpuStore's internal
  // per-host map. We DON'T use the public `latest` projection here
  // because that one only mirrors the currently-selected host; the
  // Fleet view needs every host's latest at once.
  const samplesByHost = useGpuStore((s) => s.latestByHost);
  const seriesByHost = useGpuStore((s) => s.seriesByHost);
  const hostSamples: GpuSample[] = Array.from(samplesByHost.get(host.id)?.values() ?? [])
    .sort((a, b) => a.gpu_index - b.gpu_index);

  const status = effectiveStatus(host);
  const isOffline = status === 'offline' || status === 'disabled' || status === 'pending';

  const stats = aggregateHostStats(hostSamples);
  const sparklineValues = buildHostSparkline(seriesByHost, host.id);
  const utilColor = colorFor(statusFor(stats.avgUtil ?? 0, 85, 95));
  const vendor = detectVendor(hostSamples.map((s) => s.name));

  return (
    <button
      type="button"
      onClick={onOpen}
      className="card card-hover p-4 flex flex-col gap-3 text-left w-full min-w-0"
      style={{ opacity: isOffline ? 0.55 : 1 }}
    >
      <header className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <VendorIcon vendor={vendor} size={18} title={vendor ? vendor.toUpperCase() : host.label} />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight truncate" style={{ color: 'var(--gv-text)' }} title={host.label}>
              {host.label}
            </h3>
            <p className="text-[11px] mt-0.5 font-mono truncate" style={{ color: 'var(--gv-text-dim)' }}>
              {host.hostname ?? host.id.slice(0, 13)}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <StatusPill status={status} lastSeenEpoch={host.last_seen} />
          {!isOffline && sparklineValues.length > 1 && (
            <Sparkline
              values={sparklineValues}
              max={100}
              width={80}
              height={22}
              stroke={utilColor}
            />
          )}
        </div>
      </header>

      {!detailed && (
        <HostMetricRows isOffline={isOffline} stats={stats} t={t} />
      )}

      {detailed && !isOffline && hostSamples.length > 0 && (
        <div className="flex flex-col gap-2">
          {hostSamples.map((s) => (
            <GpuMiniTile key={s.gpu_index} sample={s} />
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

      <footer
        className="flex items-center justify-between text-[11px] pt-1.5 border-t flex-wrap gap-2"
        style={{ borderColor: 'var(--gv-border)', color: 'var(--gv-text-muted)' }}
      >
        <span className="inline-flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5" style={{ color: 'var(--gv-info)' }} />
          <span className="font-mono">{t('fleet.stat_gpus')}: {hostSamples.length}</span>
          {stats.pcieKbps > 0 && (
            <span style={{ color: 'var(--gv-text-dim)' }}>· PCIe {formatPcie(stats.pcieKbps)}</span>
          )}
        </span>
        <span className="font-mono">
          {host.agent_version ? `agent v${host.agent_version}` : host.kind}
          <span className="ml-2" style={{ color: 'var(--gv-text-dim)' }}>{host.id.slice(0, 8)}…</span>
        </span>
      </footer>
    </button>
  );
}

interface HostStats {
  avgUtil: number | null;
  hottestTemp: number | null;
  totalPower: number;
  powerMax: number;
  vramUsed: number;
  vramTotal: number;
  pcieKbps: number;
}

function aggregateHostStats(samples: GpuSample[]): HostStats {
  if (samples.length === 0) {
    return {
      avgUtil: null, hottestTemp: null, totalPower: 0, powerMax: 0,
      vramUsed: 0, vramTotal: 0, pcieKbps: 0,
    };
  }
  let utilSum = 0;
  let utilCount = 0;
  let hottest = Number.NEGATIVE_INFINITY;
  let power = 0;
  let vramUsed = 0;
  let vramTotal = 0;
  let pcieKbps = 0;
  for (const g of samples) {
    if (g.utilization !== null) { utilSum += g.utilization; utilCount++; }
    if (g.temperature > hottest) hottest = g.temperature;
    power += g.power;
    vramUsed += g.memory_used;
    vramTotal += g.memory_total ?? 0;
    pcieKbps += (g.pcie_rx_kbps ?? 0) + (g.pcie_tx_kbps ?? 0);
  }
  // Power gauge max: scale to a reasonable headroom over current draw so
  // the bar fills meaningfully on idle hosts but still has room to grow.
  const powerMax = Math.max(300 * samples.length, Math.ceil(power * 1.4));
  return {
    avgUtil: utilCount > 0 ? utilSum / utilCount : null,
    hottestTemp: hottest === Number.NEGATIVE_INFINITY ? null : hottest,
    totalPower: power,
    powerMax,
    vramUsed,
    vramTotal,
    pcieKbps,
  };
}

function buildHostSparkline(
  seriesByHost: Map<string, Map<number, { utilization: (number | null)[] }>>,
  hostId: string,
): number[] {
  const perGpu = seriesByHost.get(hostId);
  if (!perGpu || perGpu.size === 0) return [];
  // Use the first GPU's series as the timeline; average utilization
  // across all GPUs per sample point.
  const first = perGpu.values().next().value;
  if (!first) return [];
  const len = first.utilization.length;
  const sums: number[] = new Array(len).fill(0);
  const counts: number[] = new Array(len).fill(0);
  for (const s of perGpu.values()) {
    const arr = s.utilization;
    const offset = len - arr.length;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null || v === undefined) continue;
      sums[i + offset] += v;
      counts[i + offset] += 1;
    }
  }
  return sums.map((s, i) => (counts[i] === 0 ? 0 : s / counts[i])).slice(-60);
}

function HostMetricRows({
  isOffline, stats, t,
}: Readonly<{
  isOffline: boolean;
  stats: HostStats;
  t: (key: string) => string;
}>) {
  if (isOffline) {
    return (
      <div
        className="rounded-lg px-3 py-4 text-center text-xs"
        style={{ background: 'var(--gv-surface-alt)', color: 'var(--gv-text-dim)' }}
      >
        {t('fleet.host_offline')}
      </div>
    );
  }
  const vramPct = stats.vramTotal > 0 ? (stats.vramUsed / stats.vramTotal) * 100 : 0;
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <MetricRow
        icon={<Activity className="w-3.5 h-3.5" />}
        label={t('dashboard.metrics.utilization')}
        value={stats.avgUtil ?? 0}
        displayValue={stats.avgUtil === null ? 'N/A' : undefined}
        max={100}
        warn={85}
        danger={95}
        unit="%"
      />
      <MetricRow
        icon={<MemoryStick className="w-3.5 h-3.5" />}
        label={t('dashboard.metrics.memory')}
        value={vramPct}
        displayValue={stats.vramTotal === 0
          ? 'N/A'
          : `${(stats.vramUsed / 1024).toFixed(1)} / ${(stats.vramTotal / 1024).toFixed(0)} GiB`}
        max={100}
        warn={80}
        danger={92}
        unit=""
      />
      <MetricRow
        icon={<Thermometer className="w-3.5 h-3.5" />}
        label={t('dashboard.metrics.temperature')}
        value={stats.hottestTemp ?? 0}
        displayValue={stats.hottestTemp === null ? 'N/A' : undefined}
        max={100}
        warn={75}
        danger={85}
        unit="°C"
      />
      <MetricRow
        icon={<Zap className="w-3.5 h-3.5" />}
        label={t('dashboard.metrics.power')}
        value={stats.totalPower}
        max={stats.powerMax}
        warn={Math.round(stats.powerMax * 0.7)}
        danger={Math.round(stats.powerMax * 0.9)}
        unit="W"
      />
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

