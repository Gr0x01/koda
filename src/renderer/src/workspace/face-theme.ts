import type { CSSProperties } from 'react'
import type { MiniAppTheme } from '@shared/ipc'

/** Map an app's declared theme tokens onto Koda's CSS vars for the face overlay chrome (summon pill,
 *  reply bubble, question chips) — shared by the desktop face and the phone face so both wear the
 *  app's design instead of reading as foreign chrome. Values feed React style properties only (never
 *  markup), with a light character allowlist so a manifest can't smuggle url()/expression payloads
 *  into the window's styles. Unknown/invalid values fall back to Koda's own tokens per-field. */
export function themeStyle(theme?: MiniAppTheme): CSSProperties | undefined {
  if (!theme) return undefined
  const ok = (v?: string): v is string => !!v && /^[#a-zA-Z0-9 .,()%/'-]+$/.test(v)
  const s: Record<string, string> = {}
  if (ok(theme.accent)) s['--koda-accent'] = theme.accent
  if (ok(theme.surface)) s['--koda-surface'] = theme.surface
  if (ok(theme.text)) s['--koda-text'] = theme.text
  if (ok(theme.border)) s['--koda-border'] = theme.border
  if (ok(theme.font)) s.fontFamily = theme.font
  return Object.keys(s).length ? (s as CSSProperties) : undefined
}
