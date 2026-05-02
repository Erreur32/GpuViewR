import { create } from 'zustand';
import { api } from '../lib/api';

export interface UpdateResult {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  dockerReady: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  checkedAt: string;
  message: string;
  fromCache: boolean;
  error?: string;
}

export interface UpdateConfig {
  enabled: boolean;
  frequencyHours: number;
}

interface UpdateState {
  result: UpdateResult | null;
  config: UpdateConfig | null;
  loading: boolean;
  dismissed: string | null;
  bannerEnabled: boolean;

  check: (force?: boolean) => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: (patch: Partial<UpdateConfig>) => Promise<void>;
  dismiss: (version: string) => void;
  isDismissed: (version: string) => boolean;
  setBannerEnabled: (v: boolean) => void;
  hydrate: () => void;
}

const DISMISS_KEY = 'gpuviewr.update_dismissed';
const BANNER_KEY = 'gpuviewr.update_banner_enabled';

export const useUpdateStore = create<UpdateState>((set, get) => ({
  result: null,
  config: null,
  loading: false,
  dismissed: null,
  bannerEnabled: true,

  check: async (force = false) => {
    set({ loading: true });
    try {
      const r = await api<{ result: UpdateResult }>(`/updates/check${force ? '?force=true' : ''}`);
      set({ result: r.result });
    } catch {
      // Ignore: UI surfaces nothing rather than scaring the user with a transient failure.
    } finally {
      set({ loading: false });
    }
  },

  loadConfig: async () => {
    try {
      const r = await api<{ config: UpdateConfig }>('/updates/config');
      set({ config: r.config });
    } catch { /* ignore */ }
  },

  saveConfig: async (patch) => {
    const r = await api<{ config: UpdateConfig }>('/updates/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    set({ config: r.config });
  },

  dismiss: (version) => {
    localStorage.setItem(DISMISS_KEY, version);
    set({ dismissed: version });
  },

  isDismissed: (version) => get().dismissed === version,

  setBannerEnabled: (v) => {
    localStorage.setItem(BANNER_KEY, v ? '1' : '0');
    set({ bannerEnabled: v });
  },

  hydrate: () => {
    const d = localStorage.getItem(DISMISS_KEY);
    if (d) set({ dismissed: d });
    const b = localStorage.getItem(BANNER_KEY);
    if (b !== null) set({ bannerEnabled: b === '1' });
  },
}));
