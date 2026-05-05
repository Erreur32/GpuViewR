// Persistent badge shown only in the public demo build so visitors can't
// mistake the synthetic data for a real device.
const SHOW = (import.meta.env.VITE_DEMO as string | undefined) === '1';

export default function DemoBanner() {
  if (!SHOW) return null;
  return (
    <div
      role="status"
      className="w-full text-center text-xs sm:text-sm font-medium px-3 py-1.5 border-b"
      style={{
        background: 'linear-gradient(90deg, rgba(245,158,11,0.18), rgba(168,85,247,0.18))',
        color: 'var(--gv-fg)',
        borderColor: 'var(--gv-border)',
      }}
    >
      DEMO MODE — synthetic data, no real hardware. Source:{' '}
      <a href="https://github.com/Erreur32/GpuViewR" className="underline" target="_blank" rel="noreferrer noopener">
        github.com/Erreur32/GpuViewR
      </a>
    </div>
  );
}
