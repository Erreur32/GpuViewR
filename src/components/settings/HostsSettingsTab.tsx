import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, KeyRound, Trash2, Terminal, Container, Server } from 'lucide-react';
import { useHostsStore, effectiveStatus, formatRelative, LOCAL_HOST_ID, type HostRecord } from '../../store/hostsStore';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/toastStore';
import { copyText } from '../../lib/clipboard';
import StatusPill from '../fleet/StatusPill';
import EnrollHostModal from './EnrollHostModal';
import { ModalShell, WarningBanner, CopyValueBlock } from './_modalParts';

// Same constant the footer uses — Vite injects the package.json version
// at build time, so this stays in sync with what the hub actually runs.
const HUB_VERSION = __APP_VERSION__;

export default function HostsSettingsTab() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const hosts = useHostsStore((s) => s.hosts);
  const refresh = useHostsStore((s) => s.refresh);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [rotateFor, setRotateFor] = useState<HostRecord | null>(null);
  const [deleteFor, setDeleteFor] = useState<HostRecord | null>(null);

  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  if (!isAdmin) {
    return (
      <div className="card p-6 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
        {t('hosts.admin_only')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{t('hosts.section_title')}</h2>
          <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
            {t('hosts.section_help')}
          </p>
        </div>
        <button type="button" onClick={() => setEnrollOpen(true)} className="btn-primary">
          <Plus size={16} /> {t('hosts.add_host')}
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                <th className="px-4 py-3 font-medium">{t('hosts.col_label')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_status')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_agent')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_last_seen')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('hosts.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h) => (
                <HostRow
                  key={h.id}
                  host={h}
                  onRotate={() => setRotateFor(h)}
                  onDelete={() => setDeleteFor(h)}
                />
              ))}
              {hosts.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm" style={{ color: 'var(--gv-text-muted)' }}>
                    {t('hosts.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {enrollOpen && <EnrollHostModal onClose={() => setEnrollOpen(false)} />}
      {rotateFor && (
        <RotateTokenModal host={rotateFor} onClose={() => setRotateFor(null)} />
      )}
      {deleteFor && (
        <DeleteHostModal host={deleteFor} onClose={() => setDeleteFor(null)} />
      )}
    </div>
  );
}

function HostRow({
  host, onRotate, onDelete,
}: Readonly<{ host: HostRecord; onRotate: () => void; onDelete: () => void }>) {
  const { t } = useTranslation();
  const isLocal = host.id === LOCAL_HOST_ID;
  const status = effectiveStatus(host);
  const now = Math.floor(Date.now() / 1000);
  const lastSeenLabel = host.last_seen === null
    ? '—'
    : t('common.ago_relative', { time: formatRelative(now - host.last_seen) });

  // Show the system hostname (when the schema has it) as the secondary
  // line. Falls back to the truncated id so a freshly-enrolled host
  // still has *something* to identify it. Skip the line entirely if
  // it'd just repeat the label (the local row before hostname is
  // populated, for example).
  const secondaryRaw = host.hostname ?? `${host.id.slice(0, 13)}…`;
  const secondary = secondaryRaw === host.label ? null : secondaryRaw;

  return (
    <tr className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{host.label}</span>
          {isLocal && <HubBadge t={t} />}
        </div>
        {secondary && (
          <div className="text-xs font-mono" style={{ color: 'var(--gv-text-dim)' }} title={host.id}>
            {secondary}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        {/* lastSeenEpoch={null} → render only the status dot + label.
            The dedicated "Last seen" column on this row already shows
            the age, so duplicating it inside the pill would read as
            "22s · En ligne · 22s il y a" — redundant. */}
        <StatusPill status={status} lastSeenEpoch={null} />
      </td>
      <td className="px-4 py-3 font-mono text-xs">
        <VersionCell isLocal={isLocal} agentVersion={host.agent_version} kind={host.kind} t={t} />
      </td>
      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {lastSeenLabel}
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1.5">
          {!isLocal && (
            <>
              <IconBtn title={t('hosts.rotate_token')} onClick={onRotate}>
                <KeyRound size={14} />
              </IconBtn>
              <IconBtn title={t('hosts.delete')} onClick={onDelete} danger>
                <Trash2 size={14} />
              </IconBtn>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// Distinguishes the host row that is the hub itself (no remote agent —
// the hub collects via local nvidia-smi). Helps the admin see at a
// glance which row they can't enroll/rotate/delete, and matches the
// "This host" wording used elsewhere.
// Version cell content. Extracted so the row renderer doesn't carry a
// nested ternary (SonarCloud S3358) — three mutually exclusive cases
// (local hub / agent with reported version / agent without one) read
// more clearly as guarded early returns.
function VersionCell({
  isLocal, agentVersion, kind, t,
}: Readonly<{ isLocal: boolean; agentVersion: string | null; kind: string; t: (key: string) => string }>) {
  if (isLocal) {
    return <span title={t('hosts.hub_version_help')}>v{HUB_VERSION}</span>;
  }
  if (agentVersion) {
    return <span title={t('hosts.agent_version_help')}>v{agentVersion}</span>;
  }
  return <span style={{ color: 'var(--gv-text-dim)' }}>{kind}</span>;
}

function HubBadge({ t }: Readonly<{ t: (key: string) => string }>) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider"
      style={{
        color: 'var(--gv-info)',
        background: 'color-mix(in srgb, var(--gv-info) 14%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-info) 35%, transparent)',
      }}
      title={t('hosts.hub_badge_help')}
    >
      <Server className="w-2.5 h-2.5" />
      {t('hosts.hub_badge')}
    </span>
  );
}

function IconBtn({
  children, title, danger, onClick,
}: Readonly<{ children: React.ReactNode; title: string; danger?: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        background: 'transparent',
        color: danger ? 'var(--gv-danger)' : 'var(--gv-text-muted)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gv-surface-alt)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function RotateTokenModal({ host, onClose }: Readonly<{ host: HostRecord; onClose: () => void }>) {
  const { t } = useTranslation();
  const rotateToken = useHostsStore((s) => s.rotateToken);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const doRotate = async () => {
    setRotating(true);
    try {
      const token = await rotateToken(host.id);
      setNewToken(token);
    } catch (err) {
      notify('error', t('hosts.rotate_failed'), (err as Error).message);
    } finally {
      setRotating(false);
    }
  };

  const copy = async () => {
    if (!newToken) return;
    const ok = await copyText(newToken);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      notify('error', t('hosts.copy_failed'), t('hosts.copy_failed_hint'));
    }
  };

  return (
    <ModalShell
      title={t('hosts.rotate_title', { label: host.label })}
      hint={newToken ? t('hosts.rotate_done_hint') : t('hosts.rotate_intro')}
      onClose={onClose}
      maxWidth="max-w-lg"
    >
      <WarningBanner>{t('hosts.rotate_warning')}</WarningBanner>

      {!newToken && (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
          <button type="button" onClick={doRotate} disabled={rotating} className="btn-danger">
            {t('hosts.rotate_confirm')}
          </button>
        </div>
      )}

      {newToken && (
        <>
          <CopyValueBlock
            label={t('hosts.new_token')}
            value={newToken}
            onCopy={copy}
            copied={copied}
            kind="monoWrap"
            sensitive
          />
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn-primary">{t('common.done')}</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// Confirmation modal for deleting a host. Shows the uninstall command
// up-front so the admin can clean the agent on the remote machine
// BEFORE the hub forgets it — otherwise systemd retries the (rejected)
// connection in a loop until manual intervention.
function DeleteHostModal({ host, onClose }: Readonly<{ host: HostRecord; onClose: () => void }>) {
  const { t } = useTranslation();
  const remove = useHostsStore((s) => s.remove);
  const [mode, setMode] = useState<'curl' | 'docker'>('curl');
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const hubHttp = `${globalThis.location.protocol}//${globalThis.location.host}`;
  const curlCmd = `curl -fsSL ${hubHttp}/install.sh | sudo bash -s -- --uninstall`;
  const dockerCmd = `docker rm -f gpuviewr-agent`;
  const activeCmd = mode === 'curl' ? curlCmd : dockerCmd;

  const copy = async () => {
    const ok = await copyText(activeCmd);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      notify('error', t('hosts.copy_failed'), t('hosts.copy_failed_hint'));
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await remove(host.id);
      notify('success', t('hosts.deleted'), host.label);
      onClose();
    } catch (err) {
      notify('error', t('hosts.delete_failed'), (err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <ModalShell
      title={t('hosts.delete_title', { label: host.label })}
      hint={t('hosts.delete_intro')}
      onClose={onClose}
    >
      <WarningBanner>{t('hosts.delete_warning_orphan')}</WarningBanner>

      <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
        {t('hosts.delete_uninstall_hint')}
      </p>

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

      <CopyValueBlock
        label={t('hosts.uninstall_cmd')}
        value={activeCmd}
        onCopy={copy}
        copied={copied}
        kind="pre"
      />

      <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
        {t('hosts.delete_history_kept')}
      </p>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={deleting} className="btn-ghost">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={doDelete} disabled={deleting} className="btn-danger">
          <Trash2 size={14} /> {t('hosts.delete_confirm')}
        </button>
      </div>
    </ModalShell>
  );
}
