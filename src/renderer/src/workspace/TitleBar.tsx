import { RemoteMenu } from './RemoteMenu'
import { Segmented } from '../ui'
import { useWorkspace } from './store'

// ── Title bar ────────────────────────────────────────────────────────────────────
// A slim draggable strip so the frameless window can be moved; left inset clears the
// macOS traffic lights (positioned in main/index.ts). Shows "Koda — <folder>" centered
// (the one place the name belongs); the folder is the active session's cwd until step 6
// gives the window a real project context.
export function TitleBar() {
  const folder = useWorkspace((s) => {
    const cwd = s.activeId ? s.sessions[s.activeId]?.cwd : undefined
    return cwd?.replace(/\/+$/, '').split('/').pop() || ''
  })
  // Under `npm run dev` the strip's bottom divider goes amber so a dev instance reads at a glance
  // next to the installed .app — a colored seam, not a filled band, so it stays out of the way.
  const dev = import.meta.env.DEV
  return (
    <div
      className={`app-drag relative flex h-9 shrink-0 items-center bg-bg px-3 ${dev ? 'border-b-2' : 'border-b border-border'}`}
      style={dev ? { borderBottomColor: '#f4c000' } : undefined}
    >
      {/* Find moved into the Files panel header, so the label can recenter. Equal flex-1 spacers
          center it across the full bar; at real window widths it never reaches the traffic lights. */}
      <div className="flex-1" />
      <div className="shrink truncate text-center font-display text-xs font-medium text-text-muted">
        {dev ? 'KODA DEV' : 'Koda'}
        {folder && <span className="text-text-muted/60"> — {folder}</span>}
      </div>
      <div className="flex-1" />
      {/* Pinned absolute (not in the flex flow) so the title stays truly centered regardless of the
          cluster width. inset-y-0 + flex centers it over the full bar height — no half-pixel translate
          rounding. app-no-drag so the controls are clickable inside the draggable strip. Kept to two
          tenants (the face flip + Remote) — the theme quick-toggle moved to the status bar so this
          strip stays calm. */}
      <div className="app-no-drag absolute inset-y-0 right-3 flex items-center gap-2.5">
        <FaceToggle />
        <RemoteMenu />
      </div>
    </div>
  )
}

// ── App | Workshop ───────────────────────────────────────────────────────────────
// The figure-ground flip for a faced project (mini-apps-plan.md "Desktop FACE model"): App = the
// running mini app full-bleed; Workshop = the normal Koda chassis behind it. Only rendered when this
// window's project has a registered app — for everyone else the title bar is unchanged (and the
// mini-apps flag being off means the list is always empty, so this never shows).
function FaceToggle() {
  const hasApp = useWorkspace((s) => s.miniApps.some((a) => a.projectPath === s.projectPath))
  const firstAppDir = useWorkspace(
    (s) => s.miniApps.find((a) => a.projectPath === s.projectPath)?.dir,
  )
  const faceView = useWorkspace((s) => s.faceView)
  const faceDir = useWorkspace((s) => s.faceDir)
  const openFace = useWorkspace((s) => s.openFace)
  const setFaceView = useWorkspace((s) => s.setFaceView)
  if (!hasApp) return null
  const onApp = faceView === 'app' && !!faceDir
  return (
    <Segmented
      aria-label="App or workshop"
      options={[
        { value: 'app', label: 'App', title: 'The running app (⌘\\)' },
        { value: 'workshop', label: 'Workshop', title: 'The full workspace behind it (⌘\\)' },
      ]}
      value={onApp ? 'app' : 'workshop'}
      onChange={(v) => {
        if (v === 'workshop') setFaceView('workshop')
        else if (faceDir) setFaceView('app')
        else if (firstAppDir) openFace(firstAppDir)
      }}
    />
  )
}
