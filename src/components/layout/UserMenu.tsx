import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, LogOut, UserRound } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useDropdown } from '../../lib/useDropdown';
import DropdownPanel from '../ui/DropdownPanel';

/** Header user button: opens a menu (profile, sign out) instead of signing
 *  out on the first click. Profile = Settings > General > User. */
export default function UserMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { open, setOpen, rootRef } = useDropdown();
  if (!user) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="btn-ghost inline-flex items-center gap-1.5"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title={user.username}
      >
        <UserRound className="w-4 h-4" />
        <span className="hidden sm:inline">{user.username}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <DropdownPanel align="right" label={t('auth.user_menu')}>
          <div className="px-3 py-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--gv-text-muted)' }}>
            {t('auth.signed_in_as', { user: user.username })}
            <span className="ml-1.5 uppercase tracking-wider text-[10px]" style={{ color: 'var(--gv-text-dim)' }}>
              {user.role}
            </span>
          </div>
          <button
            type="button"
            className="seg-btn text-left inline-flex items-center gap-2 whitespace-nowrap"
            onClick={() => {
              setOpen(false);
              navigate('/settings/general?section=user');
            }}
          >
            <UserRound className="w-4 h-4" /> {t('auth.profile')}
          </button>
          <button
            type="button"
            className="seg-btn text-left inline-flex items-center gap-2 whitespace-nowrap"
            style={{ color: 'var(--gv-danger)' }}
            onClick={() => {
              setOpen(false);
              logout();
            }}
          >
            <LogOut className="w-4 h-4" /> {t('auth.logout')}
          </button>
        </DropdownPanel>
      )}
    </div>
  );
}
