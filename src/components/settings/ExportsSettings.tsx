import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Activity, Database, Webhook, Save, PlayCircle, BellRing, BarChart3, Eye, Home, HelpCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/toastStore';

type SubTab = 'notification' | 'homeassistant' | 'metrics';

interface PrometheusConfig { enabled: boolean }
interface MqttConfig {
  enabled: boolean; url: string; username?: string; password?: string;
  topicPrefix: string; haDiscovery: boolean; intervalSeconds: number;
}
interface InfluxConfig {
  enabled: boolean; url: string; token: string; org: string; bucket: string;
  measurement: string; intervalSeconds: number;
}
type WebhookType = 'generic' | 'discord' | 'telegram';
type WebhookMode = 'metrics' | 'alerts';

const WEBHOOK_PAYLOAD_FIELDS = [
  'gpu_index', 'name', 'uuid', 'driver_version',
  'temperature', 'utilization',
  'memory_used', 'memory_total',
  'power', 'fan_speed',
  'clock_graphics', 'clock_memory',
  'timestamp', 'timestamp_epoch',
] as const;
type WebhookPayloadField = (typeof WEBHOOK_PAYLOAD_FIELDS)[number];

interface WebhookConfig {
  enabled: boolean;
  type: WebhookType;
  mode: WebhookMode;
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  intervalSeconds: number;
  payloadFields: WebhookPayloadField[];
  token?: string;
  chatId?: string;
}
interface AllConfigs {
  prometheus: PrometheusConfig;
  mqtt: MqttConfig;
  influxdb: InfluxConfig;
  webhook: WebhookConfig;
}

interface PrometheusDispatchInfo {
  enabled: boolean;
  endpoint: { method: 'GET'; path: string; url: string };
  metrics: Array<{ name: string; help: string; type: 'gauge' | 'counter'; unit: string }>;
}
interface MqttDispatchInfo {
  enabled: boolean;
  broker: string;
  connected: boolean;
  intervalSeconds: number;
  stateTopicPattern: string;
  resolvedStateTopics: string[];
  payloadKeys: string[];
  haDiscovery:
    | { enabled: false }
    | {
        enabled: true;
        configTopicPattern: string;
        sensors: Array<{ key: string; name: string; unit: string; cls?: string }>;
      };
}
interface InfluxDispatchInfo {
  enabled: boolean;
  writeUrl: string;
  measurement: string;
  intervalSeconds: number;
  tagKeys: string[];
  fieldKeys: string[];
}
interface DispatchInfo {
  prometheus: PrometheusDispatchInfo;
  mqtt: MqttDispatchInfo;
  influxdb: InfluxDispatchInfo;
}

