import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Terminal } from 'lucide-react';
import { useHostsStore } from '../../store/hostsStore';
import { notify } from '../../store/toastStore';
import { copyText } from '../../lib/clipboard';
import { ModalShell, WarningBanner, CopyValueBlock } from './_modalParts';

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
      const proto = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
      const hubHttp = `${globalThis.location.protocol}//${globalThis.location.host}`;
      const hubWs = `${proto}://${globalThis.location.host}/agent`;
      setResult({ hostId: r.host.id, token: r.token, hubHttp, hubWs });
      setStage('token');
    } catch (err) {
      notify('error', t('hosts.enroll_failed'), (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string, kind: 'id' | 'token' | 'cmd') => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } else {
      notify('error', t('hosts.copy_failed'), t('hosts.copy_failed_hint'));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Docker one-liner that auto-detects vendor (NVIDIA / AMD), pulls
  // the matching docker-compose.agent.<vendor>.yaml from GitHub,
  // generates .env from --hub + --token, and runs `docker compose up
  // -d`. Works on NVIDIA AND AMD hosts — same command on both.
  const dockerCmd = result
    ? `curl -fsSL ${result.hubHttp}/install-agent.sh | bash -s -- \\\n  --hub ${result.hubHttp} \\\n  --token ${result.hostId}.${result.token}`
    : '';

  // Bare-metal one-liner: the install.sh script splits "host_id.secret"
  // back into HOST_ID + AGENT_TOKEN env vars, so we only need a single
  // --token flag à la Beszel.
  const curlCmd = result
    ? `curl -fsSL ${result.hubHttp}/install.sh | sudo bash -s -- \\\n  --url ${result.hubHttp} \\\n  --token ${result.hostId}.${result.token}`
    : '';

  const activeCmd = mode === 'curl' ? curlCmd : dockerCmd;

  return (
    <ModalShell
      title={stage === 'form' ? t('hosts.enroll_title') : t('hosts.enroll_done_title')}
      hint={stage === 'form' ? t('hosts.enroll_form_hint') : t('hosts.enroll_done_hint')}
      onClose={onClose}
    >
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
          <WarningBanner>{t('hosts.token_warning')}</WarningBanner>

          <CopyValueBlock
            label={t('hosts.host_id')}
            value={result.hostId}
            onCopy={() => copy(result.hostId, 'id')}
            copied={copied === 'id'}
            kind="monoWrap"
          />

          <CopyValueBlock
            label={t('hosts.agent_token')}
            value={result.token}
            onCopy={() => copy(result.token, 'token')}
            copied={copied === 'token'}
            sensitive
          />

          <div className="flex flex-col gap-2">
            {/* Mode picker — curl is highlighted as recommended for new
                installs since it's a single line, no Docker dependency. */}
            <div className="seg" role="toolbar" aria-label={t('hosts.install_mode_label')}>
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

            <CopyValueBlock
              label={mode === 'curl' ? t('hosts.curl_cmd') : t('hosts.docker_cmd')}
              value={activeCmd}
              onCopy={() => copy(activeCmd, 'cmd')}
              copied={copied === 'cmd'}
              kind="pre"
            />
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn-primary">{t('common.done')}</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
