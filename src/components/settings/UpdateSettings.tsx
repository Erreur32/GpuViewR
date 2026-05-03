import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ArrowUpCircle, Check, ExternalLink, Bell, BellOff } from 'lucide-react';
import { useUpdateStore } from '../../store/updateStore';
import { notify } from '../../store/toastStore';
import { useAuthStore } from '../../store/authStore';

export default function UpdateSettings() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const {
    config, result, loading, loadConfig, saveConfig, check,
    bannerEnabled, setBannerEnabled, hydrate,
  } = useUpdateStore();
  const [enabled, setEnabled] = useState<boolean>(true);
  const [hours, setHours] = useState<number>(24);

  useEffect(() => { hydrate(); void loadConfig(); void check(false); }, [hydrate, loadConfig, check]);
  useEffect(() => {
    if (!config) return;
    setEnabled(config.enabled);
    setHours(config.frequencyHours);
  }, [config]);

  const save = async () => {
    try {
      await saveConfig({ enabled, frequencyHours: hours });
      notify('success', t('settings.saved'));
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <ArrowUpCircle className="w-4 h-4" /> {t('settings.updates')}
      </h2>

      <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
        <input type="checkbox"
               checked={enabled}
               disabled={!isAdmin}
               onChange={(e) => setEnabled(e.target.checked)}
               className="sr-only peer" />
        <span className="w-10 h-5 rounded-full transition-colors relative" style={{
          background: enabled ? 'var(--gv-accent)' : 'var(--gv-surface-alt)',
        }}>
          <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                style={{ transform: enabled ? 'translateX(20px)' : 'translateX(0)' }} />
        </span>
        {t('settings.updates_enable')}
      </label>

      <div>
        <label className="label">{t('settings.updates_frequency')}</label>
        <input
          type="number"
          min="1"
          max="168"
          className="input max-w-[160px] !px-2 !py-1 !rounded-md"
          value={hours}
          disabled={!isAdmin || !enabled}
          onChange={(e) => setHours(Number.parseInt(e.target.value, 10) || 24)}
        />
        <p className="text-xs mt-1" style={{ color: 'var(--gv-text-dim)' }}>
          {t('settings.updates_frequency_help')}
        </p>
      </div>

      {result && (
        <div className="text-xs space-y-0.5" style={{ color: 'var(--gv-text-muted)' }}>
          <div>{t('updates.current')}: <strong style={{ color: 'var(--gv-text)' }}>{result.currentVersion}</strong></div>
          <div>
            {t('updates.latest')}:{' '}
            <strong style={{ color: result.updateAvailable ? 'var(--gv-accent)' : 'var(--gv-text)' }}>
              {result.latestVersion ?? '-'}
            </strong>
          </div>
          <div className="opacity-70">
            {t('updates.last_check')}: {new Date(result.checkedAt).toLocaleString()}
            {result.fromCache ? ` · ${t('updates.cached')}` : ''}
          </div>
          {result.error && (
            <div style={{ color: 'var(--gv-warn)' }}>{t('common.error')}: {result.error}</div>
          )}
        </div>
      )}

      {result?.releaseUrl && (
        <div
          className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'var(--gv-surface-alt)',
            border: '1px solid var(--gv-border)',
            color: 'var(--gv-text-muted)',
          }}
        >
          <span>
            {t('updates.release_notes')}{result.latestVersion ? ` · v${result.latestVersion}` : ''}
          </span>
          <a
            className="inline-flex items-center gap-1 hover:underline"
            style={{ color: 'var(--gv-accent)' }}
            href={result.releaseUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t('updates.view_on_github')} <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          className="btn-ghost"
          disabled={loading}
          onClick={async () => {
            // Use the value freshly returned by check(); reading the
            // store right after may pick up a stale snapshot if the
            // request failed silently.
            const r = await check(true);
            if (!r) {
              notify('warn', t('updates.check_failed'), undefined, 6000);
            } else if (r.error) {
              notify('error', t('updates.check_failed'), r.error, 6000);
            } else if (r.updateAvailable) {
              notify('success',
                t('updates.update_available_title', { version: r.latestVersion ?? '' }),
                r.releaseUrl ?? undefined,
                6000);
            } else {
              notify('success',
                t('updates.up_to_date_title'),
                t('updates.up_to_date_subtitle', { version: r.currentVersion }),
                4000);
            }
          }}
        >
          <RefreshCw className={'w-4 h-4 ' + (loading ? 'animate-spin' : '')} />
          {t('updates.recheck')}
        </button>
        {isAdmin && (
          <button className="btn-primary" onClick={save}>
            <Check className="w-4 h-4" />
            {t('common.save')}
          </button>
        )}
      </div>
    </section>

    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        {bannerEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
        {t('settings.about_banner_title')}
      </h2>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.about_banner_help')}</p>
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={bannerEnabled} onChange={(e) => setBannerEnabled(e.target.checked)} />
        {t('settings.about_banner_enable')}
      </label>
    </section>
    </div>
  );
}