export default function ExportsSettings() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [cfg, setCfg] = useState<AllConfigs | null>(null);
  const [info, setInfo] = useState<DispatchInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<SubTab>(() => {
    const saved = localStorage.getItem('gpuviewr.exportsSubTab') as SubTab | null;
    if (saved === 'notification' || saved === 'homeassistant' || saved === 'metrics') return saved;
    return 'notification';
  });
  const selectSub = (id: SubTab) => {
    setSub(id);
    localStorage.setItem('gpuviewr.exportsSubTab', id);
  };

  const load = () => {
    api<AllConfigs>('/exports').then(setCfg).catch((e: Error) => notify('error', t('common.error'), e.message));
    // Best-effort; the dispatch panel just stays empty if this fails (e.g. on a
    // build before the route shipped). Don't surface an error toast for it.
    api<DispatchInfo>('/exports/info').then(setInfo).catch(() => setInfo(null));
  };
  useEffect(() => { load(); }, []);

  const save = async <K extends keyof AllConfigs>(kind: K, patch: AllConfigs[K]) => {
    setBusy(true);
    try {
      await api(`/exports/${kind}`, { method: 'PUT', body: JSON.stringify(patch) });
      notify('success', t('settings.saved'));
      load();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testIt = async (kind: keyof AllConfigs) => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>(`/exports/${kind}/test`, { method: 'POST' });
      notify(r.ok ? 'success' : 'warn', r.message);
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return null;

  return (
    <section className="card p-5 space-y-5">
      <h2 className="font-semibold flex items-center gap-2">
        <Send className="w-4 h-4" /> {t('settings.exports_title')}
      </h2>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {t('settings.exports_help')}
      </p>

      <div role="tablist" className="seg flex-wrap">
        <button
          role="tab"
          aria-selected={sub === 'notification'}
          aria-pressed={sub === 'notification'}
          className="seg-btn inline-flex items-center gap-2"
          onClick={() => selectSub('notification')}
        >
          <BellRing className="w-4 h-4" /> {t('settings.exports_sub_notification')}
          <ActiveDot active={cfg.webhook.enabled} title={t('settings.exports_active')} />
        </button>
        <button
          role="tab"
          aria-selected={sub === 'homeassistant'}
          aria-pressed={sub === 'homeassistant'}
          className="seg-btn inline-flex items-center gap-2"
          onClick={() => selectSub('homeassistant')}
        >
          <Home className="w-4 h-4" /> {t('settings.exports_sub_homeassistant')}
          <ActiveDot
            active={cfg.mqtt.enabled && !!info?.mqtt?.connected}
            title={t('settings.exports_active_connected')}
          />
        </button>
        <button
          role="tab"
          aria-selected={sub === 'metrics'}
          aria-pressed={sub === 'metrics'}
          className="seg-btn inline-flex items-center gap-2"
          onClick={() => selectSub('metrics')}
        >
          <BarChart3 className="w-4 h-4" /> {t('settings.exports_sub_metrics')}
          <ActiveDot
            active={cfg.prometheus.enabled || cfg.influxdb.enabled}
            title={t('settings.exports_active')}
          />
        </button>
      </div>

      {sub === 'notification' && (
        <WebhookBlock cfg={cfg.webhook} disabled={!isAdmin || busy} onSave={(p) => save('webhook', p)} onTest={() => testIt('webhook')} />
      )}

      {sub === 'homeassistant' && (
        <div className="space-y-4">
          <MqttBlock cfg={cfg.mqtt} info={info?.mqtt} disabled={!isAdmin || busy} onSave={(p) => save('mqtt', p)} onTest={() => testIt('mqtt')} />
          <HomeAssistantHelp />
        </div>
      )}

      {sub === 'metrics' && (
        <div className="space-y-4">
          <PrometheusBlock cfg={cfg.prometheus} info={info?.prometheus} disabled={!isAdmin || busy} onSave={(p) => save('prometheus', p)} />
          <InfluxBlock cfg={cfg.influxdb} info={info?.influxdb} disabled={!isAdmin || busy} onSave={(p) => save('influxdb', p)} onTest={() => testIt('influxdb')} />
        </div>
      )}
    </section>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function Toggle({ label, checked, onChange, disabled }: Readonly<{
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}>) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <span className="w-10 h-5 rounded-full transition-colors relative" style={{
        background: checked ? 'var(--gv-accent)' : 'var(--gv-surface-alt)',
      }}>
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }} />
      </span>
      {label}
    </label>
  );
}

function ActiveDot({ active, title }: Readonly<{ active: boolean; title: string }>) {
  if (!active) return null;
  return (
    <span
      aria-label={title}
      title={title}
      className="inline-block w-2 h-2 rounded-full"
      style={{
        background: 'var(--gv-ok)',
        boxShadow: '0 0 6px color-mix(in srgb, var(--gv-ok) 60%, transparent)',
      }}
    />
  );
}

function Block({ icon, title, children }: Readonly<{ icon: React.ReactNode; title: string; children: React.ReactNode }>) {
  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--gv-surface-alt)' }}>
      <div className="flex items-center gap-2 font-medium">
        {icon}<span>{title}</span>
      </div>
      {children}
    </div>
  );
}

function PrometheusBlock({ cfg, info, disabled, onSave }: Readonly<{
  cfg: PrometheusConfig; info?: PrometheusDispatchInfo; disabled?: boolean; onSave: (c: PrometheusConfig) => void;
}>) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(cfg.enabled);
  useEffect(() => { setEnabled(cfg.enabled); }, [cfg.enabled]);
  return (
    <Block icon={<Activity className="w-4 h-4" />} title="Prometheus">
      <Toggle label={t('settings.exports_enabled')} checked={enabled} onChange={setEnabled} disabled={disabled} />
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {t('settings.exports_prom_help')} <code>GET /metrics</code>
      </p>
      <button className="btn-primary" disabled={disabled} onClick={() => onSave({ enabled })}>
        <Save className="w-4 h-4" /> {t('common.save')}
      </button>
      {cfg.enabled && info && (
        <DispatchPanel
          rows={[
            { label: t('settings.exports_info_endpoint'), value: <code>{info.endpoint.method} {info.endpoint.url}</code> },
            { label: t('settings.exports_info_metrics_count'), value: String(info.metrics.length) },
          ]}
          listTitle={t('settings.exports_info_metrics')}
          listItems={info.metrics.map((m) => ({
            primary: <code>{m.name}</code>,
            secondary: `${m.help} · ${m.type}`,
          }))}
        />
      )}
    </Block>
  );
}

