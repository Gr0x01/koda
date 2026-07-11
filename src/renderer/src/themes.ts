/**
 * Appearance packs — the recognizable IDE themes Koda ships beyond its own ink default.
 *
 * The PAIRED model (VS Code-style): every theme is inherently light OR dark. The user picks a
 * preferred light theme and a preferred dark theme independently; the Light/Dark/System toggle
 * (theme.tsx) then decides which of the two is showing. So this catalog is the single source for
 * the pack palettes — both the CSS custom-property overrides applied to <html> AND the Monaco
 * editor themes derived from the same colors (surface/monaco-themes.ts), so code coloring and the
 * surrounding app never drift apart.
 *
 * Koda's own light/dark stay CSS-driven in styles/index.css (untouched, lowest blast radius); they
 * appear here only as catalog ENTRIES (id/label/mode, no tokens) so the pickers can list them and
 * Monaco can map them to its built-in vs / vs-dark. A pack with `tokens` overrides the brand vars;
 * a builtin without `tokens` clears them and falls back to the CSS defaults.
 *
 * Palettes are the canonical published values for each scheme; names are the original authors'
 * (Dracula, Nord, Solarized, Monokai, One Dark, GitHub) — see THIRD_PARTY_NOTICES.
 */

export type ThemeMode = 'light' | 'dark'

/** The seven syntax roles, mapped 1:1 to the highlight.js token groups in styles/index.css. */
export interface SyntaxTokens {
  comment: string
  keyword: string
  string: string
  number: string
  function: string
  type: string
  variable: string
}

/** The brand UI vars a pack overrides (the `--koda-*` set, minus the mode-derived shadow). */
export interface UiTokens {
  bg: string
  surface: string
  border: string
  text: string
  textMuted: string
  accent: string
}

export interface ThemeDef {
  id: string
  label: string
  mode: ThemeMode
  /** A pack's palette. Absent for the two builtins (koda-light/koda-dark → CSS defaults). */
  tokens?: UiTokens & { hljs: SyntaxTokens }
}

// ── The two builtins (palette lives in styles/index.css) ──────────────────────────────
export const KODA_LIGHT = 'koda-light'
export const KODA_DARK = 'koda-dark'

