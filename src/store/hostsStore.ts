// Hosts registry on the client side. Mirrors the hub's `hosts` table:
// list, status (online/lagging/offline), capabilities, last_seen. The
// store is hydrated on login via GET /api/hosts and kept up-to-date by
// two channels: a 15 s polling refresh (catches enrollments from
// other admins) and host_status events on the existing /ws/gpu stream
// (catches near-real-time online/offline transitions).
//
// Convention: 'local' is reserved for the hub's own nvidia-smi. The UI
// stays zero-touch for mono-host installs (the FleetIndicator and
// /fleet are hidden when there's only the 'local' host).

import { create } from 'zustand';
import { api } from '../lib/api';

export type HostKind = 'local' | 'agent' | 'prometheus';
export type HostStatus = 'pending' | 'online' | 'lagging' | 'offline' | 'disabled';
export type InstallMode = 'docker' | 'systemd' | 'windows' | 'unknown';

export interface HostRecord {
  id: string;
  label: string;
  hostname: string | null;
  kind: HostKind;
  endpoint: string | null;
  capabilities: string | null;
  agent_version: string | null;
  /** Reported by agent v0.5.3+ in its hello frame. NULL on pre-v0.5.3
   *  agents — UI treats NULL the same as 'unknown' (shows both update
   *  recipes since we can't tell which one applies). */
  install_mode: InstallMode | null;
  /** 0/1 (SQLite). When 1 + install_mode='systemd' + agent < hub, the
   *  hub pushes the new agent.mjs over the WS at hello time. Default 0
   *  (opt-in) — flipping this gives the hub binary-execute authority
   *  on the remote host, so it has to be a conscious admin decision. */
  auto_update: number;
  protocol_ver: number;
  enrolled_at: number;
  last_seen: number | null;
  status: HostStatus;
  /** Unix epoch seconds of the last time the periodic scheduler
   *  considered this host (v0.6.5+). NULL on rows that predate the
   *  scheduler or that have never been ticked. Drives the
   *  AutoUpdateToggle tooltip's "last check Xm ago" line. */
  last_update_check_at: number | null;
  /** Unix epoch seconds of the last successful agent_update push
   *  (auto or force). NULL = never pushed. */
  last_update_pushed_at: number | null;
  /** Hub version pushed at last_update_pushed_at. NULL if never. */
  last_update_pushed_version: string | null;
}

export const LOCAL_HOST_ID = 'local';
const POLL_MS = 15_000;

interface HostsState {
  hosts: HostRecord[];
  loading: boolean;
  /** Flips to true after the first refresh() completes (success OR
   *  failure). Guards UI code that decides to redirect based on
   *  hosts.length so we don't bounce away from /fleet during the
   *  brief window between mount and the first GET /api/hosts response. */
  hydrated: boolean;
  error: string | null;
  /** Drives which host the Dashboard currently visualises. Defaults
   *  to the local hub so single-host installs behave as before. */
  selectedHostId: string;

  refresh: () => Promise<void>;
  startPolling: () => () => void;
  setSelectedHost: (host_id: string) => void;
  applyStatusEvent: (host_id: string, status: HostStatus, last_seen: number | null) => void;

