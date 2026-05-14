import { useState } from 'react';
import { Github, Settings, Activity } from 'lucide-react';
import { MOCK_HOSTS } from './data/mockHosts';
import FleetIndicator from './components/FleetIndicator';
import FleetView from './pages/FleetView';
import HostsSettings from './pages/HostsSettings';

type Route = 'fleet' | 'settings';

export default function App() {
  const [route, setRoute] = useState<Route>('fleet');

  return (
    <div className="min-h-screen flex flex-col">
      <PreviewBanner />

      <header
        className="sticky top-0 z-40 backdrop-blur-xl border-b"
        style={{
          background: 'color-mix(in srgb, var(--gv-bg) 70%, transparent)',
          borderColor: 'var(--gv-border)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm"
              style={{ background: 'var(--gv-accent)', color: 'var(--gv-accent-fg)' }}
            >
              G
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-bold">GpuViewR</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--gv-text-dim)' }}>
                multi-host preview
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <FleetIndicator hosts={MOCK_HOSTS} onClick={() => setRoute('fleet')} />
            <NavBtn active={route === 'fleet'} onClick={() => setRoute('fleet')} icon={<Activity size={14} />}>
              Fleet
            </NavBtn>
            <NavBtn active={route === 'settings'} onClick={() => setRoute('settings')} icon={<Settings size={14} />}>
              Hosts
            </NavBtn>
            <a
              href="https://github.com/Erreur32/GpuViewR"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs"
              style={{ color: 'var(--gv-text-muted)' }}
            >
              <Github size={14} />
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {route === 'fleet' && <FleetView onHostClick={(id) => alert(`Drill-down: /host/${id}\n\n(Stub — real drill-down shows the existing Dashboard bound to this host.)`)} />}
        {route === 'settings' && <HostsSettings />}
      </main>

      <footer
        className="border-t py-4 text-center text-xs"
        style={{ borderColor: 'var(--gv-border)', color: 'var(--gv-text-dim)' }}
      >
        Design preview · mock data · v0.3.0-preview · not connected to any backend
      </footer>
    </div>
  );
}

function NavBtn({
  children, icon, active, onClick,
}: Readonly<{ children: React.ReactNode; icon: React.ReactNode; active: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors"
      style={{
        background: active ? 'var(--gv-surface-alt)' : 'transparent',
        color: active ? 'var(--gv-text)' : 'var(--gv-text-muted)',
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function PreviewBanner() {
  return (
    <div
      className="text-center py-1.5 text-xs font-mono"
      style={{
        background: 'color-mix(in srgb, var(--gv-warn) 14%, transparent)',
        color: 'var(--gv-warn)',
        borderBottom: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
      }}
    >
      ⚠ Multi-host UI preview — mock data, no backend, design only
    </div>
  );
}
