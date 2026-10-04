import { useTranslation } from 'react-i18next';

/** Click-outside-to-close layer behind a modal card, a real button (as in
 *  ModalShell) so the overlay isn't a div with a mouse-only handler. The
 *  card above it needs `relative` to sit on top. */
export default function BackdropClose({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useTranslation();
  return (
    <button type="button" aria-label={t('common.close')} className="absolute inset-0 cursor-default" onClick={onClose} />
  );
}
