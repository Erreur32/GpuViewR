import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Trash2, Bell, Volume2, VolumeX, Edit3, Sparkles, Webhook,
  Thermometer, Activity, MemoryStick, Zap, Fan,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { useUiStore } from '../../store/uiStore';
import { notify } from '../../store/toastStore';

type Metric = 'temperature' | 'utilization' | 'memory' | 'power' | 'fan_speed';
type Condition = 'above' | 'below';

// Visual cue per metric so users scan rule rows without reading the metric column.
const METRIC_ICON: Record<Metric, { icon: LucideIcon; color: string }> = {
  temperature: { icon: Thermometer,  color: 'var(--gv-danger)' },
  utilization: { icon: Activity,     color: 'var(--gv-info)' },
  memory:      { icon: MemoryStick,  color: 'var(--gv-accent)' },
  power:       { icon: Zap,          color: 'var(--gv-warn)' },
  fan_speed:   { icon: Fan,          color: 'var(--gv-ok)' },
};

// Display order shared by the Rules table and the Presets picker so
// temperature rules cluster together, then utilization, memory, power,
// fan — instead of arbitrary insertion order.
const METRIC_ORDER: Metric[] = ['temperature', 'utilization', 'memory', 'power', 'fan_speed'];

function MetricIcon({ metric, className = 'w-4 h-4' }: Readonly<{ metric: Metric; className?: string }>) {
  const spec = METRIC_ICON[metric];
  const Icon = spec.icon;
  return <Icon className={className} style={{ color: spec.color }} />;
}

interface Rule {
  id: number;
  name: string;
  metric: Metric;
  condition: Condition;
  threshold: number;
  duration_s: number;
  gpu_index: number | null;
  enabled: 0 | 1;
  notify_browser: 0 | 1;
  notify_sound: 0 | 1;
  notify_webhook: 0 | 1;
  cooldown_s: number;
}

interface AlertEvent {
  id: number;
  rule_name: string;
  gpu_index: number;
  metric: string;
  threshold: number;
  observed: number;
  state: 'firing' | 'resolved';
  message: string;
  triggered_at: number;
}

const EMPTY: Omit<Rule, 'id'> = {
  name: '',
  metric: 'temperature',
  condition: 'above',
  threshold: 80,
  duration_s: 30,
  gpu_index: null,
  enabled: 1,
  notify_browser: 1,
  notify_sound: 0,
  notify_webhook: 1,
  cooldown_s: 300,
};

