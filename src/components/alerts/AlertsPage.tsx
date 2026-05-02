import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Bell, Volume2, VolumeX, Edit3 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { useUiStore } from '../../store/uiStore';
import { notify } from '../../store/toastStore';

type Metric = 'temperature' | 'utilization' | 'memory' | 'power' | 'fan_speed';
type Condition = 'above' | 'below';

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
            <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
              <Plus className="w-4 h-4" /> {t('alerts.new_rule')}
            </button>
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
              {rules.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--gv-border)' }}>
                  <td className="py-2 px-4">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
                      {r.gpu_index === null ? t('alerts.all_gpus') : `GPU #${r.gpu_index}`}
                    </div>
                  </td>
                  <td className="py-2 px-4 tabular-nums">
                    {t(`alerts.metrics.${r.metric}`)} {r.condition === 'above' ? '≥' : '≤'} {r.threshold}
                  </td>
                  <td className="py-2 px-4 tabular-nums">{r.duration_s}s</td>
                  <td className="py-2 px-4 flex items-center gap-2">
                    {!!r.notify_browser && <Bell className="w-3.5 h-3.5" style={{ color: 'var(--gv-info)' }} />}
                    {!!r.notify_sound && <Volume2 className="w-3.5 h-3.5" style={{ color: 'var(--gv-warn)' }} />}
                  </td>
                  <td className="py-2 px-4 text-right">
                    <div className="inline-flex items-center gap-1">
                      <label className="inline-flex items-center cursor-pointer mr-2">
                        <input
                          type="checkbox"
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
            <input type="number" step="0.1" className="input" value={rule.threshold ?? 0} onChange={(e) => update({ threshold: parseFloat(e.target.value) })} />
          </div>
          <div>
            <label className="label">{t('alerts.duration_s')}</label>
            <input type="number" min="0" className="input" value={rule.duration_s ?? 0} onChange={(e) => update({ duration_s: parseInt(e.target.value, 10) })} />
          </div>
          <div>
            <label className="label">{t('alerts.cooldown_s')}</label>
            <input type="number" min="0" className="input" value={rule.cooldown_s ?? 300} onChange={(e) => update({ cooldown_s: parseInt(e.target.value, 10) })} />
          </div>
        </div>

        <div>
          <label className="label">{t('alerts.gpu_filter')}</label>
          <input
            type="number" min="0"
            className="input"
            placeholder={t('alerts.all_gpus_placeholder')}
            value={rule.gpu_index ?? ''}
            onChange={(e) => update({ gpu_index: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <Toggle checked={!!rule.notify_browser} onChange={(v) => update({ notify_browser: v ? 1 : 0 })} label={t('alerts.notify_browser')} />
          <Toggle checked={!!rule.notify_sound}   onChange={(v) => update({ notify_sound: v ? 1 : 0 })}   label={t('alerts.notify_sound')} />
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