function MqttBlock({ cfg, info, disabled, onSave, onTest }: Readonly<{
  cfg: MqttConfig; info?: MqttDispatchInfo; disabled?: boolean; onSave: (c: MqttConfig) => void; onTest: () => void;
}>) {
  const { t } = useTranslation();
  const [s, setS] = useState(cfg);
  useEffect(() => { setS(cfg); }, [cfg]);
  return (
    <Block icon={<Send className="w-4 h-4" />} title="MQTT / Home Assistant">
      <Toggle label={t('settings.exports_enabled')} checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} disabled={disabled} />
      <Field label={t('settings.exports_mqtt_url')} value={s.url} onChange={(v) => setS({ ...s, url: v })} disabled={disabled} placeholder="mqtt://broker:1883" />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('settings.exports_user')} value={s.username ?? ''} onChange={(v) => setS({ ...s, username: v })} disabled={disabled} />
        <Field label={t('settings.exports_pass')} value={s.password ?? ''} onChange={(v) => setS({ ...s, password: v })} disabled={disabled} type="password" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('settings.exports_mqtt_prefix')} value={s.topicPrefix} onChange={(v) => setS({ ...s, topicPrefix: v })} disabled={disabled} />
        <Field label={t('settings.exports_interval')} value={String(s.intervalSeconds)} onChange={(v) => setS({ ...s, intervalSeconds: Number.parseInt(v, 10) || 10 })} disabled={disabled} type="number" />
      </div>
      <Toggle label={t('settings.exports_mqtt_ha')} checked={s.haDiscovery} onChange={(v) => setS({ ...s, haDiscovery: v })} disabled={disabled} />
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {t('settings.exports_mqtt_help')}
      </p>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={disabled} onClick={() => onSave(s)}>
          <Save className="w-4 h-4" /> {t('common.save')}
        </button>
        <button className="btn-ghost" disabled={disabled} onClick={onTest}>
          <PlayCircle className="w-4 h-4" /> {t('settings.exports_test')}
        </button>
      </div>
      {cfg.enabled && info && (
        <DispatchPanel
          rows={[
            { label: t('settings.exports_info_broker'), value: <code>{info.broker || '—'}</code> },
            {
              label: t('settings.exports_info_status'),
              value: (
                <span style={{ color: info.connected ? 'var(--gv-ok)' : 'var(--gv-warn)' }}>
                  {info.connected ? t('settings.exports_info_connected') : t('settings.exports_info_disconnected')}
                </span>
              ),
            },
            { label: t('settings.exports_info_interval'), value: `${info.intervalSeconds}s` },
            { label: t('settings.exports_info_topic_pattern'), value: <code>{info.stateTopicPattern}</code> },
            ...(info.resolvedStateTopics.length > 0
              ? [{ label: t('settings.exports_info_resolved_topics'), value: <code>{info.resolvedStateTopics.join(', ')}</code> }]
              : []),
          ]}
          listTitle={t('settings.exports_info_payload_keys')}
          listItems={info.payloadKeys.map((k) => ({ primary: <code>{k}</code> }))}
          extra={info.haDiscovery.enabled ? (
            <DispatchPanel
              rows={[
                { label: t('settings.exports_info_ha_topic_pattern'), value: <code>{info.haDiscovery.configTopicPattern}</code> },
              ]}
              listTitle={t('settings.exports_info_ha_sensors')}
              listItems={info.haDiscovery.sensors.map((s) => ({
                primary: <code>{s.key}</code>,
                secondary: `${s.name} · ${s.unit}${s.cls ? ` · class=${s.cls}` : ''}`,
              }))}
              embedded
            />
          ) : undefined}
        />
      )}
    </Block>
  );
}