export default function AlertsPage() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const soundEnabled = useUiStore((s) => s.soundEnabled);
  const setSoundEnabled = useUiStore((s) => s.setSoundEnabled);
  const [rules, setRules] = useState<Rule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);

  async function load() {
    const r = await api<{ rules: Rule[] }>('/alerts/rules');
    const e = await api<{ events: AlertEvent[] }>('/alerts/events?limit=50');
    setRules(r.rules);
    setEvents(e.events);
  }
  useEffect(() => { void load(); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      if (editing.id) {
        await api(`/alerts/rules/${editing.id}`, { method: 'PATCH', body: JSON.stringify(editing) });
      } else {
        await api('/alerts/rules', { method: 'POST', body: JSON.stringify(editing) });
      }
      setEditing(null);
      notify('success', t('alerts.saved'));
      await load();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  }

  async function remove(id: number) {
    try {
      await api(`/alerts/rules/${id}`, { method: 'DELETE' });
      notify('success', t('alerts.deleted'));
      await load();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  }

  async function toggle(rule: Rule) {
    try {
      await api(`/alerts/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) });
      await load();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  }

  async function toggleWebhook(rule: Rule) {
    try {
      await api(`/alerts/rules/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notify_webhook: !rule.notify_webhook }),
      });
      await load();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    }
  }

  async function requestBrowserPerm() {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    notify(p === 'granted' ? 'success' : 'warn', t('alerts.browser_perm_' + p));
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('alerts.title')}</h1>
          <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('alerts.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            aria-pressed={soundEnabled}
            onClick={() => setSoundEnabled(!soundEnabled)}
            title={soundEnabled ? t('alerts.sound_disable') : t('alerts.sound_enable')}
          >
            {soundEnabled
              ? <Volume2 className="w-4 h-4" style={{ color: 'var(--gv-ok)' }} />
              : <VolumeX className="w-4 h-4" style={{ color: 'var(--gv-text-dim)' }} />}
            {soundEnabled ? t('alerts.sound_on') : t('alerts.sound_off')}
          </button>
          <button className="btn-ghost" onClick={requestBrowserPerm}>
            <Bell className="w-4 h-4" /> {t('alerts.enable_browser')}
          </button>
          {isAdmin && (
            <>
              <button className="btn-ghost" onClick={() => setPresetsOpen(true)}>
                <Sparkles className="w-4 h-4" /> {t('alerts.presets')}
              </button>
              <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
                <Plus className="w-4 h-4" /> {t('alerts.new_rule')}
              </button>
            </>
          )}
        </div>
      </header>

      <section className="card overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold uppercase tracking-wider"
             style={{ color: 'var(--gv-text-muted)', borderBottom: '1px solid var(--gv-border)' }}>
          {t('alerts.rules')}
        </div>
        {rules.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: 'var(--gv-text-muted)' }}>
            {t('alerts.no_rules')}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--gv-surface-alt)', color: 'var(--gv-text-muted)' }}>
                <th className="text-left py-2 px-4 text-xs uppercase tracking-wider font-medium">{t('alerts.rule_name')}</th>
                <th className="text-left py-2 px-4 text-xs uppercase tracking-wider font-medium">{t('alerts.condition')}</th>
                <th className="text-left py-2 px-4 text-xs uppercase tracking-wider font-medium">{t('alerts.duration')}</th>
                <th className="text-left py-2 px-4 text-xs uppercase tracking-wider font-medium">{t('alerts.notify')}</th>
                <th className="text-right py-2 px-4 text-xs uppercase tracking-wider font-medium">{t('alerts.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {[...rules].sort((a, b) => {
                const ai = METRIC_ORDER.indexOf(a.metric);
                const bi = METRIC_ORDER.indexOf(b.metric);
                if (ai !== bi) return ai - bi;
                if (a.threshold !== b.threshold) return a.threshold - b.threshold;
                return a.name.localeCompare(b.name);
              }).map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--gv-border)' }}>
                  <td className="py-2 px-4">
                    <div className="flex items-start gap-2">
                      <span title={t(`alerts.metrics.${r.metric}`)} className="inline-flex shrink-0 mt-0.5">
                        <MetricIcon metric={r.metric} className="w-4 h-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{r.name}</div>
                        <div className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
                          {r.gpu_index === null ? t('alerts.all_gpus') : `GPU #${r.gpu_index}`}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-4 tabular-nums">
                    {t(`alerts.metrics.${r.metric}`)} {r.condition === 'above' ? '≥' : '≤'} {r.threshold}
                  </td>
                  <td className="py-2 px-4 tabular-nums">{r.duration_s}s</td>
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2">
                      {!!r.notify_browser && (
                        <span title={t('alerts.notify_browser')} className="inline-flex">
                          <Bell className="w-3.5 h-3.5" style={{ color: 'var(--gv-info)' }} />
                        </span>
                      )}
                      {!!r.notify_sound && (
                        <span title={t('alerts.notify_sound')} className="inline-flex">
                          <Volume2 className="w-3.5 h-3.5" style={{ color: 'var(--gv-warn)' }} />
                        </span>
                      )}
                      <span
                        title={r.notify_webhook ? t('alerts.webhook_active_hint') : t('alerts.webhook_inactive_hint')}
                        className="inline-flex cursor-help"
                      >
                        <Webhook
                          className="w-3.5 h-3.5"
                          style={{
                            color: r.notify_webhook ? 'var(--gv-accent)' : 'var(--gv-text-dim)',
                            opacity: r.notify_webhook ? 1 : 0.5,
                          }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      <label
                        className="inline-flex items-center cursor-pointer"
                        title={t('alerts.toggle_webhook_hint')}
                      >
                        <input
                          type="checkbox"
                          checked={!!r.notify_webhook}
                          onChange={() => isAdmin && toggleWebhook(r)}
                          disabled={!isAdmin}
                          className="sr-only peer"
                        />
                        <span className="inline-flex items-center gap-1 w-auto h-5 px-1.5 rounded-full transition-colors text-[10px] font-medium uppercase tracking-wider" style={{
                          background: r.notify_webhook ? 'color-mix(in srgb, var(--gv-accent) 18%, transparent)' : 'var(--gv-surface-alt)',
                          color: r.notify_webhook ? 'var(--gv-accent)' : 'var(--gv-text-dim)',
                          border: `1px solid ${r.notify_webhook ? 'color-mix(in srgb, var(--gv-accent) 35%, transparent)' : 'var(--gv-border)'}`,
                        }}>
                          <Webhook className="w-3 h-3" />
                          {r.notify_webhook ? 'ON' : 'OFF'}
                        </span>
                      </label>
                      <label
                        className="inline-flex items-center cursor-pointer"
                        aria-label={t('alerts.enabled')}
                      >
                        <input
                          type="checkbox"
                          aria-label={t('alerts.enabled')}
                          checked={!!r.enabled}
                          onChange={() => isAdmin && toggle(r)}
                          disabled={!isAdmin}
                          className="sr-only peer"
                        />
                        <span className="w-9 h-5 rounded-full transition-colors relative" style={{
                          background: r.enabled ? 'var(--gv-accent)' : 'var(--gv-surface-alt)',
                        }}>
                          <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                                style={{ transform: r.enabled ? 'translateX(16px)' : 'translateX(0)' }} />
                        </span>
                      </label>
                      {isAdmin && (
                        <>
                          <button className="btn-ghost !p-1.5" onClick={() => setEditing(r)} aria-label="Edit">
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button className="btn-ghost !p-1.5" onClick={() => remove(r.id)} aria-label="Delete">
                            <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--gv-danger)' }} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold uppercase tracking-wider"
             style={{ color: 'var(--gv-text-muted)', borderBottom: '1px solid var(--gv-border)' }}>
          {t('alerts.recent_events')}
        </div>
        {events.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: 'var(--gv-text-muted)' }}>
            {t('alerts.no_events')}
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--gv-border)' }}>
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5 flex items-start gap-3 text-sm">
                <span className="mt-0.5 inline-block w-2 h-2 rounded-full" style={{
                  background: e.state === 'firing' ? 'var(--gv-danger)' : 'var(--gv-ok)',
                  boxShadow: `0 0 8px ${e.state === 'firing' ? 'var(--gv-danger)' : 'var(--gv-ok)'}`,
                }} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{e.rule_name}</div>
                  <div className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{e.message}</div>
                </div>
                <span className="text-xs tabular-nums" style={{ color: 'var(--gv-text-dim)' }}>
                  {new Date(e.triggered_at * 1000).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} onSave={save} setRule={setEditing} />}
      {presetsOpen && (
        <PresetsModal
          installed={rules}
          onClose={() => setPresetsOpen(false)}
          onInstalled={async () => { setPresetsOpen(false); await load(); }}
        />
      )}
    </div>
  );
}

