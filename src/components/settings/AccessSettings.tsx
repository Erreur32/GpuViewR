import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Braces, Copy, KeyRound, Plug, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { notify } from '../../store/toastStore';

interface TokenRecord {
  id: number;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

interface AccessState {
  api_enabled: boolean;
  mcp_enabled: boolean;
  tokens: TokenRecord[];
  max_tokens: number;
  mcp_tools: Array<{ name: string; description: string }>;
}

const API_ENDPOINTS: ReadonlyArray<{ path: string; key: string }> = [
  { path: '/api/v1/health', key: 'access.ep_health' },
  { path: '/api/v1/hosts', key: 'access.ep_hosts' },
  { path: '/api/v1/gpus?host=<id>', key: 'access.ep_gpus' },
  { path: '/api/v1/gpus/history?host=<id>&gpu=0&range=1h', key: 'access.ep_history' },
  { path: '/api/v1/gpus/stats?host=<id>&gpu=0&range=24h', key: 'access.ep_stats' },
  { path: '/api/v1/processes?host=<id>&gpu=0', key: 'access.ep_processes' },
  { path: '/api/v1/llm', key: 'access.ep_llm' },
];

function useAccess() {
  const [state, setState] = useState<AccessState | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api<AccessState>('/access'));
    } catch (err) {
      notify('error', 'Error', (err as Error).message);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state, refresh };
}

async function copy(text: string, t: (k: string) => string) {
  notify((await copyText(text)) ? 'success' : 'error', t('access.copied'), '');
}

function Switch({ checked, onChange, label }: Readonly<{ checked: boolean; onChange: (v: boolean) => void; label: string }>) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <span className="w-10 h-5 rounded-full transition-colors relative"
            style={{ background: checked ? 'var(--gv-accent)' : 'var(--gv-surface-alt)' }}>
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }} />
      </span>
      {label}
    </label>
  );
}

function CodeBlock({ text }: Readonly<{ text: string }>) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <pre className="input font-mono text-xs overflow-x-auto whitespace-pre pr-10">{text}</pre>
      <button type="button" className="btn-ghost absolute top-1 right-1 !p-1" title={t('access.copy')}
              aria-label={t('access.copy')} onClick={() => copy(text, t)}>
        <Copy className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function formatTime(epoch: number | null, never: string): string {
  return epoch ? new Date(epoch * 1000).toLocaleString() : never;
}

/** Read-only tokens, shared by the API and MCP tabs. */
function TokensCard({ state, refresh }: Readonly<{ state: AccessState; refresh: () => Promise<void> }>) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string }>('/access/tokens', { method: 'POST', body: JSON.stringify({ name }) });
      setFresh(r.token);
      setName('');
      await refresh();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tok: TokenRecord) => {
    if (!globalThis.confirm(t('access.revoke_confirm', { name: tok.name }))) return;
    try {
      await api(`/access/tokens/${tok.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  };

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4" /> {t('access.tokens_title')}</h2>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('access.tokens_help')}</p>

      {fresh && (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t('access.token_once')}</p>
          <CodeBlock text={fresh} />
        </div>
      )}

      {state.tokens.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--gv-text-dim)' }}>{t('access.tokens_empty')}</p>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--gv-border)' }}>
          {state.tokens.map((tok) => (
            <li key={tok.id} className="flex items-center gap-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{tok.name}</div>
                <div className="text-xs font-mono" style={{ color: 'var(--gv-text-dim)' }}>
                  {tok.prefix}… · {t('access.created')} {formatTime(tok.created_at, '')} · {t('access.last_used')} {formatTime(tok.last_used_at, t('access.never'))}
                </div>
              </div>
              <button type="button" className="btn-ghost" title={t('access.revoke')} aria-label={t('access.revoke')}
                      onClick={() => revoke(tok)}>
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2 items-end">
        <div className="flex-1 max-w-sm">
          <label className="label" htmlFor="access-token-name">{t('access.token_name')}</label>
          <input id="access-token-name" className="input" maxLength={64} value={name}
                 placeholder={t('access.token_name_placeholder')} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="button" className="btn-primary"
                disabled={busy || name.trim() === '' || state.tokens.length >= state.max_tokens} onClick={create}>
          {t('access.create_token')}
        </button>
      </div>
    </section>
  );
}

function useSwitch(refresh: () => Promise<void>, field: 'api_enabled' | 'mcp_enabled') {
  const { t } = useTranslation();
  return async (value: boolean) => {
    try {
      await api('/access', { method: 'PUT', body: JSON.stringify({ [field]: value }) });
      await refresh();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  };
}

export function ApiSettings() {
  const { t } = useTranslation();
  const { state, refresh } = useAccess();
  const toggle = useSwitch(refresh, 'api_enabled');
  if (!state) return null;
  const base = globalThis.location.origin;

  return (
    <div className="space-y-6">
      <section className="card p-5 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><Braces className="w-4 h-4" /> {t('access.api_title')}</h2>
        <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('access.api_help')}</p>
        <Switch checked={state.api_enabled} onChange={toggle} label={t('access.api_enable')} />

        <h3 className="text-sm font-medium pt-2">{t('access.endpoints')}</h3>
        <ul className="space-y-1 text-xs">
          {API_ENDPOINTS.map((e) => (
            <li key={e.path} className="flex flex-wrap gap-x-3">
              <code className="font-mono">GET {e.path}</code>
              <span style={{ color: 'var(--gv-text-dim)' }}>{t(e.key)}</span>
            </li>
          ))}
        </ul>

        <h3 className="text-sm font-medium pt-2">{t('access.example')}</h3>
        <CodeBlock text={`curl -H "Authorization: Bearer gvk_..." ${base}/api/v1/gpus`} />
      </section>
      <TokensCard state={state} refresh={refresh} />
    </div>
  );
}

export function McpSettings() {
  const { t } = useTranslation();
  const { state, refresh } = useAccess();
  const toggle = useSwitch(refresh, 'mcp_enabled');
  if (!state) return null;
  const url = `${globalThis.location.origin}/mcp`;
  const claudeCode = `claude mcp add --transport http gpuviewr ${url} --header "Authorization: Bearer gvk_..."`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { gpuviewr: { type: 'http', url, headers: { Authorization: 'Bearer gvk_...' } } } },
    null,
    2,
  );

  return (
    <div className="space-y-6">
      <section className="card p-5 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><Plug className="w-4 h-4" /> {t('access.mcp_title')}</h2>
        <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('access.mcp_help')}</p>
        <Switch checked={state.mcp_enabled} onChange={toggle} label={t('access.mcp_enable')} />

        <h3 className="text-sm font-medium pt-2">{t('access.mcp_url')}</h3>
        <CodeBlock text={url} />
        <h3 className="text-sm font-medium pt-2">Claude Code</h3>
        <CodeBlock text={claudeCode} />
        <h3 className="text-sm font-medium pt-2">{t('access.mcp_json')}</h3>
        <CodeBlock text={jsonConfig} />

        <h3 className="text-sm font-medium pt-2">{t('access.mcp_tools')}</h3>
        <ul className="space-y-1 text-xs">
          {state.mcp_tools.map((tool) => (
            <li key={tool.name} className="flex flex-wrap gap-x-3">
              <code className="font-mono">{tool.name}</code>
              <span style={{ color: 'var(--gv-text-dim)' }}>{tool.description}</span>
            </li>
          ))}
        </ul>
      </section>
      <TokensCard state={state} refresh={refresh} />
    </div>
  );
}