function InfluxBlock({ cfg, info, disabled, onSave, onTest }: Readonly<{
  cfg: InfluxConfig; info?: InfluxDispatchInfo; disabled?: boolean; onSave: (c: InfluxConfig) => void; onTest: () => void;
}>) {
  const { t } = useTranslation();
  const [s, setS] = useState(cfg);
  useEffect(() => { setS(cfg); }, [cfg]);
  return (
    <Block icon={<Database className="w-4 h-4" />} title="InfluxDB v2">
      <Toggle label={t('settings.exports_enabled')} checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} disabled={disabled} />
      <Field label="URL" value={s.url} onChange={(v) => setS({ ...s, url: v })} disabled={disabled} placeholder="https://influxdb:8086" />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Org" value={s.org} onChange={(v) => setS({ ...s, org: v })} disabled={disabled} />
        <Field label="Bucket" value={s.bucket} onChange={(v) => setS({ ...s, bucket: v })} disabled={disabled} />
      </div>
      <Field label="Token" value={s.token} onChange={(v) => setS({ ...s, token: v })} disabled={disabled} type="password" />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('settings.exports_inf_measurement')} value={s.measurement} onChange={(v) => setS({ ...s, measurement: v })} disabled={disabled} />
        <Field label={t('settings.exports_interval')} value={String(s.intervalSeconds)} onChange={(v) => setS({ ...s, intervalSeconds: Number.parseInt(v, 10) || 10 })} disabled={disabled} type="number" />
      </div>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={disabled} onClick={() => onSave(s)}>
          <Save className="w-4 h-4" /> {t('common.save')}
        </button>
        <button className="btn-ghost" disabled={disabled} onClick={onTest}>
          <PlayCircle className="w-4 h-4" /> {t('settings.exports_test')}
        </button>
      </div>
      {cfg.enabled && info && (
        <DispatchPanel
          rows={[
            { label: t('settings.exports_info_write_url'), value: <code className="break-all">{info.writeUrl || '—'}</code> },
            { label: t('settings.exports_inf_measurement'), value: <code>{info.measurement}</code> },
            { label: t('settings.exports_info_interval'), value: `${info.intervalSeconds}s` },
            { label: t('settings.exports_info_tag_keys'), value: <code>{info.tagKeys.join(', ')}</code> },
          ]}
          listTitle={t('settings.exports_info_field_keys')}
          listItems={info.fieldKeys.map((k) => ({ primary: <code>{k}</code> }))}
        />
      )}
    </Block>
  );
}

