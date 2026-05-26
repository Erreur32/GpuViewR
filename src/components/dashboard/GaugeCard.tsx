import { ReactNode, useEffect, useRef, useState } from "react";
import Sparkline from "./Sparkline";

type Status = "ok" | "warn" | "danger";

type Props = Readonly<{
  label: string;
  value: number;
  displayValue?: string;
  displaySubValue?: string;
  unit: string;
  max: number;
  warn?: number;
  danger?: number;
  icon?: ReactNode;
  history?: number[];
  variant?: "arc" | "bar";
  /** Epoch (s) of the latest sample for this metric. Drives the live "tick" pulse. */
  ts?: number;
  /** False when this metric is N/A on the active host (e.g. fan_speed on a
   *  passively-cooled iGPU, temperature/power on Windows PDH, etc.). When
   *  not available, the "Live" dot stays dim (no flash on incoming samples)
   *  and the value text is rendered in the muted text color so the card
   *  doesn't visually claim a live measurement that doesn't exist. */
  available?: boolean;
}>;

function statusFor(value: number, warn?: number, danger?: number): Status {
  if (danger !== undefined && value >= danger) return "danger";
  if (warn !== undefined && value >= warn) return "warn";
  return "ok";
}

function colorFor(status: Status): string {
  return status === "danger"
    ? "var(--gv-danger)"
    : status === "warn"
      ? "var(--gv-warn)"
      : "var(--gv-ok)";
}

export default function GaugeCard({
  label,
  value,
  displayValue,
  displaySubValue,
  unit,
  max,
  warn,
  danger,
  icon,
  history,
  ts,
  available = true,
  variant = "arc",
}: Props) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const status = statusFor(value, warn, danger);
  // Active metric → status color (ok/warn/danger). Unavailable metric →
  // muted text color so the card visually fades into a neutral state
  // instead of pretending to read "0 % ok" on a missing sensor.
  const colorVar = available ? colorFor(status) : "var(--gv-text-dim)";

  // Live tick: brief flash on each new sample so the user perceives the live
  // update. Gated on `available` so a card whose metric is N/A on the active
  // host (e.g. fan_speed on a passive iGPU) doesn't flash on every sample
  // and falsely advertise a live measurement.
  const [flash, setFlash] = useState(false);
  const lastTs = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!available) return;
    if (ts !== undefined && ts !== lastTs.current) {
      lastTs.current = ts;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 220);
      return () => clearTimeout(id);
    }
  }, [ts, available]);

  return (
    <div className="card card-hover p-4 flex flex-col gap-3">
      <div
        className="flex items-center justify-between text-xs"
        style={{ color: "var(--gv-text-muted)" }}
      >
        <span className="inline-flex items-center gap-1.5 uppercase tracking-wider font-medium">
          {icon}
          <span>{label}</span>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full transition-opacity duration-300"
            style={{
              background: colorVar,
              opacity: !available ? 0.3 : flash ? 1 : 0.45,
              boxShadow: available && flash ? `0 0 6px ${colorVar}` : "none",
            }}
            title={available ? "Live" : "N/A on this host"}
          />
        </span>
        {history && history.length > 1 && (
          <Sparkline
            values={history.slice(-60)}
            max={Math.max(max, ...history)}
            width={80}
            height={22}
            stroke={colorVar}
          />
        )}
      </div>

      {variant === "arc" ? (
        <ArcGauge
          pct={pct}
          colorVar={colorVar}
          value={value}
          unit={unit}
          max={max}
          displayValue={displayValue}
          displaySubValue={displaySubValue}
          warn={warn}
          danger={danger}
          status={status}
        />
      ) : (
        <BarGauge
          pct={pct}
          colorVar={colorVar}
          value={value}
          unit={unit}
          max={max}
          displayValue={displayValue}
          displaySubValue={displaySubValue}
          status={status}
        />
      )}
    </div>
  );
}

