import { create } from 'zustand';
import { applyTheme, getTheme } from '../lib/themes';

export type GaugeView = 'arc' | 'bar';
export type Range = '1m' | '2m' | '5m' | '15m' | '1h' | '6h' | '24h' | '3d';
export type ChartSeriesKey = 'util' | 'temp' | 'pow';
export type ChartColors = Partial<Record<ChartSeriesKey, string>>;
export type TimeFormat = '24h' | '12h';

interface UiState {
  themeId: string;
  gaugeView: GaugeView;
  range: Range;
  selectedGpu: number;
  soundEnabled: boolean;
  chartColors: ChartColors;
  timeFormat: TimeFormat;

  setThemeId: (id: string) => void;
  setGaugeView: (v: GaugeView) => void;
  setRange: (r: Range) => void;
  setSelectedGpu: (i: number) => void;
  setSoundEnabled: (v: boolean) => void;
  setChartColor: (key: ChartSeriesKey, color: string | null) => void;
  resetChartColors: () => void;
  setTimeFormat: (f: TimeFormat) => void;

  hydrate: () => void;
}

const KEYS = {
  theme: 'gpuviewr.theme',
  view: 'gpuviewr.gauge_view',
  range: 'gpuviewr.range',
  sound: 'gpuviewr.sound',
  chartColors: 'gpuviewr.chart_colors',
  timeFormat: 'gpuviewr.time_format',
};

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function readChartColors(): ChartColors {
  try {
    const raw = localStorage.getItem(KEYS.chartColors);
    if (!raw) return {};
    const obj = JSON.parse(raw) as ChartColors;
    return typeof obj === 'object' && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  themeId: 'midnight',
  gaugeView: 'arc',
  range: '1h',
  selectedGpu: 0,
  soundEnabled: false,
  chartColors: {},
  timeFormat: '24h',

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
  setChartColor: (key, color) => {
    const next = { ...get().chartColors };
    if (color === null) delete next[key];
    else next[key] = color;
    localStorage.setItem(KEYS.chartColors, JSON.stringify(next));
    set({ chartColors: next });
  },
  resetChartColors: () => {
    localStorage.removeItem(KEYS.chartColors);
    set({ chartColors: {} });
  },
  setTimeFormat: (f) => {
    localStorage.setItem(KEYS.timeFormat, f);
    set({ timeFormat: f });
  },

  hydrate: () => {
    const themeId = readLS(KEYS.theme, 'midnight');
    const gaugeView = (readLS(KEYS.view, 'arc') as GaugeView) || 'arc';
    const range = (readLS(KEYS.range, '1h') as Range) || '1h';
    const sound = readLS(KEYS.sound, '0') === '1';
    const chartColors = readChartColors();
    const timeFormat = (readLS(KEYS.timeFormat, '24h') as TimeFormat) || '24h';
    applyTheme(themeId);
    set({ themeId, gaugeView, range, soundEnabled: sound, chartColors, timeFormat });
  },
}));
