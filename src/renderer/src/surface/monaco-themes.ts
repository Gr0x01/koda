import type * as Monaco from 'monaco-editor'
import { getTheme, KODA_DARK, packThemes, type ThemeDef } from '../themes'

/**
 * Monaco editor themes derived from the appearance-pack catalog, so the file/diff editors match the
 * surrounding app instead of falling back to a generic vs-dark. Built from the SAME token data that
 * drives the app's CSS vars (themes.ts) — one source, no drift between the editor and its chrome.
 *
 * The two builtins (koda-light/koda-dark) keep Monaco's stock vs / vs-dark; only packs get a custom
 * theme, registered once at monaco load (monaco-setup.ts) and selected by id from the Editor `theme`.
 */

/** Monaco's `rules.foreground` wants a bare 6-hex (no '#'); `colors` wants a full '#rrggbb[aa]'. */
function bare(hex: string): string {
  return hex.replace('#', '')
}

/** The Monaco theme name for a resolved Koda theme id (builtins → stock vs / vs-dark). */
export function monacoThemeId(themeId: string): string {
  const def = getTheme(themeId)
  if (!def || !def.tokens) return themeId === KODA_DARK ? 'vs-dark' : 'vs'
  return `koda-${def.id}`
}

function defineFor(monaco: typeof Monaco, def: ThemeDef): void {
  if (!def.tokens) return
  const t = def.tokens
  const h = t.hljs
  monaco.editor.defineTheme(`koda-${def.id}`, {
    base: def.mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: bare(h.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(h.keyword) },
      { token: 'operator', foreground: bare(h.keyword) },
      { token: 'string', foreground: bare(h.string) },
      { token: 'number', foreground: bare(h.number) },
      { token: 'regexp', foreground: bare(h.string) },
      { token: 'type', foreground: bare(h.type) },
      { token: 'type.identifier', foreground: bare(h.type) },
      { token: 'function', foreground: bare(h.function) },
      { token: 'identifier', foreground: bare(t.text) },
      { token: 'variable', foreground: bare(h.variable) },
      { token: 'tag', foreground: bare(h.variable) },
      { token: 'attribute.name', foreground: bare(h.variable) },
      { token: 'attribute.value', foreground: bare(h.string) },
    ],
    colors: {
      // The editor sits on a raised file card → match `surface`, not the app canvas.
      'editor.background': t.surface,
      'editor.foreground': t.text,
      'editorLineNumber.foreground': `${t.textMuted}80`,
      'editorLineNumber.activeForeground': t.text,
      'editorCursor.foreground': t.accent,
      'editor.selectionBackground': `${t.accent}40`,
      'editor.lineHighlightBackground': `${t.text}0d`,
      'editorIndentGuide.background': `${t.border}80`,
      'editorIndentGuide.activeBackground': t.border,
      'editorWhitespace.foreground': `${t.border}80`,
      'editorGutter.background': t.surface,
      'editorWidget.background': t.surface,
      'editorWidget.border': t.border,
    },
  })
}

/** Register every pack theme. Called once after the monaco instance is wired (monaco-setup.ts). */
export function registerPackThemes(monaco: typeof Monaco): void {
  for (const def of packThemes()) defineFor(monaco, def)
}