function ArcGauge({
  pct,
  colorVar,
  value,
  unit,
  max,
  displayValue,
  displaySubValue,
  warn,
  danger,
  status,
}: {
  pct: number;
  colorVar: string;
  value: number;
  unit: string;
  max: number;
  displayValue?: string;
  displaySubValue?: string;
  warn?: number;
  danger?: number;
  status: Status;
}) {
  const radius = 50;
  const strokeW = 13;
  const circ = 2 * Math.PI * radius * 0.75;
  const offset = circ - (pct / 100) * circ;

  // Threshold tick marks on the arc (warn + danger), so the user can see the bands at a glance.
  const ticks: { pct: number; color: string }[] = [];
  if (warn !== undefined)
    ticks.push({
      pct: Math.min(100, (warn / max) * 100),
      color: "var(--gv-warn)",
    });
  if (danger !== undefined)
    ticks.push({
      pct: Math.min(100, (danger / max) * 100),
      color: "var(--gv-danger)",
    });

  return (
    <div className="relative w-full aspect-square max-w-[160px] mx-auto">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-[135deg]">
        <defs>
          <linearGradient
            id={`gaugeGrad-${status}`}
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor={colorVar} stopOpacity="0.35" />
            <stop offset="100%" stopColor={colorVar} stopOpacity="1" />
          </linearGradient>
        </defs>
        {/* track */}
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth={strokeW}
          stroke="var(--gv-border)"
          strokeDasharray={`${circ} ${2 * Math.PI * radius}`}
          strokeLinecap="round"
        />
        {/* threshold ticks */}
        {ticks.map((t) => {
          const a = (t.pct / 100) * circ;
          return (
            <circle
              key={t.color + t.pct}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              strokeWidth={strokeW - 4}
              stroke={t.color}
              strokeDasharray={`2 ${2 * Math.PI * radius - 2}`}
              strokeDashoffset={-a}
              strokeLinecap="butt"
              opacity="0.7"
            />
          );
        })}
        {/* value arc */}
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          strokeWidth={strokeW}
          stroke={`url(#gaugeGrad-${status})`}
          strokeDasharray={`${circ} ${2 * Math.PI * radius}`}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{
            transition:
              "stroke-dashoffset 600ms cubic-bezier(0.2, 0.8, 0.2, 1), stroke 300ms",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div
          className="text-2xl font-bold tabular-nums leading-none"
          style={{ color: colorVar }}
        >
          {displayValue ?? `${value.toFixed(value < 10 ? 1 : 0)}${unit}`}
        </div>
        {displaySubValue ? (
          <div
            className="text-[10px] mt-1"
            style={{ color: "var(--gv-text-dim)" }}
          >
            {displaySubValue}
          </div>
        ) : (
          !displayValue && (
            <div
              className="text-[10px] mt-1"
              style={{ color: "var(--gv-text-dim)" }}
            >
              / {max}
              {unit}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function BarGauge({
  pct,
  colorVar,
  value,
  unit,
  max,
  displayValue,
  displaySubValue,
  status,
}: {
  pct: number;
  colorVar: string;
  value: number;
  unit: string;
  max: number;
  displayValue?: string;
  displaySubValue?: string;
  status: Status;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span
          className="text-2xl font-bold tabular-nums leading-none"
          style={{ color: colorVar }}
        >
          {displayValue ?? `${value.toFixed(value < 10 ? 1 : 0)}${unit}`}
        </span>
        <span className="text-[10px]" style={{ color: "var(--gv-text-dim)" }}>
          {displaySubValue ?? `/ ${max}${unit}`}
        </span>
      </div>
      <div
        className="relative h-3 w-full rounded-full overflow-hidden"
        style={{ background: "var(--gv-surface-alt)" }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            // Gradient anchored to the full track (sombre fixed at the
            // left edge, clair fixed at the right edge); the fill grows
            // by revealing more of it via clip-path so the dark band
            // doesn't stretch with pct.
            background: `linear-gradient(90deg, color-mix(in srgb, ${colorVar} 35%, #000) 0%, ${colorVar} 70%, color-mix(in srgb, ${colorVar} 70%, #fff) 100%)`,
            boxShadow: `0 0 8px color-mix(in srgb, ${colorVar} 40%, transparent)`,
            clipPath: `inset(0 ${100 - pct}% 0 0)`,
            transition:
              "clip-path 600ms cubic-bezier(0.2, 0.8, 0.2, 1), background 300ms",
          }}
          aria-label={`${status} ${pct.toFixed(0)}%`}
        />
      </div>
      <div
        className="flex justify-between text-[10px] tabular-nums"
        style={{ color: "var(--gv-text-dim)" }}
      >
        <span>0</span>
        <span>{pct.toFixed(0)}%</span>
        <span>
          {max}
          {unit}
        </span>
      </div>
    </div>
  );
}
