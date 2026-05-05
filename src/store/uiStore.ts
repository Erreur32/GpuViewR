import { create } from 'zustand';
import { applyTheme, getTheme } from '../lib/themes';

export type GaugeView = 'arc' | 'bar';
export type DashboardView = 'single' | 'all';
export type Range = 'live' | '5m' | '15m' | '1h' | '6h' | '24h' | '3d';
export type ChartSeriesKey = 'util' | 'temp' | 'pow' | 'mem' | 'fan';
export type ChartColors = Partial<Record<ChartSeriesKey, string>>;
export type TimeFormat = '24h' | '12h';
export type ChartThresholds = Partial<Record<ChartSeriesKey, number>>;

export const DEFAULT_THRESHOLDS: Required<ChartThresholds> = {
  util: 95,
  temp: 83,
  pow: 350,
  mem: 90,
  fan: 90,
};

// Default palette ("Royal") applied on first run when the user has no
// custom chart colors yet. Mirrors the Royal preset in SettingsPage.
const ROYAL_DEFAULT_COLORS: Required<ChartColors> = {
  util: '#6366f1',
  temp: '#a855f7',
  pow: '#3b82f6',
  mem: '#06b6d4',
  fan: '#14b8a6',
};

interface UiState {
  themeId: string;
  gaugeView: GaugeView;
  dashboardView: DashboardView;
  range: Range;
  selectedGpu: number;
  soundEnabled: boolean;
  chartColors: ChartColors;
  timeFormat: TimeFormat;
  chartThresholds: ChartThresholds;
  chartThresholdsEnabled: boolean;
  chartPaletteInitialized: boolean;

  setThemeId: (id: string) => void;
  setGaugeView: (v: GaugeView) => void;
  setDashboardView: (v: DashboardView) => void;
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
  dashboardView: 'gpuviewr.dashboard_view',
  range: 'gpuviewr.range',
  selectedGpu: 'gpuviewr.selected_gpu',
  sound: 'gpuviewr.sound',
  chartColors: 'gpuviewr.chart_colors',
  timeFormat: 'gpuviewr.time_format',
  chartThresholds: 'gpuviewr.chart_thresholds',
  chartThresholdsEnabled: 'gpuviewr.chart_thresholds_enabled',
  chartPaletteInitialized: 'gpuviewr.chart_palette_initialized',
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
    for (const k of ['util', 'temp', 'pow', 'mem', 'fan'] as ChartSeriesKey[]) {
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
  dashboardView: 'single',
  range: 'live',
  selectedGpu: 0,
  soundEnabled: false,
  chartColors: {},
  timeFormat: '24h',
  chartThresholds: { ...DEFAULT_THRESHOLDS },
  chartThresholdsEnabled: true,
  chartPaletteInitialized: false,

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
  setDashboardView: (v) => {
    localStorage.setItem(KEYS.dashboardView, v);
    set({ dashboardView: v });
  },
  setRange: (r) => {
    localStorage.setItem(KEYS.range, r);
    set({ range: r });
  },
  setSelectedGpu: (i) => {
    try { localStorage.setItem(KEYS.selectedGpu, String(i)); } catch { /* ignore */ }
    set({ selectedGpu: i });
  },
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
    const dashboardView: DashboardView = readLS(KEYS.dashboardView, 'single') === 'all' ? 'all' : 'single';
    // Migrate legacy values ('1m', '2m') that no longer exist in the
    // Range union to the closest current option so the UI does not break
    // for users upgrading from <= 0.1.8.
    const rawRange = readLS(KEYS.range, 'live');
    const range: Range = (['live', '5m', '15m', '1h', '6h', '24h', '3d'] as Range[]).includes(rawRange as Range)
      ? (rawRange as Range)
      : 'live';
    const sound = readLS(KEYS.sound, '0') === '1';
    const rawGpu = Number.parseInt(readLS(KEYS.selectedGpu, '0'), 10);
    const selectedGpu = Number.isFinite(rawGpu) && rawGpu >= 0 ? rawGpu : 0;
    const chartColors = readChartColors();
    const timeFormat = (readLS(KEYS.timeFormat, '24h') as TimeFormat) || '24h';
    const chartThresholds = readChartThresholds();
    const chartThresholdsEnabled = readLS(KEYS.chartThresholdsEnabled, '1') === '1';
    // First run: seed the chart palette with "Royal" so the dashboard ships
    // with a polished look out of the box. Honors any pre-existing custom
    // color the user might have picked before this default landed.
    let initialized = readLS(KEYS.chartPaletteInitialized, '0') === '1';
    let effectiveColors = chartColors;
    if (!initialized) {
      effectiveColors = { ...ROYAL_DEFAULT_COLORS, ...chartColors };
      try {
        localStorage.setItem(KEYS.chartColors, JSON.stringify(effectiveColors));
        localStorage.setItem(KEYS.chartPaletteInitialized, '1');
      } catch { /* ignore quota / disabled storage */ }
      initialized = true;
    }
    applyTheme(themeId);
    set({
      themeId, gaugeView, dashboardView, range, selectedGpu, soundEnabled: sound, chartColors: effectiveColors, timeFormat,
      chartThresholds, chartThresholdsEnabled, chartPaletteInitialized: initialized,
    });
  },
}));
