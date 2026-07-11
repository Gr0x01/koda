import { AnimatePresence, motion, duration, ease } from '../motion'
import { SurfaceHost } from '../surface/SurfaceHost'
import { ImageLightbox } from '../surface/ImageLightbox'
import { Settings } from '../settings/Settings'
import { Sidebar } from './Sidebar'
import { SourceControl } from './SourceControl'
import { SearchOverlay } from './SearchOverlay'
import { TitleBar } from './TitleBar'
import { StatusBar, BillingFallbackBanner } from './StatusBar'
import { useWorkspace, activeEditor, PREVIEW_SURFACE_ID } from './store'

// Settings / Versions swap in over the workspace: a soft fade + short rise, quicker fade-out. No scale
// (a full-cover panel zooming reads as a jump); the small y-lift gives it a "settles into place" feel.
const panelVariants = {
  hidden: { opacity: 0, y: 10, transition: { duration: duration.fast, ease: ease.out } },
  visible: { opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.out } },
}

/**
 * The workspace chassis (ui-workspace.md §2) — Cursor's proven shell, inverted to be
 * conversation-first: a slim activity rail, the sessions sidebar (§7), the surface host (the
 * conversation, with artifact surfaces beside it later), and an ambient status bar. Replaces the
 * top-tab stopgap. Built on the store's flat session map + layout seam, so split/tile/multi-window
 * are additive later without reworking this shell.
 */
export function Chassis() {
  const settingsOpen = useWorkspace((s) => s.settingsOpen)
  const versionsOpen = useWorkspace((s) => s.versionsOpen)
  const setVersionsOpen = useWorkspace((s) => s.setVersionsOpen)
  const searchOpen = useWorkspace((s) => s.searchOpen)
  const previewExpanded = useWorkspace(
    (s) => s.previewExpanded && s.dockOpen && activeEditor(s).activeSurfaceId === PREVIEW_SURFACE_ID,
  )

  // The activity rail is gone: Sessions is the sidebar (always present), everyday change review lives
  // in the Changes dock tab, and Settings / the full Versions (history) view are corner-summoned
  // overlays over the main area. Versions is the deep history surface (graph + branch review); the
  // everyday per-session save+review is the dock's Changes tab.
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-text antialiased">
      <TitleBar />
      <BillingFallbackBanner />
      {/* The workspace stays mounted underneath; Settings / Versions animate in as a full-cover layer
          over it (fade + soft rise) and fall away on close instead of hard-cutting. AnimatePresence lives
          here — the parent that owns the open flags — so the exit actually plays. */}
      <div className="relative flex min-h-0 flex-1">
        {!previewExpanded && <Sidebar />}
        {/* The main area sits flush against the window and is divided from the sidebar by a single
            hairline (the sidebar's right border) — flat and grounded, matching the sidebar's own
            square, edge-to-edge chrome rather than floating as a separate rounded card. */}
        <main className="min-h-0 flex-1 overflow-hidden">
          <SurfaceHost />
        </main>

        <AnimatePresence>
          {settingsOpen ? (
            <motion.div
              key="settings"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="absolute inset-0 z-20 overflow-hidden bg-bg"
            >
              <Settings />
            </motion.div>
          ) : versionsOpen ? (
            // Full-area history — the deep graph/branch-review view, summoned from the status bar or the
            // Changes tab's "History →". Returns to the workspace via its back affordance.
            <motion.div
              key="versions"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className="absolute inset-0 z-20 overflow-hidden bg-bg"
            >
              <SourceControl onLeave={() => setVersionsOpen(false)} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <StatusBar />

      {/* Find overlay — summoned over everything (⌘P / ⌘⇧F); mounted only while open so each open is
          a fresh autofocus + clean state. AnimatePresence defers the unmount so it animates out. */}
      <AnimatePresence>{searchOpen && <SearchOverlay />}</AnimatePresence>

      {/* The one image preview — opened by any thumbnail anywhere (composer, transcript, Recent images). */}
      <ImageLightbox />
    </div>
  )
}
