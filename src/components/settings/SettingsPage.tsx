import { useTranslation } from 'react-i18next';
import { Moon, LayoutGrid, BarChart3, Languages, Clock } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { THEMES } from '../../lib/themes';
import UpdateSettings from './UpdateSettings';
import DatabaseSettings from './DatabaseSettings';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { themeId, setThemeId, gaugeView, setGaugeView, timeFormat, setTimeFormat } = useUiStore();

  const setLang = (code: string) => {
    i18n.changeLanguage(code);
    localStorage.setItem('gpuviewr.lang', code);
  };

  const dark = THEMES.filter((t) => t.mode === 'dark');
  const light = THEMES.filter((t) => t.mode === 'light');

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
        <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.subtitle')}</p>
      </header>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Moon className="w-4 h-4" /> {t('settings.theme')}
        </h2>
        <ThemeRow title={t('settings.dark_themes')} themes={dark} current={themeId} onSelect={setThemeId} />
        <ThemeRow title={t('settings.light_themes')} themes={light} current={themeId} onSelect={setThemeId} />
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><LayoutGrid className="w-4 h-4" /> {t('settings.gauge_view')}</h2>
        <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.gauge_view_help')}</p>
        <div className="seg">
          <button className="seg-btn inline-flex items-center gap-2" aria-pressed={gaugeView === 'arc'} onClick={() => setGaugeView('arc')}>
            <LayoutGrid className="w-4 h-4" /> {t('dashboard.view_arc')}
          </button>
          <button className="seg-btn inline-flex items-center gap-2" aria-pressed={gaugeView === 'bar'} onClick={() => setGaugeView('bar')}>
            <BarChart3 className="w-4 h-4" /> {t('dashboard.view_bar')}
          </button>
        </div>
      </section>

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

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold flex items-center gap-2"><Clock className="w-4 h-4" /> {t('settings.time_format')}</h2>
        <div className="seg">
          <button className="seg-btn" aria-pressed={timeFormat === '24h'} onClick={() => setTimeFormat('24h')}>24h</button>
          <button className="seg-btn" aria-pressed={timeFormat === '12h'} onClick={() => setTimeFormat('12h')}>12h (AM/PM)</button>
        </div>
      </section>

      <DatabaseSettings />

      <UpdateSettings />
    </div>
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
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {themes.map((th) => (
          <button
            key={th.id}
            onClick={() => onSelect(th.id)}
            aria-pressed={current === th.id}
            className="rounded-xl p-3 text-left transition-all border-2"
            style={{
              borderColor: current === th.id ? th.tokens.accent : 'var(--gv-border)',
              background: `linear-gradient(135deg, ${th.tokens.bg}, ${th.tokens.bg2})`,
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: th.tokens.accent, boxShadow: `0 0 6px ${th.tokens.accent}` }} />
              <span className="text-sm font-medium" style={{ color: th.mode === 'light' ? '#0f172a' : '#f1f5f9' }}>{th.label}</span>
            </div>
            <div className="flex gap-1">
              <span className="h-2 flex-1 rounded" style={{ background: th.tokens.surface, border: '1px solid rgba(255,255,255,0.05)' }} />
              <span className="h-2 w-4 rounded" style={{ background: th.tokens.accent }} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