function WebhookBlock({ cfg, disabled, onSave, onTest }: Readonly<{
  cfg: WebhookConfig; disabled?: boolean; onSave: (c: WebhookConfig) => void; onTest: () => void;
}>) {
  const { t } = useTranslation();
  const [s, setS] = useState(cfg);
  useEffect(() => { setS(cfg); }, [cfg]);
  const placeholderForType: Record<WebhookType, string> = {
    generic:  'https://example.com/hook',
    discord:  'https://discord.com/api/webhooks/...',
    telegram: '',
  };
  return (
    <Block icon={<Webhook className="w-4 h-4" />} title="Webhook">
      <Toggle label={t('settings.exports_enabled')} checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} disabled={disabled} />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">{t('settings.exports_webhook_type')}</label>
          <select
            className="input"
            value={s.type}
            disabled={disabled}
            onChange={(e) => setS({ ...s, type: e.target.value as WebhookType })}
          >
            <option value="generic">Generic (JSON)</option>
            <option value="discord">Discord</option>
            <option value="telegram">Telegram</option>
          </select>
        </div>
        <div>
          <label className="label">{t('settings.exports_webhook_mode')}</label>
          <select
            className="input"
            value={s.mode}
            disabled={disabled}
            onChange={(e) => setS({ ...s, mode: e.target.value as WebhookMode })}
          >
            <option value="alerts">{t('settings.exports_webhook_mode_alerts')}</option>
            <option value="metrics">{t('settings.exports_webhook_mode_metrics')}</option>
          </select>
        </div>
      </div>

      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {s.mode === 'alerts'
          ? t('settings.exports_webhook_mode_alerts_help')
          : t('settings.exports_webhook_mode_metrics_help')}
      </p>

      {s.type !== 'telegram' && (
        <Field
          label="URL"
          value={s.url}
          onChange={(v) => setS({ ...s, url: v })}
          disabled={disabled}
          placeholder={placeholderForType[s.type]}
        />
      )}

      {s.type === 'telegram' && (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Bot Token"
            value={s.token ?? ''}
            onChange={(v) => setS({ ...s, token: v })}
            disabled={disabled}
            type="password"
            placeholder="123:ABC-..."
          />
          <Field
            label="Chat ID"
            value={s.chatId ?? ''}
            onChange={(v) => setS({ ...s, chatId: v })}
            disabled={disabled}
            placeholder="-1001234567890"
          />
        </div>
      )}

      {s.type === 'generic' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Method</label>
            <select className="input" value={s.method} disabled={disabled} onChange={(e) => setS({ ...s, method: e.target.value as 'POST' | 'PUT' })}>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </select>
          </div>
        </div>
      )}

      {/* Interval applies to every webhook type in metrics mode (the
          server schedules the push regardless of generic/discord/telegram). */}
      {s.mode === 'metrics' && (
        <Field
          label={t('settings.exports_interval')}
          value={String(s.intervalSeconds)}
          onChange={(v) => setS({ ...s, intervalSeconds: Number.parseInt(v, 10) || 30 })}
          disabled={disabled}
          type="number"
        />
      )}

      {/* Field picker — only meaningful for raw JSON (generic) in metrics mode.
          Discord/Telegram payloads are reformatted into embeds/text by the
          server so per-field selection is ignored there. */}
      {s.mode === 'metrics' && s.type === 'generic' && (
        <PayloadFieldsPicker
          selected={s.payloadFields ?? [...WEBHOOK_PAYLOAD_FIELDS]}
          disabled={disabled}
          onChange={(next) => setS({ ...s, payloadFields: next })}
        />
      )}

      {s.type === 'generic' && (
        <HeadersEditor
          headers={s.headers ?? {}}
          disabled={disabled}
          onChange={(next) => setS({ ...s, headers: next })}
        />
      )}

      <div className="flex gap-2">
        <button className="btn-primary" disabled={disabled} onClick={() => onSave(s)}>
          <Save className="w-4 h-4" /> {t('common.save')}
        </button>
        <button className="btn-ghost" disabled={disabled} onClick={onTest}>
          <PlayCircle className="w-4 h-4" /> {t('settings.exports_test')}
        </button>
      </div>
    </Block>
  );
}