  /** Admin enroll → returns the one-shot token. */
  enroll: (label: string) => Promise<{ host: HostRecord; token: string }>;
  rename: (id: string, label: string) => Promise<void>;
  rotateToken: (id: string) => Promise<string>;
  remove: (id: string) => Promise<void>;
  setAutoUpdate: (id: string, enabled: boolean) => Promise<void>;
  /** Force an immediate agent update push. Bypasses auto_update +
   *  cooldown + version compare gates on the backend; only constraint
   *  remaining is install_mode='systemd' and an actively connected agent.
   *  Returns the version that was pushed. Throws on REST error so the
   *  caller can surface the message in a toast. */
  forceUpdate: (id: string) => Promise<{ version: string; size: number }>;
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  loading: false,
  hydrated: false,
  error: null,
  selectedHostId: LOCAL_HOST_ID,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const r = await api<{ hosts: HostRecord[] }>('/hosts');
      set({ hosts: r.hosts, loading: false, hydrated: true });
    } catch (err) {
      // Flip hydrated on failure too: a broken /api/hosts shouldn't trap
      // routes that gate on hosts.length in a perpetual loading state.
      set({ error: (err as Error).message, loading: false, hydrated: true });
    }
  },

  startPolling: () => {
    void get().refresh();
    const id = setInterval(() => { void get().refresh(); }, POLL_MS);
    return () => clearInterval(id);
  },

  setSelectedHost: (host_id) => set({ selectedHostId: host_id }),

  applyStatusEvent: (host_id, status, last_seen) =>
    set((state) => ({
      hosts: state.hosts.map((h) =>
        h.id === host_id ? { ...h, status, last_seen: last_seen ?? h.last_seen } : h,
      ),
    })),

  enroll: async (label) => {
    const r = await api<{ host: HostRecord; token: string }>('/hosts', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
    set((state) => ({ hosts: [...state.hosts, r.host] }));
    return r;
  },

  rename: async (id, label) => {
    const r = await api<{ host: HostRecord }>(`/hosts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    });
    set((state) => ({ hosts: state.hosts.map((h) => (h.id === id ? r.host : h)) }));
  },

  setAutoUpdate: async (id, enabled) => {
    const r = await api<{ host: HostRecord }>(`/hosts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_update: enabled }),
    });
    set((state) => ({ hosts: state.hosts.map((h) => (h.id === id ? r.host : h)) }));
  },

  rotateToken: async (id) => {
    const r = await api<{ token: string }>(`/hosts/${id}/rotate-token`, { method: 'POST' });
    return r.token;
  },

  forceUpdate: async (id) => {
    const r = await api<{ ok: true; version: string; size: number }>(
      `/hosts/${id}/force-update`,
      { method: 'POST' },
    );
    return { version: r.version, size: r.size };
  },

  remove: async (id) => {
    await api<void>(`/hosts/${id}`, { method: 'DELETE' });
    set((state) => ({
      hosts: state.hosts.filter((h) => h.id !== id),
      // Fall back to 'local' if we were viewing the host we just deleted.
      selectedHostId: state.selectedHostId === id ? LOCAL_HOST_ID : state.selectedHostId,
    }));
  },
}));

/** Convenience: true when there's exactly one host (the local hub).
 *  Used by Header / Settings to hide the multi-host UI entirely so
 *  mono-host installs see no new surface. */
export function useIsMonoHost(): boolean {
  return useHostsStore((s) => s.hosts.length <= 1);
}

// Window between "fresh" and "the watchdog will give up". The watchdog
// flips the host to 'offline' at OFFLINE_THRESHOLD_S = 30s (server/
// services/hostsWatchdog.ts), so we have to leave it strictly less.
// Earlier this was 15s and tripped on any tick-jitter > a single sample
// (TICK_MS=1000 → 16 missed samples). 25s is the new compromise: still
// distinct from offline, but tolerant of a brief WS reconnect or a
// backgrounded browser tab. Keep in sync with server/routes/health.ts.
export const LAGGING_THRESHOLD_S = 25;

/** Effective last-seen for lag computation. Combines two signals so
 *  the displayed status doesn't flicker on the 15 s /api/hosts polling
 *  cadence:
 *    - h.last_seen: authoritative but stale up to 15 s between polls.
 *    - liveLastSeen: latest sample timestamp received over the WS,
 *      pulled from gpuStore.latestByHost. Always 1-2 s fresh for any
 *      host actively streaming.
 *  Returns whichever is more recent. */
export function freshestLastSeen(h: HostRecord, liveLastSeen: number | null): number | null {
  if (h.last_seen === null && liveLastSeen === null) return null;
  return Math.max(h.last_seen ?? 0, liveLastSeen ?? 0);
}

/** Derive a displayed "effective" status that incorporates the lag
 *  window the watchdog uses internally: an agent whose last_seen is
 *  more than LAGGING_THRESHOLD_S old shows as 'lagging' even if status
 *  is still 'online' (the 30 s flip lives on the server side).
 *  Pass `liveLastSeen` from gpuStore.latestByHost to avoid the
 *  /api/hosts 15 s poll staleness — without it the status flickers
 *  green→orange→green between polls on a healthy agent. */
export function effectiveStatus(
  h: HostRecord,
  now = Math.floor(Date.now() / 1000),
  liveLastSeen: number | null = null,
): HostStatus {
  if (h.status !== 'online') return h.status;
  if (h.kind !== 'agent') return 'online';
  const seen = freshestLastSeen(h, liveLastSeen);
  if (seen === null) return 'online';
  if (now - seen > LAGGING_THRESHOLD_S) return 'lagging';
  return 'online';
}

export function formatRelative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
