import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, MemoryStick, Server, HardDrive, Gauge, BarChart3, LayoutGrid, Cable, AlertTriangle, Info, ArrowDownToLine, ArrowUpFromLine, Thermometer } from 'lucide-react';
import UsageArc from '../ui/UsageArc';
import { api } from '../../lib/api';
import PcieThroughputTile from '../dashboard/PcieThroughputTile';
import SystemTemperaturesPanel, { type HostTempSensor } from './SystemTemperaturesPanel';

type ViewMode = 'bar' | 'gauge';

type SystemInfo = Readonly<{
  host: {
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    uptime: number;
    loadavg: number[];
    os: { name: string; prettyName: string | null; version: string | null; id: string | null };
  };
  cpu: { model: string; cores: number; speedMHz: number; usagePct: number };
  memory: { total: number; free: number; used: number; usedPct: number };
  process: { nodeVersion: string; pid: number; uptime: number; rss: number };
  temperatures?: ReadonlyArray<HostTempSensor>;
  gpus: Array<{
    gpu_index: number;
    name: string;
    uuid: string | null;
    driver_version: string | null;
    memory_total: number | null;
    memory_used: number;
    temperature: number;
    utilization: number | null;
    power: number;
    fan_speed: number | null;
    clock_graphics: number | null;
    clock_memory: number | null;
    pci_bus_id: string | null;
    pcie_gen_current: number | null;
    pcie_gen_max: number | null;
    pcie_width_current: number | null;
    pcie_width_max: number | null;
    pcie_bandwidth_GBps: number | null;
    pcie_bandwidth_max_GBps: number | null;
    pcie_rx_kbps: number | null;
    pcie_tx_kbps: number | null;
  }>;
}>;

const REFRESH_MS = 5000;

