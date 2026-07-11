import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Reading text size — the Appearance → Text size preference. Shifts the `data-text-size` attribute on
 * <html>, which rescales the prose/doc base px in styles/index.css (the line-height ratio is fixed, so
 * the rhythm holds at every size). Renderer-only via localStorage, mirroring the theme module (pure
 * appearance, no main/IPC round-trip). 'medium' is the default and carries no attribute override.
 *
 * It's a context (not a plain hook) so the Monaco editors — which read a px NUMBER, not a CSS var —
 * re-render live when the setting changes. The CSS-driven surfaces (transcript, doc) don't need React
 * reactivity: the <html> attribute change recomputes their type instantly on its own.
 */
export type TextSize = 'compact' | 'medium' | 'comfortable'
const STORAGE_KEY = 'koda.textSize'

/** Monospace editor px per size — the code surfaces (raw file, diff) scale on their own baseline (13),
 *  not the prose scale, so code stays comfortably dense even at the larger reading size. */
const CODE_FONT_PX: Record<TextSize, number> = { compact: 12, medium: 13, comfortable: 14 }

function getInitialTextSize(): TextSize {
  const s = localStorage.getItem(STORAGE_KEY)
  return s === 'compact' || s === 'comfortable' || s === 'medium' ? s : 'medium'
}

/** Apply to <html> (called once at boot before render to avoid a flash, and on every change). */
export function applyTextSize(size: TextSize): void {
  document.documentElement.setAttribute('data-text-size', size)
}

/** Apply the saved size before first paint. Called from main.tsx ahead of render. */
export function initTextSize(): void {
  applyTextSize(getInitialTextSize())
}

type TextSizeContextValue = {
  size: TextSize
  setSize: (s: TextSize) => void
  /** The monospace font size (px) for Monaco file/diff editors at the current setting. */
  codeFontSize: number
}
const TextSizeContext = createContext<TextSizeContextValue | null>(null)

export function TextSizeProvider({ children }: { children: ReactNode }) {
  const [size, setSize] = useState<TextSize>(getInitialTextSize)

  useEffect(() => {
    applyTextSize(size)
    localStorage.setItem(STORAGE_KEY, size)
  }, [size])

  return (
    <TextSizeContext.Provider value={{ size, setSize, codeFontSize: CODE_FONT_PX[size] }}>
      {children}
    </TextSizeContext.Provider>
  )
}

export function useTextSize(): TextSizeContextValue {
  const ctx = useContext(TextSizeContext)
  if (!ctx) throw new Error('useTextSize must be used within a TextSizeProvider')
  return ctx
}
