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
        const cur = series.get(s.gpu_index) ?? emptySeries();
        cur.t.push(s.timestamp_epoch);
        cur.temperature.push(s.temperature);
        cur.utilization.push(s.utilization);
        cur.memory_used.push(s.memory_used);
        cur.power.push(s.power);
        if (cur.t.length > MAX_POINTS) {
          const drop = cur.t.length - MAX_POINTS;
          cur.t.splice(0, drop);
          cur.temperature.splice(0, drop);
          cur.utilization.splice(0, drop);
          cur.memory_used.splice(0, drop);
          cur.power.splice(0, drop);
        }
        series.set(s.gpu_index, cur);
      }
      return { latest, series };
    }),

  reset: () => set({ latest: new Map(), series: new Map() }),
}));
