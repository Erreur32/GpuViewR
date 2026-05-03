// Theme registry: extend by adding entries here. Tokens map to CSS variables
// applied on <html> via useTheme().
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

export const THEMES: Theme[] = [
  {
    id: 'midnight',
    label: 'Midnight',
    mode: 'dark',
    tokens: {
      bg: '#0a1020',
      bg2: '#0e1830',
      surface: 'rgba(15, 23, 42, 0.7)',
      surfaceAlt: 'rgba(30, 41, 59, 0.5)',
      border: 'rgba(255, 255, 255, 0.06)',
      text: '#f1f5f9',
      textMuted: '#94a3b8',
      textDim: '#64748b',
      accent: '#2f7bff',
      accentFg: '#ffffff',
      ok: '#10b981',
      warn: '#f59e0b',
      danger: '#ef4444',
      info: '#06b6d4',
      chartGrid: 'rgba(148, 163, 184, 0.08)',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    mode: 'dark',
    tokens: {
      bg: '#0d0d10',
      bg2: '#16161b',
      surface: 'rgba(24, 24, 28, 0.75)',
      surfaceAlt: 'rgba(40, 40, 46, 0.55)',
      border: 'rgba(255, 255, 255, 0.05)',
      text: '#ededf0',
      textMuted: '#9ca3af',
      textDim: '#6b7280',
      accent: '#2f7bff',
      accentFg: '#ffffff',
      ok: '#34d399',
      warn: '#fbbf24',
      danger: '#f87171',
      info: '#22d3ee',
      chartGrid: 'rgba(160, 160, 170, 0.08)',
    },
  },
  {
    id: 'oceanic',
    label: 'Oceanic',
    mode: 'dark',
    tokens: {
      bg: '#031d2a',
      bg2: '#06324a',
      surface: 'rgba(8, 47, 73, 0.65)',
      surfaceAlt: 'rgba(14, 73, 114, 0.5)',
      border: 'rgba(125, 211, 252, 0.1)',
      text: '#e0f2fe',
      textMuted: '#7dd3fc',
      textDim: '#0ea5e9',
      accent: '#22d3ee',
      accentFg: '#082f49',
      ok: '#34d399',
      warn: '#facc15',
      danger: '#fb7185',
      info: '#38bdf8',
      chartGrid: 'rgba(125, 211, 252, 0.1)',
    },
  },
  {
    id: 'light',
    label: 'Daylight',
    mode: 'light',
    tokens: {
      bg: '#f8fafc',
      bg2: '#eef2f7',
      surface: 'rgba(255, 255, 255, 0.9)',
      surfaceAlt: 'rgba(241, 245, 249, 0.85)',
      border: 'rgba(15, 23, 42, 0.08)',
      text: '#0f172a',
      textMuted: '#475569',
      textDim: '#94a3b8',
      accent: '#2f7bff',
      accentFg: '#ffffff',
      ok: '#059669',
      warn: '#d97706',
      danger: '#dc2626',
      info: '#0891b2',
      chartGrid: 'rgba(15, 23, 42, 0.06)',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    mode: 'light',
    tokens: {
      bg: '#fdfcf7',
      bg2: '#f5f1e6',
      surface: 'rgba(255, 253, 247, 0.95)',
      surfaceAlt: 'rgba(245, 240, 224, 0.7)',
      border: 'rgba(82, 64, 38, 0.1)',
      text: '#3b2f1d',
      textMuted: '#7c6a4d',
      textDim: '#a89779',
      accent: '#b45309',
      accentFg: '#fffbeb',
      ok: '#15803d',
      warn: '#b45309',
      danger: '#b91c1c',
      info: '#0e7490',
      chartGrid: 'rgba(82, 64, 38, 0.08)',
    },
  },
  {
    // Paper, dimmed: forest-paper variant. Deep moss greens with a sage-mint
    // text and emerald accent. Not black — keeps the parchment warmth but in
    // botanical/herbarium tones.
    id: 'paper-dark',
    label: 'Paper Dark',
    mode: 'dark',
    tokens: {
      bg: '#131e17',
      bg2: '#1a2820',
      surface: 'rgba(26, 40, 32, 0.78)',
      surfaceAlt: 'rgba(40, 56, 46, 0.55)',
      border: 'rgba(190, 230, 200, 0.08)',
      text: '#e3f1e6',
      textMuted: '#a8c5b0',
      textDim: '#6f8a78',
      accent: '#4ade80',
      accentFg: '#0a1410',
      ok: '#84cc16',
      warn: '#fbbf24',
      danger: '#f87171',
      info: '#22d3ee',
      chartGrid: 'rgba(190, 230, 200, 0.06)',
    },
  },
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
