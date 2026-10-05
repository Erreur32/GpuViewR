import { useTranslation } from 'react-i18next';
import InfoTooltip from './InfoTooltip';

/** Metrics that can come back as null from an agent. */
export type NaMetric = 'fan' | 'temperature' | 'power' | 'utilization';

/** Warn-coloured info icon next to an N/A value: why this sensor is
 *  missing on this GPU (dashboard.na.<metric> in the locales). */
export default function SensorNaInfo({
  metric,
  placement = 'bottom',
}: Readonly<{ metric: NaMetric; placement?: 'top' | 'bottom' }>) {
  const { t } = useTranslation();
  const title = t('dashboard.na.title', { metric: t(`dashboard.metrics.${metric}`) });
  const reasons = t(`dashboard.na.${metric}.reasons`, { returnObjects: true }) as string[];
  return (
    <InfoTooltip label={title} placement={placement} tone="warn">
      <span className="block font-semibold mb-1" style={{ color: 'var(--gv-warn)' }}>{title}</span>
      <span className="block mb-1.5" style={{ color: 'var(--gv-text-muted)' }}>{t(`dashboard.na.${metric}.intro`)}</span>
      <ul className="list-disc pl-4 space-y-1 mb-1.5">
        {reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      <span className="block pt-1.5 border-t" style={{ borderColor: 'var(--gv-border)', color: 'var(--gv-text-dim)' }}>
        {t('dashboard.na.footer')}
      </span>
    </InfoTooltip>
  );
}
