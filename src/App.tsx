import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { useUiStore } from './store/uiStore';
import LoginPage from './components/login/LoginPage';
import Dashboard from './components/dashboard/Dashboard';
import AlertsPage from './components/alerts/AlertsPage';
import LogsPage from './components/logs/LogsPage';
import SettingsPage from './components/settings/SettingsPage';
import SystemPage from './components/system/SystemPage';
import AppLayout from './components/layout/AppLayout';
import Toaster from './components/ui/Toaster';

export default function App() {
  const { token, hydrate, fetchStatus } = useAuthStore();
  const hydrateUi = useUiStore((s) => s.hydrate);
  const location = useLocation();

  useEffect(() => {
    hydrateUi();
    hydrate();
    fetchStatus();
  }, [hydrateUi, hydrate, fetchStatus]);

  return (
    <>
      <Routes>
        <Route path="/login" element={token ? <Navigate to="/" replace /> : <LoginPage />} />
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
