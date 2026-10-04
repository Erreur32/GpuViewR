import { create } from 'zustand';
import { api } from '../lib/api';
import { notify } from './toastStore';
import {
  DEFAULT_THRESHOLDS,
  readBrowserThresholds,
  type ThresholdKey,
  type ThresholdValues,
} from '../lib/thresholds';

/** Where the thresholds lived before they moved to the hub. */
const BROWSER_KEY = 'gpuviewr.chart_thresholds';
/** Inputs fire on every keystroke; save once typing pauses. */
const SAVE_DELAY_MS = 600;

interface ThresholdsDoc {
  global: ThresholdValues | null;
  gpus: Record<string, ThresholdValues>;
}

interface ThresholdsState {
  global: ThresholdValues;
  /** Per-GPU overrides, keyed by gpuKey(hostId, gpuIndex). */
  gpus: Record<string, ThresholdValues>;
  /** Fetches the hub's set. An admin's first load seeds it with the
   *  values this browser had before they were shared. */
  load: (isAdmin: boolean) => Promise<void>;
  setGlobal: (key: ThresholdKey, value: number | null) => void;
  resetGlobal: () => void;
  /** undefined = inherit the global value, null = no line. */
  setGpu: (gpu: string, key: ThresholdKey, value: number | null | undefined) => void;
  clearGpu: (gpu: string) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useThresholdsStore = create<ThresholdsState>((set, get) => {
  /** Debounced PUT of the whole document; the hub validates it again. */
  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const { global, gpus } = get();
      api<ThresholdsDoc>('/thresholds', { method: 'PUT', body: JSON.stringify({ global, gpus }) })
        .catch((err: Error) => notify('error', 'Chart thresholds', err.message));
    }, SAVE_DELAY_MS);
  }

  return {
    global: { ...DEFAULT_THRESHOLDS },
    gpus: {},

    load: async (isAdmin) => {
      let browser: string | null = null;
      try { browser = localStorage.getItem(BROWSER_KEY); } catch { /* storage disabled */ }
      const local = readBrowserThresholds(browser);
      try {
        const doc = await api<ThresholdsDoc>('/thresholds');
        set({ global: doc.global ?? local, gpus: doc.gpus });
        if (doc.global === null && isAdmin) scheduleSave();
      } catch {
        // Hub unreachable or older than this front: keep the browser's set.
        set({ global: local });
      }
    },

    setGlobal: (key, value) => {
      set({ global: { ...get().global, [key]: value } });
      scheduleSave();
    },

    resetGlobal: () => {
      set({ global: { ...DEFAULT_THRESHOLDS } });
      scheduleSave();
    },

    setGpu: (gpu, key, value) => {
      const entry: ThresholdValues = { ...get().gpus[gpu] };
      if (value === undefined) delete entry[key];
      else entry[key] = value;
      const gpus = { ...get().gpus };
      if (Object.keys(entry).length === 0) delete gpus[gpu];
      else gpus[gpu] = entry;
      set({ gpus });
      scheduleSave();
    },

    clearGpu: (gpu) => {
      const gpus = { ...get().gpus };
      delete gpus[gpu];
      set({ gpus });
      scheduleSave();
    },
  };
});
