import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

/** Gap between the icon and the bubble, and minimum margin to the viewport. */
const GAP = 8;
const MARGIN = 8;

// Info icon with a hover/focus tooltip. Only --gv-* variables, so it
// follows every theme (dark and light). The bubble is portalled to <body>
// with fixed positioning: cards use backdrop-filter, which gives each one
// its own stacking context, so an in-card bubble went under the next card.
// `label` is the accessible name; `children` is the rich body when there
// is one, else `label` is shown.
export default function InfoTooltip({
  label,
  children,
  placement = 'top',
  tone = 'muted',
}: Readonly<{
  label: string;
  children?: ReactNode;
  placement?: 'top' | 'bottom';
  /** Icon colour: muted text, or the warn token for "something is missing". */
  tone?: 'muted' | 'warn';
}>) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });

  // Place the bubble once it is rendered (its size is known): centred on
  // the icon, flipped when it would leave the viewport, clamped to it.
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !tipRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const above = b.top - GAP - tip.height;
    const below = b.bottom + GAP;
    let top = placement === 'top' ? above : below;
    if (placement === 'top' && above < MARGIN) top = below;
    if (placement === 'bottom' && below + tip.height > window.innerHeight - MARGIN && above >= MARGIN) top = above;
    const left = Math.min(
      Math.max(MARGIN, b.left + b.width / 2 - tip.width / 2),
      window.innerWidth - tip.width - MARGIN,
    );
    setPos({ top, left, visibility: 'visible' });
  }, [open, placement]);

  const show = () => setOpen(true);
  const hide = () => {
    setOpen(false);
    setPos({ visibility: 'hidden' });
  };

  return (
    <span className="relative inline-flex ml-0.5 align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        className="inline-flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 cursor-help"
        style={{
          color: tone === 'warn' ? 'var(--gv-warn)' : 'var(--gv-text-muted)',
          // Accent ring, same as the focus styles on cards and buttons.
          // @ts-expect-error CSS custom property
          '--tw-ring-color': 'color-mix(in srgb, var(--gv-accent) 35%, transparent)',
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          className="fixed z-[100] pointer-events-none p-2.5 rounded-lg text-[11px] leading-snug normal-case tracking-normal font-normal text-left max-w-[min(20rem,calc(100vw-2rem))] w-max"
          style={{
            ...pos,
            background: 'var(--gv-bg2)',
            color: 'var(--gv-text)',
            border: '1px solid var(--gv-border)',
            boxShadow: '0 10px 28px -8px color-mix(in srgb, var(--gv-bg) 70%, #000 60%)',
          }}
        >
          {children ?? label}
        </span>,
        document.body,
      )}
    </span>
  );
}
