import { create } from 'zustand';
import { applyTheme, getTheme } from '../lib/themes';

export type GaugeView = 'arc' | 'bar';
export type Range = 'live' | '5m' | '15m' | '1h' | '6h' | '24h' | '3d';
export type ChartSeriesKey = 'util' | 'temp' | 'pow';
export type ChartColors = Partial<Record<ChartSeriesKey, string>>;
export type TimeFormat = '24h' | '12h';
export type ChartThresholds = Partial<Record<ChartSeriesKey, number>>;

export const DEFAULT_THRESHOLDS: Required<ChartThresholds> = {
  util: 95,
  temp: 83,
  pow: 350,
};

interface UiState {
  themeId: string;
  gaugeView: GaugeView;
  range: Range;
  selectedGpu: number;
  soundEnabled: boolean;
  chartColors: ChartColors;
  timeFormat: TimeFormat;
  chartThresholds: ChartThresholds;
  chartThresholdsEnabled: boolean;

  setThemeId: (id: string) => void;
  setGaugeView: (v: GaugeView) => void;
  setRange: (r: Range) => void;
  setSelectedGpu: (i: number) => void;
  setSoundEnabled: (v: boolean) => void;
  setChartColor: (key: ChartSeriesKey, color: string | null) => void;
  resetChartColors: () => void;
  setTimeFormat: (f: TimeFormat) => void;
  setChartThreshold: (key: ChartSeriesKey, value: number | null) => void;
  setChartThresholdsEnabled: (v: boolean) => void;
  resetChartThresholds: () => void;

  hydrate: () => void;
}

const KEYS = {
  theme: 'gpuviewr.theme',
  view: 'gpuviewr.gauge_view',
  range: 'gpuviewr.range',
  sound: 'gpuviewr.sound',
  chartColors: 'gpuviewr.chart_colors',
  timeFormat: 'gpuviewr.time_format',
  chartThresholds: 'gpuviewr.chart_thresholds',
  chartThresholdsEnabled: 'gpuviewr.chart_thresholds_enabled',
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

function readChartThresholds(): ChartThresholds {
  try {
    const raw = localStorage.getItem(KEYS.chartThresholds);
    if (!raw) return { ...DEFAULT_THRESHOLDS };
    const obj = JSON.parse(raw) as ChartThresholds;
    if (typeof obj !== 'object' || obj === null) return { ...DEFAULT_THRESHOLDS };
    const out: ChartThresholds = {};
    for (const k of ['util', 'temp', 'pow'] as ChartSeriesKey[]) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_THRESHOLDS };
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
  chartThresholds: { ...DEFAULT_THRESHOLDS },
  chartThresholdsEnabled: true,

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
  setChartThreshold: (key, value) => {
    const next = { ...get().chartThresholds };
    if (value === null || !Number.isFinite(value)) delete next[key];
    else next[key] = value;
    localStorage.setItem(KEYS.chartThresholds, JSON.stringify(next));
    set({ chartThresholds: next });
  },
  setChartThresholdsEnabled: (v) => {
    localStorage.setItem(KEYS.chartThresholdsEnabled, v ? '1' : '0');
    set({ chartThresholdsEnabled: v });
  },
  resetChartThresholds: () => {
    const next = { ...DEFAULT_THRESHOLDS };
    localStorage.setItem(KEYS.chartThresholds, JSON.stringify(next));
    set({ chartThresholds: next });
  },

  hydrate: () => {
    const themeId = readLS(KEYS.theme, 'midnight');
    const gaugeView = (readLS(KEYS.view, 'arc') as GaugeView) || 'arc';
    // Migrate legacy values ('1m', '2m') that no longer exist in the
    // Range union to the closest current option so the UI does not break
    // for users upgrading from <= 0.1.8.
    const rawRange = readLS(KEYS.range, '1h');
    const range: Range = (['live', '5m', '15m', '1h', '6h', '24h', '3d'] as Range[]).includes(rawRange as Range)
      ? (rawRange as Range)
      : ((rawRange === '1m' || rawRange === '2m') ? 'live' : '1h');
    const sound = readLS(KEYS.sound, '0') === '1';
    const chartColors = readChartColors();
    const timeFormat = (readLS(KEYS.timeFormat, '24h') as TimeFormat) || '24h';
    const chartThresholds = readChartThresholds();
    const chartThresholdsEnabled = readLS(KEYS.chartThresholdsEnabled, '1') === '1';
    applyTheme(themeId);
    set({
      themeId, gaugeView, range, soundEnabled: sound, chartColors, timeFormat,
      chartThresholds, chartThresholdsEnabled,
    });
  },
}));