function HeadersEditor({ headers, disabled, onChange }: Readonly<{
  headers: Record<string, string>;
  disabled?: boolean;
  onChange: (next: Record<string, string>) => void;
}>) {
  const { t } = useTranslation();
  // Render as an ordered array internally so the user can have multiple in-flight
  // edits with empty keys without React reordering rows under them.
  const entries = Object.entries(headers);
  const update = (idx: number, key: string, value: string) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      const useK = i === idx ? key : k;
      const useV = i === idx ? value : v;
      if (useK.trim()) next[useK] = useV;
    });
    onChange(next);
  };
  const add = () => {
    // Append a placeholder pair the user can fill in.
    const next = { ...headers, '': '' };
    onChange(next);
  };
  const remove = (idx: number) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => { if (i !== idx && k.trim()) next[k] = v; });
    onChange(next);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="label">{t('settings.exports_webhook_headers')}</label>
        <button
          type="button"
          className="btn-ghost text-xs"
          disabled={disabled}
          onClick={add}
        >
          + {t('settings.exports_webhook_headers_add')}
        </button>
      </div>
      {entries.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
          {t('settings.exports_webhook_headers_empty')}
        </p>
      )}
      {entries.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="text"
            className="input"
            value={k}
            disabled={disabled}
            placeholder="X-Header-Name"
            onChange={(e) => update(i, e.target.value, v)}
          />
          <input
            type="text"
            className="input"
            value={v}
            disabled={disabled}
            placeholder="value"
            onChange={(e) => update(i, k, e.target.value)}
          />
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={disabled}
            onClick={() => remove(i)}
            aria-label={t('settings.exports_webhook_headers_remove')}
            title={t('settings.exports_webhook_headers_remove')}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function PayloadFieldsPicker({ selected, disabled, onChange }: Readonly<{
  selected: WebhookPayloadField[];
  disabled?: boolean;
  onChange: (next: WebhookPayloadField[]) => void;
}>) {
  const { t } = useTranslation();
  const set = new Set<WebhookPayloadField>(selected);
  const toggle = (f: WebhookPayloadField) => {
    const next = new Set(set);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    // Preserve canonical order so the JSON keys stay predictable.
    onChange(WEBHOOK_PAYLOAD_FIELDS.filter((k) => next.has(k)));
  };
  const allOn = set.size === WEBHOOK_PAYLOAD_FIELDS.length;
  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <label className="label !mb-0">{t('settings.exports_webhook_fields')}</label>
        <div className="flex gap-1">
          <button
            type="button"
            className="btn-ghost text-[10px] !px-2 !py-0.5"
            disabled={disabled}
            onClick={() => onChange([...WEBHOOK_PAYLOAD_FIELDS])}
            aria-pressed={allOn}
          >
            {t('settings.exports_webhook_fields_all')}
          </button>
          <button
            type="button"
            className="btn-ghost text-[10px] !px-2 !py-0.5"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            {t('settings.exports_webhook_fields_none')}
          </button>
        </div>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--gv-text-dim)' }}>
        {t('settings.exports_webhook_fields_help')}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {WEBHOOK_PAYLOAD_FIELDS.map((f) => {
          const checked = set.has(f);
          return (
            <label
              key={f}
              className="inline-flex items-center gap-2 text-xs cursor-pointer rounded-md px-2 py-1"
              style={{
                background: checked ? 'color-mix(in srgb, var(--gv-accent) 12%, transparent)' : 'var(--gv-surface-alt)',
                border: `1px solid ${checked ? 'color-mix(in srgb, var(--gv-accent) 35%, transparent)' : 'var(--gv-border)'}`,
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(f)}
                className="accent-current"
              />
              <span className="font-mono tabular-nums">{f}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function DispatchPanel({ rows, listTitle, listItems, extra, embedded }: Readonly<{
  rows: Array<{ label: string; value: React.ReactNode }>;
  listTitle: string;
  listItems: Array<{ primary: React.ReactNode; secondary?: string }>;
  extra?: React.ReactNode;
  embedded?: boolean;
}>) {
  const { t } = useTranslation();
  return (
    <details
      className="rounded-lg p-3 text-xs"
      style={{
        background: embedded ? 'transparent' : 'var(--gv-surface)',
        border: '1px dashed var(--gv-border)',
      }}
    >
      <summary
        className="cursor-pointer select-none flex items-center gap-2 font-medium"
        style={{ color: 'var(--gv-text-muted)' }}
      >
        <Eye className="w-3.5 h-3.5" />
        {t('settings.exports_info_title')}
      </summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt style={{ color: 'var(--gv-text-dim)' }}>{r.label}</dt>
            <dd style={{ color: 'var(--gv-text)' }}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">
        <div style={{ color: 'var(--gv-text-dim)' }} className="mb-1">{listTitle}</div>
        <ul className="space-y-0.5">
          {listItems.map((item, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span>{item.primary}</span>
              {item.secondary && <span style={{ color: 'var(--gv-text-dim)' }}>— {item.secondary}</span>}
            </li>
          ))}
        </ul>
      </div>
      {extra && <div className="mt-3">{extra}</div>}
    </details>
  );
}

function HomeAssistantHelp() {
  const { t } = useTranslation();
  const steps: string[] = t('settings.exports_ha_help_steps', { returnObjects: true }) as string[];
  return (
    <details
      className="rounded-xl p-4 text-sm"
      style={{ background: 'var(--gv-surface-alt)', border: '1px dashed var(--gv-border)' }}
    >
      <summary
        className="cursor-pointer select-none flex items-center gap-2 font-medium"
        style={{ color: 'var(--gv-text)' }}
      >
        <HelpCircle className="w-4 h-4" />
        {t('settings.exports_ha_help_title')}
      </summary>
      <p className="mt-3 text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {t('settings.exports_ha_help_intro')}
      </p>
      <ol className="mt-2 space-y-1.5 text-xs list-decimal pl-5" style={{ color: 'var(--gv-text)' }}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <p className="mt-3 text-xs" style={{ color: 'var(--gv-text-dim)' }}>
        {t('settings.exports_ha_help_note')}
      </p>
    </details>
  );
}

function Field({ label, value, onChange, disabled, type = 'text', placeholder }: Readonly<{
  label: string; value: string; onChange: (v: string) => void; disabled?: boolean; type?: string; placeholder?: string;
}>) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type={type}
        className="input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
