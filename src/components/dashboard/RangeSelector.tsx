import { useTranslation } from 'react-i18next';
import { useUiStore, type Range } from '../../store/uiStore';

const RANGES: Range[] = ['1m', '2m', '5m', '15m', '1h', '6h', '24h', '3d'];

export default function RangeSelector() {
  const { t } = useTranslation();
  const range = useUiStore((s) => s.range);
  const setRange = useUiStore((s) => s.setRange);

  return (
    <div className="seg" role="group" aria-label="Range">
      {RANGES.map((r) => (
        <button
          key={r}
          className="seg-btn"
          aria-pressed={r === range}
          onClick={() => setRange(r)}
        >
          {t(`dashboard.ranges.${r}`)}
        </button>
      ))}
    </div>
  );
}