interface Preset {
  id: string;
  name: string;
  metric: Metric;
  condition: Condition;
  threshold: number;
  duration_s: number;
  cooldown_s: number;
  notify_sound: 0 | 1;
}

function presetKey(p: Pick<Preset, 'metric' | 'condition' | 'threshold'>): string {
  return `${p.metric}|${p.condition}|${p.threshold}`;
}

function PresetsModal({
  installed, onClose, onInstalled,
}: Readonly<{ installed: Rule[]; onClose: () => void; onInstalled: () => void | Promise<void> }>) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Already-installed rules keyed by (metric, condition, threshold) so
  // re-opening the modal won't propose duplicates.
  const installedKeys = new Set(installed.map((r) => presetKey(r)));

  useEffect(() => {
    api<{ presets: Preset[] }>('/alerts/presets')
      .then((r) => {
        // Sort by metric category so temp / util / mem / power / fan
        // presets cluster together in the list.
        const sorted = [...r.presets].sort((a, b) => {
          const ai = METRIC_ORDER.indexOf(a.metric);
          const bi = METRIC_ORDER.indexOf(b.metric);
          if (ai !== bi) return ai - bi;
          return a.threshold - b.threshold;
        });
        setPresets(sorted);
        // Default selection: only presets not already installed.
        setSelected(new Set(sorted.filter((p) => !installedKeys.has(presetKey(p))).map((p) => p.id)));
      })
      .catch(() => setPresets([]));
    // installedKeys derives from `installed` once at open; don't refire on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const install = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await api('/alerts/presets/install', {
        method: 'POST',
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      notify('success', t('alerts.presets_installed'));
      await onInstalled();
    } catch (err) {
      notify('error', t('common.error'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="card p-5 w-full max-w-2xl space-y-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> {t('alerts.presets_title')}
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--gv-text-muted)' }}>
            {t('alerts.presets_help')}
          </p>
        </div>

        <ul className="divide-y max-h-[55vh] overflow-y-auto" style={{ borderColor: 'var(--gv-border)' }}>
          {presets.map((p) => {
            const isInstalled = installedKeys.has(presetKey(p));
            const checked = !isInstalled && selected.has(p.id);
            return (
              <li
                key={p.id}
                className="py-2.5 flex items-start gap-3"
                style={isInstalled ? { opacity: 0.5 } : undefined}
                title={isInstalled ? t('alerts.preset_already_installed') : undefined}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked}
                  disabled={isInstalled}
                  onChange={() => toggle(p.id)}
                />
                <span className="inline-flex shrink-0 mt-0.5" aria-hidden>
                  <MetricIcon metric={p.metric} className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                    <span>{p.name}</span>
                    {isInstalled && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          color: 'var(--gv-ok)',
                          background: 'color-mix(in srgb, var(--gv-ok) 14%, transparent)',
                          border: '1px solid color-mix(in srgb, var(--gv-ok) 35%, transparent)',
                        }}
                      >
                        {t('alerts.preset_already_installed')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs tabular-nums" style={{ color: 'var(--gv-text-muted)' }}>
                    {t(`alerts.metrics.${p.metric}`)} {p.condition === 'above' ? '≥' : '≤'} {p.threshold}
                    {' · '}{t('alerts.duration')} {p.duration_s}s
                    {' · '}{t('alerts.cooldown_s')} {p.cooldown_s}s
                    {p.notify_sound ? ' · 🔊' : ''}
                  </div>
                </div>
              </li>
            );
          })}
          {presets.length === 0 && (
            <li className="py-4 text-center text-sm" style={{ color: 'var(--gv-text-muted)' }}>
              {t('common.loading')}
            </li>
          )}
        </ul>

        <div className="flex justify-between items-center gap-2 pt-1">
          <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
            {t('alerts.presets_disabled_note')}
          </span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button
              type="button"
              className="btn-primary"
              onClick={install}
              disabled={busy || selected.size === 0}
            >
              <Plus className="w-4 h-4" />
              {t('alerts.presets_install', { count: selected.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleModal({
  rule, onClose, onSave, setRule,
}: {
  rule: Partial<Rule>;
  onClose: () => void;
  onSave: (e: FormEvent) => void;
  setRule: (r: Partial<Rule>) => void;
}) {
  const { t } = useTranslation();
  const update = (patch: Partial<Rule>) => setRule({ ...rule, ...patch });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={onSave} className="card p-5 w-full max-w-lg space-y-4">
        <h2 className="text-lg font-semibold">{rule.id ? t('alerts.edit_rule') : t('alerts.new_rule')}</h2>

        <div>
          <label className="label">{t('alerts.rule_name')}</label>
          <input className="input" required value={rule.name || ''} onChange={(e) => update({ name: e.target.value })} placeholder="High temperature" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t('alerts.metric')}</label>
            <select className="input" value={rule.metric} onChange={(e) => update({ metric: e.target.value as Metric })}>
              <option value="temperature">{t('alerts.metrics.temperature')}</option>
              <option value="utilization">{t('alerts.metrics.utilization')}</option>
              <option value="memory">{t('alerts.metrics.memory')}</option>
              <option value="power">{t('alerts.metrics.power')}</option>
              <option value="fan_speed">{t('alerts.metrics.fan_speed')}</option>
            </select>
          </div>
          <div>
            <label className="label">{t('alerts.condition')}</label>
            <select className="input" value={rule.condition} onChange={(e) => update({ condition: e.target.value as Condition })}>
              <option value="above">{t('alerts.above')} (≥)</option>
              <option value="below">{t('alerts.below')} (≤)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">{t('alerts.threshold')}</label>
            <input type="number" step="0.1" className="input" value={rule.threshold ?? 0} onChange={(e) => update({ threshold: Number.parseFloat(e.target.value) })} />
          </div>
          <div>
            <label className="label">{t('alerts.duration_s')}</label>
            <input type="number" min="0" className="input" value={rule.duration_s ?? 0} onChange={(e) => update({ duration_s: Number.parseInt(e.target.value, 10) })} />
          </div>
          <div>
            <label className="label">{t('alerts.cooldown_s')}</label>
            <input type="number" min="0" className="input" value={rule.cooldown_s ?? 300} onChange={(e) => update({ cooldown_s: Number.parseInt(e.target.value, 10) })} />
          </div>
        </div>

        <div>
          <label className="label">{t('alerts.gpu_filter')}</label>
          <input
            type="number" min="0"
            className="input"
            placeholder={t('alerts.all_gpus_placeholder')}
            value={rule.gpu_index ?? ''}
            onChange={(e) => update({ gpu_index: e.target.value === '' ? null : Number.parseInt(e.target.value, 10) })}
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <Toggle checked={!!rule.notify_browser} onChange={(v) => update({ notify_browser: v ? 1 : 0 })} label={t('alerts.notify_browser')} />
          <Toggle checked={!!rule.notify_sound}   onChange={(v) => update({ notify_sound: v ? 1 : 0 })}   label={t('alerts.notify_sound')} />
          <Toggle checked={!!rule.notify_webhook} onChange={(v) => update({ notify_webhook: v ? 1 : 0 })} label={t('alerts.notify_webhook')} />
          <Toggle checked={!!rule.enabled}        onChange={(v) => update({ enabled: v ? 1 : 0 })}        label={t('alerts.enabled')} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <span className="w-9 h-5 rounded-full transition-colors relative" style={{
        background: checked ? 'var(--gv-accent)' : 'var(--gv-surface-alt)',
      }}>
        <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }} />
      </span>
      <span style={{ color: 'var(--gv-text)' }}>{label}</span>
    </label>
  );
}
