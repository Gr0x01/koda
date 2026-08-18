import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, duration, ease } from '../motion'
import { SurfaceHost } from '../surface/SurfaceHost'
import { ImageLightbox } from '../surface/ImageLightbox'
import { Settings } from '../settings/Settings'
import { AppFace } from './AppFace'
import { Sidebar } from './Sidebar'
import { SourceControl } from './SourceControl'
import { SearchOverlay } from './SearchOverlay'
import { LibraryHost } from './library/LibraryHost'
import { TitleBar } from './TitleBar'
import { StatusBar, BillingFallbackBanner, AccountSignInBanner, DataIntegrityBanner } from './StatusBar'
import { stageVisible, useWorkspace } from './store'
import { windowHasOpenModal } from '../window-modal'
import { handleFileMenuCommand } from './file-menu-command'

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
  // Stage expanded: the sidebar steps aside too, so the staged surface really is the whole window.
  const stageExpanded = useWorkspace((s) => s.stageExpanded && stageVisible(s))
  const projectPath = useWorkspace((s) => s.projectPath)
  const faceDir = useWorkspace((s) => s.faceDir)
  const faceOn = useWorkspace((s) => !!s.faceDir && s.faceView === 'app')

  // The sidebar's Files tree is gone, so the native File menu remains the app-wide route to these.
  // New document is also visible inside the Library, where document creation belongs; either route
  // lands in the user's Documents/ home and opens on the Stage. A new folder still lands at the
  // project root. `filesRev` keeps the Library, document shelf, and @-mention picker live.
  //
  // A folder created this way keeps the name main gave it: rename-on-create needed the tree's inline
  // editor, and nothing else in the renderer can rename a folder. Flagged for RB rather than patched
  // over with invented UI.
  useEffect(() =>
    window.koda.onFileMenuCommand((command) => {
      const s = useWorkspace.getState()
      handleFileMenuCommand(command, {
        newDocument: () => void s.newDocument(),
        newFolder: () => void s.newFolder(),
        importFiles: () =>
          void window.koda
            .importFilesFromMenu()
            .then((result) => result && useWorkspace.setState((state) => ({ filesRev: state.filesRev + 1 })))
            .catch(console.error),
        filesImported: () => useWorkspace.setState((state) => ({ filesRev: state.filesRev + 1 })),
        // The visible doc editor answers (it owns the rendered DOM); no doc on the Stage = no-op.
        exportPdf: () => window.dispatchEvent(new CustomEvent('koda:export-pdf')),
      })
    }), [])

  // Mini apps (the face): learn this project's registered apps, then front one — either the app the
  // user clicked on ProjectHome's rail (pendingFaceDir, one-shot like intakePending), or, per the FACE
  // model, ANY faced project opens on its face (the workshop is behind it, one toggle away). Flag off
  // ⇒ the list is empty ⇒ this never fronts anything.
  useEffect(() => {
    if (!projectPath) return
    void useWorkspace
      .getState()
      .refreshMiniApps()
      .then(() => {
        const s = useWorkspace.getState()
        const pending = s.pendingFaceDir
        if (pending) s.setPendingFaceDir(null) // one-shot: consumed the moment it's looked at
        if (pending && s.miniApps.some((a) => a.dir === pending)) {
          s.openFace(pending)
        } else if (!s.faceDir) {
          const own = s.miniApps.find((a) => a.projectPath === projectPath)
          if (own) s.openFace(own.dir)
        }
      })
  }, [projectPath])

  // Graduation, live: a window opened BEFORE the agent built its app only fetched the list once
  // (above), so the face never appeared — the agent said "your app is running" over an unchanged
  // workshop. Main pushes registry changes; re-fetch, then front the new face only once every
  // session's turn is over — flipping mid-turn would hide the agent's progress (and any approval
  // prompt) behind the full-bleed face.
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((x) => x.busy))
  const revealPending = useRef(false)
  const maybeReveal = (): void => {
    if (!revealPending.current) return
    const s = useWorkspace.getState()
    if (Object.values(s.sessions).some((x) => x.busy)) return
    revealPending.current = false
    if (s.faceDir) return // the user already fronted (or dismissed to) a face themselves
    const own = s.miniApps.find((a) => a.projectPath === s.projectPath)
    if (own) s.openFace(own.dir)
  }
  useEffect(() => {
    // Optional-chained: in dev, HMR can hand this renderer to a preload that predates the API.
    return window.koda.onMiniAppsChanged?.(() => {
      void useWorkspace
        .getState()
        .refreshMiniApps()
        .then(() => {
          const s = useWorkspace.getState()
          if (!s.faceDir && s.miniApps.some((a) => a.projectPath === s.projectPath)) {
            revealPending.current = true
          }
          maybeReveal() // already idle ⇒ reveal now (no busy edge will fire)
        })
    })
  }, [])
  useEffect(() => {
    if (!anyBusy) maybeReveal()
  }, [anyBusy])

  // Already-open handoff: main surfaced this window because the user clicked its app tile elsewhere.
  // Front that app's face (openFace flips to the app view) so the click lands on the running app.
  useEffect(() => {
    return window.koda.onFrontFace?.((dir) => {
      const s = useWorkspace.getState()
      if (s.miniApps.some((a) => a.dir === dir)) s.openFace(dir)
    })
  }, [])

  // ⌘\ flips figure and ground (matches the TitleBar toggle's hint). Only bound while the project
  // actually has an app fronted or frontable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (windowHasOpenModal()) return
      if (!(e.metaKey && e.key === '\\')) return
      const s = useWorkspace.getState()
      if (!s.faceDir) return
      e.preventDefault()
      s.setFaceView(s.faceView === 'app' ? 'workshop' : 'app')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The activity rail is gone: Sessions is the sidebar (always present), everyday change review lives
  // in the Changes dock tab, and Settings / the full Versions (history) view are corner-summoned
  // overlays over the main area. Versions is the deep history surface (graph + branch review); the
  // everyday per-session save+review is the dock's Changes tab.
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-text antialiased">
      <TitleBar />
      <DataIntegrityBanner />
      <BillingFallbackBanner />
      <AccountSignInBanner />
      {/* The workspace stays mounted underneath; Settings / Versions animate in as a full-cover layer
          over it (fade + soft rise) and fall away on close instead of hard-cutting. AnimatePresence lives
          here — the parent that owns the open flags — so the exit actually plays. */}
      <div className="relative flex min-h-0 flex-1">
        {/* Face fronted ⇒ the app IS the window (mini-apps-plan.md FACE model): no sidebar, no dock,
            no status bar. BOTH sides stay mounted and flip via CSS — unmounting the workshop would
            dispose the Dock terminal's xterm (losing scrollback while the pty keeps printing), and
            unmounting the face would reload the app's iframe state on every ⌘\ round-trip. */}
        {!stageExpanded && (
          <div className={faceOn ? 'hidden' : 'contents'}>
            <Sidebar />
          </div>
        )}
        {/* The main area sits flush against the window and is divided from the sidebar by a single
            hairline (the sidebar's right border) — flat and grounded, matching the sidebar's own
            square, edge-to-edge chrome rather than floating as a separate rounded card. */}
        <main className={`min-h-0 flex-1 overflow-hidden ${faceOn ? 'hidden' : ''}`}>
          <SurfaceHost />
        </main>
        {faceDir && (
          <main className={`min-h-0 flex-1 overflow-hidden ${faceOn ? 'flex' : 'hidden'}`}>
            <AppFace />
          </main>
        )}

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

      {!faceOn && <StatusBar />}

      {/* Find overlay — summoned over everything (⌘P / ⌘⇧F); mounted only while open so each open is
          a fresh autofocus + clean state. AnimatePresence defers the unmount so it animates out. */}
      <AnimatePresence>{searchOpen && <SearchOverlay />}</AnimatePresence>

      {/* The Library (⌘K) — the document surface, beside the code-shaped Find overlay rather than
          inside it. It owns its own open flag and AnimatePresence. */}
      <LibraryHost />

      {/* The one image preview — opened by any thumbnail anywhere (composer, transcript, Recent images). */}
      <ImageLightbox />
    </div>
  )
}
