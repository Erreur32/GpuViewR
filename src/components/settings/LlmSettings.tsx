import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Plus, Trash2, Server } from 'lucide-react';
import { api } from '../../lib/api';
import { notify } from '../../store/toastStore';
import { useAuthStore } from '../../store/authStore';
import { useHostsStore } from '../../store/hostsStore';

interface Rule {
  match: string;
  runtime: string;
  model_flag?: string;
  model?: string;
}

interface HostLlmConfig {
  endpoints: string[];
  ollama_manifests_dir: string | null;
}

/** Same limits as server/services/llmConfig.ts. */
const MAX_RULES = 50;
const MAX_ENDPOINTS = 16;
// Examples only: LAN LLM servers usually speak plain http, which the hub accepts.
const ENDPOINT_EXAMPLES = ['192.168.1.10:8081', '192.168.1.10:11434'].map((h) => `${'http'}://${h}`).join('\n');

/** A rule plus a client-only key, stable while the list is edited. */
type EditRule = Rule & { key: number };
let nextKey = 0;
const withKey = (r: Rule): EditRule => ({ ...r, key: nextKey++ });
const withoutKey = (r: EditRule): Rule => ({
  match: r.match,
  runtime: r.runtime,
  ...(r.model_flag ? { model_flag: r.model_flag } : {}),
  ...(r.model ? { model: r.model } : {}),
});

/** Settings > LLM. Naming rules apply to every agent; endpoints and the
 *  Ollama manifests dir are per host. Changes reach connected agents at
 *  once (the hub pushes them in a config frame). */
export default function LlmSettings() {
  return (
    <div className="space-y-6">
      <RulesSection />
      <HostSection />
    </div>
  );
}

function RulesSection() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [rules, setRules] = useState<EditRule[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ rules: Rule[] }>('/llm/rules').then((r) => setRules(r.rules.map(withKey))).catch(() => { /* toast on save */ });
  }, []);

  const update = (key: number, patch: Partial<Rule>) => setRules(rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ rules: Rule[] }>('/llm/rules', { method: 'PUT', body: JSON.stringify({ rules: rules.map(withoutKey) }) });
      setRules(r.rules.map(withKey));
      notify('success', t('settings.saved'), t('llm.pushed'));
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <Bot className="w-4 h-4" /> {t('llm.rules_title')}
      </h2>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('llm.rules_help')}</p>

      {rules.length === 0 && <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>{t('llm.rules_empty')}</p>}

      {rules.map((r) => (
        <div key={r.key} className="grid gap-2 items-end md:grid-cols-[2fr_1.2fr_1fr_1.2fr_auto]">
          <Field label={t('llm.rule_match')} value={r.match} max={120} placeholder="my-llm-server" disabled={!isAdmin}
                 onChange={(v) => update(r.key, { match: v })} />
          <Field label={t('llm.rule_runtime')} value={r.runtime} max={40} placeholder="MyServer" disabled={!isAdmin}
                 onChange={(v) => update(r.key, { runtime: v })} />
          <Field label={t('llm.rule_flag')} value={r.model_flag ?? ''} max={40} placeholder="--model" disabled={!isAdmin}
                 onChange={(v) => update(r.key, { model_flag: v || undefined })} />
          <Field label={t('llm.rule_model')} value={r.model ?? ''} max={120} placeholder={t('llm.rule_model_placeholder')} disabled={!isAdmin}
                 onChange={(v) => update(r.key, { model: v || undefined })} />
          {isAdmin && (
            <button type="button" className="btn-ghost !p-2" aria-label={t('llm.remove')} title={t('llm.remove')}
                    onClick={() => setRules(rules.filter((x) => x.key !== r.key))}>
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      ))}

      {isAdmin && (
        <div className="flex gap-2 pt-1">
          <button type="button" className="btn-ghost" disabled={rules.length >= MAX_RULES}
                  onClick={() => setRules([...rules, withKey({ match: '', runtime: '' })])}>
            <Plus className="w-4 h-4" /> {t('llm.add_rule')}
          </button>
          <button type="button" className="btn-primary" disabled={saving} onClick={save}>{t('common.save')}</button>
        </div>
      )}
    </section>
  );
}

function HostSection() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const hosts = useHostsStore((s) => s.hosts);
  const refreshHosts = useHostsStore((s) => s.refresh);
  const [hostId, setHostId] = useState<string>('');
  const [endpoints, setEndpoints] = useState('');
  const [dir, setDir] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (hosts.length === 0) refreshHosts().catch(() => { /* ignore */ });
  }, [hosts.length, refreshHosts]);

  useEffect(() => {
    if (!hostId && hosts.length > 0) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  useEffect(() => {
    if (!hostId) return;
    api<{ config: HostLlmConfig }>(`/llm/hosts/${encodeURIComponent(hostId)}`)
      .then((r) => {
        setEndpoints(r.config.endpoints.join('\n'));
        setDir(r.config.ollama_manifests_dir ?? '');
      })
      .catch(() => { setEndpoints(''); setDir(''); });
  }, [hostId]);

  const save = async () => {
    setSaving(true);
    try {
      const list = endpoints.split('\n').map((l) => l.trim()).filter(Boolean);
      const r = await api<{ config: HostLlmConfig }>(`/llm/hosts/${encodeURIComponent(hostId)}`, {
        method: 'PUT',
        body: JSON.stringify({ config: { endpoints: list, ollama_manifests_dir: dir.trim() || null } }),
      });
      setEndpoints(r.config.endpoints.join('\n'));
      setDir(r.config.ollama_manifests_dir ?? '');
      notify('success', t('settings.saved'), t('llm.pushed'));
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <Server className="w-4 h-4" /> {t('llm.host_title')}
      </h2>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('llm.host_help')}</p>

      <div>
        <label className="label" htmlFor="llm-host">{t('llm.host')}</label>
        <select id="llm-host" className="input max-w-sm" value={hostId} onChange={(e) => setHostId(e.target.value)}>
          {hosts.map((h) => <option key={h.id} value={h.id}>{h.label || h.hostname || h.id}</option>)}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="llm-endpoints">{t('llm.endpoints', { max: MAX_ENDPOINTS })}</label>
        <textarea
          id="llm-endpoints"
          className="input font-mono text-xs min-h-[84px]"
          value={endpoints}
          disabled={!isAdmin}
          placeholder={ENDPOINT_EXAMPLES}
          onChange={(e) => setEndpoints(e.target.value)}
        />
        <p className="text-xs mt-1" style={{ color: 'var(--gv-text-dim)' }}>{t('llm.endpoints_help')}</p>
      </div>

      <Field label={t('llm.manifests_dir')} value={dir} max={512} placeholder="/home/docker/llm/ollama/models/manifests"
             disabled={!isAdmin} onChange={setDir} help={t('llm.manifests_dir_help')} />

      {isAdmin && (
        <button type="button" className="btn-primary" disabled={saving || !hostId} onClick={save}>{t('common.save')}</button>
      )}
    </section>
  );
}

function Field({ label, value, onChange, max, placeholder, disabled, help }: Readonly<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder?: string;
  disabled?: boolean;
  help?: string;
}>) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" value={value} maxLength={max} placeholder={placeholder} disabled={disabled}
             onChange={(e) => onChange(e.target.value)} />
      {help && <span className="block text-xs mt-1" style={{ color: 'var(--gv-text-dim)' }}>{help}</span>}
    </label>
  );
}
