import { create } from 'zustand';
import { LOCAL_HOST_ID, useHostsStore } from './hostsStore';

export interface GpuSample {
  gpu_index: number;
  name: string;
  uuid: string | null;
  driver_version: string | null;
  temperature: number;
  utilization: number | null;
  memory_used: number;
  memory_total: number | null;
  power: number;
  fan_speed: number | null;
  clock_graphics: number | null;
  clock_memory: number | null;
  pci_bus_id?: string | null;
  pcie_gen_current?: number | null;
  pcie_gen_max?: number | null;
  pcie_width_current?: number | null;
  pcie_width_max?: number | null;
  pcie_rx_kbps?: number | null;
  pcie_tx_kbps?: number | null;
  timestamp: string;
  timestamp_epoch: number;
}

const MAX_POINTS = 600; // ~10 minutes at 1Hz

interface Series {
  t: number[];
  temperature: number[];
  utilization: (number | null)[];
  memory_used: number[];
  power: number[];
  fan_speed: (number | null)[];
}

export interface HistoryRow {
  timestamp_epoch: number;
  temperature: number;
  utilization: number | null;
  memory_used: number;
  memory_total: number | null;
  power: number;
  fan_speed: number | null;
}

interface HistoryEntry {
  rows: HistoryRow[];
  fetchedAt: number;
}

interface GpuState {
  connected: boolean;

  // ── Public, host-scoped projections ────────────────────────────────
  // These are kept in sync with the currently selected host (via
  // hostsStore.selectedHostId) so every existing consumer keeps
  // working without knowing about multi-host. When the user switches
  // host, the projection swaps to the new bucket — the Dashboard
  // re-renders with the new host's GPUs.
  latest: Map<number, GpuSample>;
  series: Map<number, Series>;
  // History cache keys are now namespaced by host_id internally so
  // switching hosts doesn't reuse the wrong rows; the public
  // shape of `history.get(\`${gpuIndex}|${range}\`)` is preserved for
  // backward compat with LiveChart.
  history: Map<string, HistoryEntry>;

  // ── Internal per-host storage ──────────────────────────────────────
  latestByHost: Map<string, Map<number, GpuSample>>;
  seriesByHost: Map<string, Map<number, Series>>;
  historyByHost: Map<string, Map<string, HistoryEntry>>;

  setConnected: (c: boolean) => void;
  /** Bus-side ingest: host_id is the authoritative source from the
   *  WS payload. Mono-host streams default to 'local'. */
  ingest: (host_id: string, samples: GpuSample[]) => void;
  setHistory: (host_id: string, gpuIndex: number, range: string, rows: HistoryRow[]) => void;
  getHistory: (host_id: string, gpuIndex: number, range: string) => HistoryRow[] | null;
  /** Recompute the public projections for the new selected host. Called
   *  by hostsStore via a subscription wired up in main.tsx. */
  projectForHost: (host_id: string) => void;
  reset: () => void;
}

function emptySeries(): Series {
  return { t: [], temperature: [], utilization: [], memory_used: [], power: [], fan_speed: [] };
}

function appendSample(prev: Series, s: GpuSample): Series {
  const start = prev.t.length + 1 > MAX_POINTS ? prev.t.length + 1 - MAX_POINTS : 0;
  return {
    t: prev.t.slice(start).concat(s.timestamp_epoch),
    temperature: prev.temperature.slice(start).concat(s.temperature),
    utilization: prev.utilization.slice(start).concat(s.utilization),
    memory_used: prev.memory_used.slice(start).concat(s.memory_used),
    power: prev.power.slice(start).concat(s.power),
    fan_speed: prev.fan_speed.slice(start).concat(s.fan_speed),
  };
}

export const useGpuStore = create<GpuState>((set, get) => ({
  connected: false,
  latest: new Map(),
  series: new Map(),
  history: new Map(),
  latestByHost: new Map(),
  seriesByHost: new Map(),
  historyByHost: new Map(),

  setConnected: (c) => set({ connected: c }),

  setHistory: (host_id, gpuIndex, range, rows) =>
    set((state) => {
      const next = new Map(state.historyByHost);
      const inner = new Map(next.get(host_id) ?? new Map());
      inner.set(`${gpuIndex}|${range}`, { rows, fetchedAt: Date.now() });
      next.set(host_id, inner);
      // Project to the public `history` map if the entry belongs to
      // the currently selected host.
      const selected = useHostsStore.getState().selectedHostId;
      if (host_id === selected) {
        return { historyByHost: next, history: inner };
      }
      return { historyByHost: next };
    }),

  getHistory: (host_id, gpuIndex, range) => {
    const inner = get().historyByHost.get(host_id);
    const entry = inner?.get(`${gpuIndex}|${range}`);
    return entry ? entry.rows : null;
  },

  ingest: (host_id, samples) =>
    set((state) => {
      const nextLatestByHost = new Map(state.latestByHost);
      const nextSeriesByHost = new Map(state.seriesByHost);
      const latestForHost = new Map(nextLatestByHost.get(host_id) ?? new Map<number, GpuSample>());
      const seriesForHost = new Map(nextSeriesByHost.get(host_id) ?? new Map<number, Series>());

      for (const s of samples) {
        latestForHost.set(s.gpu_index, s);
        const prev = seriesForHost.get(s.gpu_index) ?? emptySeries();
        seriesForHost.set(s.gpu_index, appendSample(prev, s));
      }
      nextLatestByHost.set(host_id, latestForHost);
      nextSeriesByHost.set(host_id, seriesForHost);

      const selected = useHostsStore.getState().selectedHostId;
      // Only touch the public projection if the new data belongs to
      // the host the user is currently watching. Other hosts' samples
      // stay buffered internally and surface on host switch.
      if (host_id === selected) {
        return {
          latestByHost: nextLatestByHost,
          seriesByHost: nextSeriesByHost,
          latest: latestForHost,
          series: seriesForHost,
        };
      }
      return { latestByHost: nextLatestByHost, seriesByHost: nextSeriesByHost };
    }),

  projectForHost: (host_id) =>
    set((state) => ({
      latest: state.latestByHost.get(host_id) ?? new Map(),
      series: state.seriesByHost.get(host_id) ?? new Map(),
      history: state.historyByHost.get(host_id) ?? new Map(),
    })),

  reset: () => set({
    latest: new Map(),
    series: new Map(),
    history: new Map(),
    latestByHost: new Map(),
    seriesByHost: new Map(),
    historyByHost: new Map(),
  }),
}));

// Wire: when the user changes the selected host, re-project the public
// fields so every existing component (Dashboard, LiveChart, AllGpusGrid,
// MultiGpuChart, StatsSection, AppFooter) sees the new host's GPUs
// without needing per-component awareness.
useHostsStore.subscribe((state, prev) => {
  if (state.selectedHostId !== prev.selectedHostId) {
    useGpuStore.getState().projectForHost(state.selectedHostId);
  }
});

// Backward-compat helper for code paths that still call the old
// (gpuIndex, range) signature. Resolves to the currently selected host.
export function currentHostId(): string {
  return useHostsStore.getState().selectedHostId || LOCAL_HOST_ID;
}
