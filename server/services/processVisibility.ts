// Process visibility: what the agent could not see, and whether the
// UI should warn about it. Pure functions, shared by the WS ingest
// (validation) and the /api/processes route (warning decision).

import type { GpuProcess, ProcessVisibility } from './_processTypes.js';
import type { GpuSample } from './parsers/nvidia.js';

const INSTALL_MODES = new Set(['docker', 'systemd', 'windows', 'macos', 'unknown']);

/** Keep only well-typed fields of the agent's visibility block; it is
 *  echoed to the UI, so nothing else from the frame gets through. */
export function parseVisibility(raw: unknown): ProcessVisibility | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const denied = typeof v.denied_pids === 'number' && Number.isFinite(v.denied_pids) && v.denied_pids > 0
    ? Math.floor(v.denied_pids)
    : 0;
  const pidIsolated = v.pid_isolated === true;
  if (denied === 0 && !pidIsolated) return null;
  return {
    denied_pids: denied,
    has_ptrace: v.has_ptrace === true,
    install_mode: typeof v.install_mode === 'string' && INSTALL_MODES.has(v.install_mode) ? v.install_mode : 'unknown',
    ...(pidIsolated ? { pid_isolated: true } : {}),
  };
}

/** VRAM in use that no listed process accounts for, above which the
 *  denied pids likely include a real GPU client (driver/firmware
 *  reservations and desktop compositors stay well under this). */
const HIDDEN_VRAM_MIN_MIB = 1024;

/** Warn only when the agent could not see some pids (denied, or hidden
 *  by its own pid namespace) AND the card has VRAM in use that the
 *  listed processes don't explain. Either alone is the norm: a Docker
 *  agent can't read host processes, and drivers up to 550 still list
 *  other containers' GPU processes to an isolated agent. */
export function hiddenProcesses(
  visibility: ProcessVisibility,
  samples: GpuSample[],
  listed: GpuProcess[],
  gpuIdx: number | null,
): (ProcessVisibility & { unaccounted_mib: number }) | null {
  const cards = gpuIdx === null ? samples : samples.filter((s) => s.gpu_index === gpuIdx);
  if (cards.length === 0) return null;
  const used = cards.reduce((sum, s) => sum + (Number.isFinite(s.memory_used) ? s.memory_used : 0), 0);
  const accounted = listed.reduce((sum, p) => sum + p.used_memory, 0);
  const unaccounted = Math.round(used - accounted);
  return unaccounted >= HIDDEN_VRAM_MIN_MIB ? { ...visibility, unaccounted_mib: unaccounted } : null;
}
