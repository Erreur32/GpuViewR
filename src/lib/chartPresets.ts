// Chart color palettes used by the Dashboard's LiveChart + GaugeCard
// gradient fills. Extracted from SettingsPage so the 5 presets don't
// trip SonarCloud's duplicate-block rule on the settings file
// (5 near-identical literals at ~9 lines each after Prettier-style
// expansion = ~45 "duplicated" lines).

export interface ChartPreset {
  id: string;
  label: string;
  colors: {
    util: string;
    temp: string;
    pow: string;
    mem: string;
    fan: string;
  };
}

// Tuple order: util, temp, pow, mem, fan. Same convention as the
// ChartPreset.colors object so the .map shorthand below is readable
// without re-checking each preset.
type PresetTuple = readonly [
  id: string,
  label: string,
  util: string,
  temp: string,
  pow: string,
  mem: string,
  fan: string,
];

const RAW: readonly PresetTuple[] = [
  ["cyber", "Cyber", "#22d3ee", "#f472b6", "#a3e635", "#a78bfa", "#fbbf24"],
  ["sunset", "Sunset", "#fb7185", "#fbbf24", "#ec4899", "#f97316", "#22d3ee"],
  ["aurora", "Aurora", "#34d399", "#06b6d4", "#a78bfa", "#f472b6", "#fbbf24"],
  ["royal", "Royal", "#6366f1", "#a855f7", "#3b82f6", "#06b6d4", "#14b8a6"],
  ["mono", "Graphite", "#9ca3af", "#e5e7eb", "#64748b", "#475569", "#94a3b8"],
];

export const CHART_PRESETS: ChartPreset[] = RAW.map(
  ([id, label, util, temp, pow, mem, fan]) => ({
    id,
    label,
    colors: { util, temp, pow, mem, fan },
  }),
);
