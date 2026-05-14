import { useState } from 'react';
import { Plus, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { MOCK_HOSTS, formatRelative } from '../data/mockHosts';
import StatusPill from '../components/StatusPill';
import EnrollHostModal from '../components/EnrollHostModal';

export default function HostsSettings() {
  const [enrollOpen, setEnrollOpen] = useState(false);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hosts</h1>
          <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
            Manage remote GpuViewR agents. Each host is identified by a stable UUID.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnrollOpen(true)}
          className="btn-primary"
        >
          <Plus size={16} /> Add host
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
              <th className="px-4 py-3 font-medium">Label</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">GPUs</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Last seen</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_HOSTS.map((h) => (
              <tr key={h.id} className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
                <td className="px-4 py-3">
                  <div className="font-medium">{h.label}</div>
                  <div className="text-xs font-mono" style={{ color: 'var(--gv-text-dim)' }}>{h.id.slice(0, 13)}…</div>
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={h.status} lastSeenSecondsAgo={h.last_seen_seconds_ago} />
                </td>
                <td className="px-4 py-3 font-mono">{h.gpus.length}</td>
                <td className="px-4 py-3 font-mono text-xs">v{h.agent_version}</td>
                <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--gv-text-muted)' }}>
                  {formatRelative(h.last_seen_seconds_ago)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    <IconBtn title="Rename"><Pencil size={14} /></IconBtn>
                    <IconBtn title="Rotate token"><KeyRound size={14} /></IconBtn>
                    <IconBtn title="Delete" danger><Trash2 size={14} /></IconBtn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {enrollOpen && <EnrollHostModal onClose={() => setEnrollOpen(false)} />}
    </div>
  );
}

function IconBtn({ children, title, danger }: Readonly<{ children: React.ReactNode; title: string; danger?: boolean }>) {
  return (
    <button
      type="button"
      title={title}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        background: 'transparent',
        color: danger ? 'var(--gv-danger)' : 'var(--gv-text-muted)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--gv-surface-alt)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}
