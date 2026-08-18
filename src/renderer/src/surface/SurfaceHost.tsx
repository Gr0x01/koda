import { useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, duration, ease, spring } from '../motion'
import { ConversationSurface } from './ConversationSurface'
import { Dock } from './Dock'
import { fitStage } from './stage-layout'
import { ResizeHandle } from '../workspace/ResizeHandle'
import { stageVisible, useWorkspace } from '../workspace/store'

/**
 * The breathing center (ui-workspace.md §3/§4). The conversation is ALWAYS present and premium; a
 * collapsible right DOCK sits beside it — the STAGE: a small set of co-open tabs (the running app,
 * the doc the agent is writing, the diff it just made, the shell, the changes), with the agent's
 * auto-follow selecting or adding one. The stage shows only while the session HAS something on it
 * (`stageVisible`), so a fresh chat is a full-width conversation; hidden, nothing running is torn down
 * (the preview dev server keeps going). Toggled from the session header. Expanded (`stageExpanded`)
 * the stage takes the full width instead, whatever tab is on it.
 *
 * The row measures itself because the stage's width is a persisted PIXEL preference and the room it
 * has is not: the window resizes, and so does the sidebar beside it. `fitStage` turns the two into the
 * layout — side by side while both are readable, the stage laid OVER the conversation once they are
 * not (document-workspace.md, "Responsive behavior").
 */
export function SurfaceHost() {
  const dockOpen = useWorkspace(stageVisible)
  const stageExpanded = useWorkspace((s) => s.stageExpanded)
  // The persisted divider position is the DOCK's width now (the conversation fills the rest as a
  // centered reading column, Cursor-style — so the dock can slide in/out without the conversation
  // jumping between two layouts).
  const dockWidth = useWorkspace((s) => s.conversationWidth)
  const setDockWidth = useWorkspace((s) => s.setConversationWidth)
  const setDockOpen = useWorkspace((s) => s.setDockOpen)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  const reduce = useReducedMotion()
  const rowRef = useRef<HTMLDivElement>(null)
  // While dragging the divider, width must track the cursor exactly — so the open/close tween is
  // suppressed (otherwise every drag frame would re-animate toward a moving target and lag).
  const [resizing, setResizing] = useState(false)
  const [rowWidth, setRowWidth] = useState(0)

  // Observed rather than read off `window`: the sidebar's own drag changes this row's width without a
  // window resize, and a stage clamped only at window-resize time would still overflow. Layout effect
  // + an immediate first measure so the first paint is already clamped instead of snapping.
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const measure = (): void => setRowWidth(row.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  const fit = fitStage(rowWidth, dockWidth)
  // Expanded is the user asking for the whole window on purpose; it keeps its own full-width path.
  const overlay = fit.overlay && !stageExpanded
  const fullWidth = stageExpanded || overlay
  const dockFrameWidth: number | string = fullWidth ? '100%' : fit.width
  // Overlaid, the panel is already the row's full width, so it comes and goes by SLIDING off the right
  // edge; side by side it still opens by growing, which is what lets the conversation reflow with it.
  const away = overlay ? { width: '100%', x: '100%' } : { width: 0, x: 0 }

  return (
    <div ref={rowRef} className="relative flex h-full min-h-0">
      {!stageExpanded && (
        <div className="min-w-0 flex-1">
          <ConversationSurface />
        </div>
      )}
      <AnimatePresence initial={false}>
        {dockOpen && (
          <motion.div
            key="dock"
            className={
              overlay
                ? // Its own background: side by side the stage inherits the shell's, but laid OVER the
                  // conversation a transparent panel reads as two surfaces printed on each other.
                  'absolute inset-y-0 right-0 z-10 h-full overflow-hidden bg-bg shadow-pop'
                : `relative h-full shrink-0 overflow-hidden ${stageExpanded ? '' : 'border-l border-border'}`
            }
            initial={away}
            animate={{ width: dockFrameWidth, x: 0 }}
            exit={away}
            transition={
              reduce || resizing
                ? { duration: 0 }
                : overlay
                  ? spring.gentle
                  : { duration: duration.slow, ease: ease.out }
            }
          >
            {/* Overlaid, the stage covers the session header that holds the show/hide toggle, so the
                way back has to live on the stage itself. On the panel's left edge (inside its overflow,
                so it travels with the slide) and first in the tab order: the exit before the room. */}
            {overlay && (
              <button
                type="button"
                onClick={() => setDockOpen(false)}
                title="Hide the stage"
                aria-label="Hide the stage and show the conversation"
                className="absolute left-0 top-1/2 z-10 grid h-14 w-3.5 -translate-y-1/2 place-items-center rounded-r-md border border-l-0 border-border bg-surface text-text-muted shadow-soft transition-colors hover:bg-text/5 hover:text-text"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            )}
            {/* Fixed width, pinned to the left edge of the (growing) panel so the dock's content
                doesn't reflow as the width animates — it slides in with the panel, then settles. */}
            <div style={{ width: dockFrameWidth }} className="absolute inset-y-0 left-0">
              <Dock />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* The divider straddles the dock's left border. It lives OUTSIDE the dock's overflow-hidden
          (which would clip a border-straddling handle to half + push it into the dock) and above it
          (so it's reliably grabbable over the preview iframe). Positioned at the boundary = the drawn
          width in from the row's right edge; `translate-x-1/2` (default) centers it on the border.
          Overlaid there is no boundary to drag — the stage is the whole row. */}
      {dockOpen && !stageExpanded && !overlay && (
        <ResizeHandle
          orientation="vertical"
          style={{ right: fit.width }}
          onResize={(x) => {
            if (!resizing) setResizing(true)
            const r = rowRef.current?.getBoundingClientRect()
            // Capped at what the row can hold, so what gets PERSISTED on release is the width the user
            // actually saw. A window resize never writes here — that clamp is display-only.
            if (r) setDockWidth(Math.min(r.right - x, fit.maxWidth))
          }}
          onResizeEnd={() => {
            setResizing(false)
            persistLayout()
          }}
        />
      )}
    </div>
  )
}
