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
export type InstallMode = 'docker' | 'systemd' | 'windows' | 'macos' | 'unknown';

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
  /** Admin-picked hex color (e.g. '#c026d3'), or null to fall back to
   *  the index-based palette in FleetChart.tsx. Set via Settings →
   *  Hosts' color picker (setColor below). */
  color: string | null;
}

export const LOCAL_HOST_ID = 'local';
const POLL_MS = 15_000;

export type RejectionReason = 'unknown_host' | 'bad_token' | 'disabled' | 'missing_credentials';

/** One agent WS handshake that failed authentication (bad/rotated
 *  token, unknown or deleted host_id, disabled host). Mirrors
 *  server/services/agentRejections.ts — in-memory on the hub, reset
 *  on restart. Not a substitute for gpu_metrics/alert_events history,
 *  just an operational "is something still knocking?" signal. */
export interface RejectedAttempt {
  ip: string;
  host_id: string;
  reason: RejectionReason;
  ts: number;
  /** True when this host_id logged 5+ attempts within the last 5 min. */
  flood: boolean;
}

interface HostsState {
  hosts: HostRecord[];
  loading: boolean;
  /** Flips to true after the first refresh() completes (success OR
   *  failure). Guards UI code that decides to redirect based on
   *  hosts.length so we don't bounce away from /fleet during the
   *  brief window between mount and the first GET /api/hosts response. */
  hydrated: boolean;
  error: string | null;
  /** Hub clock minus browser clock, in seconds (positive = hub ahead).
   *  Measured on every /api/hosts poll from the `now` the hub stamps in
   *  its response. Every hub-stamped epoch (last_seen) is shifted by
   *  this before being compared with Date.now() so a browser whose
   *  clock drifts never sees phantom "lagging" hosts or a wrong
   *  "il y a Xs". 0 until the first poll completes. */
  clockOffsetS: number;
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
  /** Sets this host's fixed identity color (Settings → Hosts' color
   *  picker), or clears it back to the index-based palette when
   *  `color` is null. */
  setColor: (id: string, color: string | null) => Promise<void>;
  /** Toggles whether the hub accepts this agent's WS connections at all.
   *  Setting `enabled=false` also force-closes any currently-live socket
   *  server-side (see disconnectAgent in agentIngestWS.ts) so the cutoff
   *  is immediate rather than waiting for the agent's own reconnect. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Force an immediate agent update push. Bypasses auto_update +
   *  cooldown + version compare gates on the backend; only constraint
   *  remaining is install_mode='systemd' and an actively connected agent.
   *  Returns the version that was pushed. Throws on REST error so the
   *  caller can surface the message in a toast. */
  forceUpdate: (id: string) => Promise<{ version: string; size: number }>;

  /** Rejected agent WS handshakes, freshest first. Fetched on-demand
   *  by the Settings → Hosts panel (not part of the 15s host poll —
   *  irrelevant to every other screen). */
  rejectedAttempts: RejectedAttempt[];
  fetchRejectedAttempts: () => Promise<void>;
  clearRejectedAttempts: () => Promise<void>;
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  loading: false,
  hydrated: false,
  error: null,
  clockOffsetS: 0,
  selectedHostId: LOCAL_HOST_ID,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const r = await api<{ hosts: HostRecord[]; now?: number }>('/hosts');
      // `now` is absent on a pre-v0.8.23 hub (or the demo mock): keep
      // whatever offset we had rather than snapping back to 0.
      const clockOffsetS = typeof r.now === 'number'
        ? r.now - Math.floor(Date.now() / 1000)
        : get().clockOffsetS;
      set({ hosts: r.hosts, clockOffsetS, loading: false, hydrated: true });
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

  setColor: async (id, color) => {
    const r = await api<{ host: HostRecord }>(`/hosts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ color }),
    });
    set((state) => ({ hosts: state.hosts.map((h) => (h.id === id ? r.host : h)) }));
  },

  setEnabled: async (id, enabled) => {
    const r = await api<{ host: HostRecord }>(`/hosts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: enabled ? 'offline' : 'disabled' }),
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

  rejectedAttempts: [],

  fetchRejectedAttempts: async () => {
    const r = await api<{ attempts: RejectedAttempt[] }>('/hosts/rejected');
    set({ rejectedAttempts: r.attempts });
  },

  clearRejectedAttempts: async () => {
    await api<void>('/hosts/rejected', { method: 'DELETE' });
    set({ rejectedAttempts: [] });
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

/** Effective last-seen for lag computation, expressed in the BROWSER
 *  clock. Combines two signals so the displayed status doesn't flicker
 *  on the 15 s /api/hosts polling cadence:
 *    - h.last_seen: authoritative but stale up to 15 s between polls,
 *      and stamped by the hub's clock, hence shifted by clockOffsetS.
 *    - liveLastSeen: browser-clock time of the last WS frame for this
 *      host (gpuStore.receivedAtByHost). Always 1-2 s fresh for any
 *      host actively streaming, and skew-free by construction.
 *  Returns whichever is more recent. */
export function freshestLastSeen(
  h: HostRecord,
  liveLastSeen: number | null,
  clockOffsetS = 0,
): number | null {
  if (h.last_seen === null && liveLastSeen === null) return null;
  const polled = h.last_seen === null ? 0 : h.last_seen - clockOffsetS;
  return Math.max(polled, liveLastSeen ?? 0);
}

/** Derive a displayed "effective" status that incorporates the lag
 *  window the watchdog uses internally: an agent whose last_seen is
 *  more than LAGGING_THRESHOLD_S old shows as 'lagging' even if status
 *  is still 'online' (the 30 s flip lives on the server side).
 *  `now` and `liveLastSeen` are browser-clock epochs; `clockOffsetS`
 *  (hostsStore) converts the hub-stamped h.last_seen into the same
 *  reference. Without that conversion a browser running ~24 s ahead of
 *  its hub sat right on the 25 s threshold and flickered "lagging" at
 *  random on every render, the bug chased from v0.8.16 to v0.8.22. */
export function effectiveStatus(
  h: HostRecord,
  now = Math.floor(Date.now() / 1000),
  liveLastSeen: number | null = null,
  clockOffsetS = 0,
): HostStatus {
  if (h.status !== 'online') return h.status;
  if (h.kind !== 'agent') return 'online';
  const seen = freshestLastSeen(h, liveLastSeen, clockOffsetS);
  if (seen === null) return 'online';
  return now - seen > LAGGING_THRESHOLD_S ? 'lagging' : 'online';
}

/** Above this the Settings → Hosts tab shows a "fix your clock" banner.
 *  Statuses are already corrected by clockOffsetS; the banner is there
 *  so a drifting workstation gets noticed instead of silently masked. */
export const CLOCK_SKEW_WARN_S = 5;

export function formatRelative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
