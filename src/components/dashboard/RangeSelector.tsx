import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, ChevronDown } from 'lucide-react';
import { useUiStore, type Range } from '../../store/uiStore';

const RANGES: Range[] = ['live', '5m', '15m', '1h', '6h', '24h', '3d'];

// Single button collapsed by default (one row of 7 range buttons ate too
// much header width) : click to reveal the choices, pick one and it
// collapses back showing the active range's label on the trigger.
export default function RangeSelector() {
  const { t } = useTranslation();
  const range = useUiStore((s) => s.range);
  const setRange = useUiStore((s) => s.setRange);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="seg-btn inline-flex items-center gap-1.5"
        style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t('dashboard.range_label')}
      >
        <Clock className="w-3.5 h-3.5" />
        {t(`dashboard.ranges.${range}`)}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          className="seg absolute right-0 top-full mt-1 z-20 flex-col"
          style={{ background: 'var(--gv-bg2)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          role="listbox"
          aria-label={t('dashboard.range_label')}
        >
          {RANGES.map((r) => (
            <button
              key={r}
              className="seg-btn text-left"
              role="option"
              aria-selected={r === range}
              aria-pressed={r === range}
              onClick={() => {
                setRange(r);
                setOpen(false);
              }}
            >
              {t(`dashboard.ranges.${r}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
