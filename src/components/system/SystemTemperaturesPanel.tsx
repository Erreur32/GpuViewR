import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Thermometer, Cpu, HardDrive, Server, ChevronDown, ChevronRight, Gpu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface HostTempSensor {
  source: string;
  label: string;
  valueC: number;
  maxC: number | null;
  critC: number | null;
}

interface Props {
  temperatures: ReadonlyArray<HostTempSensor>;
  // Optional GPU readings, used to populate the GPU sub-frame on
  // systems where the kernel doesn't expose GPU temps via hwmon
  // (NVIDIA proprietary stack reports through nvidia-smi, not hwmon).
  gpus?: ReadonlyArray<{ gpu_index: number; name: string; temperature: number }>;
}

type Category = 'cpu' | 'gpu' | 'other';

// Pretty source labels per known hwmon driver. Anything unknown falls
// through to the raw kernel name.
const SOURCE_META: Record<string, { name: string; icon: LucideIcon; category: Category }> = {
  coretemp:    { name: 'CPU (Intel)',     icon: Cpu,       category: 'cpu' },
  k10temp:     { name: 'CPU (AMD)',       icon: Cpu,       category: 'cpu' },
  zenpower:    { name: 'CPU (AMD Zen)',   icon: Cpu,       category: 'cpu' },
  k8temp:      { name: 'CPU (AMD K8)',    icon: Cpu,       category: 'cpu' },
  cpu_thermal: { name: 'CPU',             icon: Cpu,       category: 'cpu' },
  amdgpu:      { name: 'GPU (AMD)',       icon: Gpu,       category: 'gpu' },
  nouveau:     { name: 'GPU (Nouveau)',   icon: Gpu,       category: 'gpu' },
  radeon:      { name: 'GPU (Radeon)',    icon: Gpu,       category: 'gpu' },
  nvidia:      { name: 'GPU (NVIDIA)',    icon: Gpu,       category: 'gpu' },
  acpitz:      { name: 'ACPI thermal',    icon: Server,    category: 'other' },
  nvme:        { name: 'NVMe SSD',        icon: HardDrive, category: 'other' },
  drivetemp:   { name: 'SATA drive',      icon: HardDrive, category: 'other' },
  iwlwifi_1:   { name: 'Wi-Fi',           icon: Server,    category: 'other' },
};

function categoryOf(source: string): Category {
  return SOURCE_META[source]?.category ?? 'other';
}

// 5-band heat scale. Mirrors UsageBar/UsageArc severity in SystemPage so
// the eye groups thermal state by the same colour cues.
function tempColor(c: number): string {
  if (c >= 90) return 'var(--gv-danger, #ef4444)';
  if (c >= 75) return 'var(--gv-orange, #f97316)';
  if (c >= 60) return 'var(--gv-warn, #f59e0b)';
  if (c >= 40) return 'var(--gv-ok, #22c55e)';
  return 'var(--gv-info, #3b82f6)';
}

// Critical threshold heuristic. Sensors that don't expose temp_crit get
// a sane default so the heat bar still has a denominator.
function defaultCrit(source: string, exposed: number | null): number {
  if (exposed && exposed >= 50) return exposed;
  if (source.startsWith('nvme')) return 85;
  if (source === 'coretemp' || source === 'k10temp' || source === 'zenpower') return 100;
  return 95;
}

interface Group {
  source: string;
  prettyName: string;
  Icon: LucideIcon;
  sensors: HostTempSensor[];
  hottest: HostTempSensor;
}

function groupBySource(sensors: ReadonlyArray<HostTempSensor>): Group[] {
  const map = new Map<string, HostTempSensor[]>();
  for (const s of sensors) {
    const arr = map.get(s.source) ?? [];
    arr.push(s);
    map.set(s.source, arr);
  }
  const groups: Group[] = [];
  for (const [source, arr] of map) {
    arr.sort((a, b) => b.valueC - a.valueC);
    const meta = SOURCE_META[source];
    groups.push({
      source,
      prettyName: meta?.name ?? source,
      Icon: meta?.icon ?? Thermometer,
      sensors: arr,
      hottest: arr[0],
    });
  }
  // Hottest source first so the eye scans from "most attention needed"
  // downward.
  groups.sort((a, b) => b.hottest.valueC - a.hottest.valueC);
  return groups;
}

const STORAGE_KEY = 'gpuviewr.systemTempsOpen';

// Promote GPU readings from info.gpus into synthetic hwmon-shaped
// sensors so the GPU sub-frame works on NVIDIA boxes (proprietary
// driver doesn't register hwmon nodes). Skipped when the kernel
// already exposes a GPU hwmon source (amdgpu/nouveau) — those carry
// richer per-channel labels we don't want to overwrite.
function buildSensors(
  temperatures: ReadonlyArray<HostTempSensor>,
  gpus: ReadonlyArray<{ gpu_index: number; name: string; temperature: number }> | undefined,
): HostTempSensor[] {
  const merged: HostTempSensor[] = [...temperatures];
  if (!gpus || gpus.length === 0) return merged;
  const hasGpuHwmon = temperatures.some((s) => categoryOf(s.source) === 'gpu');
  if (hasGpuHwmon) return merged;
  for (const g of gpus) {
    if (!Number.isFinite(g.temperature) || g.temperature < 5 || g.temperature > 150) continue;
    merged.push({
      source: 'nvidia',
      label: `GPU ${g.gpu_index} · ${g.name}`,
      valueC: g.temperature,
      maxC: null,
      critC: null,
    });
  }
  return merged;
}

