import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { useUiStore } from './store/uiStore';
import { useHostsStore } from './store/hostsStore';
import LoginPage from './components/login/LoginPage';
import Dashboard from './components/dashboard/Dashboard';
import AlertsPage from './components/alerts/AlertsPage';
import LogsPage from './components/logs/LogsPage';
import SettingsPage from './components/settings/SettingsPage';
import SystemPage from './components/system/SystemPage';
import FleetPage from './components/fleet/FleetPage';
import AppLayout from './components/layout/AppLayout';
import Toaster from './components/ui/Toaster';

export default function App() {
  const { token, hydrate, fetchStatus } = useAuthStore();
  const hydrateUi = useUiStore((s) => s.hydrate);
  const startHostsPolling = useHostsStore((s) => s.startPolling);
  const location = useLocation();

  useEffect(() => {
    hydrateUi();
    hydrate();
    fetchStatus();
  }, [hydrateUi, hydrate, fetchStatus]);

  // Start the /api/hosts polling once the user is authenticated. The
  // initial fetch arrives within ~15 ms; subsequent refreshes pick up
  // enrollments made by another admin in another tab. Cleared on logout.
  useEffect(() => {
    if (!token) return;
    return startHostsPolling();
  }, [token, startHostsPolling]);

  return (
    <>
      <Routes>
        {/* Restore the original URL after login: when an unauthenticated
            user lands on /fleet, the protected branch below replaces to
            /login with state.from = current location; after the token is
            set, we read it back so the user lands on /fleet, not /. */}
        <Route
          path="/login"
          element={
            token ? (
              <Navigate
                to={
                  (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/'
                }
                replace
              />
            ) : (
              <LoginPage />
            )
          }
        />
        <Route
          element={
            token ? (
              <AppLayout />
            ) : (
              <Navigate to="/login" replace state={{ from: location }} />
            )
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/host/:hostId" element={<Dashboard />} />
          <Route path="/fleet" element={<FleetPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}
