import { Outlet } from 'react-router-dom';
import Header from './Header';

export default function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <Outlet />
      </main>
      <footer className="text-center text-xs py-4" style={{ color: 'var(--gv-text-dim)' }}>
        GpuViewR
      </footer>
    </div>
  );
}
