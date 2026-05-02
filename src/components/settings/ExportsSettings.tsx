import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Activity, Database, Webhook, RefreshCw, Save, PlayCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/toastStore';

interface PrometheusConfig { enabled: boolean }
interface MqttConfig {
  enabled: boolean; url: string; username?: string; password?: string;
  topicPrefix: string; haDiscovery: boolean; intervalSeconds: number;
}
interface InfluxConfig {
  enabled: boolean; url: string; token: string; org: string; bucket: string;
  measurement: string; intervalSeconds: number;
}
interface WebhookConfig {
  enabled: boolean; url: string; method: 'POST' | 'PUT';
  headers: Record<string, string>; intervalSeconds: number;
}
interface AllConfigs {
  prometheus: PrometheusConfig;
  mqtt: MqttConfig;
  influxdb: InfluxConfig;
  webhook: WebhookConfig;
}

export default function ExportsSettings() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [cfg, setCfg] = useState<AllConfigs | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<AllConfigs>('/exports').then(setCfg).catch((e: Error) => notify('error', t('common.error'), e.message));
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
      <div className="flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2">
          <Send className="w-4 h-4" /> {t('settings.exports_title')}
        </h2>
        <button className="btn-ghost" onClick={load} disabled={busy}>
          <RefreshCw className={'w-4 h-4 ' + (busy ? 'animate-spin' : '')} />
          {t('common.refresh')}
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {t('settings.exports_help')}
      </p>

      <PrometheusBlock cfg={cfg.prometheus} disabled={!isAdmin || busy} onSave={(p) => save('prometheus', p)} />
      <MqttBlock cfg={cfg.mqtt} disabled={!isAdmin || busy} onSave={(p) => save('mqtt', p)} onTest={() => testIt('mqtt')} />
      <InfluxBlock cfg={cfg.influxdb} disabled={!isAdmin || busy} onSave={(p) => save('influxdb', p)} onTest={() => testIt('influxdb')} />
      <WebhookBlock cfg={cfg.webhook} disabled={!isAdmin || busy} onSave={(p) => save('webhook', p)} onTest={() => testIt('webhook')} />
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

function PrometheusBlock({ cfg, disabled, onSave }: Readonly<{
  cfg: PrometheusConfig; disabled?: boolean; onSave: (c: PrometheusConfig) => void;
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
    </Block>
  );
}

function MqttBlock({ cfg, disabled, onSave, onTest }: Readonly<{
  cfg: MqttConfig; disabled?: boolean; onSave: (c: MqttConfig) => void; onTest: () => void;
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
        <Field label={t('settings.exports_interval')} value={String(s.intervalSeconds)} onChange={(v) => setS({ ...s, intervalSeconds: parseInt(v, 10) || 10 })} disabled={disabled} type="number" />
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
    </Block>
  );
}

function InfluxBlock({ cfg, disabled, onSave, onTest }: Readonly<{
  cfg: InfluxConfig; disabled?: boolean; onSave: (c: InfluxConfig) => void; onTest: () => void;
}>) {
  const { t } = useTranslation();
  const [s, setS] = useState(cfg);
  useEffect(() => { setS(cfg); }, [cfg]);
  return (
    <Block icon={<Database className="w-4 h-4" />} title="InfluxDB v2">
      <Toggle label={t('settings.exports_enabled')} checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} disabled={disabled} />
      <Field label="URL" value={s.url} onChange={(v) => setS({ ...s, url: v })} disabled={disabled} placeholder="http://influxdb:8086" />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Org" value={s.org} onChange={(v) => setS({ ...s, org: v })} disabled={disabled} />
        <Field label="Bucket" value={s.bucket} onChange={(v) => setS({ ...s, bucket: v })} disabled={disabled} />
      </div>
      <Field label="Token" value={s.token} onChange={(v) => setS({ ...s, token: v })} disabled={disabled} type="password" />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('settings.exports_inf_measurement')} value={s.measurement} onChange={(v) => setS({ ...s, measurement: v })} disabled={disabled} />
        <Field label={t('settings.exports_interval')} value={String(s.intervalSeconds)} onChange={(v) => setS({ ...s, intervalSeconds: parseInt(v, 10) || 10 })} disabled={disabled} type="number" />
      </div>
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

function WebhookBlock({ cfg, disabled, onSave, onTest }: Readonly<{
  cfg: WebhookConfig; disabled?: boolean; onSave: (c: WebhookConfig) => void; onTest: () => void;
}>) {
  const { t } = useTranslation();
  const [s, setS] = useState(cfg);
  useEffect(() => { setS(cfg); }, [cfg]);
  return (
    <Block icon={<Webhook className="w-4 h-4" />} title="Webhook">
      <Toggle label={t('settings.exports_enabled')} checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} disabled={disabled} />
      <Field label="URL" value={s.url} onChange={(v) => setS({ ...s, url: v })} disabled={disabled} placeholder="https://example.com/hook" />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Method</label>
          <select className="input" value={s.method} disabled={disabled} onChange={(e) => setS({ ...s, method: e.target.value as 'POST' | 'PUT' })}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
          </select>
        </div>
        <Field label={t('settings.exports_interval')} value={String(s.intervalSeconds)} onChange={(v) => setS({ ...s, intervalSeconds: parseInt(v, 10) || 30 })} disabled={disabled} type="number" />
      </div>
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
