import { create } from 'zustand';
import { applyTheme, getTheme } from '../lib/themes';
import { chartPresetForTheme } from '../lib/chartPresets';

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
// Exported so the FleetChart can reuse the same fallback rather than
// hardcoding its own metric → colour map.
export const ROYAL_DEFAULT_COLORS: Required<ChartColors> = {
  util: '#6366f1',
  temp: '#a855f7',
  pow: '#3b82f6',
  mem: '#06b6d4',
  fan: '#14b8a6',
};

export type FleetView = 'simple' | 'detailed';

/** Max width of the page body (header, main, footer) in px. The top of
 *  the slider means "full width" and is stored as 0. */
export const CONTENT_WIDTH = { min: 1200, max: 2560, step: 80, default: 1600, full: 0 } as const;

/** Settings panel width at the default page width (Tailwind max-w-5xl).
 *  It grows 1:1 with the page width above the default, so widening the
 *  page widens the settings tabs too instead of leaving a fixed column. */
const SETTINGS_BASE_WIDTH = 1024;

function applyContentWidth(px: number): void {
  const root = document.documentElement.style;
  const full = px === CONTENT_WIDTH.full;
  root.setProperty('--gv-content-max', full ? '100%' : `${px}px`);
  const settings = Math.max(SETTINGS_BASE_WIDTH, px - (CONTENT_WIDTH.default - SETTINGS_BASE_WIDTH));
  root.setProperty('--gv-settings-max', full ? '100%' : `${settings}px`);
}

function clampContentWidth(px: number): number {
  if (px === CONTENT_WIDTH.full) return px;
  if (!Number.isFinite(px)) return CONTENT_WIDTH.default;
  return Math.min(CONTENT_WIDTH.max, Math.max(CONTENT_WIDTH.min, px));
}

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
  /** Fleet page density: 'simple' = single hottest-GPU card, 'detailed' =
   *  per-GPU mini-tile row with util / temp / power + sparkline. */
  fleetView: FleetView;
  contentWidth: number;
  /** Process table: threshold (MiB of VRAM + GTT) below which processes
   *  are hidden while processFilterOn. Kept when the filter is switched
   *  off, so the switch toggles back to the same value. */
  processMinMib: number;
  processFilterOn: boolean;
  /** Process table: show only LLM processes (Ollama, llama.cpp, ...). */
  processLlmOnly: boolean;

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
  setFleetView: (v: FleetView) => void;
  setContentWidth: (px: number) => void;
  /** Sets the threshold; 0 switches the filter off. */
  setProcessMinMib: (mib: number) => void;
  setProcessFilterOn: (on: boolean) => void;
  setProcessLlmOnly: (on: boolean) => void;

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
  fleetView: 'gpuviewr.fleet_view',
  contentWidth: 'gpuviewr.content_width',
  processMinMib: 'gpuviewr.process_min_mib',
  processFilterOn: 'gpuviewr.process_filter_on',
  processLlmOnly: 'gpuviewr.process_llm_only',
};

/** Threshold used the first time the filter is switched on. */
const PROCESS_MIN_MIB_DEFAULT = 256;

/** Allowed range for processMinMib; 0 disables the filter. */
export const PROCESS_MIN_MIB_MAX = 100_000;

function clampProcessMinMib(v: number): number {
  return Number.isFinite(v) ? Math.min(PROCESS_MIN_MIB_MAX, Math.max(0, Math.round(v))) : 0;
}

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
  fleetView: 'simple',
  contentWidth: CONTENT_WIDTH.default,
  processMinMib: PROCESS_MIN_MIB_DEFAULT,
  processFilterOn: false,
  processLlmOnly: false,

  setThemeId: (id) => {
    const t = getTheme(id);
    applyTheme(t.id);
    localStorage.setItem(KEYS.theme, t.id);
    // Each theme comes with its own chart palette; picking a theme resets
    // the curves to it. Per-host colours (hosts.color, server side) are
    // a separate setting and stay untouched.
    const chartColors: ChartColors = { ...chartPresetForTheme(t.id).colors };
    localStorage.setItem(KEYS.chartColors, JSON.stringify(chartColors));
    set({ themeId: t.id, chartColors });
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
  setFleetView: (v) => {
    localStorage.setItem(KEYS.fleetView, v);
    set({ fleetView: v });
  },
  setContentWidth: (px) => {
    const w = clampContentWidth(px);
    applyContentWidth(w);
    localStorage.setItem(KEYS.contentWidth, String(w));
    set({ contentWidth: w });
  },
  setProcessMinMib: (mib) => {
    const v = clampProcessMinMib(mib);
    if (v === 0) {
      get().setProcessFilterOn(false);
      return;
    }
    try {
      localStorage.setItem(KEYS.processMinMib, String(v));
      localStorage.setItem(KEYS.processFilterOn, '1');
    } catch { /* ignore */ }
    set({ processMinMib: v, processFilterOn: true });
  },
  setProcessFilterOn: (on) => {
    try { localStorage.setItem(KEYS.processFilterOn, on ? '1' : '0'); } catch { /* ignore */ }
    set({ processFilterOn: on });
  },
  setProcessLlmOnly: (on) => {
    try { localStorage.setItem(KEYS.processLlmOnly, on ? '1' : '0'); } catch { /* ignore */ }
    set({ processLlmOnly: on });
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
    const fleetView: FleetView = readLS(KEYS.fleetView, 'simple') === 'detailed' ? 'detailed' : 'simple';
    const contentWidth = clampContentWidth(Number.parseInt(readLS(KEYS.contentWidth, String(CONTENT_WIDTH.default)), 10));
    applyContentWidth(contentWidth);
    const processMinMib = clampProcessMinMib(Number.parseInt(readLS(KEYS.processMinMib, String(PROCESS_MIN_MIB_DEFAULT)), 10)) || PROCESS_MIN_MIB_DEFAULT;
    const processFilterOn = readLS(KEYS.processFilterOn, '0') === '1';
    const processLlmOnly = readLS(KEYS.processLlmOnly, '0') === '1';
    set({
      themeId, gaugeView, dashboardView, range, selectedGpu, soundEnabled: sound, chartColors: effectiveColors, timeFormat,
      chartThresholds, chartThresholdsEnabled, chartPaletteInitialized: initialized,
      fleetView, contentWidth, processMinMib, processFilterOn, processLlmOnly,
    });
  },
}));
