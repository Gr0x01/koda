import { Component, type ReactNode } from 'react'
import type { RendererLog } from '@shared/ipc'
import { Button } from './Button'
import { PixelGlyph } from './PixelGlyph'
import { motion, cardVariants, duration, ease } from '../motion'
import { flushAllFileWriters } from '../workspace/file-writer-registry'

// A failed dynamic import ("Failed to fetch dynamically imported module" / "error loading dynamically
// imported module"). It happens when Vite invalidates the module graph mid-session (dep re-optimize)
// or a shipped build's chunk hash goes stale after an update. The graph is fine on a *fresh* load, so
// the only real recovery is a full reload — an in-place refetch hits the same dead URL.
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|importing a module script failed/i.test(msg)
}

/** A stale Vite dependency graph can fail either while fetching a chunk or after two generations have
 *  loaded. Milkdown exposes the latter as a missing symbol-keyed initialization timer. Both have the
 *  same recovery: clear the renderer's module graph with one guarded reload. */
export function isModuleGraphError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return isChunkLoadError(error) || /Timer ["']InitReady["'] not found/i.test(msg)
}

// Auto-reload a module-graph failure, but bounded by SUCCESS, never by time. One reload clears the
// ordinary transient case invisibly. The case that stranded the doc editor is a BURST: while the agent
// hot-reloads Koda's own source in dev, the renderer full-reloads again and again, and each rebuild can
// land Milkdown on two dependency generations before Vite has settled — so a single reload isn't
// enough. A few attempts are allowed, but only a clean editor mount proves the graph actually settled
// and restores the budget. A quiet stretch is NOT evidence of recovery: a user retrying by hand (⌘K,
// pick a doc, watch it vanish) arrives minutes apart, so a time-based reset hands every retry a fresh
// budget and turns a persistently split graph into an endless silent reload loop where the recovery
// card can never appear. Counting attempts since the last clean mount surfaces the card on the fourth
// failure no matter how slowly the user retries.
const RELOAD_KEY = 'koda:chunk-reload'
const MAX_RELOADS = 3

// sessionStorage so the count survives the reloads it meters, then dies with the window.
function reloadCount(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY)) || 0
  } catch {
    return 0
  }
}

// Would this error trigger a silent auto-reload? Pure read — computed the same way in the render phase
// (getDerivedStateFromError) and the commit phase (componentDidCatch), which see the same stored budget,
// so both agree on whether we're recovering silently or surfacing the card.
function willAutoReload(error: unknown): boolean {
  if (!isModuleGraphError(error)) return false
  return reloadCount() < MAX_RELOADS
}

/** A clean editor mount means the graph settled, so clear the budget: the NEXT unrelated burst then
 *  starts fresh instead of inheriting attempts already spent. Called from the surfaces that recover
 *  this way, so a converged recovery doesn't count against a later one. */
export function noteModuleGraphRecovered(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY)
  } catch {
    // sessionStorage can be unavailable (private mode / teardown); recovery just loses its memory.
  }
}

/** Recover a known transient module-graph failure without looping or discarding a live editor buffer.
 *  Feature-local async failures do not reach React error boundaries, so they call this same guarded
 *  path directly. A refused writer keeps the renderer alive for an explicit recovery instead. */
export async function reloadForModuleGraphError(error: unknown): Promise<boolean> {
  if (!willAutoReload(error)) return false
  try {
    await flushAllFileWriters()
  } catch (saveError) {
    console.error('renderer reload blocked because an editor could not save:', saveError)
    return false
  }
  // A concurrent recovery may have spent the budget while the writer drain was in flight.
  if (!willAutoReload(error)) return false
  const spent = reloadCount() + 1
  sessionStorage.setItem(RELOAD_KEY, String(spent))
  // The reload wipes the renderer before anything renders the cause, so leave it in the main log
  // trail: without this line a silent recovery is indistinguishable from a plain window reload.
  // Typed locally because the phone client shares this boundary and has no desktop preload.
  ;(window as { koda?: { logFromRenderer?: (entry: RendererLog) => void } }).koda?.logFromRenderer?.({
    level: 'warn',
    args: [`module-graph error, auto-reload ${spent}/${MAX_RELOADS}: ${String(error)}`],
  })
  window.location.reload()
  return true
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
    void reloadForModuleGraphError(error).then((reloading) => {
      if (!reloading) this.setState({ phase: 'crashed' })
    })
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
            <PixelGlyph loader variant="snake" size={16} className="text-text-muted" />
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
          {/* A human click is loop-safe budget repayment: chunk blips spend the budget but only a
              clean doc mount repays it, so without this a long-lived window that burned three blips
              would show this card for every later blip. A genuinely broken module still converges —
              each refilled budget burns its silent reloads and lands back here, waiting on a click. */}
          <Button
            onClick={() => {
              noteModuleGraphRecovered()
              window.location.reload()
            }}
          >
            Reload
          </Button>
        </motion.div>
      </div>
    )
  }
}
