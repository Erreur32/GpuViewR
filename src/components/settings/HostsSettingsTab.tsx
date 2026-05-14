import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, KeyRound, Trash2, Copy, AlertTriangle, X, Terminal, Container } from 'lucide-react';
import { useHostsStore, effectiveStatus, formatRelative, LOCAL_HOST_ID, type HostRecord } from '../../store/hostsStore';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/toastStore';
import { copyText } from '../../lib/clipboard';
import StatusPill from '../fleet/StatusPill';
import EnrollHostModal from './EnrollHostModal';

export default function HostsSettingsTab() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const hosts = useHostsStore((s) => s.hosts);
  const refresh = useHostsStore((s) => s.refresh);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [rotateFor, setRotateFor] = useState<HostRecord | null>(null);
  const [deleteFor, setDeleteFor] = useState<HostRecord | null>(null);

  useEffect(() => { void refresh(); }, [refresh]);

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
  const lastSeenLabel = host.last_seen !== null
    ? `${formatRelative(now - host.last_seen)} ${t('common.ago')}`
    : '—';

  return (
    <tr className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
      <td className="px-4 py-3">
        <div className="font-medium">{host.label}</div>
        <div className="text-xs font-mono" style={{ color: 'var(--gv-text-dim)' }}>
          {host.id.slice(0, 13)}…
        </div>
      </td>
      <td className="px-4 py-3">
        <StatusPill status={status} lastSeenEpoch={host.last_seen} />
      </td>
      <td className="px-4 py-3 font-mono text-xs">
        {host.agent_version ? `v${host.agent_version}` : <span style={{ color: 'var(--gv-text-dim)' }}>{host.kind}</span>}
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{t('hosts.rotate_title', { label: host.label })}</h2>
            <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
              {newToken ? t('hosts.rotate_done_hint') : t('hosts.rotate_intro')}
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

        <div
          className="rounded-xl p-3 flex items-start gap-2 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--gv-warn) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
            color: 'var(--gv-warn)',
          }}
        >
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{t('hosts.rotate_warning')}</span>
        </div>

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
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                  {t('hosts.new_token')}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className="text-xs inline-flex items-center gap-1.5"
                  style={{ color: copied ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
                >
                  <Copy size={12} /> {copied ? t('common.copied') : t('common.copy')}
                </button>
              </div>
              <div
                className="rounded-xl px-3 py-2.5 text-xs font-mono break-all"
                style={{
                  background: 'var(--gv-surface-alt)',
                  border: '1px solid var(--gv-border)',
                  color: 'var(--gv-warn)',
                }}
              >
                {newToken}
              </div>
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

  const hubHttp = `${window.location.protocol}//${window.location.host}`;
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-xl p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{t('hosts.delete_title', { label: host.label })}</h2>
            <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
              {t('hosts.delete_intro')}
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

        <div
          className="rounded-xl p-3 flex items-start gap-2 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--gv-warn) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
            color: 'var(--gv-warn)',
          }}
        >
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{t('hosts.delete_warning_orphan')}</span>
        </div>

        <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
          {t('hosts.delete_uninstall_hint')}
        </p>

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

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
              {t('hosts.uninstall_cmd')}
            </span>
            <button
              type="button"
              onClick={copy}
              className="text-xs inline-flex items-center gap-1.5"
              style={{ color: copied ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
            >
              <Copy size={12} /> {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <pre
            className="rounded-xl p-3 text-xs font-mono overflow-x-auto"
            style={{
              background: 'var(--gv-surface-alt)',
              border: '1px solid var(--gv-border)',
              color: 'var(--gv-text)',
            }}
          >{activeCmd}</pre>
        </div>

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
      </div>
    </div>
  );
}
