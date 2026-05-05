import { Outlet } from 'react-router-dom';
import Header from './Header';
import AppFooter from './AppFooter';
import DemoBanner from './DemoBanner';
import { useGpuStream } from '../../lib/useGpuStream';

export default function AppLayout() {
  // Keep the GPU WebSocket open for the whole authenticated session so
  // history accumulates in the store even while the user is on Settings,
  // Alerts or Logs. Without this the chart shows a gap covering the
  // time spent off the dashboard.
  useGpuStream();
  return (
    <div className="min-h-screen flex flex-col">
      <DemoBanner />
      <Header />
      <main className="flex-1 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
      <AppFooter />
    </div>
  );
}
