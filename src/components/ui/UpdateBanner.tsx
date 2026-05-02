import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, X, ExternalLink, RefreshCw, ClipboardCopy, Check } from 'lucide-react';
import { useUpdateStore } from '../../store/updateStore';

const UPDATE_COMMAND = './update.sh';

export default function UpdateBanner() {
  const { t } = useTranslation();
  const { result, loading, check, dismiss, isDismissed, hydrate } = useUpdateStore();
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    hydrate();
    void check(false);
  }, [hydrate, check]);

  if (!result || !result.updateAvailable || !result.dockerReady) return null;
  if (result.latestVersion && isDismissed(result.latestVersion)) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <>
      <div className="card p-3 mb-4 flex items-center gap-3 flex-wrap"
           style={{ borderColor: 'color-mix(in srgb, var(--gv-accent) 35%, var(--gv-border))' }}>
        <ArrowUpCircle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--gv-accent)' }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">
            {t('updates.available_title', { version: result.latestVersion })}
          </div>
          <div className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
            {t('updates.available_subtitle', { current: result.currentVersion, latest: result.latestVersion })}
          </div>
        </div>
        <button className="btn-ghost text-xs" onClick={() => setShowDetails(true)}>
          {t('updates.see_details')}
        </button>
        <button className="btn-primary text-xs" onClick={copy}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
          {copied ? t('common.copied') : t('updates.copy_command')}
        </button>
        <button
          className="btn-ghost !p-1.5"
          onClick={() => result.latestVersion && dismiss(result.latestVersion)}
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {showDetails && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowDetails(false)}>
          <div onClick={(e) => e.stopPropagation()} className="card p-5 w-full max-w-2xl space-y-4 max-h-[80vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <ArrowUpCircle className="w-5 h-5" style={{ color: 'var(--gv-accent)' }} />
                {t('updates.modal_title', { version: result.latestVersion })}
              </h2>
              <button className="btn-ghost !p-1.5" onClick={() => setShowDetails(false)} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label={t('updates.current')} value={result.currentVersion} />
              <Stat label={t('updates.latest')} value={result.latestVersion ?? '-'} accent />
            </div>

            <section>
              <h3 className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--gv-text-muted)' }}>
                {t('updates.release_notes')}
              </h3>
              <pre className="rounded-xl p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed"
                   style={{ background: 'var(--gv-surface-alt)', color: 'var(--gv-text)' }}>
                {result.releaseNotes || t('updates.no_notes')}
              </pre>
              {result.releaseUrl && (
                <a className="text-xs inline-flex items-center gap-1 mt-2 hover:underline"
                   style={{ color: 'var(--gv-accent)' }}
                   href={result.releaseUrl} target="_blank" rel="noreferrer">
                  {t('updates.view_on_github')} <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </section>

            <section>
              <h3 className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--gv-text-muted)' }}>
                {t('updates.how_to')}
              </h3>
              <p className="text-xs mb-2" style={{ color: 'var(--gv-text-muted)' }}>{t('updates.how_to_help')}</p>
              <div className="flex items-center gap-2 rounded-xl p-3 font-mono text-sm"
                   style={{ background: 'var(--gv-surface-alt)' }}>
                <span style={{ color: 'var(--gv-text-dim)' }}>$</span>
                <span className="flex-1" style={{ color: 'var(--gv-text)' }}>{UPDATE_COMMAND}</span>
                <button className="btn-ghost !p-1.5" onClick={copy} aria-label="Copy">
                  {copied ? <Check className="w-4 h-4" /> : <ClipboardCopy className="w-4 h-4" />}
                </button>
              </div>
              <ul className="mt-3 text-xs space-y-1" style={{ color: 'var(--gv-text-muted)' }}>
                <li>• <code>./update.sh</code>: {t('updates.help_pull')}</li>
                <li>• <code>./update.sh --check</code>: {t('updates.help_check')}</li>
                <li>• <code>./update.sh --rollback</code>: {t('updates.help_rollback')}</li>
              </ul>
            </section>

            <div className="flex justify-between gap-2 pt-2">
              <button className="btn-ghost" disabled={loading} onClick={() => check(true)}>
                <RefreshCw className={'w-4 h-4 ' + (loading ? 'animate-spin' : '')} />
                {t('updates.recheck')}
              </button>
              <button className="btn-primary" onClick={() => setShowDetails(false)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-3" style={{ background: accent ? 'color-mix(in srgb, var(--gv-accent) 10%, var(--gv-surface))' : 'var(--gv-surface)' }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gv-text-muted)' }}>{label}</div>
      <div className="text-lg font-bold tabular-nums" style={{ color: accent ? 'var(--gv-accent)' : 'var(--gv-text)' }}>{value}</div>
    </div>
  );
}
