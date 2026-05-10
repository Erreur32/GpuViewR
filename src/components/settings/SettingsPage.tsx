import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Moon, Languages, Clock, Sliders, Share2, Database, RefreshCw, Activity, Info, Palette, RotateCcw, Volume2, VolumeX, Bell, BellOff, BellRing } from 'lucide-react';
import { useUiStore, DEFAULT_THRESHOLDS, type ChartSeriesKey } from '../../store/uiStore';
import { THEMES } from '../../lib/themes';
import UpdateSettings from './UpdateSettings';
import DatabaseSettings from './DatabaseSettings';
import ExportsSettings from './ExportsSettings';
import AboutSettings from './AboutSettings';

type TabId = 'general' | 'theme' | 'exports' | 'database' | 'updates' | 'about';

interface ChartPreset {
  id: string;
  label: string;
  colors: { util: string; temp: string; pow: string; mem: string; fan: string };
}

// Curated, well-balanced palettes. Each preset maps the 5 dashboard
// metrics (utilization / temperature / power / memory / fan) to a coherent
// color scheme that plays well with both dark and light themes and
// the gradient area fill underneath the lines.
const CHART_PRESETS: ChartPreset[] = [
  { id: 'cyber',  label: 'Cyber',    colors: { util: '#22d3ee', temp: '#f472b6', pow: '#a3e635', mem: '#a78bfa', fan: '#fbbf24' } },
  { id: 'sunset', label: 'Sunset',   colors: { util: '#fb7185', temp: '#fbbf24', pow: '#ec4899', mem: '#f97316', fan: '#22d3ee' } },
  { id: 'aurora', label: 'Aurora',   colors: { util: '#34d399', temp: '#06b6d4', pow: '#a78bfa', mem: '#f472b6', fan: '#fbbf24' } },
  { id: 'royal',  label: 'Royal',    colors: { util: '#6366f1', temp: '#a855f7', pow: '#3b82f6', mem: '#06b6d4', fan: '#14b8a6' } },
  { id: 'mono',   label: 'Graphite', colors: { util: '#9ca3af', temp: '#e5e7eb', pow: '#64748b', mem: '#475569', fan: '#94a3b8' } },
];

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const {
    themeId, setThemeId, timeFormat, setTimeFormat,
    chartThresholds, chartThresholdsEnabled,
    setChartThreshold, setChartThresholdsEnabled, resetChartThresholds,
    chartColors, setChartColor, resetChartColors,
    soundEnabled, setSoundEnabled,
  } = useUiStore();

  const applyChartPreset = (preset: ChartPreset) => {
    setChartColor('util' as ChartSeriesKey, preset.colors.util);
    setChartColor('temp' as ChartSeriesKey, preset.colors.temp);
    setChartColor('pow' as ChartSeriesKey, preset.colors.pow);
    setChartColor('mem' as ChartSeriesKey, preset.colors.mem);
    setChartColor('fan' as ChartSeriesKey, preset.colors.fan);
  };
  // The active tab is driven by the URL (/settings/<tab>) so deep-links and
  // refresh land back on the right panel. We keep the localStorage key so a
  // bare /settings hit still restores the user's last visited tab.
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab: string }>();
  const VALID_TABS: ReadonlyArray<TabId> = ['general', 'theme', 'exports', 'database', 'updates', 'about'];
  const fallback = (localStorage.getItem('gpuviewr.settingsTab') as TabId | null) ?? 'general';
  const tab: TabId = (VALID_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as TabId)
    : fallback;

  // Sync the URL when no segment is present (so a bare /settings reload keeps
  // the last visited tab) and persist the choice for the next bare visit.
  useEffect(() => {
    if (!tabParam || !(VALID_TABS as readonly string[]).includes(tabParam)) {
      navigate(`/settings/${tab}`, { replace: true });
    }
    localStorage.setItem('gpuviewr.settingsTab', tab);
  }, [tab, tabParam, navigate]);

  const selectTab = (id: TabId) => {
    localStorage.setItem('gpuviewr.settingsTab', id);
    navigate(`/settings/${id}`);
  };

  const setLang = (code: string) => {
    i18n.changeLanguage(code);
    localStorage.setItem('gpuviewr.lang', code);
  };

  const dark = THEMES.filter((t) => t.mode === 'dark');
  const light = THEMES.filter((t) => t.mode === 'light');

  const tabs: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', label: t('settings.tab_general'), icon: Sliders },
    { id: 'theme', label: t('settings.tab_custom'), icon: Palette },
    { id: 'exports', label: t('settings.tab_exports'), icon: Share2 },
    { id: 'database', label: t('settings.tab_database'), icon: Database },
    { id: 'updates', label: t('settings.tab_updates'), icon: RefreshCw },
    { id: 'about', label: t('settings.tab_about'), icon: Info },
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
        <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.subtitle')}</p>
      </header>

      <div role="tablist" aria-label={t('settings.title')} className="seg flex-wrap">
        {tabs.map((tb) => {
          const Icon = tb.icon;
          return (
            <button
              key={tb.id}
              role="tab"
              aria-selected={tab === tb.id}
              aria-pressed={tab === tb.id}
              className="seg-btn inline-flex items-center gap-2"
              onClick={() => selectTab(tb.id)}
            >
              <Icon className="w-4 h-4" /> {tb.label}
            </button>
          );
        })}
      </div>

      {tab === 'theme' && (
        <div className="space-y-6">
          <section className="card p-5 space-y-4">
            <h2 className="font-semibold flex items-center gap-2">
              <Moon className="w-4 h-4" /> {t('settings.theme')}
            </h2>
            <ThemeRow title={t('settings.dark_themes')} themes={dark} current={themeId} onSelect={setThemeId} />
            <ThemeRow title={t('settings.light_themes')} themes={light} current={themeId} onSelect={setThemeId} />
          </section>

          <section className="card p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="font-semibold flex items-center gap-2">
                <Palette className="w-4 h-4" /> {t('settings.chart_palette')}
              </h2>
              <button
                type="button"
                className="seg-btn text-xs inline-flex items-center gap-1.5"
                onClick={resetChartColors}
                title={t('settings.chart_palette_reset')}
              >
                <RotateCcw className="w-3.5 h-3.5" /> {t('settings.chart_palette_reset')}
              </button>
            </div>
            <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.chart_palette_help')}</p>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {CHART_PRESETS.map((p) => {
                const active = chartColors.util === p.colors.util
                  && chartColors.temp === p.colors.temp
                  && chartColors.pow === p.colors.pow
                  && chartColors.mem === p.colors.mem
                  && chartColors.fan === p.colors.fan;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyChartPreset(p)}
                    aria-pressed={active}
                    className="rounded-xl p-3 text-left transition-all border-2 hover:scale-[1.02]"
                    style={{
                      borderColor: active ? p.colors.util : 'var(--gv-border)',
                      background: 'var(--gv-surface-alt)',
                    }}
                  >
                    <div className="text-xs font-semibold mb-2" style={{ color: 'var(--gv-text)' }}>{p.label}</div>
                    <div
                      className="h-8 rounded-md"
                      style={{
                        background: `linear-gradient(90deg, ${p.colors.util} 0%, ${p.colors.util} 20%, ${p.colors.mem} 20%, ${p.colors.mem} 40%, ${p.colors.fan} 40%, ${p.colors.fan} 60%, ${p.colors.temp} 60%, ${p.colors.temp} 80%, ${p.colors.pow} 80%, ${p.colors.pow} 100%)`,
                        boxShadow: active ? `0 0 12px color-mix(in srgb, ${p.colors.util} 50%, transparent)` : 'none',
                      }}
                    />
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1">
              <ColorPicker
                label={t('dashboard.metrics.utilization')}
                value={chartColors.util}
                onChange={(c) => setChartColor('util' as ChartSeriesKey, c)}
                onClear={() => setChartColor('util' as ChartSeriesKey, null)}
              />
              <ColorPicker
                label={t('dashboard.metrics.memory')}
                value={chartColors.mem}
                onChange={(c) => setChartColor('mem' as ChartSeriesKey, c)}
                onClear={() => setChartColor('mem' as ChartSeriesKey, null)}
              />
              <ColorPicker
                label={t('dashboard.metrics.fan')}
                value={chartColors.fan}
                onChange={(c) => setChartColor('fan' as ChartSeriesKey, c)}
                onClear={() => setChartColor('fan' as ChartSeriesKey, null)}
              />
              <ColorPicker
                label={t('dashboard.metrics.temperature')}
                value={chartColors.temp}
                onChange={(c) => setChartColor('temp' as ChartSeriesKey, c)}
                onClear={() => setChartColor('temp' as ChartSeriesKey, null)}
              />
              <ColorPicker
                label={t('dashboard.metrics.power')}
                value={chartColors.pow}
                onChange={(c) => setChartColor('pow' as ChartSeriesKey, c)}
                onClear={() => setChartColor('pow' as ChartSeriesKey, null)}
              />
            </div>
          </section>
        </div>
      )}

      {tab === 'general' && (
        <div className="space-y-6">
          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2"><Languages className="w-4 h-4" /> {t('settings.language')}</h2>
            <div className="seg">
              {LANGUAGES.map((l) => (
                <button key={l.code} className="seg-btn" aria-pressed={i18n.language?.startsWith(l.code)} onClick={() => setLang(l.code)}>
                  {l.label}
                </button>
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
              {t('settings.lang_more_help')}
            </p>
          </section>

          <NotificationsSection
            soundEnabled={soundEnabled}
            setSoundEnabled={setSoundEnabled}
          />

          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2"><Clock className="w-4 h-4" /> {t('settings.time_format')}</h2>
            <div className="seg">
              <button className="seg-btn" aria-pressed={timeFormat === '24h'} onClick={() => setTimeFormat('24h')}>24h</button>
              <button className="seg-btn" aria-pressed={timeFormat === '12h'} onClick={() => setTimeFormat('12h')}>12h (AM/PM)</button>
            </div>
          </section>

          <section className="card p-5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4" /> {t('settings.thresholds')}
            </h2>
            <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.thresholds_help')}</p>
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={chartThresholdsEnabled}
                onChange={(e) => setChartThresholdsEnabled(e.target.checked)}
              />
              {t('settings.thresholds_enable')}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1" aria-disabled={!chartThresholdsEnabled}>
              <ThresholdField
                label={t('dashboard.metrics.utilization')}
                unit="%"
                value={chartThresholds.util}
                placeholder={DEFAULT_THRESHOLDS.util}
                disabled={!chartThresholdsEnabled}
                onChange={(v) => setChartThreshold('util' as ChartSeriesKey, v)}
                clearLabel={t('settings.thresholds_clear')}
              />
              <ThresholdField
                label={t('dashboard.metrics.memory')}
                unit="%"
                value={chartThresholds.mem}
                placeholder={DEFAULT_THRESHOLDS.mem}
                disabled={!chartThresholdsEnabled}
                onChange={(v) => setChartThreshold('mem' as ChartSeriesKey, v)}
                clearLabel={t('settings.thresholds_clear')}
              />
              <ThresholdField
                label={t('dashboard.metrics.fan')}
                unit="%"
                value={chartThresholds.fan}
                placeholder={DEFAULT_THRESHOLDS.fan}
                disabled={!chartThresholdsEnabled}
                onChange={(v) => setChartThreshold('fan' as ChartSeriesKey, v)}
                clearLabel={t('settings.thresholds_clear')}
              />
              <ThresholdField
                label={t('dashboard.metrics.temperature')}
                unit="°C"
                value={chartThresholds.temp}
                placeholder={DEFAULT_THRESHOLDS.temp}
                disabled={!chartThresholdsEnabled}
                onChange={(v) => setChartThreshold('temp' as ChartSeriesKey, v)}
                clearLabel={t('settings.thresholds_clear')}
              />
              <ThresholdField
                label={t('dashboard.metrics.power')}
                unit="W"
                value={chartThresholds.pow}
                placeholder={DEFAULT_THRESHOLDS.pow}
                disabled={!chartThresholdsEnabled}
                onChange={(v) => setChartThreshold('pow' as ChartSeriesKey, v)}
                clearLabel={t('settings.thresholds_clear')}
              />
            </div>
            <div>
              <button
                type="button"
                className="seg-btn text-xs"
                onClick={resetChartThresholds}
                disabled={!chartThresholdsEnabled}
              >
                {t('settings.thresholds_reset')}
              </button>
            </div>
          </section>
        </div>
      )}

      {tab === 'exports' && <ExportsSettings />}
      {tab === 'database' && <DatabaseSettings />}
      {tab === 'updates' && <UpdateSettings />}
      {tab === 'about' && <AboutSettings />}
    </div>
  );
}

function NotificationsSection({
  soundEnabled, setSoundEnabled,
}: Readonly<{ soundEnabled: boolean; setSoundEnabled: (v: boolean) => void }>) {
  const { t } = useTranslation();
  // The Notification API is window-scoped, so the permission state can change
  // outside React (other tab, browser settings). We poll on focus to refresh
  // the status badge without forcing a full reload.
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  });
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    const onFocus = () => setPerm(Notification.permission);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const ask = async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPerm(result);
  };

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <BellRing className="w-4 h-4" /> {t('settings.notifications')}
      </h2>
      <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {t('settings.notifications_help')}
      </p>

      <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={soundEnabled}
          onChange={(e) => setSoundEnabled(e.target.checked)}
          className="sr-only peer"
        />
        <span className="w-10 h-5 rounded-full transition-colors relative" style={{
          background: soundEnabled ? 'var(--gv-accent)' : 'var(--gv-surface-alt)',
        }}>
          <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                style={{ transform: soundEnabled ? 'translateX(20px)' : 'translateX(0)' }} />
        </span>
        {soundEnabled
          ? <span className="inline-flex items-center gap-1.5"><Volume2 className="w-4 h-4" /> {t('settings.sound_on')}</span>
          : <span className="inline-flex items-center gap-1.5"><VolumeX className="w-4 h-4" /> {t('settings.sound_off')}</span>}
      </label>

      <div className="flex items-center gap-2 flex-wrap pt-1">
        <span className="text-sm inline-flex items-center gap-1.5" style={{ color: 'var(--gv-text-muted)' }}>
          {perm === 'granted' ? <Bell className="w-4 h-4" style={{ color: 'var(--gv-ok)' }} /> : <BellOff className="w-4 h-4" />}
          {t('settings.browser_notifs')}:
        </span>
        <PermissionBadge perm={perm} />
        {perm === 'default' && (
          <button type="button" className="btn-primary text-xs" onClick={ask}>
            {t('settings.browser_notifs_enable')}
          </button>
        )}
        {perm === 'denied' && (
          <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
            {t('settings.browser_notifs_denied_help')}
          </span>
        )}
      </div>
    </section>
  );
}

