import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LocalLinkContext } from '../output/Markdown'
import { AnimatePresence, duration, ease, motion } from '../motion'
import { useWorkspace } from './store'
import { followRefusalCopy, followSession } from './session-href'
import { classifyStageHref } from '@shared/stage-links'

/**
 * Desktop-only: makes local-file links inside assistant markdown open in the Stage
 * (the same openFile path the Files tree uses) instead of the browser. The agent
 * often writes a doc and links it in its reply — that link's href is a project path,
 * which in a dev build would otherwise resolve to a localhost URL and open the
 * browser. Here it lands as a doc surface. Web links are untouched (see MarkdownLink).
 *
 * It also owns the SESSION door (`koda://session/<id>`, see session-href.ts): a link that lands the
 * user in the conversation a document or a citation came out of. That href is always claimed, even
 * when the chat behind it is gone, because falling through would hand `window.open` a scheme nothing
 * on the machine can serve. A refused follow says so in the status line below rather than swallowing
 * the click — the one path where the door's state can't be read before the user commits to it.
 */
export function StageLinkProvider({ children }: { children: ReactNode }) {
  const openFile = useWorkspace((s) => s.openFile)
  const activeId = useWorkspace((s) => s.activeId)
  const [refusal, setRefusal] = useState<string | null>(null)
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reportRefusal = useCallback((message: string) => {
    setRefusal(message)
    if (refusalTimer.current) clearTimeout(refusalTimer.current)
    refusalTimer.current = setTimeout(() => setRefusal(null), REFUSAL_LINGER_MS)
  }, [])

  useEffect(
    () => () => {
      if (refusalTimer.current) clearTimeout(refusalTimer.current)
    },
    [],
  )

  const handle = useCallback(
    (href: string): boolean => {
      const link = classifyStageHref(href)
      if (link.kind === 'session') {
        void followSession(link.sessionId, useWorkspace.getState).then((outcome) => {
          const refused = followRefusalCopy(outcome)
          if (refused) reportRefusal(refused)
        })
        return true
      }
      if (link.kind !== 'file') return false
      void window.koda
        .resolveStageLink({ ...(activeId ? { sessionId: activeId } : {}), href })
        .then((target) => {
          if (target.kind !== 'file') {
            if (target.reason) reportRefusal(target.reason)
            return
          }
          const state = useWorkspace.getState()
          const cwd = activeId ? state.sessions[activeId]?.cwd : state.projectPath
          const absolute = target.absolutePath ?? (cwd ? `${cwd.replace(/\/+$/, '')}/${target.path}` : null)
          if (!absolute) return reportRefusal("Koda couldn't place that file on this Stage.")
          openFile(absolute, target.line, {
            ...(target.line !== undefined ? { view: 'file' as const } : {}),
            gotoColumn: target.column,
          })
        })
        .catch(() => reportRefusal("Koda couldn't open that local link."))
      return true
    },
    [activeId, openFile, reportRefusal],
  )

  return (
    <LocalLinkContext.Provider value={handle}>
      {children}
      {/* The live region is mounted for the life of the workspace and only its CONTENTS come and go:
          a screen reader announces text inserted into a region it already knows about, and misses a
          region that appears with its message already inside it. Centering lives here too, because
          motion owns the inner element's `transform`. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-6"
      >
        <AnimatePresence>
          {refusal && (
            <motion.div
              key="refusal"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: duration.base, ease: ease.out }}
              className="max-w-md rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] leading-snug text-text shadow-soft"
            >
              {refusal}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LocalLinkContext.Provider>
  )
}

/** Long enough to read a short sentence twice, short enough that it never becomes furniture. */
const REFUSAL_LINGER_MS = 5000
