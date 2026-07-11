import { Component, type ReactNode } from 'react'
import { Button } from './Button'
import { PixelGlyph } from './PixelGlyph'
import { motion, cardVariants, duration, ease } from '../motion'

// A failed dynamic import ("Failed to fetch dynamically imported module" / "error loading dynamically
// imported module"). It happens when Vite invalidates the module graph mid-session (dep re-optimize)
// or a shipped build's chunk hash goes stale after an update. The graph is fine on a *fresh* load, so
// the only real recovery is a full reload — an in-place refetch hits the same dead URL.
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|importing a module script failed/i.test(msg)
}

// Auto-reload at most once per this window. A reload recovers the transient case invisibly; if the
// module is *genuinely* broken it'll fail again immediately, and the second failure (inside the
// window) falls through to the recovery card instead of looping forever.
const RELOAD_KEY = 'koda:chunk-reload-at'
const RELOAD_WINDOW_MS = 10_000

// Would this error trigger the silent auto-reload? Pure read — computed the same way in the render
// phase (getDerivedStateFromError) and the commit phase (componentDidCatch), which see the same
// stored timestamp, so both agree on whether we're recovering silently or surfacing the card.
function willAutoReload(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
  return Date.now() - last > RELOAD_WINDOW_MS
}

type Phase = 'ok' | 'reloading' | 'crashed'

/**
 * The renderer's one safety net. Without a boundary, a throw anywhere — most commonly a lazy chunk
 * that failed to fetch (see lazyWithRetry) — unmounts the whole React tree to the root and leaves a
 * black window whose only escape is a manual reload.
 *
 * Two outcomes, and the difference is what keeps it from *flashing* an error:
 *  - `reloading` — a chunk failure we're about to silently reload past. We show a calm, app-colored
 *    screen (never the error card), so the reload reads as a brief blink, not a fault.
 *  - `crashed` — a genuine, non-recoverable error (or a chunk failure that already reloaded once and
 *    still fails). We fade in a recovery card with a manual Reload.
 *
 * The error is forwarded to the log file via the console.error override in logging.ts.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { phase: Phase }> {
  state: { phase: Phase } = { phase: 'ok' }

  static getDerivedStateFromError(error: unknown): { phase: Phase } {
    return { phase: willAutoReload(error) ? 'reloading' : 'crashed' }
  }

  componentDidCatch(error: unknown): void {
    console.error('renderer crashed (ErrorBoundary):', error)
    if (willAutoReload(error)) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      window.location.reload()
    }
  }

  render(): ReactNode {
    const { phase } = this.state
    if (phase === 'ok') return this.props.children

    // About to reload: hold on a calm, app-colored screen so nothing red flashes. The twinkle is
    // delayed, so a fast reload shows pure background and only a lingering one reveals a soft loader.
    if (phase === 'reloading') {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-bg">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            transition={{ delay: 0.3, duration: duration.base, ease: ease.out }}
          >
            <PixelGlyph loader size={16} className="text-text-muted" />
          </motion.div>
        </div>
      )
    }

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg p-6">
        <motion.div
          variants={cardVariants}
          initial="hidden"
          animate="visible"
          className="flex max-w-sm flex-col items-center gap-4 text-center"
        >
          <PixelGlyph glyph="cross" size={22} className="text-text-muted" />
          <div className="space-y-1.5">
            <h1 className="font-display text-sm font-semibold text-text">Something glitched</h1>
            <p className="text-[12.5px] leading-relaxed text-text-muted">
              A part of the app failed to load. Your work is saved. Reloading usually clears it.
            </p>
          </div>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </motion.div>
      </div>
    )
  }
}