export default function SystemTemperaturesPanel({ temperatures, gpus }: Readonly<Props>) {
  const { t } = useTranslation();
  const sensors = useMemo(() => buildSensors(temperatures, gpus), [temperatures, gpus]);
  const groups = useMemo(() => groupBySource(sensors), [sensors]);
  const cpuSensors = useMemo(() => sensors.filter((s) => categoryOf(s.source) === 'cpu'), [sensors]);
  const gpuSensors = useMemo(() => sensors.filter((s) => categoryOf(s.source) === 'gpu'), [sensors]);
  const [open, setOpen] = useState<boolean>(
    () => (typeof localStorage === 'undefined' ? true : localStorage.getItem(STORAGE_KEY) !== '0'),
  );
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  if (groups.length === 0) return null;

  const hottest = groups[0].hottest;
  const heroColor = tempColor(hottest.valueC);
  const isHot = hottest.valueC >= 75;

  return (
    <section
      className="card p-5 space-y-4 border-l-2"
      style={{ borderLeftColor: 'color-mix(in srgb, var(--gv-warn) 50%, transparent)' }}
    >
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="font-semibold flex items-center gap-2 text-left"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}
        >
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <Thermometer className="w-4 h-4" style={{ color: 'var(--gv-warn)' }} />
          {t('system.temps_title')}
          <span className="text-xs font-normal" style={{ color: 'var(--gv-text-muted)' }}>
            ({sensors.length})
          </span>
          {!open && (
            <span
              className="text-xs font-mono tabular-nums ml-1"
              style={{ color: heroColor }}
              title={`${hottest.source} · ${hottest.label}`}
            >
              · {hottest.valueC.toFixed(1)}°C
            </span>
          )}
        </button>
        <span className="text-[11px] flex items-center gap-3 flex-wrap" style={{ color: 'var(--gv-text-dim)' }}>
          <span>
            <span className="font-mono tabular-nums" style={{ color: 'var(--gv-text)' }}>
              {avgC(sensors).toFixed(1)}°C
            </span>{' '}
            {t('system.temps_avg')}
          </span>
          <span>
            <span className="font-mono tabular-nums" style={{ color: 'var(--gv-text)' }}>
              {groups.length}
            </span>{' '}
            {t('system.temps_sources')}
          </span>
        </span>
      </header>

      {open && <>

      {/* Hero — split into two sub-frames (CPU / GPU) so each silicon
          domain gets its own hottest reading + heat bar. The
          surrounding glow follows the overall hottest sensor so the
          card still flashes when *something* is in trouble. */}
      <div
        className="relative rounded-2xl p-3 overflow-hidden space-y-4"
        style={{
          background:
            `radial-gradient(circle at 20% 0%, color-mix(in srgb, ${heroColor} 18%, transparent), transparent 60%),`
            + ' var(--gv-surface-alt)',
          border: `1px solid color-mix(in srgb, ${heroColor} 30%, var(--gv-border))`,
          boxShadow: isHot
            ? `0 0 30px -10px color-mix(in srgb, ${heroColor} 55%, transparent)`
            : 'none',
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CategoryFrame label={t('system.temps_cpu')} Icon={Cpu} sensors={cpuSensors} t={t} />
          <CategoryFrame label={t('system.temps_gpu')} Icon={Gpu} sensors={gpuSensors} t={t} />
        </div>

        {/* Heatmap strip — one segment per sensor, colour by reading.
            Compact, shows the entire system thermal landscape in a
            single horizontal glance. */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gv-text-muted)' }}>
            {t('system.temps_map')}
          </div>
          <div className="flex flex-wrap gap-[3px]">
            {sensors.map((s, i) => {
              const c = tempColor(s.valueC);
              return (
                <span
                  key={`${s.source}-${s.label}-${i}`}
                  title={`${s.source} · ${s.label} — ${s.valueC.toFixed(1)}°C`}
                  className="inline-block w-3 h-3 rounded-sm"
                  style={{
                    background: c,
                    boxShadow: `0 0 6px color-mix(in srgb, ${c} 45%, transparent)`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Source-grouped chip cards. Each chip = one sensor reading. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {groups.map((g) => {
          const groupCrit = defaultCrit(g.source, g.hottest.critC);
          const groupColor = tempColor(g.hottest.valueC);
          return (
            <div
              key={g.source}
              className="rounded-xl p-3 space-y-2"
              style={{
                background: 'var(--gv-surface-alt)',
                border: `1px solid color-mix(in srgb, ${groupColor} 22%, var(--gv-border))`,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <g.Icon className="w-4 h-4 shrink-0" style={{ color: groupColor }} />
                  <span className="font-semibold truncate text-sm">{g.prettyName}</span>
                  <span className="text-[10px] font-mono opacity-60 truncate">{g.source}</span>
                </div>
                <span
                  className="text-sm font-mono font-bold tabular-nums whitespace-nowrap"
                  style={{ color: groupColor }}
                >
                  {g.hottest.valueC.toFixed(1)}°C
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.sensors.map((s, i) => {
                  const c = tempColor(s.valueC);
                  const pct = Math.max(0, Math.min(100, (s.valueC / groupCrit) * 100));
                  const critSuffix = s.critC ? ` (crit ${s.critC}°C)` : '';
                  return (
                    <div
                      key={`${s.label}-${i}`}
                      className="relative rounded-md px-2 py-1 text-[11px] leading-tight overflow-hidden"
                      style={{
                        background: `color-mix(in srgb, ${c} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
                        minWidth: '4.5rem',
                      }}
                      title={`${s.label} — ${s.valueC.toFixed(1)}°C${critSuffix}`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 opacity-25"
                        style={{ width: `${pct}%`, background: c }}
                      />
                      <div className="relative flex items-baseline justify-between gap-2">
                        <span className="truncate" style={{ color: 'var(--gv-text-muted)' }}>{s.label}</span>
                        <span className="font-mono tabular-nums font-semibold" style={{ color: c }}>
                          {s.valueC.toFixed(0)}°
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      </>}
    </section>
  );
}

function avgC(sensors: ReadonlyArray<HostTempSensor>): number {
  if (sensors.length === 0) return 0;
  let sum = 0;
  for (const s of sensors) sum += s.valueC;
  return sum / sensors.length;
}

// Per-category sub-frame: hottest sensor in the category + a heat bar
// scaled to that sensor's critical threshold. Shows an empty state
// when the host has no sensors in this category (e.g. NVIDIA-only
// box without the userland tools, or an iGPU-less server for CPU).
function CategoryFrame({
  label, Icon, sensors, t,
}: Readonly<{
  label: string;
  Icon: LucideIcon;
  sensors: ReadonlyArray<HostTempSensor>;
  t: (key: string) => string;
}>) {
  if (sensors.length === 0) {
    return (
      <div
        className="rounded-xl p-3 flex flex-col gap-1.5"
        style={{
          background: 'var(--gv-surface)',
          border: '1px dashed var(--gv-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 opacity-60" />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>
            {label}
          </span>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--gv-text-dim)' }}>
          {t('system.temps_no_sensors')}
        </div>
      </div>
    );
  }
  const hottest = sensors.reduce((a, b) => (b.valueC > a.valueC ? b : a));
  const color = tempColor(hottest.valueC);
  const crit = defaultCrit(hottest.source, hottest.critC);
  const pct = Math.max(0, Math.min(100, (hottest.valueC / crit) * 100));
  const prettyName = SOURCE_META[hottest.source]?.name ?? hottest.source;
  return (
    <div
      className="rounded-xl p-3 flex flex-col gap-2"
      style={{
        // Use --gv-surface (the card surface, not --gv-bg) so the panel
        // sits *above* its parent on every theme — light themes get a
        // soft tinted card, dark themes get a slightly lifted panel.
        // The 8% colour wash keeps the category accent visible without
        // washing out the text on light backgrounds.
        background: `color-mix(in srgb, ${color} 8%, var(--gv-surface))`,
        border: `1px solid color-mix(in srgb, ${color} 35%, var(--gv-border))`,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="w-4 h-4 shrink-0" style={{ color }} />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color }}>
            {label}
          </span>
          <span className="text-[10px] opacity-60 ml-0.5">({sensors.length})</span>
        </div>
        <span
          className="text-2xl font-bold font-mono tabular-nums leading-none"
          style={{
            color,
            textShadow: `0 0 12px color-mix(in srgb, ${color} 40%, transparent)`,
          }}
        >
          {hottest.valueC.toFixed(1)}°
        </span>
      </div>
      <div className="text-[11px] truncate" style={{ color: 'var(--gv-text-muted)' }}>
        <span className="font-medium" style={{ color: 'var(--gv-text)' }}>{hottest.label}</span>
        <span className="opacity-70"> · {prettyName}</span>
      </div>
      <div>
        {/* Same gradient-base + mask-trailing-end pattern as
            SystemPage's UsageBar so the bar reads identically across
            light/dark themes — the 85% bg / 15% black mask is the
            shared track tone used everywhere on the System page. */}
        <div
          className="h-1.5 rounded-full relative overflow-hidden"
          style={{
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
          <div
            className="absolute inset-y-0 right-0 transition-[width] duration-500"
            style={{
              width: `${100 - pct}%`,
              background: 'color-mix(in srgb, var(--gv-bg) 85%, #000 15%)',
            }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] mt-1" style={{ color: 'var(--gv-text-dim)' }}>
          <span>0°C</span>
          <span className="tabular-nums">
            {pct.toFixed(0)}% / {crit}°C {t('system.temps_crit')}
          </span>
        </div>
      </div>
    </div>
  );
}
