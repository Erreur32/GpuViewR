import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Github, Cpu, Wifi, WifiOff, Clock, Activity } from 'lucide-react';
import { useGpuStore } from '../../store/gpuStore';
import { useUiStore } from '../../store/uiStore';
import { fmtClock } from '../../lib/time';

const VERSION = `v${__APP_VERSION__}`;

export default function AppFooter() {
  const { t } = useTranslation();
  const connected = useGpuStore((s) => s.connected);
  const latest = useGpuStore((s) => s.latest);
  const timeFormat = useUiStore((s) => s.timeFormat);

  // Live clock — bumped every second so the footer reads as "alive".
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const samples = Array.from(latest.values());
  const gpuCount = samples.length;
  const aggUtil = samples.length > 0
    ? Math.round(samples.reduce((acc, s) => acc + (s.utilization ?? 0), 0) / samples.length)
    : null;
  const aggTemp = samples.length > 0
    ? Math.round(samples.reduce((acc, s) => acc + s.temperature, 0) / samples.length)
    : null;
  const aggPower = samples.length > 0
    ? Math.round(samples.reduce((acc, s) => acc + s.power, 0))
    : null;

  return (
    <footer
      className="border-t mt-6"
      style={{
        borderColor: 'var(--gv-border)',
        background: 'color-mix(in srgb, var(--gv-bg) 60%, transparent)',
      }}
    >
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3 flex-wrap text-xs">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold" style={{ color: 'var(--gv-text)' }}>GpuViewR</span>
          <span className="font-mono" style={{ color: 'var(--gv-text-dim)' }}>{VERSION}</span>
          <a
            href="https://github.com/Erreur32/GpuViewR"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:underline"
            style={{ color: 'var(--gv-text-muted)' }}
            title="GitHub"
          >
            <Github className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Erreur32/GpuViewR</span>
          </a>
        </div>

        <div className="flex items-center gap-3 flex-wrap" style={{ color: 'var(--gv-text-muted)' }}>
          <Pill
            icon={connected
              ? <Wifi className="w-3 h-3" style={{ color: 'var(--gv-ok)' }} />
              : <WifiOff className="w-3 h-3" style={{ color: 'var(--gv-warn)' }} />}
            label={connected ? t('common.connected') : t('common.disconnected')}
            color={connected ? 'var(--gv-ok)' : 'var(--gv-warn)'}
            pulse={connected}
          />

          {gpuCount > 0 && (
            <Pill
              icon={<Cpu className="w-3 h-3" />}
              label={`${gpuCount} GPU${gpuCount > 1 ? 's' : ''}`}
            />
          )}

          {aggUtil !== null && (
            <Pill
              icon={<Activity className="w-3 h-3" style={{ color: 'var(--gv-accent)' }} />}
              label={`${aggUtil}% · ${aggTemp}°C · ${aggPower}W`}
              title={t('footer.aggregate_help')}
            />
          )}

          <Pill
            icon={<Clock className="w-3 h-3" />}
            label={fmtClock(now, timeFormat)}
            mono
          />
        </div>
      </div>
    </footer>
  );
}

function Pill({
  icon, label, color, pulse, mono, title,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  color?: string;
  pulse?: boolean;
  mono?: boolean;
  title?: string;
}>) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
      title={title}
      style={{
        background: 'var(--gv-surface-alt)',
        border: '1px solid var(--gv-border)',
        color: color ?? 'var(--gv-text-muted)',
      }}
    >
      {pulse && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: color ?? 'var(--gv-ok)', boxShadow: `0 0 6px ${color ?? 'var(--gv-ok)'}` }}
        />
      )}
      {icon}
      <span className={mono ? 'font-mono tabular-nums' : ''}>{label}</span>
    </span>
  );
}
