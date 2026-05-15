// Per-host store for GPU-process snapshots received from remote
// agents. Kept entirely in-memory: process lists change every second
// or two and have no historical value, so DB roundtrips would only
// add latency. An offline host's snapshot ages out via TTL_MS so the
// UI doesn't keep showing a frozen list after the agent disappears.
//
// Hub-local processes live in processCollector.ts and bypass this
// store entirely (the route reads them directly).

import type { GpuProcess } from './processCollector.js';

export interface RemoteProcessSnapshot {
  /** Wall-clock epoch (seconds) the snapshot landed at the hub. */
  ts: number;
  processes: GpuProcess[];
}

// Treat a snapshot older than 30s as stale and return empty. Agents
// emit at the same tick rate as samples (1 Hz by default), so this is
// generous — a real outage shows up as a stale list within seconds.
const TTL_MS = 30_000;

const snapshots = new Map<string, RemoteProcessSnapshot>();

export const agentProcessStore = {
  /** Replace the snapshot for `hostId`. Empty list is fine — it clears the table. */
  set(hostId: string, snap: RemoteProcessSnapshot): void {
    snapshots.set(hostId, snap);
  },

  /** Fresh snapshot for `hostId`, or null if missing or older than TTL_MS. */
  get(hostId: string): RemoteProcessSnapshot | null {
    const snap = snapshots.get(hostId);
    if (!snap) return null;
    if (Date.now() - snap.ts * 1000 > TTL_MS) return null;
    return snap;
  },

  /** Drop a host's snapshot, e.g. when a host record is deleted. */
  delete(hostId: string): void {
    snapshots.delete(hostId);
  },

  /** Test-only accessor; exposes the raw map for unit tests. */
  _all(): ReadonlyMap<string, RemoteProcessSnapshot> {
    return snapshots;
  },

  TTL_MS,
};
