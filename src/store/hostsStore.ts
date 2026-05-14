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

export interface HostRecord {
  id: string;
  label: string;
  hostname: string | null;
  kind: HostKind;
  endpoint: string | null;
  capabilities: string | null;
  agent_version: string | null;
  protocol_ver: number;
  enrolled_at: number;
  last_seen: number | null;
  status: HostStatus;
}

export const LOCAL_HOST_ID = 'local';
const POLL_MS = 15_000;

interface HostsState {
  hosts: HostRecord[];
  loading: boolean;
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
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  loading: false,
  error: null,
  selectedHostId: LOCAL_HOST_ID,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const r = await api<{ hosts: HostRecord[] }>('/hosts');
      set({ hosts: r.hosts, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
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

  rotateToken: async (id) => {
    const r = await api<{ token: string }>(`/hosts/${id}/rotate-token`, { method: 'POST' });
    return r.token;
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

/** Derive a displayed "effective" status that incorporates the lag
 *  window the watchdog uses internally: an agent whose last_seen is
 *  more than 15s old shows as 'lagging' even if status is still
 *  'online' (the 30 s flip lives on the server side). */
export function effectiveStatus(h: HostRecord, now = Math.floor(Date.now() / 1000)): HostStatus {
  if (h.status !== 'online') return h.status;
  if (h.kind !== 'agent') return 'online';
  if (h.last_seen === null) return 'online';
  if (now - h.last_seen > 15) return 'lagging';
  return 'online';
}

export function formatRelative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