function PermissionBadge({ perm }: Readonly<{ perm: NotificationPermission | 'unsupported' }>) {
  const { t } = useTranslation();
  const map: Record<typeof perm, { label: string; color: string }> = {
    granted: { label: t('settings.browser_notifs_granted'), color: 'var(--gv-ok)' },
    default: { label: t('settings.browser_notifs_default'), color: 'var(--gv-warn)' },
    denied: { label: t('settings.browser_notifs_denied'), color: 'var(--gv-danger)' },
    unsupported: { label: t('settings.browser_notifs_unsupported'), color: 'var(--gv-text-dim)' },
  };
  const info = map[perm];
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-medium"
      style={{
        color: info.color,
        background: `color-mix(in srgb, ${info.color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${info.color} 30%, transparent)`,
      }}
    >
      {info.label}
    </span>
  );
}

function ColorPicker({
  label, value, onChange, onClear,
}: Readonly<{
  label: string;
  value: string | undefined;
  onChange: (c: string) => void;
  onClear: () => void;
}>) {
  const display = value ?? '#888888';
  const isCustom = !!value;
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}>
      <div className="text-xs mb-2" style={{ color: 'var(--gv-text-muted)' }}>{label}</div>
      <div className="flex items-center gap-2">
        <label className="relative inline-flex items-center cursor-pointer">
          <span
            className="inline-block w-7 h-7 rounded-md"
            style={{
              background: display,
              boxShadow: isCustom ? `0 0 8px ${display}` : 'none',
              border: '1px solid var(--gv-border)',
            }}
          />
          <input
            type="color"
            aria-label={`${label} color`}
            className="sr-only"
            value={display}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <span className="font-mono text-[11px] tabular-nums flex-1" style={{ color: isCustom ? 'var(--gv-text)' : 'var(--gv-text-dim)' }}>
          {value ?? '—'}
        </span>
        {isCustom && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: 'var(--gv-text-dim)', background: 'transparent', border: '1px solid var(--gv-border)' }}
            title="Reset to theme default"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function ThresholdField({
  label, unit, value, placeholder, disabled, onChange, clearLabel,
}: Readonly<{
  label: string;
  unit: string;
  value: number | undefined;
  placeholder: number;
  disabled: boolean;
  onChange: (v: number | null) => void;
  clearLabel: string;
}>) {
  return (
    <label className="block text-xs space-y-1">
      <span style={{ color: 'var(--gv-text-muted)' }}>{label} ({unit})</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min="0"
          value={value ?? ''}
          placeholder={String(placeholder)}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') { onChange(null); return; }
            const n = Number(raw);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="w-full px-2 py-1 rounded"
          style={{
            background: 'var(--gv-surface-alt)',
            border: '1px solid var(--gv-border)',
            color: 'var(--gv-text)',
          }}
        />
        {value !== undefined && (
          <button
            type="button"
            aria-label={clearLabel}
            title={clearLabel}
            disabled={disabled}
            onClick={() => onChange(null)}
            className="px-2 py-1 rounded text-xs"
            style={{
              background: 'transparent',
              border: '1px solid var(--gv-border)',
              color: 'var(--gv-text-dim)',
            }}
          >
            ×
          </button>
        )}
      </span>
    </label>
  );
}

function ThemeRow({
  title, themes, current, onSelect,
}: {
  title: string;
  themes: { id: string; label: string; mode: string; tokens: { bg: string; bg2: string; accent: string; surface: string } }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'var(--gv-text-muted)' }}>{title}</div>
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {themes.map((th) => (
          <button
            key={th.id}
            onClick={() => onSelect(th.id)}
            aria-pressed={current === th.id}
            className="rounded-lg p-2 text-left transition-all border-2"
            style={{
              borderColor: current === th.id ? th.tokens.accent : 'var(--gv-border)',
              background: `linear-gradient(135deg, ${th.tokens.bg}, ${th.tokens.bg2})`,
            }}
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: th.tokens.accent, boxShadow: `0 0 4px ${th.tokens.accent}` }} />
              <span className="text-xs font-medium truncate" style={{ color: th.mode === 'light' ? '#0f172a' : '#f1f5f9' }}>{th.label}</span>
            </div>
            <div className="flex gap-1">
              <span className="h-1.5 flex-1 rounded" style={{ background: th.tokens.surface, border: '1px solid rgba(255,255,255,0.05)' }} />
              <span className="h-1.5 w-3 rounded" style={{ background: th.tokens.accent }} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