export default function SystemPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Persist the bar/gauge choice across visits so users don't have to
  // re-pick it every time they open System. Local to this page — does
  // not piggyback on the dashboard's global gauge view setting.
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => ((localStorage.getItem('gpuviewr.systemView') as ViewMode | null) ?? 'bar'),
  );
  const selectView = (m: ViewMode) => {
    setViewMode(m);
    localStorage.setItem('gpuviewr.systemView', m);
  };

  const load = () => {
    setError(null);
    api<SystemInfo>('/system')
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Server className="w-5 h-5" /> {t('system.title')}
          </h1>
          <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('system.subtitle')}</p>
        </div>
        <fieldset className="seg" aria-label={t('system.view_mode')}>
          <legend className="sr-only">{t('system.view_mode')}</legend>
          {/* Order matches the Dashboard's view selector: gauges first
              (left), bars second (right). Keeps muscle memory consistent
              when toggling between the two pages. */}
          <button
            className="seg-btn inline-flex items-center gap-2"
            aria-pressed={viewMode === 'gauge'}
            onClick={() => selectView('gauge')}
          >
            <LayoutGrid className="w-4 h-4" /> {t('dashboard.view_arc')}
          </button>
          <button
            className="seg-btn inline-flex items-center gap-2"
            aria-pressed={viewMode === 'bar'}
            onClick={() => selectView('bar')}
          >
            <BarChart3 className="w-4 h-4" /> {t('dashboard.view_bar')}
          </button>
        </fieldset>
      </div>

      {error && (
        <div className="card p-3 text-sm" style={{ color: 'var(--gv-warn)' }}>
          {t('common.error')}: {error}
        </div>
      )}

      {info && (
        <>
          <ZoneHeader
            color="var(--gv-info)"
            icon={<Server className="w-4 h-4" />}
            label={t('system.zone_machine')}
            sub={t('system.zone_machine_sub')}
          />
          {/* Machine zone layout:
              - bar mode: vertical stack (full-width bars read better)
              - gauge mode + md  : Host full width / CPU + Memory side-by-side
              - gauge mode + xl  : Host (2fr) + CPU (1fr) + Memory (1fr) all on one row */}
          <div
            className={
              'pl-3 border-l-2 '
              + (viewMode === 'gauge'
                ? 'grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4'
                : 'space-y-4')
            }
            style={{ borderColor: 'color-mix(in srgb, var(--gv-info) 35%, transparent)' }}
          >
            <section
              className={
                'card p-4 flex flex-col gap-3'
                + (viewMode === 'gauge' ? ' md:col-span-2' : '')
              }
            >
              <CardHeader
                icon={<Server className="w-4 h-4" style={{ color: 'var(--gv-info)' }} />}
                title={t('system.host')}
                badge={
                  <span
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider"
                    style={{
                      color: 'var(--gv-info)',
                      background: 'color-mix(in srgb, var(--gv-info) 14%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--gv-info) 35%, transparent)',
                    }}
                    title={t('hosts.hub_badge_help')}
                  >
                    {t('hosts.hub_badge')}
                  </span>
                }
                meta={[
                  info.host.os.prettyName ?? info.host.os.name,
                  `${info.host.platform} ${info.host.release}`,
                  info.host.arch,
                  info.host.hostname,
                  `up ${fmtUptime(info.host.uptime)}`,
                ]}
              />
              <div className="mt-auto">
                <LoadAvgBars loadavg={info.host.loadavg} cores={info.cpu.cores} label={t('system.loadavg')} viewMode={viewMode} />
              </div>
            </section>

            <section className="card p-4 flex flex-col gap-3">
              <CardHeader
                icon={<Cpu className="w-4 h-4" style={{ color: 'var(--gv-info)' }} />}
                title={t('system.cpu')}
                meta={[
                  info.cpu.model,
                  `${info.cpu.cores} cores`,
                  `${info.cpu.speedMHz} MHz`,
                ]}
              />
              <div className="mt-auto">
                <UsageBar label={t('system.cpu_usage')} pct={info.cpu.usagePct} viewMode={viewMode} />
              </div>
            </section>

            <section className="card p-4 flex flex-col gap-3">
              <CardHeader
                icon={<MemoryStick className="w-4 h-4" style={{ color: 'var(--gv-info)' }} />}
                title={t('system.memory')}
                meta={[
                  `${fmtBytes(info.memory.total)} total`,
                  `${fmtBytes(info.memory.used)} used`,
                  `${fmtBytes(info.memory.free)} free`,
                ]}
              />
              <div className="mt-auto">
                <UsageBar
                  label={t('system.mem_used')}
                  pct={info.memory.usedPct}
                  valueText={`${info.memory.usedPct.toFixed(1)}%`}
                  valueSub={`${fmtBytes(info.memory.used)} / ${fmtBytes(info.memory.total)}`}
                  viewMode={viewMode}
                />
              </div>
            </section>
          </div>

          {info.temperatures && info.temperatures.length > 0 && (
            <>
              <ZoneHeader
                color="var(--gv-warn)"
                icon={<Thermometer className="w-4 h-4" />}
                label={t('system.zone_thermal')}
                sub={t('system.zone_thermal_sub')}
              />
              <div
                className="pl-3 border-l-2"
                style={{ borderColor: 'color-mix(in srgb, var(--gv-warn) 35%, transparent)' }}
              >
                <SystemTemperaturesPanel
                  temperatures={info.temperatures}
                  gpus={info.gpus.map((g) => ({
                    gpu_index: g.gpu_index,
                    name: g.name,
                    temperature: g.temperature,
                  }))}
                />
              </div>
            </>
          )}

          <ZoneHeader
            color="var(--gv-accent)"
            icon={<Gauge className="w-4 h-4" />}
            label={t('system.zone_gpu')}
            sub={t('system.zone_gpu_sub')}
          />
          <section className="card p-5 space-y-3 border-l-2 ml-0" style={{ borderLeftColor: 'color-mix(in srgb, var(--gv-accent) 50%, transparent)' }}>
            <h2 className="font-semibold flex items-center gap-2">
              <Gauge className="w-4 h-4" style={{ color: 'var(--gv-accent)' }} /> {t('system.gpus')} ({info.gpus.length})
            </h2>
            {info.gpus.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('system.no_gpu')}</p>
            ) : (
              <div className="space-y-3">
                {info.gpus.map((g) => {
                  const memPct = g.memory_total && g.memory_total > 0
                    ? (g.memory_used / g.memory_total) * 100
                    : 0;
                  // Stable identity (right-aligned, on the title line).
                  const titleMeta: string[] = [];
                  if (g.driver_version) titleMeta.push(`drv ${g.driver_version}`);
                  if (g.pcie_gen_current && g.pcie_width_current) {
                    titleMeta.push(`PCIe ${g.pcie_gen_current}.0 ×${g.pcie_width_current}`);
                  }
                  // Live readings, second line under the title.
                  const liveMeta: string[] = [`${g.temperature.toFixed(0)}°C`, `${g.power.toFixed(0)} W`];
                  if (g.fan_speed !== null) liveMeta.push(`fan ${g.fan_speed.toFixed(0)}%`);
                  if (g.clock_graphics !== null) liveMeta.push(`GR ${g.clock_graphics} MHz`);
                  if (g.clock_memory !== null) liveMeta.push(`MEM ${g.clock_memory} MHz`);
                  if (g.pci_bus_id) liveMeta.push(g.pci_bus_id);
                  return (
                    <div key={g.gpu_index} className="rounded-xl p-3 space-y-2" style={{ background: 'var(--gv-surface-alt)' }}>
                      <div className="flex items-baseline justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <HardDrive className="w-4 h-4 shrink-0" style={{ color: 'var(--gv-accent)' }} />
                          <span className="font-semibold truncate">#{g.gpu_index} · {g.name}</span>
                        </div>
                        {titleMeta.length > 0 && (
                          <span className="text-[11px] tabular-nums" style={{ color: 'var(--gv-text-muted)' }}>
                            {titleMeta.join(' · ')}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] tabular-nums leading-snug" style={{ color: 'var(--gv-text-muted)' }}>
                        {liveMeta.join(' · ')}
                        {g.uuid && (
                          <span className="ml-2 font-mono opacity-60" title={g.uuid}>
                            · {g.uuid.slice(0, 12)}…
                          </span>
                        )}
                      </div>
                      {(() => {
                        const hasThroughput = g.pcie_rx_kbps !== null || g.pcie_tx_kbps !== null;
                        // Gauge mode: 1 row with Util | RX | TX | Mem so the
                        // gauges stay on the same line (4 columns when RX/TX
                        // are present, 2 otherwise).
                        // Bar mode: vertical stack — Util, then a 2-col
                        // RX/TX row, then Mem.
                        let gridCls: string;
                        if (viewMode !== 'gauge') {
                          gridCls = 'space-y-2';
                        } else if (hasThroughput) {
                          gridCls = 'grid grid-cols-1 sm:grid-cols-4 gap-3 items-center';
                        } else {
                          gridCls = 'grid grid-cols-2 gap-3';
                        }
                        return (
                          <div className={gridCls}>
                            <UsageBar
                              label={t('system.gpu_util')}
                              pct={g.utilization ?? 0}
                              valueText={g.utilization === null ? 'N/A' : `${g.utilization.toFixed(2)}%`}
                              viewMode={viewMode}
                            />
                            {hasThroughput && viewMode === 'gauge' && (
                              <>
                                <PcieThroughputTile
                                  icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
                                  label={t('dashboard.pcie_rx')}
                                  kbps={g.pcie_rx_kbps}
                                  linkBwGBps={g.pcie_bandwidth_GBps}
                                />
                                <PcieThroughputTile
                                  icon={<ArrowUpFromLine className="w-3.5 h-3.5" />}
                                  label={t('dashboard.pcie_tx')}
                                  kbps={g.pcie_tx_kbps}
                                  linkBwGBps={g.pcie_bandwidth_GBps}
                                />
                              </>
                            )}
                            {hasThroughput && viewMode !== 'gauge' && (
                              <div className="grid grid-cols-2 gap-2">
                                <PcieThroughputTile
                                  icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
                                  label={t('dashboard.pcie_rx')}
                                  kbps={g.pcie_rx_kbps}
                                  linkBwGBps={g.pcie_bandwidth_GBps}
                                />
                                <PcieThroughputTile
                                  icon={<ArrowUpFromLine className="w-3.5 h-3.5" />}
                                  label={t('dashboard.pcie_tx')}
                                  kbps={g.pcie_tx_kbps}
                                  linkBwGBps={g.pcie_bandwidth_GBps}
                                />
                              </div>
                            )}
                            <UsageBar
                              label={t('system.gpu_memory')}
                              pct={memPct}
                              valueText={`${g.memory_used.toLocaleString()} MiB`}
                              valueSub={`/ ${(g.memory_total ?? 0).toLocaleString()} MiB`}
                              viewMode={viewMode}
                            />
                          </div>
                        );
                      })()}
                      <PcieSection gpu={g} t={t} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// Dedicated PCIe connectivity panel under each GPU. Highlights the
// link bandwidth (theoretical max for the active PCIe gen × width) and
// flags a degraded link when the current gen/width is below what the
// GPU + slot support. NVIDIA cards downshift the link gen at idle to
// save power, so the headline number can sit well below the max — this
// is normal ASPM behaviour, not a fault.
function PcieSection({ gpu, t }: Readonly<{
  gpu: {
    pci_bus_id: string | null;
    pcie_gen_current: number | null;
    pcie_gen_max: number | null;
    pcie_width_current: number | null;
    pcie_width_max: number | null;
    pcie_bandwidth_GBps: number | null;
    pcie_bandwidth_max_GBps: number | null;
  };
  t: (key: string) => string;
}>) {
  // If the driver/runtime didn't expose any PCIe info, hide the section
  // entirely rather than render rows full of dashes.
  const hasAny =
    gpu.pci_bus_id ||
    gpu.pcie_gen_current !== null ||
    gpu.pcie_width_current !== null ||
    gpu.pcie_bandwidth_GBps !== null;
  if (!hasAny) return null;

  // Only flag a degraded link when the lane *width* is below max — that
  // is a physical/BIOS issue. A lower current PCIe gen vs max is normal
  // ASPM downshift at idle and would otherwise produce false positives.
  const degraded =
    gpu.pcie_width_current !== null && gpu.pcie_width_max !== null && gpu.pcie_width_current < gpu.pcie_width_max;

  const linkText = gpu.pcie_gen_current !== null && gpu.pcie_width_current !== null
    ? `PCIe ${gpu.pcie_gen_current}.0 ×${gpu.pcie_width_current}`
    : '-';
  const linkMaxText = gpu.pcie_gen_max !== null && gpu.pcie_width_max !== null
    ? `PCIe ${gpu.pcie_gen_max}.0 ×${gpu.pcie_width_max}`
    : null;

  return (
    <div
      className="mt-3 rounded-xl px-3 py-1.5"
      style={{
        background: 'color-mix(in srgb, var(--gv-info) 6%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-info) 25%, transparent)',
      }}
    >
      {/* Compact single-row layout: title + all PCIe metadata inline,
          wraps on narrow widths. Vertical footprint reduced versus the
          previous header + headline + grid stack. */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs">
        <span className="inline-flex items-center gap-1.5">
          <Cable className="w-4 h-4 shrink-0" style={{ color: 'var(--gv-info)' }} />
          <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gv-info)' }}>
            {t('system.pcie_title')}
          </span>
        </span>

        {gpu.pcie_bandwidth_GBps !== null && (
          <span className="inline-flex items-baseline gap-1">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
              {t('system.pcie_bandwidth')}
            </span>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--gv-info)' }}>
              {gpu.pcie_bandwidth_GBps.toFixed(2)} GB/s
            </span>
            {gpu.pcie_bandwidth_max_GBps !== null && gpu.pcie_bandwidth_max_GBps > gpu.pcie_bandwidth_GBps && (
              <span className="text-[10px] tabular-nums" style={{ color: 'var(--gv-text-dim)' }}>
                / max {gpu.pcie_bandwidth_max_GBps.toFixed(2)} GB/s
              </span>
            )}
            <InfoTooltip text={t('system.pcie_bandwidth_hint')} />
          </span>
        )}

        {gpu.pci_bus_id && (
          <span className="inline-flex items-baseline gap-1">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
              {t('system.pcie_slot')}
            </span>
            <span className="font-mono tabular-nums" style={{ color: 'var(--gv-text)' }}>
              {gpu.pci_bus_id}
            </span>
          </span>
        )}

        {linkText !== '-' && (
          <span className="inline-flex items-baseline gap-1">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
              {t('system.pcie_link')}
            </span>
            <span className="tabular-nums" style={{ color: 'var(--gv-text)' }}>
              {linkText}
              {linkMaxText && linkMaxText !== linkText && (
                <span className="text-[10px]" style={{ color: 'var(--gv-text-dim)' }}> (max {linkMaxText})</span>
              )}
            </span>
          </span>
        )}

        {degraded && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
            title={t('system.pcie_degraded_hint')}
            style={{
              color: 'var(--gv-warn)',
              background: 'color-mix(in srgb, var(--gv-warn) 15%, transparent)',
              border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
            }}
          >
            <AlertTriangle className="w-3 h-3" />
            {t('system.pcie_degraded')}
          </span>
        )}
      </div>
    </div>
  );
}

// Theme-agnostic info icon with a CSS-only hover/focus tooltip. Uses
// only --gv-* CSS variables so it adapts to every registered theme
// (dark Midnight/Graphite/Oceanic, light variants, etc.) without
// hard-coded colours. Tooltip stays clipped to the viewport via
// `max-w-[min(20rem,calc(100vw-2rem))]` and is dismissed by mouseout
// or blur. Also exposes `title` as an accessibility fallback.
function InfoTooltip({ text }: Readonly<{ text: string }>) {
  return (
    <span className="relative inline-flex group ml-0.5 align-middle">
      <button
        type="button"
        aria-label={text}
        title={text}
        className="inline-flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 cursor-help"
        style={{
          color: 'var(--gv-text-muted)',
          // Use the accent ring colour so it visually agrees with the
          // rest of the focus styles on cards/buttons.
          // @ts-expect-error CSS custom property
          '--tw-ring-color': 'color-mix(in srgb, var(--gv-accent) 35%, transparent)',
        }}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      <span
        role="tooltip"
        className="invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-opacity duration-150 pointer-events-none absolute z-20 left-1/2 -translate-x-1/2 bottom-full mb-2 p-2 rounded-lg text-[11px] leading-snug normal-case tracking-normal font-normal text-left max-w-[min(20rem,calc(100vw-2rem))] w-max"
        style={{
          background: 'var(--gv-surface)',
          color: 'var(--gv-text)',
          border: '1px solid var(--gv-border)',
          boxShadow: '0 8px 24px -10px color-mix(in srgb, var(--gv-bg) 80%, #000 60%)',
          backdropFilter: 'blur(6px)',
        }}
      >
        {text}
      </span>
    </span>
  );
}

// Visual separator between machine-level stats (host/CPU/RAM) and
// GPU-level stats. Uses a coloured pill so the eye groups the cards
// underneath without needing to read the headings.
function ZoneHeader({ color, icon, label, sub }: Readonly<{
  color: string;
  icon: React.ReactNode;
  label: string;
  sub?: string;
}>) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      <span
        className="inline-flex items-center justify-center w-7 h-7 rounded-lg"
        style={{
          color,
          background: `color-mix(in srgb, ${color} 18%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        }}
      >
        {icon}
      </span>
      <div className="leading-tight">
        <div className="text-sm font-semibold uppercase tracking-wider" style={{ color }}>
          {label}
        </div>
        {sub && <div className="text-[11px]" style={{ color: 'var(--gv-text-muted)' }}>{sub}</div>}
      </div>
    </div>
  );
}

/**
 * Concept B layout: title + icon on the left, dotted-list of metadata
 * chips on the right of the same row (or wraps below on narrow widths).
 * Replaces the previous {h2 + 3-col grid of label/value pairs} so the
 * card body keeps its real estate for the bars/gauges underneath.
 */
function CardHeader({ icon, title, meta, badge }: Readonly<{
  icon: React.ReactNode;
  title: string;
  meta: Array<string | null | undefined>;
  /** Optional pill rendered between the title and the meta line — used
   *  on the Host card to flag "this is the hub itself" (matches the
   *  Hub badge on Settings → Hosts). */
  badge?: React.ReactNode;
}>) {
  const items = meta.filter((m): m is string => Boolean(m && m.trim().length > 0));
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <h2 className="font-semibold flex items-center gap-2 min-w-0">
        {icon}
        <span className="truncate">{title}</span>
        {badge}
      </h2>
      {items.length > 0 && (
        <span
          className="text-[11px] tabular-nums leading-snug min-w-0 truncate sm:whitespace-normal"
          style={{ color: 'var(--gv-text-muted)' }}
        >
          {items.join(' · ')}
        </span>
      )}
    </div>
  );
}

// 5-level severity scale used by both the linear bar and the arc gauge.
// Stays in sync with the gradient stops in <UsageArc /> so the colour the
// user sees on the bar matches the colour the gauge sweeps to.
//
//   <20 %  blue    idle / cold
//   <50 %  green   healthy
//   <75 %  yellow  moderate
//   <90 %  orange  high
//   ≥90 %  red     critical
function severityColor(pct: number): string {
  if (pct >= 90) return 'var(--gv-danger, #ef4444)';
  if (pct >= 75) return 'var(--gv-orange, #f97316)';
  if (pct >= 50) return 'var(--gv-warn, #f59e0b)';
  if (pct >= 20) return 'var(--gv-ok, #22c55e)';
  return 'var(--gv-info, #3b82f6)';
}

function UsageBar({ label, pct, valueText, valueSub, viewMode = 'bar' }: Readonly<{
  label: string;
  pct: number;
  valueText?: string;
  // Optional second line, rendered muted (e.g. "/ 24576 MiB" max capacity).
  valueSub?: string;
  viewMode?: ViewMode;
}>) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = severityColor(clamped);
  const display = valueText ?? `${clamped.toFixed(1)}%`;

  if (viewMode === 'gauge') {
    return <UsageArc label={label} pct={clamped} display={display} sub={valueSub} color={color} />;
  }

  return (
    // Single-line layout: LABEL · bar (flex-1, thin) · VALUE.
    // Saves vertical space vs. the previous "value-on-top / bar-below"
    // stack and lets the value text grow without making the row taller
    // than a typical line of text.
    <div className="flex items-center gap-3">
      <span
        className="text-[10px] uppercase tracking-wider shrink-0 truncate"
        style={{ color: 'var(--gv-text-muted)', minWidth: '4.5rem', maxWidth: '8rem' }}
      >
        {label}
      </span>
      <div
        className="flex-1 h-1.5 rounded-full relative overflow-hidden"
        style={{
          // Full-width 5-band heat gradient as the *base* layer. Same stops
          // as the arc gauge so bar↔gauge stay in lockstep.
          background:
            'linear-gradient(90deg,'
            + ' var(--gv-info, #3b82f6) 0%,'
            + ' var(--gv-ok, #22c55e) 20%,'
            + ' var(--gv-warn, #f59e0b) 50%,'
            + ' var(--gv-orange, #f97316) 75%,'
            + ' var(--gv-danger, #ef4444) 90%,'
            + ' var(--gv-danger, #ef4444) 100%)',
        }}
      >
        {/* Mask the unfilled trailing portion. 15 % darker than the theme
            background — the universal compromise: dark themes stay deep
            without going pure black, light themes get a mid-grey track
            that still lets the heat gradient pop. */}
        <div
          className="absolute inset-y-0 right-0 transition-[width] duration-500"
          style={{
            width: `${100 - clamped}%`,
            background: 'color-mix(in srgb, var(--gv-bg) 85%, #000 15%)',
          }}
        />
      </div>
      <span className="shrink-0 text-right leading-tight">
        <span
          className="block text-base font-mono tabular-nums font-bold"
          style={{ color }}
        >
          {display}
        </span>
        {valueSub && (
          <span className="block text-[11px] font-mono tabular-nums" style={{ color: 'var(--gv-text-dim)' }}>
            {valueSub}
          </span>
        )}
      </span>
    </div>
  );
}

// UsageArc lives in `../ui/UsageArc` so the System page and the
// Fleet GPU mini-tiles share one source of truth for the speedometer.

// 1/5/15 minute load averages, normalized to (load / cores * 100). At 100% the
// run-queue equals the core count — anything above means tasks are waiting.
function LoadAvgBars({ loadavg, cores, label, viewMode = 'bar' }: Readonly<{
  loadavg: number[]; cores: number; label: string; viewMode?: ViewMode;
}>) {
  const windows = ['1 min', '5 min', '15 min'];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--gv-text-muted)' }}>
        {label}
      </div>
      <div className={viewMode === 'gauge' ? 'grid grid-cols-3 gap-3' : 'space-y-2'}>
        {loadavg.slice(0, 3).map((load, i) => {
          const pct = cores > 0 ? (load / cores) * 100 : 0;
          return (
            <UsageBar
              key={windows[i]}
              label={windows[i]}
              pct={pct}
              valueText={`${load.toFixed(2)} (${pct.toFixed(0)}%)`}
              viewMode={viewMode}
            />
          );
        })}
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

function fmtUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
