import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Save, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/toastStore';

interface DbInfo {
  rows: number;
  oldestEpoch: number | null;
  newestEpoch: number | null;
  sizeBytes: number;
  pageCount: number;
  pageSize: number;
  retentionDays: number;
  journalMode: string;
}

export default function DatabaseSettings() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [retention, setRetention] = useState<number>(7);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<DbInfo>('/system/db')
      .then((r) => { setInfo(r); setRetention(r.retentionDays); })
      .catch((e: Error) => notify('error', t('common.error'), e.message));
  };
  useEffect(() => { load(); }, []);

  const saveRetention = async () => {
    setBusy(true);
    try {
      await api('/system/db/retention', { method: 'PUT', body: JSON.stringify({ days: retention }) });
      notify('success', t('settings.saved'));
      load();
    } catch (e) {
      notify('error', t('common.error'), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const purge = async (mode: 'retention' | 'all') => {
    if (mode === 'all' && !confirm(t('settings.db_purge_all_confirm'))) return;
    setBusy(true);
    try {
      const r = await api<{ removed: number }>('/system/db/purge', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      notify('success', t('settings.db_purge_done', { count: r.removed }));
      load();
    } catch (e) {
      notify('error', t('common.error'), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5 space-y-4">
      <h2 className="font-semibold flex items-center gap-2">
        <Database className="w-4 h-4" /> {t('settings.db_title')}
      </h2>

      {info && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-sm">
          <Stat label={t('settings.db_rows')} value={info.rows.toLocaleString()} />
          <Stat label={t('settings.db_size')} value={fmtBytes(info.sizeBytes)} />
          <Stat label={t('settings.db_oldest')} value={info.oldestEpoch ? new Date(info.oldestEpoch * 1000).toLocaleString() : '-'} />
          <Stat label={t('settings.db_newest')} value={info.newestEpoch ? new Date(info.newestEpoch * 1000).toLocaleString() : '-'} />
          <Stat label={t('settings.db_journal')} value={info.journalMode.toUpperCase()} />
          <Stat label={t('settings.db_pages')} value={`${info.pageCount.toLocaleString()} × ${info.pageSize}B`} />
        </div>
      )}

      <div>
        <label className="label" htmlFor="retention-input">{t('settings.db_retention')}</label>
        <div className="flex items-center gap-2">
          <input
            id="retention-input"
            type="number"
            min="1"
            max="365"
            className="input max-w-[120px] !px-2 !py-1 !rounded-md"
            value={retention}
            disabled={!isAdmin || busy}
            onChange={(e) => setRetention(Number.parseInt(e.target.value, 10) || 7)}
          />
          <span className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.db_retention_unit')}</span>
          {isAdmin && (
            <button className="btn-primary" onClick={saveRetention} disabled={busy}>
              <Save className="w-4 h-4" />
              {t('common.save')}
            </button>
          )}
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--gv-text-dim)' }}>
          {t('settings.db_retention_help')}
        </p>
      </div>

      {isAdmin && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--gv-surface-alt)' }}>
          <div className="text-xs uppercase tracking-wider flex items-center gap-2" style={{ color: 'var(--gv-warn)' }}>
            <AlertTriangle className="w-3.5 h-3.5" />
            {t('settings.db_purge_zone')}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={() => purge('retention')} disabled={busy}>
              <Trash2 className="w-4 h-4" />
              {t('settings.db_purge_retention')}
            </button>
            <button
              className="btn-ghost"
              onClick={() => purge('all')}
              disabled={busy}
              style={{ color: 'var(--gv-danger)' }}
            >
              <Trash2 className="w-4 h-4" />
              {t('settings.db_purge_all')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider truncate" style={{ color: 'var(--gv-text-muted)' }}>{label}</div>
      <div className="tabular-nums font-semibold text-[13px] truncate" title={value} style={{ color: 'var(--gv-text)' }}>{value}</div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}
