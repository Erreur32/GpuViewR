import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn, UserPlus, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';

export default function LoginPage() {
  const { t } = useTranslation();
  const { login, register, hasUsers, error, loading } = useAuthStore();

  const isRegister = !hasUsers;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // ?expired=1 lands here when api.ts auto-logs-out on a 401 (stale
  // JWT after a hub reset, secret rotation, etc.). Show a banner so
  // the user doesn't think it's a random bug.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    if (params.get('expired') === '1') {
      setSessionExpired(true);
      // Clean the query string from the URL bar — pure cosmetic, so
      // a future reload of /login doesn't keep the banner.
      const url = new URL(globalThis.location.href);
      url.searchParams.delete('expired');
      globalThis.history.replaceState({}, '', url.toString());
    }
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (isRegister) await register(username, password);
      else await login(username, password);
    } catch {
      // error stored in zustand
    }
  };

  return (
    <div className="min-h-screen w-full grid place-items-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 mb-8">
          <img
            src={`${import.meta.env.BASE_URL}GPUViewR.png`}
            alt="GpuViewR"
            width={72}
            height={72}
            className="w-18 h-18 rounded-2xl object-contain"
            style={{
              width: 72,
              height: 72,
              background: 'color-mix(in srgb, var(--gv-accent) 18%, transparent)',
              border: '1px solid color-mix(in srgb, var(--gv-accent) 35%, transparent)',
              padding: 6,
            }}
          />
          <h1 className="text-3xl font-bold tracking-tight">{t('app.title')}</h1>
          <p className="text-sm text-slate-400">{t('app.subtitle')}</p>
        </div>

        <form onSubmit={onSubmit} className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            {isRegister ? <UserPlus className="w-5 h-5" /> : <LogIn className="w-5 h-5" />}
            {isRegister ? t('auth.register') : t('auth.login')}
          </h2>

          <div>
            <label className="label">{t('auth.username')}</label>
            <input
              autoFocus
              autoComplete="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="label">{t('auth.password')}</label>
            <input
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isRegister ? 8 : undefined}
            />
          </div>

          {sessionExpired && !error && (
            <div
              className="text-sm flex items-start gap-2 rounded-lg px-3 py-2"
              style={{
                color: 'var(--gv-warn)',
                background: 'color-mix(in srgb, var(--gv-warn) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--gv-warn) 30%, transparent)',
              }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{t('auth.session_expired')}</span>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {isRegister && (
            <p className="text-xs text-slate-400">{t('auth.first_user_hint')}</p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={loading}>
            {loading ? t('common.loading') : isRegister ? t('auth.submit_register') : t('auth.submit_login')}
          </button>
        </form>
      </div>
    </div>
  );
}
