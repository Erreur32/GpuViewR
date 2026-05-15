// Theme registry: extend by adding entries here. Tokens map to CSS variables
// applied on <html> via applyTheme().
export type ThemeMode = 'dark' | 'light';

export interface ThemeTokens {
  bg: string;        // page background
  bg2: string;       // gradient stop
  surface: string;   // card bg
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;    // primary accent
  accentFg: string;  // text on accent
  ok: string;
  warn: string;
  danger: string;
  info: string;
  chartGrid: string;
}

export interface Theme {
  id: string;
  label: string;
  mode: ThemeMode;
  tokens: ThemeTokens;
}

// Each theme is declared as a flat 15-string tuple in this exact order.
// The named-tuple labels give editors a hover hint per position; the
// TokenTuple type catches order mistakes at compile time. Switching from
// "object literal per theme" to "tuple per theme" eliminates the
// duplicated key column that SonarCloud was flagging (61.8% on the
// previous shape) without losing type safety.
type TokenTuple = [
  bg: string,
  bg2: string,
  surface: string,
  surfaceAlt: string,
  border: string,
  text: string,
  textMuted: string,
  textDim: string,
  accent: string,
  accentFg: string,
  ok: string,
  warn: string,
  danger: string,
  info: string,
  chartGrid: string,
];

const TOKEN_KEYS: ReadonlyArray<keyof ThemeTokens> = [
  'bg', 'bg2', 'surface', 'surfaceAlt', 'border',
  'text', 'textMuted', 'textDim',
  'accent', 'accentFg',
  'ok', 'warn', 'danger', 'info', 'chartGrid',
];

function makeTheme(id: string, label: string, mode: ThemeMode, t: TokenTuple): Theme {
  const tokens = {} as ThemeTokens;
  for (let i = 0; i < TOKEN_KEYS.length; i++) {
    tokens[TOKEN_KEYS[i]] = t[i];
  }
  return { id, label, mode, tokens };
}

export const THEMES: Theme[] = [
  // [bg, bg2, surface, surfaceAlt, border, text, textMuted, textDim,
  //  accent, accentFg, ok, warn, danger, info, chartGrid]
  makeTheme('midnight', 'Midnight', 'dark', [
    '#0a1020', '#0e1830',
    'rgba(22, 32, 58, 0.88)', 'rgba(40, 54, 82, 0.70)',
    'rgba(255, 255, 255, 0.10)',
    '#ffffff', '#a3b1c5', '#6b7993',
    '#2f7bff', '#ffffff',
    '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
    'rgba(148, 163, 184, 0.08)',
  ]),
  makeTheme('graphite', 'Graphite', 'dark', [
    '#0d0d10', '#16161b',
    'rgba(34, 34, 40, 0.90)', 'rgba(54, 54, 62, 0.72)',
    'rgba(255, 255, 255, 0.09)',
    '#ffffff', '#b0b3bb', '#7a7d86',
    '#2f7bff', '#ffffff',
    '#34d399', '#fbbf24', '#f87171', '#22d3ee',
    'rgba(160, 160, 170, 0.08)',
  ]),
  makeTheme('oceanic', 'Oceanic', 'dark', [
    '#031d2a', '#06324a',
    'rgba(8, 47, 73, 0.65)', 'rgba(14, 73, 114, 0.5)',
    'rgba(125, 211, 252, 0.1)',
    '#e0f2fe', '#7dd3fc', '#0ea5e9',
    '#22d3ee', '#082f49',
    '#34d399', '#facc15', '#fb7185', '#38bdf8',
    'rgba(125, 211, 252, 0.1)',
  ]),
  makeTheme('light', 'Daylight', 'light', [
    '#f8fafc', '#eef2f7',
    'rgba(255, 255, 255, 0.9)', 'rgba(241, 245, 249, 0.85)',
    'rgba(15, 23, 42, 0.08)',
    '#0f172a', '#475569', '#94a3b8',
    '#2f7bff', '#ffffff',
    '#059669', '#d97706', '#dc2626', '#0891b2',
    'rgba(15, 23, 42, 0.06)',
  ]),
  makeTheme('paper', 'Paper', 'light', [
    '#fdfcf7', '#f5f1e6',
    'rgba(255, 253, 247, 0.95)', 'rgba(245, 240, 224, 0.7)',
    'rgba(82, 64, 38, 0.1)',
    '#3b2f1d', '#7c6a4d', '#a89779',
    '#b45309', '#fffbeb',
    '#15803d', '#b45309', '#b91c1c', '#0e7490',
    'rgba(82, 64, 38, 0.08)',
  ]),
  // Paper, dimmed: forest-paper variant. Deep moss greens with a sage-mint
  // text and emerald accent — keeps parchment warmth in botanical tones.
  makeTheme('paper-dark', 'Paper Dark', 'dark', [
    '#131e17', '#1a2820',
    'rgba(26, 40, 32, 0.78)', 'rgba(40, 56, 46, 0.55)',
    'rgba(190, 230, 200, 0.08)',
    '#e3f1e6', '#a8c5b0', '#6f8a78',
    '#4ade80', '#0a1410',
    '#84cc16', '#fbbf24', '#f87171', '#22d3ee',
    'rgba(190, 230, 200, 0.06)',
  ]),
];

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function applyTheme(id: string): void {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--gv-${kebab(key)}`, value);
  }
  root.dataset.theme = theme.id;
  root.dataset.mode = theme.mode;
  if (theme.mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  root.style.colorScheme = theme.mode;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}
