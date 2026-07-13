import { useEffect, useState } from 'react'
import type { UpdateStatus, WhatsNew } from '@shared/ipc'
import { AnimatePresence, motion } from '../motion'
import { Markdown } from '../output/Markdown'
import { Button } from '../ui'

// The public changelog the popup links out to. window.open routes through main's
// window-open handler → shell.openExternal, so it opens in the user's browser.
const CHANGELOG_URL = 'https://kodahq.io/changelog'

/**
 * Two calm, app-global update surfaces (releases-and-updates.md, downstream half):
 *  - a passive "restart to update" banner once a new version has downloaded (never a forced restart);
 *  - a one-time "What's New" toast after an update (bottom-right, non-modal), read offline from the
 *    bundled CHANGELOG — it sits over the workspace instead of covering it.
 * Mounted once per resolved window; the What's New fetch is single-shot in main, so only the first
 * window to mount shows it. Both are dismissable — the update still installs on the next quit.
 */
export function UpdateSurface() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [whatsNew, setWhatsNew] = useState<WhatsNew>(null)

  useEffect(() => {
    window.koda.getUpdateStatus().then(setStatus).catch(console.error)
    const off = window.koda.onUpdateStatus(setStatus)
    window.koda.getWhatsNew().then(setWhatsNew).catch(console.error)
    return off
  }, [])

  const showBanner = status.state === 'ready' && !bannerDismissed

  return (
    <>
      <AnimatePresence>
        {showBanner && (
          <motion.div
            key="update-banner"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2"
          >
            {/* w-max + nowrap children: the pill hugs its content and never wraps, even in a narrow pane.
                The message gets left breathing room (pl-5); the two actions are grouped on the right so the
                CTA never reads as jammed against the text. */}
            <div className="flex w-max items-center gap-5 rounded-2xl border border-border bg-surface py-2.5 pl-5 pr-2.5 shadow-soft">
              <span className="whitespace-nowrap text-[13px] text-text">
                A new version of Koda is ready.
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setBannerDismissed(true)}
                  className="whitespace-nowrap rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-text-muted transition-colors hover:bg-text/5 hover:text-text"
                  aria-label="Dismiss"
                >
                  Later
                </button>
                <Button
                  variant="primary"
                  className="whitespace-nowrap"
                  onClick={() => void window.koda.quitAndInstallUpdate()}
                >
                  Restart to update
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {whatsNew && (
          <motion.div
            key="whats-new"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            // Bottom-right, non-modal: flexible width that hugs its content within a readable range.
            className="fixed right-5 bottom-5 z-40 flex w-max min-w-[300px] max-w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-soft"
          >
            <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-1.5">
              <div>
                <div className="font-display text-[10.5px] font-semibold uppercase tracking-wider text-accent">
                  What's new
                </div>
                <h2 className="mt-0.5 font-display text-[15.5px] font-semibold text-text">
                  Koda {whatsNew.version}
                </h2>
              </div>
              <button
                onClick={() => setWhatsNew(null)}
                className="-mr-1 rounded-md px-1.5 text-[15px] leading-none text-text-muted hover:bg-text/5 hover:text-text"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <div className="max-h-[240px] overflow-y-auto px-4 pt-0.5 pb-1 text-[12.5px]">
              <Markdown>{whatsNew.markdown}</Markdown>
            </div>
            <div className="flex items-center justify-between px-4 pt-2 pb-3.5">
              <Button
                variant="ghost"
                onClick={() => window.open(CHANGELOG_URL, '_blank')}
              >
                See full details
              </Button>
              <Button variant="primary" onClick={() => setWhatsNew(null)}>
                Got it
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
