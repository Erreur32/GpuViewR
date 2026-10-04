import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { useUiStore } from './store/uiStore';
import { useHostsStore } from './store/hostsStore';
import { useThresholdsStore } from './store/thresholdsStore';
import LoginPage from './components/login/LoginPage';
import Dashboard from './components/dashboard/Dashboard';
import AlertsPage from './components/alerts/AlertsPage';
import SettingsPage from './components/settings/SettingsPage';
import SystemPage from './components/system/SystemPage';
import FleetPage from './components/fleet/FleetPage';
import AppLayout from './components/layout/AppLayout';
import Toaster from './components/ui/Toaster';

export default function App() {
  const { token, hydrate, fetchStatus } = useAuthStore();
  const hydrateUi = useUiStore((s) => s.hydrate);
  const startHostsPolling = useHostsStore((s) => s.startPolling);
  const loadThresholds = useThresholdsStore((s) => s.load);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
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

  // Chart threshold lines are shared through the hub since v0.11.5.
  useEffect(() => {
    if (token) void loadThresholds(isAdmin);
  }, [token, isAdmin, loadThresholds]);

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
          {/* Logs moved under Settings; keep old bookmarks working. */}
          <Route path="/logs" element={<Navigate to="/settings/logs" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}
