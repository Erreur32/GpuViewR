import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHostsStore } from '../../store/hostsStore';
import { notify } from '../../store/toastStore';
import { copyText } from '../../lib/clipboard';
import { ModalShell, WarningBanner, CopyValueBlock } from './_modalParts';
import {
  buildInstallCommands,
  InstallModePicker,
  LABEL_KEY_BY_MODE,
  type InstallMode,
} from './_installCommands';

type Props = Readonly<{ onClose: () => void }>;
type Stage = 'form' | 'token';

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

  // Three install one-liners (Linux bash, Docker, Windows
  // PowerShell), pre-filled with the composite "host_id.secret"
  // token. Shared with RotateTokenModal — see _installCommands.tsx.
  const cmdByMode = result
    ? buildInstallCommands(result.hubHttp, `${result.hostId}.${result.token}`)
    : { curl: '', docker: '', windows: '' };
  const hintKeyByMode: Record<InstallMode, string> = {
    curl: 'hosts.install_curl_hint',
    docker: 'hosts.install_docker_hint',
    windows: 'hosts.install_windows_hint',
  };
  const activeCmd = cmdByMode[mode];

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
            {/* Mode picker — curl is the default since it's a
                single-line bash one-liner with no Docker dependency.
                The seg itself lives in ./_installCommands.tsx so the
                Rotate-token modal can render the same widget. */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <InstallModePicker mode={mode} onChange={setMode} />

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
              {t(hintKeyByMode[mode])}
            </p>

            <CopyValueBlock
              label={t(LABEL_KEY_BY_MODE[mode])}
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