// ── The catalog ───────────────────────────────────────────────────────────────────────
export const THEMES: ThemeDef[] = [
  { id: KODA_LIGHT, label: 'Koda Light', mode: 'light' },
  {
    id: 'github-light',
    label: 'GitHub Light',
    mode: 'light',
    tokens: {
      bg: '#f6f8fa',
      surface: '#ffffff',
      border: '#d0d7de',
      text: '#1f2328',
      textMuted: '#656d76',
      accent: '#0969da',
      hljs: {
        comment: '#6e7781',
        keyword: '#cf222e',
        string: '#0a3069',
        number: '#0550ae',
        function: '#8250df',
        type: '#953800',
        variable: '#e36209',
      },
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    mode: 'light',
    tokens: {
      bg: '#eee8d5',
      surface: '#fdf6e3',
      border: '#e0dac3',
      text: '#586e75',
      textMuted: '#93a1a1',
      accent: '#268bd2',
      hljs: {
        comment: '#93a1a1',
        keyword: '#859900',
        string: '#2aa198',
        number: '#d33682',
        function: '#268bd2',
        type: '#b58900',
        variable: '#cb4b16',
      },
    },
  },

  { id: KODA_DARK, label: 'Koda Dark', mode: 'dark' },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    tokens: {
      bg: '#282a36',
      surface: '#2d2f3a',
      border: '#44475a',
      text: '#f8f8f2',
      textMuted: '#6272a4',
      accent: '#bd93f9',
      hljs: {
        comment: '#6272a4',
        keyword: '#ff79c6',
        string: '#f1fa8c',
        number: '#bd93f9',
        function: '#50fa7b',
        type: '#8be9fd',
        variable: '#ffb86c',
      },
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    tokens: {
      bg: '#2e3440',
      surface: '#3b4252',
      border: '#434c5e',
      text: '#d8dee9',
      textMuted: '#7b88a1',
      accent: '#88c0d0',
      hljs: {
        comment: '#616e88',
        keyword: '#81a1c1',
        string: '#a3be8c',
        number: '#b48ead',
        function: '#88c0d0',
        type: '#8fbcbb',
        variable: '#d8dee9',
      },
    },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    mode: 'dark',
    tokens: {
      bg: '#272822',
      surface: '#2f302a',
      border: '#49483e',
      text: '#f8f8f2',
      textMuted: '#75715e',
      accent: '#66d9ef',
      hljs: {
        comment: '#75715e',
        keyword: '#f92672',
        string: '#e6db74',
        number: '#ae81ff',
        function: '#a6e22e',
        type: '#66d9ef',
        variable: '#fd971f',
      },
    },
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    mode: 'dark',
    tokens: {
      bg: '#282c34',
      surface: '#2f343e',
      border: '#3b4048',
      text: '#abb2bf',
      textMuted: '#5c6370',
      accent: '#61afef',
      hljs: {
        comment: '#5c6370',
        keyword: '#c678dd',
        string: '#98c379',
        number: '#d19a66',
        function: '#61afef',
        type: '#e5c07b',
        variable: '#e06c75',
      },
    },
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    mode: 'dark',
    tokens: {
      bg: '#0d1117',
      surface: '#161b22',
      border: '#30363d',
      text: '#e6edf3',
      textMuted: '#7d8590',
      accent: '#2f81f7',
      hljs: {
        comment: '#8b949e',
        keyword: '#ff7b72',
        string: '#a5d6ff',
        number: '#79c0ff',
        function: '#d2a8ff',
        type: '#ffa657',
        variable: '#ffa657',
      },
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    mode: 'dark',
    tokens: {
      bg: '#002b36',
      surface: '#073642',
      border: '#0a4a5a',
      text: '#93a1a1',
      textMuted: '#657b83',
      accent: '#268bd2',
      hljs: {
        comment: '#586e75',
        keyword: '#859900',
        string: '#2aa198',
        number: '#d33682',
        function: '#268bd2',
        type: '#b58900',
        variable: '#cb4b16',
      },
    },
  },
]

const BY_ID = new Map(THEMES.map((t) => [t.id, t]))

/** The full palette used to RENDER a theme's preview (swatches + the live sample card in Settings). */
export type PreviewPalette = UiTokens & { hljs: SyntaxTokens }

// The two builtins keep their real palette in CSS, so mirror it here (verbatim from styles/index.css)
// for previews only — packs derive theirs from `tokens` directly. Keep in sync with index.css.
const BUILTIN_PREVIEW: Record<string, PreviewPalette> = {
  [KODA_LIGHT]: {
    bg: '#f4f3f1', surface: '#ffffff', border: '#e9e8e4', text: '#1c1c1e', textMuted: '#76767c', accent: '#2549a8',
    hljs: { comment: '#9aa0aa', keyword: '#7c3aed', string: '#2e7d32', number: '#c2410c', function: '#1d4ed8', type: '#b45309', variable: '#be123c' },
  },
  [KODA_DARK]: {
    bg: '#0d0d0f', surface: '#17171a', border: '#26262b', text: '#ededee', textMuted: '#9a9aa0', accent: '#6a93e6',
    hljs: { comment: '#6b7280', keyword: '#c792ea', string: '#c3e88d', number: '#f78c6c', function: '#82aaff', type: '#ffcb6b', variable: '#f07178' },
  },
}

/** The colors to render a theme's preview — a pack's own tokens, or the builtin's CSS-mirrored set. */
export function previewPalette(def: ThemeDef): PreviewPalette {
  return def.tokens ?? BUILTIN_PREVIEW[def.id]
}

export function getTheme(id: string): ThemeDef | undefined {
  return BY_ID.get(id)
}

/** The themes for one mode, in catalog order (drives the two Settings pickers). */
export function themesForMode(mode: ThemeMode): ThemeDef[] {
  return THEMES.filter((t) => t.mode === mode)
}

/** Just the packs (themes with their own palette) — the builtins ride Monaco's stock vs/vs-dark. */
export function packThemes(): ThemeDef[] {
  return THEMES.filter((t) => t.tokens)
}

/** Validate a stored id for a mode, falling back to that mode's Koda builtin. */
export function resolveThemeId(id: string | null, mode: ThemeMode): string {
  const def = id ? BY_ID.get(id) : undefined
  if (def && def.mode === mode) return def.id
  return mode === 'dark' ? KODA_DARK : KODA_LIGHT
}

// Pop-shadow presets (mirror styles/index.css :root / .dark) so a pack's floating menus get the
// right elevation for its mode — packs only declare flat colors, not shadows.
const POP_SHADOW: Record<ThemeMode, string> = {
  light:
    '0 1px 1px rgba(17, 17, 20, 0.05), 0 6px 14px -4px rgba(17, 17, 20, 0.18), 0 14px 34px -10px rgba(17, 17, 20, 0.22)',
  dark: '0 1px 1px rgba(0, 0, 0, 0.4), 0 6px 14px -4px rgba(0, 0, 0, 0.5), 0 16px 36px -10px rgba(0, 0, 0, 0.6)',
}

const VAR_KEYS = [
  '--koda-bg',
  '--koda-surface',
  '--koda-border',
  '--koda-text',
  '--koda-text-muted',
  '--koda-accent',
  '--koda-shadow-pop',
  '--koda-hljs-comment',
  '--koda-hljs-keyword',
  '--koda-hljs-string',
  '--koda-hljs-number',
  '--koda-hljs-function',
  '--koda-hljs-type',
  '--koda-hljs-variable',
]

/**
 * Apply a resolved theme to <html>: a pack sets its brand + syntax vars inline (winning over the
 * CSS defaults); a builtin clears them so styles/index.css `:root` / `.dark` takes over. Caller
 * owns the `.dark` class (tracks MODE — gates Tailwind `dark:` and the Milkdown dark tweaks) and the
 * `data-theme` attribute (the active pack id).
 */
export function applyThemeVars(def: ThemeDef): void {
  const root = document.documentElement
  const style = root.style
  if (!def.tokens) {
    for (const k of VAR_KEYS) style.removeProperty(k)
    return
  }
  const t = def.tokens
  style.setProperty('--koda-bg', t.bg)
  style.setProperty('--koda-surface', t.surface)
  style.setProperty('--koda-border', t.border)
  style.setProperty('--koda-text', t.text)
  style.setProperty('--koda-text-muted', t.textMuted)
  style.setProperty('--koda-accent', t.accent)
  style.setProperty('--koda-shadow-pop', POP_SHADOW[def.mode])
  style.setProperty('--koda-hljs-comment', t.hljs.comment)
  style.setProperty('--koda-hljs-keyword', t.hljs.keyword)
  style.setProperty('--koda-hljs-string', t.hljs.string)
  style.setProperty('--koda-hljs-number', t.hljs.number)
  style.setProperty('--koda-hljs-function', t.hljs.function)
  style.setProperty('--koda-hljs-type', t.hljs.type)
  style.setProperty('--koda-hljs-variable', t.hljs.variable)
}
