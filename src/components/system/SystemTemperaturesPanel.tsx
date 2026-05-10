import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Thermometer, Flame, Cpu, HardDrive, Server, ChevronDown, ChevronRight } from 'lucide-react';
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
}

// Pretty source labels per known hwmon driver. Anything unknown falls
// through to the raw kernel name.
const SOURCE_META: Record<string, { name: string; icon: LucideIcon }> = {
  coretemp:    { name: 'CPU (Intel)',     icon: Cpu },
  k10temp:     { name: 'CPU (AMD)',       icon: Cpu },
  zenpower:    { name: 'CPU (AMD Zen)',   icon: Cpu },
  cpu_thermal: { name: 'CPU',             icon: Cpu },
  acpitz:      { name: 'ACPI thermal',    icon: Server },
  nvme:        { name: 'NVMe SSD',        icon: HardDrive },
  drivetemp:   { name: 'SATA drive',      icon: HardDrive },
  iwlwifi_1:   { name: 'Wi-Fi',           icon: Server },
};

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

export default function SystemTemperaturesPanel({ temperatures }: Readonly<Props>) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupBySource(temperatures), [temperatures]);
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
  const heroCrit = defaultCrit(groups[0].source, hottest.critC);
  const heroPct = Math.max(0, Math.min(100, (hottest.valueC / heroCrit) * 100));
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
            ({temperatures.length})
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
        <span className="text-[11px]" style={{ color: 'var(--gv-text-dim)' }}>
          {t('system.temps_hint')}
        </span>
      </header>

      {open && <>

      {/* Hero — hottest sensor on the box, glowing readout + a
          heatmap strip of every reading colour-coded by °C. */}
      <div
        className="relative rounded-2xl p-3 overflow-hidden"
        style={{
          background:
            `radial-gradient(circle at 20% 0%, color-mix(in srgb, ${heroColor} 22%, transparent), transparent 60%),`
            + ' var(--gv-surface-alt)',
          border: `1px solid color-mix(in srgb, ${heroColor} 30%, var(--gv-border))`,
          boxShadow: isHot
            ? `0 0 30px -10px color-mix(in srgb, ${heroColor} 55%, transparent)`
            : 'none',
        }}
      >
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--gv-text-muted)' }}>
              {t('system.temps_hottest')}
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span
                className={'text-3xl font-bold tabular-nums leading-none ' + (isHot ? 'temp-hot-pulse' : '')}
                style={{
                  color: heroColor,
                  textShadow: `0 0 14px color-mix(in srgb, ${heroColor} 45%, transparent)`,
                }}
              >
                {hottest.valueC.toFixed(1)}
              </span>
              <span className="text-lg font-semibold" style={{ color: heroColor }}>°C</span>
              {isHot && (
                <Flame className="w-5 h-5 temp-hot-pulse" style={{ color: heroColor }} />
              )}
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--gv-text-muted)' }}>
              <span className="font-medium" style={{ color: 'var(--gv-text)' }}>{hottest.label}</span>
              <span className="opacity-70"> · {groups[0].prettyName}</span>
            </div>
          </div>

          {/* Sensor count + average for at-a-glance context */}
          <div className="text-right text-[11px]" style={{ color: 'var(--gv-text-muted)' }}>
            <div>
              <span className="font-mono tabular-nums" style={{ color: 'var(--gv-text)' }}>
                {avgC(temperatures).toFixed(1)}°C
              </span>
              <span className="opacity-70"> {t('system.temps_avg')}</span>
            </div>
            <div className="mt-0.5">
              <span className="font-mono tabular-nums" style={{ color: 'var(--gv-text)' }}>
                {groups.length}
              </span>
              <span className="opacity-70"> {t('system.temps_sources')}</span>
            </div>
          </div>
        </div>

        {/* Hottest sensor heat bar — pct toward critical */}
        <div className="mt-3">
          <div
            className="h-1.5 rounded-full relative overflow-hidden"
            style={{ background: 'color-mix(in srgb, var(--gv-bg) 70%, #000 30%)' }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
              style={{
                width: `${heroPct}%`,
                background:
                  'linear-gradient(90deg,'
                  + ' var(--gv-info, #3b82f6) 0%,'
                  + ' var(--gv-ok, #22c55e) 25%,'
                  + ' var(--gv-warn, #f59e0b) 55%,'
                  + ' var(--gv-orange, #f97316) 80%,'
                  + ' var(--gv-danger, #ef4444) 100%)',
                boxShadow: `0 0 10px color-mix(in srgb, ${heroColor} 40%, transparent)`,
              }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] mt-1" style={{ color: 'var(--gv-text-dim)' }}>
            <span>0°C</span>
            <span className="tabular-nums">
              {heroPct.toFixed(0)}% / {heroCrit}°C {t('system.temps_crit')}
            </span>
          </div>
        </div>

        {/* Heatmap strip — one segment per sensor, colour by reading.
            Compact, shows the entire system thermal landscape in a
            single horizontal glance. */}
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-[0.18em] mb-1.5" style={{ color: 'var(--gv-text-muted)' }}>
            {t('system.temps_map')}
          </div>
          <div className="flex flex-wrap gap-[3px]">
            {temperatures.map((s, i) => {
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
                  return (
                    <div
                      key={`${s.label}-${i}`}
                      className="relative rounded-md px-2 py-1 text-[11px] leading-tight overflow-hidden"
                      style={{
                        background: `color-mix(in srgb, ${c} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
                        minWidth: '4.5rem',
                      }}
                      title={`${s.label} — ${s.valueC.toFixed(1)}°C${s.critC ? ` (crit ${s.critC}°C)` : ''}`}
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
