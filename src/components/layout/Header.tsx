import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Cpu, LogOut, BellRing, FileText, Settings, LayoutDashboard, Server } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';

const VERSION = 'v0.1.10';

export default function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();

  return (
    <header className="sticky top-0 z-30 border-b backdrop-blur-xl"
            style={{ borderColor: 'var(--gv-border)', background: 'color-mix(in srgb, var(--gv-bg) 70%, transparent)' }}>
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-4 flex-wrap">
        <NavLink to="/" className="flex items-center gap-3 group">
          <div className="grid place-items-center w-9 h-9 rounded-xl" style={{
            background: 'color-mix(in srgb, var(--gv-accent) 18%, transparent)',
            border: '1px solid color-mix(in srgb, var(--gv-accent) 35%, transparent)',
          }}>
            <Cpu className="w-5 h-5" style={{ color: 'var(--gv-accent)' }} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold flex items-center gap-2">
              {t('app.title')}
              <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>{VERSION}</span>
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
