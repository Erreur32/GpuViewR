// Shared 180° half-circle speedometer gauge. Used by the System page,
// the Fleet GPU mini-tiles, and anywhere else a percentage needs to
// render in the same heat-gradient + glow style. Pure SVG/CSS, no
// external libs — the gradient stops match the linear UsageBar in
// SystemPage so the colour signal stays in lockstep across views.

export interface UsageArcProps {
  /** Caption rendered below the arc, e.g. "CPU usage". */
  label: string;
  /** 0..100. Values outside that range are clamped. Drives both the
   *  arc fill and the danger pulse (≥90 %). */
  pct: number;
  /** Big number drawn inside the arc, e.g. "37 %", "12.4 GiB", "—". */
  display: string;
  /** Optional second line below `display`, muted (e.g. "/ 24576 MiB"). */
  sub?: string;
  /** Colour applied to the centre text and to the faint halo behind
   *  the value arc. The arc itself uses the shared gradient. */
  color: string;
  /** Override default arc max-width. Default 180 px (System sizing).
   *  Fleet mini-tile passes 110 px for a denser layout. */
  maxWidthPx?: number;
  /** Override default centre-text size class. Default `text-base`
   *  (System). Fleet mini-tile passes `text-[11px]` to fit four
   *  arcs side-by-side. */
  displayClassName?: string;
}

/**
 * @example
 * <UsageArc label="GPU temp" pct={62} display="62°C" color="var(--gv-warn)" />
 */
export default function UsageArc({
  label, pct, display, sub, color,
  maxWidthPx = 180,
  displayClassName = 'text-base font-semibold tabular-nums',
}: Readonly<UsageArcProps>) {
  const clamped = Math.max(0, Math.min(100, pct));
  // viewBox is 200×120: 200 wide for the half-circle, ~20 px headroom below
  // the arc for the centre text. Radius 80 keeps the stroke thick enough.
  const cx = 100;
  const cy = 100;
  const radius = 80;
  const fullCirc = 2 * Math.PI * radius;
  const arcLen = fullCirc * 0.5;
  const offset = arcLen - (clamped / 100) * arcLen;
  const danger = clamped >= 90;
  // Unique ids so multiple gauges on the page don't share defs.
  const uid = `${label.replaceAll(/\W+/g, '')}-${Math.round(clamped * 1000)}`;
  // 10 evenly-spaced ticks across the 180° arc.
  const tickCount = 10;
  const tickEvery = arcLen / tickCount;
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative w-full aspect-[2/1.1]" style={{ maxWidth: `${maxWidthPx}px` }}>
        {/* SVG is rotated -180° around (cx,cy) so the half-circle that lives
            in the bottom half of the circle's path renders in the top half
            of the viewBox — i.e. opens upward, speedometer style. */}
        <svg viewBox="0 0 200 120" className={`w-full h-full ${danger ? 'gauge-pulse' : ''}`}>
          <defs>
            {/* 5-band heat gradient. The arc group is rotated 180° around
                (cx, cy), and userSpaceOnUse gradients follow the shape's
                CTM — so we declare x1/x2 in the *pre-rotation* frame
                **inverted**: x1 on the right, x2 on the left. After the
                rotation kicks in, the screen-space gradient ends up with
                blue at the visible left (small pct) and red at the right
                (high pct), matching the linear bar. */}
            <linearGradient
              id={`grad-${uid}`}
              gradientUnits="userSpaceOnUse"
              x1={cx + radius} y1={cy}
              x2={cx - radius} y2={cy}
            >
              <stop offset="0%"   stopColor="var(--gv-info, #3b82f6)" />
              <stop offset="20%"  stopColor="var(--gv-ok, #22c55e)" />
              <stop offset="50%"  stopColor="var(--gv-warn, #f59e0b)" />
              <stop offset="75%"  stopColor="var(--gv-orange, #f97316)" />
              <stop offset="90%"  stopColor="var(--gv-danger, #ef4444)" />
              <stop offset="100%" stopColor="var(--gv-danger, #ef4444)" />
            </linearGradient>
            <filter id={`glow-${uid}`} x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur stdDeviation="0.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* Group rotated 180° so the natural "right half" of the circle path
              lands as the visible "top half" semicircle (opens up). */}
          <g transform={`rotate(180 ${cx} ${cy})`}>
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="18"
              stroke="var(--gv-surface-alt)"
              strokeDasharray={`${arcLen} ${fullCirc}`}
              strokeLinecap="round"
            />
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="22"
              stroke="var(--gv-border)"
              strokeDasharray={`1.4 ${tickEvery - 1.4}`}
              strokeDashoffset="0"
              opacity="0.55"
              style={{ pointerEvents: 'none' }}
            />
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="22"
              stroke={color}
              strokeDasharray={`${arcLen} ${fullCirc}`}
              strokeDashoffset={offset}
              strokeLinecap="round"
              opacity="0.08"
              style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
            />
            <circle
              cx={cx} cy={cy} r={radius} fill="none" strokeWidth="18"
              stroke={`url(#grad-${uid})`}
              strokeDasharray={`${arcLen} ${fullCirc}`}
              strokeDashoffset={offset}
              strokeLinecap="round"
              filter={`url(#glow-${uid})`}
              style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
            />
          </g>
        </svg>
        <div
          className="absolute inset-x-0 flex flex-col items-center pointer-events-none"
          style={{ bottom: '8%' }}
        >
          <div
            className={`${displayClassName} leading-none truncate max-w-full`}
            style={{ color }}
          >
            {display}
          </div>
          {sub && (
            <div className="text-[10px] tabular-nums mt-0.5 truncate max-w-full" style={{ color: 'var(--gv-text-dim)' }}>
              {sub}
            </div>
          )}
        </div>
      </div>
      <div className="text-[10px] uppercase tracking-wider mt-1 truncate max-w-full" style={{ color: 'var(--gv-text-muted)' }}>
        {label}
      </div>
    </div>
  );
}
