import { create } from 'zustand';
import { applyTheme, getTheme } from '../lib/themes';

export type GaugeView = 'arc' | 'bar';
export type Range = '5m' | '15m' | '1h' | '6h' | '24h' | '3d';

interface UiState {
  themeId: string;
  gaugeView: GaugeView;
  range: Range;
  selectedGpu: number;
  soundEnabled: boolean;

  setThemeId: (id: string) => void;
  setGaugeView: (v: GaugeView) => void;
  setRange: (r: Range) => void;
  setSelectedGpu: (i: number) => void;
  setSoundEnabled: (v: boolean) => void;

  hydrate: () => void;
}

const KEYS = {
  theme: 'gpuviewr.theme',
  view: 'gpuviewr.gauge_view',
  range: 'gpuviewr.range',
  sound: 'gpuviewr.sound',
};

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export const useUiStore = create<UiState>((set) => ({
  themeId: 'midnight',
  gaugeView: 'arc',
  range: '1h',
  selectedGpu: 0,
  soundEnabled: false,

  setThemeId: (id) => {
    const t = getTheme(id);
    applyTheme(t.id);
    localStorage.setItem(KEYS.theme, t.id);
    set({ themeId: t.id });
  },
  setGaugeView: (v) => {
    localStorage.setItem(KEYS.view, v);
    set({ gaugeView: v });
  },
  setRange: (r) => {
    localStorage.setItem(KEYS.range, r);
    set({ range: r });
  },
  setSelectedGpu: (i) => set({ selectedGpu: i }),
  setSoundEnabled: (v) => {
    localStorage.setItem(KEYS.sound, v ? '1' : '0');
    set({ soundEnabled: v });
  },

  hydrate: () => {
    const themeId = readLS(KEYS.theme, 'midnight');
    const gaugeView = (readLS(KEYS.view, 'arc') as GaugeView) || 'arc';
    const range = (readLS(KEYS.range, '1h') as Range) || '1h';
    const sound = readLS(KEYS.sound, '0') === '1';
    applyTheme(themeId);
    set({ themeId, gaugeView, range, soundEnabled: sound });
  },
}));
