import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Terminal, Monitor } from 'lucide-react';
import { useHostsStore } from '../../store/hostsStore';
import { notify } from '../../store/toastStore';
import { copyText } from '../../lib/clipboard';
import { ModalShell, WarningBanner, CopyValueBlock } from './_modalParts';

type Props = Readonly<{ onClose: () => void }>;
type Stage = 'form' | 'token';
type InstallMode = 'docker' | 'curl' | 'windows';

// Returned by POST /api/hosts — copied locally because the modal owns
// the lifecycle (the store keeps only the hash post-enroll, so we hold
// the plaintext only as long as the modal is open).
interface EnrollResult {
  hostId: string;
  token: string;
  hubHttp: string;
  hubWs: string;
}

// IP literals + 'localhost' default to plain http/ws (no TLS expected
// on LAN). Domain names default to https/wss (assumes a reverse-proxy
// with a cert). User can flip the choice via the TLS checkbox in the
// token modal.
function defaultUseTls(host: string): boolean {
  // Strip the port for the check (location.host includes :port for
  // non-default ports).
  const hostOnly = host.replace(/:\d+$/, '');
  if (hostOnly === 'localhost') return false;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostOnly)) return false;
  // IPv6 literal (browser brackets like [::1])
  if (/^\[.+\]$/.test(hostOnly)) return false;
  // Anything else (hostnames, FQDN, etc.) → assume TLS
  return true;
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
  // TLS toggle for the generated URLs. Auto-set on first render based
  // on whether the current page's host looks like an IP literal — the
  // common case "I'm on http://192.168.x.x:7510 enrolling a LAN box"
  // gets ws:// out of the box. Public FQDN deployments default to wss.
  const [useTls, setUseTls] = useState(() => defaultUseTls(globalThis.location.host));

  const submit = async () => {
    if (!label.trim() || submitting) return;
    setSubmitting(true);
    try {
      const r = await enroll(label.trim());
      const host = globalThis.location.host;
      const httpProto = useTls ? 'https' : 'http';
      const wsProto = useTls ? 'wss' : 'ws';
      const hubHttp = `${httpProto}://${host}`;
      const hubWs = `${wsProto}://${host}/agent`;
      setResult({ hostId: r.host.id, token: r.token, hubHttp, hubWs });
      setStage('token');
    } catch (err) {
      notify('error', t('hosts.enroll_failed'), (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Recompute URLs when the user toggles TLS post-enrollment too —
  // the token block stays the same, only the URLs in the recipes change.
  useEffect(() => {
    if (!result) return;
    const host = globalThis.location.host;
    const httpProto = useTls ? 'https' : 'http';
    const wsProto = useTls ? 'wss' : 'ws';
    setResult((prev) => prev && ({
      ...prev,
      hubHttp: `${httpProto}://${host}`,
      hubWs: `${wsProto}://${host}/agent`,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTls]);

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

  // Windows: PowerShell idiom equivalent to `curl | bash -s -- --args`
  // doesn't exist (iex can't forward args to the iex'd script), so we
  // pass credentials via env vars that the .ps1 reads as param() defaults.
  // The user copy-pastes the block; the script registers a SYSTEM-level
  // scheduled task. Must be run in an elevated PowerShell.
  const windowsCmd = result
    ? `Set-ExecutionPolicy Bypass -Scope Process -Force\n$env:GPVR_HUB_URL = '${result.hubHttp}'\n$env:GPVR_TOKEN   = '${result.hostId}.${result.token}'\niex (iwr "$env:GPVR_HUB_URL/install.ps1" -UseBasicParsing).Content`
    : '';

  const activeCmd =
    mode === 'curl' ? curlCmd :
    mode === 'docker' ? dockerCmd :
    windowsCmd;

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
            <div className="flex items-center justify-between gap-3 flex-wrap">
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
                <button
                  type="button"
                  className="seg-btn inline-flex items-center gap-1.5"
                  aria-pressed={mode === 'windows'}
                  onClick={() => setMode('windows')}
                >
                  <Monitor size={14} /> {t('hosts.install_mode_windows')}
                </button>
              </div>

              {/* TLS toggle — auto-detected based on whether the hub
                  URL host is an IP literal vs a domain name. Flip it
                  for unusual setups (LAN domain behind nginx with TLS,
                  or public IP without TLS). */}
              <label
                className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none"
                style={{ color: 'var(--gv-text-muted)' }}
                title={t('hosts.tls_help')}
              >
                <input
                  type="checkbox"
                  checked={useTls}
                  onChange={(e) => setUseTls(e.target.checked)}
                  className="accent-current"
                />
                {t('hosts.tls_label')}
              </label>
            </div>

            <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
              {mode === 'curl' ? t('hosts.install_curl_hint') :
               mode === 'docker' ? t('hosts.install_docker_hint') :
               t('hosts.install_windows_hint')}
            </p>

            <CopyValueBlock
              label={
                mode === 'curl' ? t('hosts.curl_cmd') :
                mode === 'docker' ? t('hosts.docker_cmd') :
                t('hosts.windows_cmd')
              }
              value={activeCmd}
              onCopy={() => copy(activeCmd, 'cmd')}
              copied={copied === 'cmd'}
              kind="pre"
            />

            <p
              className="text-[11px] leading-snug"
              style={{ color: 'var(--gv-text-dim)' }}
            >
              💡 {t('hosts.update_hint')}
            </p>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn-primary">{t('common.done')}</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
