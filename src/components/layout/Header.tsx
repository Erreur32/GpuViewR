import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut, BellRing, FileText, Settings, LayoutDashboard, Server, FlaskConical } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { api } from '../../lib/api';

const VERSION = `v${__APP_VERSION__}`;
const IS_DEV = import.meta.env.DEV;

interface HealthInfo {
  nodeEnv?: string;
  mockGpu?: boolean;
}

export default function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const [health, setHealth] = useState<HealthInfo>({});

  useEffect(() => {
    api<HealthInfo>('/health').then(setHealth).catch(() => { /* keep silent */ });
  }, []);

  const showDev = IS_DEV || health.nodeEnv === 'development';
  const showMock = health.mockGpu === true;

  return (
    <header className="sticky top-0 z-30 border-b backdrop-blur-xl"
            style={{ borderColor: 'var(--gv-border)', background: 'color-mix(in srgb, var(--gv-bg) 70%, transparent)' }}>
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4 flex-wrap">
        <NavLink to="/" className="flex items-center gap-3 group">
          <img
            src="/GPUViewR.png"
            alt="GpuViewR"
            width={36}
            height={36}
            className="w-9 h-9 rounded-xl object-contain"
            style={{
              background: 'color-mix(in srgb, var(--gv-accent) 18%, transparent)',
              border: '1px solid color-mix(in srgb, var(--gv-accent) 35%, transparent)',
              padding: 4,
            }}
          />
          <div className="leading-tight">
            <div className="font-semibold flex items-center gap-2 flex-wrap">
              {t('app.title')}
              <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>{VERSION}</span>
              {showDev && (
                <span
                  className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                  title="Vite dev mode"
                  style={{
                    color: 'var(--gv-warn)',
                    background: 'color-mix(in srgb, var(--gv-warn) 15%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--gv-warn) 40%, transparent)',
                  }}
                >
                  DEV
                </span>
              )}
              {showMock && (
                <span
                  className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                  title="Synthetic GPU data — MOCK_GPU=1"
                  style={{
                    color: 'var(--gv-danger)',
                    background: 'color-mix(in srgb, var(--gv-danger) 15%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--gv-danger) 40%, transparent)',
                  }}
                >
                  <FlaskConical className="w-2.5 h-2.5" />
                  Fake stats
                </span>
              )}
            </div>
            <div className="text-xs hidden sm:block" style={{ color: 'var(--gv-text-muted)' }}>{t('app.subtitle')}</div>
          </div>
        </NavLink>

        <nav className="flex items-center gap-1 ml-2">
          <NavItem to="/"        icon={<LayoutDashboard className="w-4 h-4" />} label={t('nav.dashboard')} end />
          <NavItem to="/alerts"  icon={<BellRing className="w-4 h-4" />}        label={t('nav.alerts')} />
          <NavItem to="/system"  icon={<Server className="w-4 h-4" />}          label={t('nav.system')} />
          <NavItem to="/logs"    icon={<FileText className="w-4 h-4" />}        label={t('nav.logs')} />
          <NavItem to="/settings" icon={<Settings className="w-4 h-4" />}       label={t('nav.settings')} />
        </nav>

        <div className="flex items-center gap-2 ml-auto">
          {user && (
            <button className="btn-ghost" onClick={logout} title={t('auth.logout')}>
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">{user.username}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function NavItem({ to, icon, label, end }: { to: string; icon: JSX.Element; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </NavLink>
  );
}
