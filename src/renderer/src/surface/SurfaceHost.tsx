import { useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, duration, ease } from '../motion'
import { ConversationSurface } from './ConversationSurface'
import { Dock } from './Dock'
import { ResizeHandle } from '../workspace/ResizeHandle'
import { useWorkspace, activeEditor, PREVIEW_SURFACE_ID } from '../workspace/store'

/**
 * The breathing center (ui-workspace.md §3/§4). The conversation is ALWAYS present and premium; a
 * collapsible right DOCK sits beside it — the STAGE: one surface showing the thing that matters now
 * (the running app, the doc the agent is writing, the diff it just made), never a strip of tool tabs.
 * Under it: the terminal shelf (summoned) and the desk (the changes strip + review sheet). Collapsed
 * (`dockOpen`=false) the conversation takes the full width and nothing running is torn down (the
 * preview dev server keeps going). Toggled from the session header.
 */
export function SurfaceHost() {
  const dockOpen = useWorkspace((s) => s.dockOpen)
  const previewExpanded = useWorkspace(
    (s) => s.previewExpanded && activeEditor(s).activeSurfaceId === PREVIEW_SURFACE_ID,
  )
  // The persisted divider position is the DOCK's width now (the conversation fills the rest as a
  // centered reading column, Cursor-style — so the dock can slide in/out without the conversation
  // jumping between two layouts).
  const dockWidth = useWorkspace((s) => s.conversationWidth)
  const setDockWidth = useWorkspace((s) => s.setConversationWidth)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  const reduce = useReducedMotion()
  const rowRef = useRef<HTMLDivElement>(null)
  // While dragging the divider, width must track the cursor exactly — so the open/close tween is
  // suppressed (otherwise every drag frame would re-animate toward a moving target and lag).
  const [resizing, setResizing] = useState(false)
  const dockFrameWidth: number | string = previewExpanded ? '100%' : dockWidth

  return (
    <div ref={rowRef} className="relative flex h-full min-h-0">
      {!previewExpanded && (
        <div className="min-w-0 flex-1">
          <ConversationSurface />
        </div>
      )}
      <AnimatePresence initial={false}>
        {dockOpen && (
          <motion.div
            key="dock"
            className={`relative h-full shrink-0 overflow-hidden ${previewExpanded ? '' : 'border-l border-border'}`}
            initial={{ width: 0 }}
            animate={{ width: dockFrameWidth }}
            exit={{ width: 0 }}
            transition={reduce || resizing ? { duration: 0 } : { duration: duration.slow, ease: ease.out }}
          >
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
          (so it's reliably grabbable over the preview iframe). Positioned at the boundary = dockWidth
          in from the row's right edge; `translate-x-1/2` (default) centers it on the border. */}
      {dockOpen && !previewExpanded && (
        <ResizeHandle
          orientation="vertical"
          style={{ right: dockWidth }}
          onResize={(x) => {
            if (!resizing) setResizing(true)
            const r = rowRef.current?.getBoundingClientRect()
            if (r) setDockWidth(r.right - x)
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
