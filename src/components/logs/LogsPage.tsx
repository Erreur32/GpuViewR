import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { api } from '../../lib/api';

type Level = 'all' | 'info' | 'warn' | 'error' | 'success' | 'debug';

interface LogEntry {
  ts: number;
  level: Exclude<Level, 'all'>;
  scope: string;
  message: string;
}

const LEVELS: Level[] = ['all', 'info', 'warn', 'error', 'success', 'debug'];

const LEVEL_COLOR: Record<Exclude<Level, 'all'>, string> = {
  info: 'var(--gv-info)',
  warn: 'var(--gv-warn)',
  error: 'var(--gv-danger)',
  success: 'var(--gv-ok)',
  debug: 'var(--gv-text-dim)',
};

export default function LogsPage() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<Level>('all');
  const [scope, setScope] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams({ limit: '500' });
    if (level !== 'all') params.set('level', level);
    if (scope) params.set('scope', scope);
    if (search) params.set('q', search);
    try {
      const r = await api<{ entries: LogEntry[]; scopes: string[] }>(`/logs?${params}`);
      setEntries(r.entries);
      setScopes(r.scopes);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [level, scope, search]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, level, scope, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.level] = (c[e.level] || 0) + 1;
    return c;
  }, [entries]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('logs.title')}</h1>
          <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('logs.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            {t('logs.auto_refresh')}
          </label>
        </div>
      </header>

      <div className="card p-3 flex flex-wrap items-center gap-3">
        <fieldset className="seg" aria-label="Level">
          <legend className="sr-only">Level</legend>
          {LEVELS.map((l) => (
            <button
              key={l}
              className="seg-btn"
              aria-pressed={level === l}
              onClick={() => setLevel(l)}
            >
              {t(`logs.levels.${l}`)}
              <span className="ml-1 text-[10px] opacity-70 tabular-nums">({counts[l] || 0})</span>
            </button>
          ))}
        </fieldset>

        <select className="input max-w-[180px]" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">{t('logs.all_scopes')}</option>
          {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gv-text-dim)' }} />
          <input
            className="input !pl-9"
            placeholder={t('logs.search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        {entries.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: 'var(--gv-text-muted)' }}>
            {loading ? t('common.loading') : t('logs.empty')}
          </div>
        ) : (
          <ul className="font-mono text-xs leading-relaxed divide-y" style={{ borderColor: 'var(--gv-border)' }}>
            {entries.map((e, i) => (
              <li key={`${e.ts}-${i}`} className="px-3 py-1.5 hover:bg-white/[0.02] flex gap-3">
                <span className="tabular-nums" style={{ color: 'var(--gv-text-dim)' }}>
                  {fmtTs(e.ts)}
                </span>
                <span
                  className="uppercase font-semibold w-14 flex-shrink-0"
                  style={{ color: LEVEL_COLOR[e.level] }}
                >
                  {e.level}
                </span>
                <span className="w-16 flex-shrink-0 truncate" style={{ color: 'var(--gv-text-muted)' }}>{e.scope}</span>
                <span className="flex-1 break-all" style={{ color: 'var(--gv-text)' }}>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
