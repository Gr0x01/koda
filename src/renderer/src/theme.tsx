import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  applyThemeVars,
  getTheme,
  KODA_DARK,
  KODA_LIGHT,
  resolveThemeId,
  type ThemeMode,
} from './themes'
import { monacoThemeId } from './surface/monaco-themes'

/** The resolved mode that actually drives the UI. */
type Theme = ThemeMode
/** What the user CHOSE for mode — 'system' tracks the OS appearance live; the others pin it. */
export type ThemePreference = 'light' | 'dark' | 'system'
const STORAGE_KEY = 'koda.theme'
// The two PAIRED appearance-pack choices: which light theme and which dark theme are active when the
// mode resolves to each. Independent picks (e.g. GitHub Light by day, Dracula by night).
const LIGHT_THEME_KEY = 'koda.lightTheme'
const DARK_THEME_KEY = 'koda.darkTheme'

function getInitialPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system' // fresh install follows the OS until the user picks
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function modeFor(preference: ThemePreference, systemIsDark: boolean): Theme {
  return preference === 'system' ? (systemIsDark ? 'dark' : 'light') : preference
}

/**
 * Apply a resolved (mode, themeId) to <html>: the `.dark` class tracks MODE (it gates Tailwind `dark:`
 * and the Milkdown dark tweaks), the `data-theme` attribute carries the active pack id (for debugging /
 * any future pack-scoped CSS), and the pack's CSS vars override the brand tokens (or clear back to the
 * styles/index.css defaults for a builtin).
 */
function applyAppearance(mode: Theme, themeId: string): void {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.setAttribute('data-theme', themeId)
  const def = getTheme(themeId) ?? getTheme(mode === 'dark' ? KODA_DARK : KODA_LIGHT)!
  applyThemeVars(def)
  // Mobile-only: the Safari status-bar / dynamic-island strip is painted from <meta theme-color>, not the
  // page, so it would show the tan canvas above the white header. Keep it matched to the surface color.
  // No-op on desktop (no such meta in the Electron renderer's index.html).
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const surface = getComputedStyle(root).getPropertyValue('--koda-surface').trim()
    if (surface) meta.setAttribute('content', surface)
  }
}

type ThemeContextValue = {
  /** The resolved light/dark mode actually applied (system preference collapsed to one). */
  theme: Theme
  /** The user's mode choice, including 'system'. */
  preference: ThemePreference
  setPreference: (p: ThemePreference) => void
  /** The chosen light-mode and dark-mode pack ids (the paired model). */
  lightTheme: string
  darkTheme: string
  setLightTheme: (id: string) => void
  setDarkTheme: (id: string) => void
  /** The resolved pack id for the current mode, and the Monaco theme name derived from it. */
  activeThemeId: string
  monacoTheme: string
}
const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * The single appearance source of truth. Resolves (mode preference × OS appearance) into a mode,
 * then picks the paired light/dark pack for that mode and applies both to <html>. A 'system'
 * preference re-resolves live on the OS media-query change. Monaco subscribes to `monacoTheme`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(getInitialPreference)
  const [systemIsDark, setSystemIsDark] = useState(systemPrefersDark)
  const [lightTheme, setLightThemeState] = useState(() =>
    resolveThemeId(localStorage.getItem(LIGHT_THEME_KEY), 'light'),
  )
  const [darkTheme, setDarkThemeState] = useState(() =>
    resolveThemeId(localStorage.getItem(DARK_THEME_KEY), 'dark'),
  )

  // Track the OS appearance so a 'system' preference updates live without a reload.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemIsDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme: Theme = modeFor(preference, systemIsDark)
  const activeThemeId = theme === 'dark' ? darkTheme : lightTheme

  useEffect(() => {
    applyAppearance(theme, activeThemeId)
    localStorage.setItem(STORAGE_KEY, preference)
  }, [theme, activeThemeId, preference])

  const setLightTheme = (id: string): void => {
    const resolved = resolveThemeId(id, 'light')
    setLightThemeState(resolved)
    localStorage.setItem(LIGHT_THEME_KEY, resolved)
  }
  const setDarkTheme = (id: string): void => {
    const resolved = resolveThemeId(id, 'dark')
    setDarkThemeState(resolved)
    localStorage.setItem(DARK_THEME_KEY, resolved)
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        preference,
        setPreference,
        lightTheme,
        darkTheme,
        setLightTheme,
        setDarkTheme,
        activeThemeId,
        monacoTheme: monacoThemeId(activeThemeId),
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

/**
 * Apply the saved appearance before first paint (no flash), mirroring initTextSize. Reads the same
 * localStorage keys the provider does and resolves the mode against the OS, so a dark-pack user
 * doesn't see a frame of the light default.
 */
export function initTheme(): void {
  const preference = getInitialPreference()
  const mode = modeFor(preference, systemPrefersDark())
  const themeId =
    mode === 'dark'
      ? resolveThemeId(localStorage.getItem(DARK_THEME_KEY), 'dark')
      : resolveThemeId(localStorage.getItem(LIGHT_THEME_KEY), 'light')
  applyAppearance(mode, themeId)
}
