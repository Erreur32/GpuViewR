// Persistent badge shown only in the public demo build so visitors can't
// mistake the synthetic data for a real device. Also exposes a
// Single | Fleet toggle so visitors can flip between the two demo
// modes without typing a URL.
const SHOW = (import.meta.env.VITE_DEMO as string | undefined) === '1';

function readFleet(): boolean {
  try { return localStorage.getItem('gpuviewr.demo.fleet') === '1'; } catch { return false; }
}

function switchMode(toFleet: boolean): void {
  try {
    if (toFleet) localStorage.setItem('gpuviewr.demo.fleet', '1');
    else localStorage.removeItem('gpuviewr.demo.fleet');
    // Hard reload so every store re-hydrates from the new mock backend.
    globalThis.location.assign(import.meta.env.BASE_URL || '/');
  } catch { /* ignore */ }
}

export default function DemoBanner() {
  if (!SHOW) return null;
  const fleet = readFleet();
  return (
    <div
      role="status"
      className="w-full text-center text-xs sm:text-sm font-medium px-3 py-1.5 border-b flex items-center justify-center gap-3 flex-wrap"
      style={{
        background: 'linear-gradient(90deg, rgba(245,158,11,0.18), rgba(168,85,247,0.18))',
        color: 'var(--gv-fg)',
        borderColor: 'var(--gv-border)',
      }}
    >
      <span>
        DEMO MODE — synthetic data, no real hardware.
      </span>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => !fleet || switchMode(false)}
          aria-pressed={!fleet}
          className="px-2 py-0.5 rounded text-[11px]"
          style={{
            background: fleet ? 'transparent' : 'rgba(255,255,255,0.18)',
            border: '1px solid rgba(255,255,255,0.25)',
            color: 'inherit',
          }}
        >
          Single host
        </button>
        <button
          type="button"
          onClick={() => fleet || switchMode(true)}
          aria-pressed={fleet}
          className="px-2 py-0.5 rounded text-[11px]"
          style={{
            background: fleet ? 'rgba(255,255,255,0.18)' : 'transparent',
            border: '1px solid rgba(255,255,255,0.25)',
            color: 'inherit',
          }}
        >
          Multi-host (4)
        </button>
      </span>
      <a href="https://github.com/Erreur32/GpuViewR" className="underline" target="_blank" rel="noreferrer noopener">
        github.com/Erreur32/GpuViewR
      </a>
    </div>
  );
}
