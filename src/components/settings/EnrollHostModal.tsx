import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Copy, AlertTriangle, Container, Terminal } from 'lucide-react';
import { useHostsStore } from '../../store/hostsStore';
import { notify } from '../../store/toastStore';

type Props = Readonly<{ onClose: () => void }>;
type Stage = 'form' | 'token';
type InstallMode = 'docker' | 'curl';

// Returned by POST /api/hosts — copied locally because the modal owns
// the lifecycle (the store keeps only the hash post-enroll, so we hold
// the plaintext only as long as the modal is open).
interface EnrollResult {
  hostId: string;
  token: string;
  hubHttp: string;
  hubWs: string;
}

export default function EnrollHostModal({ onClose }: Props) {
  const { t } = useTranslation();
  const enroll = useHostsStore((s) => s.enroll);
  const [stage, setStage] = useState<Stage>('form');
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<EnrollResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState<'id' | 'token' | 'cmd' | null>(null);
  const [mode, setMode] = useState<InstallMode>('curl');

  const submit = async () => {
    if (!label.trim() || submitting) return;
    setSubmitting(true);
    try {
      const r = await enroll(label.trim());
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const hubHttp = `${window.location.protocol}//${window.location.host}`;
      const hubWs = `${proto}://${window.location.host}/agent`;
      setResult({ hostId: r.host.id, token: r.token, hubHttp, hubWs });
      setStage('token');
    } catch (err) {
      notify('error', t('hosts.enroll_failed'), (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const copy = (text: string, kind: 'id' | 'token' | 'cmd') => {
    void navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  const dockerCmd = result
    ? `docker run -d --name gpuviewr-agent \\\n  --gpus all \\\n  --restart unless-stopped \\\n  -e HUB_URL=${result.hubWs} \\\n  -e HOST_ID=${result.hostId} \\\n  -e AGENT_TOKEN=${result.token} \\\n  ghcr.io/erreur32/gpuviewr-agent:latest`
    : '';

  // Bare-metal one-liner: the install.sh script splits "host_id.secret"
  // back into HOST_ID + AGENT_TOKEN env vars, so we only need a single
  // --token flag à la Beszel. Backend unchanged.
  const curlCmd = result
    ? `curl -fsSL ${result.hubHttp}/install.sh | sudo bash -s -- \\\n  --url ${result.hubHttp} \\\n  --token ${result.hostId}.${result.token}`
    : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-xl p-6 flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">
              {stage === 'form' ? t('hosts.enroll_title') : t('hosts.enroll_done_title')}
            </h2>
            <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
              {stage === 'form' ? t('hosts.enroll_form_hint') : t('hosts.enroll_done_hint')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg inline-flex items-center justify-center"
            style={{ color: 'var(--gv-text-muted)', background: 'var(--gv-surface-alt)' }}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        {stage === 'form' && (
          <>
            <div className="flex flex-col gap-2">
              <label className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                {t('hosts.label')}
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('hosts.label_placeholder')}
                className="input"
                autoFocus
                maxLength={64}
              />
              <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
                {t('hosts.label_help')}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
              <button
                type="button"
                onClick={submit}
                disabled={!label.trim() || submitting}
                className="btn-primary"
              >
                {t('hosts.enroll_generate')}
              </button>
            </div>
          </>
        )}

        {stage === 'token' && result && (
          <>
            <div
              className="rounded-xl p-3 flex items-start gap-2 text-sm"
              style={{
                background: 'color-mix(in srgb, var(--gv-warn) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
                color: 'var(--gv-warn)',
              }}
            >
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <span>{t('hosts.token_warning')}</span>
            </div>

            <FieldBlock
              label={t('hosts.host_id')}
              value={result.hostId}
              onCopy={() => copy(result.hostId, 'id')}
              copied={copied === 'id'}
              monoWrap
            />

            <FieldBlock
              label={t('hosts.agent_token')}
              value={result.token}
              onCopy={() => copy(result.token, 'token')}
              copied={copied === 'token'}
              sensitive
            />

            <div className="flex flex-col gap-2">
              {/* Mode picker — curl is highlighted as recommended for new
                  installs since it's a single line, no Docker dependency. */}
              <div className="seg" role="group">
                <button
                  type="button"
                  className="seg-btn inline-flex items-center gap-1.5"
                  aria-pressed={mode === 'curl'}
                  onClick={() => setMode('curl')}
                >
                  <Terminal size={14} /> {t('hosts.install_mode_curl')}
                </button>
                <button
                  type="button"
                  className="seg-btn inline-flex items-center gap-1.5"
                  aria-pressed={mode === 'docker'}
                  onClick={() => setMode('docker')}
                >
                  <Container size={14} /> {t('hosts.install_mode_docker')}
                </button>
              </div>

              <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
                {mode === 'curl' ? t('hosts.install_curl_hint') : t('hosts.install_docker_hint')}
              </p>

              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                  {mode === 'curl' ? t('hosts.curl_cmd') : t('hosts.docker_cmd')}
                </span>
                <button
                  type="button"
                  onClick={() => copy(mode === 'curl' ? curlCmd : dockerCmd, 'cmd')}
                  className="text-xs inline-flex items-center gap-1.5"
                  style={{ color: copied === 'cmd' ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
                >
                  <Copy size={12} /> {copied === 'cmd' ? t('common.copied') : t('common.copy')}
                </button>
              </div>
              <pre
                className="rounded-xl p-3 text-xs font-mono overflow-x-auto"
                style={{
                  background: 'var(--gv-surface-alt)',
                  border: '1px solid var(--gv-border)',
                  color: 'var(--gv-text)',
                }}
              >{mode === 'curl' ? curlCmd : dockerCmd}</pre>
            </div>

            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn-primary">{t('common.done')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FieldBlock({
  label, value, onCopy, copied, monoWrap, sensitive,
}: Readonly<{
  label: string; value: string; onCopy: () => void; copied: boolean; monoWrap?: boolean; sensitive?: boolean;
}>) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs inline-flex items-center gap-1.5"
          style={{ color: copied ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
        >
          <Copy size={12} /> {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <div
        className={`rounded-xl px-3 py-2.5 text-xs font-mono ${monoWrap ? 'break-all' : 'overflow-x-auto whitespace-nowrap'}`}
        style={{
          background: 'var(--gv-surface-alt)',
          border: '1px solid var(--gv-border)',
          color: sensitive ? 'var(--gv-warn)' : 'var(--gv-text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
