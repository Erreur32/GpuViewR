// Chart color palettes used by the Dashboard's LiveChart + GaugeCard
// gradient fills. Extracted from SettingsPage so the presets don't
// trip SonarCloud's duplicate-block rule on the settings file
// (near-identical literals at ~9 lines each after Prettier-style
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
  // Graphite for light backgrounds: same roles, lightness inverted so
  // every curve keeps >= 4.5:1 contrast on white.
  ["slate", "Slate", "#4b5563", "#111827", "#64748b", "#334155", "#6b7280"],
];

export const CHART_PRESETS: ChartPreset[] = RAW.map(
  ([id, label, util, temp, pow, mem, fan]) => ({
    id,
    label,
    colors: { util, temp, pow, mem, fan },
  }),
);

// Chart palette applied when the user picks a theme (Settings → Custom).
// Light themes get Slate, the dark-on-light variant of Graphite.
// Unlisted themes fall back to Royal, the first-run default.
const THEME_PRESET: Readonly<Record<string, string>> = {
  midnight: "royal",
  graphite: "mono",
  oceanic: "aurora",
  "paper-dark": "cyber",
  light: "slate",
  paper: "slate",
};

export function chartPresetForTheme(themeId: string): ChartPreset {
  const id = THEME_PRESET[themeId] ?? "royal";
  return CHART_PRESETS.find((p) => p.id === id) ?? CHART_PRESETS[0];
}
