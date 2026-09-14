import { useTranslation } from 'react-i18next';
import { Clock, ChevronDown } from 'lucide-react';
import { useUiStore, type Range } from '../../store/uiStore';
import { useDropdown } from '../../lib/useDropdown';
import DropdownPanel from '../ui/DropdownPanel';

const RANGES: Range[] = ['live', '5m', '15m', '1h', '6h', '24h', '3d'];

// Single button collapsed by default (one row of 7 range buttons ate too
// much header width) : click to reveal the choices, pick one and it
// collapses back showing the active range's label on the trigger.
export default function RangeSelector() {
  const { t } = useTranslation();
  const range = useUiStore((s) => s.range);
  const setRange = useUiStore((s) => s.setRange);
  const { open, setOpen, rootRef } = useDropdown();

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
        <DropdownPanel align="right" label={t('dashboard.range_label')}>
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
        </DropdownPanel>
      )}
    </div>
  );
}
