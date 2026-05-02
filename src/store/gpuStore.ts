import { create } from 'zustand';

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
}

interface GpuState {
  connected: boolean;
  latest: Map<number, GpuSample>;
  series: Map<number, Series>;
  setConnected: (c: boolean) => void;
  ingest: (samples: GpuSample[]) => void;
  reset: () => void;
}

function emptySeries(): Series {
  return { t: [], temperature: [], utilization: [], memory_used: [], power: [] };
}

export const useGpuStore = create<GpuState>((set) => ({
  connected: false,
  latest: new Map(),
  series: new Map(),

  setConnected: (c) => set({ connected: c }),

  ingest: (samples) =>
    set((state) => {
      const latest = new Map(state.latest);
      const series = new Map(state.series);
      for (const s of samples) {
        latest.set(s.gpu_index, s);
        const prev = series.get(s.gpu_index) ?? emptySeries();
        // Immutable update: create new arrays so subscribers see a new
        // reference. Mutating in place caused the chart to miss live
        // points until the user changed the range and forced a re-render.
        const start = prev.t.length + 1 > MAX_POINTS ? prev.t.length + 1 - MAX_POINTS : 0;
        const next: Series = {
          t: prev.t.slice(start).concat(s.timestamp_epoch),
          temperature: prev.temperature.slice(start).concat(s.temperature),
          utilization: prev.utilization.slice(start).concat(s.utilization),
          memory_used: prev.memory_used.slice(start).concat(s.memory_used),
          power: prev.power.slice(start).concat(s.power),
        };
        series.set(s.gpu_index, next);
      }
      return { latest, series };
    }),

  reset: () => set({ latest: new Map(), series: new Map() }),
}));
