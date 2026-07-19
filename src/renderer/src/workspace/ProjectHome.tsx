import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { MiniAppInfo } from '@shared/ipc'
import { useWorkspace } from './store'
import { Button } from '../ui'

/**
 * The ProjectHome screen (ui-workspace.md §9) — a window with no project yet. Pick a folder (native
 * dialog) or reopen a recent one; that becomes this window's project in place (one project per
 * window). If the folder is already open elsewhere, main focuses that window and we stay here.
 *
 * Mini apps (the FACE model): faced projects graduate OFF the recents list and onto the left app
 * rail — always visible, one click opens the project landing on its running face. The rail only
 * exists when registered apps exist (mini-apps flag off ⇒ the list is always empty ⇒ no rail).
 */
export function ProjectHome({ openCreate = false }: { openCreate?: boolean }) {
  const setProjectPath = useWorkspace((s) => s.setProjectPath)
  const setIntakePending = useWorkspace((s) => s.setIntakePending)
  const setPendingFaceDir = useWorkspace((s) => s.setPendingFaceDir)
  const [recents, setRecents] = useState<string[]>([])
  const [apps, setApps] = useState<MiniAppInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Opened via "New Project…": land with the create modal up (main sends this one-shot).
  const [creating, setCreating] = useState(openCreate)
  const [deleting, setDeleting] = useState<{ path: string; name: string } | null>(null)

  useEffect(() => {
    window.koda.getRecentProjects().then(setRecents).catch(() => {})
    window.koda.miniAppsList().then(setApps).catch(() => {})
    // A project graduating in another window surfaces on the rail here without a relaunch.
    // Optional-chained: in dev, HMR can hand this renderer to a preload that predates the API.
    return window.koda.onMiniAppsChanged?.(() => {
      window.koda.miniAppsList().then(setApps).catch(() => {})
    })
  }, [])

  function refetch(): void {
    window.koda.getRecentProjects().then(setRecents).catch(() => {})
    window.koda.miniAppsList().then(setApps).catch(() => {})
  }

  async function open(path: string): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.koda.openProject({ path })
      if (res.alreadyOpen) {
        setNote('That project is already open in another window.')
        setBusy(false)
        return
      }
      setProjectPath(res.projectPath) // App swaps this window over to the workspace
    } catch (e) {
      setNote(String(e))
      setBusy(false)
    }
  }

  async function choose(): Promise<void> {
    const { path } = await window.koda.chooseFolder()
    if (path) void open(path)
  }

  // Open an app from the rail: same project-open flow, but stage which face to land on FIRST — the
  // Chassis consumes pendingFaceDir on mount (one-shot, like intakePending) and fronts that app.
  async function openApp(app: MiniAppInfo): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.koda.openProject({ path: app.projectPath })
      if (res.alreadyOpen) {
        setNote(`${app.name} is already open in another window.`)
        setBusy(false)
        return
      }
      setPendingFaceDir(app.dir)
      setProjectPath(res.projectPath)
    } catch (e) {
      setNote(String(e))
      setBusy(false)
    }
  }

  // Faced projects live on the rail, not the recents list (they graduated).
  const plainRecents = recents.filter((p) => !apps.some((a) => a.projectPath === p))

  return (
    // The Chassis title bar that normally moves the frameless window doesn't exist on this no-project
    // screen, so add the same top drag strip here. A full-screen drag region would swallow the OS
    // edge-resize border on macOS — keep it a top bar (matching Chassis) so the window still resizes.
    <div className="relative flex h-screen w-screen flex-col items-center justify-center gap-7 bg-bg px-6 text-text">
      <div
        className={`app-drag absolute inset-x-0 top-0 flex h-9 items-center justify-center ${import.meta.env.DEV ? 'border-b-2' : ''}`}
        style={import.meta.env.DEV ? { borderBottomColor: '#f4c000' } : undefined}
      >
        {import.meta.env.DEV && (
          <span className="font-display text-xs font-semibold tracking-wide text-text-muted">
            KODA DEV
          </span>
        )}
      </div>
      {apps.length > 0 && (
        <nav
          aria-label="Your apps"
          className="absolute inset-y-0 left-0 flex w-[84px] flex-col items-center gap-2 overflow-y-auto border-r border-border bg-surface pb-4 pt-12"
        >
          <div className="mb-1 font-display text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Apps
          </div>
          {apps.map((app) => (
            <button
              key={app.dir}
              onClick={() => void openApp(app)}
              onContextMenu={(e) => {
                e.preventDefault()
                setDeleting({ path: app.projectPath, name: app.name })
              }}
              disabled={busy}
              title={app.name}
              className="flex w-full flex-col items-center gap-1 px-1.5 py-1 disabled:opacity-50"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent font-display text-lg font-semibold text-white shadow-soft transition-transform hover:scale-105">
                {(app.name[0] ?? '?').toUpperCase()}
              </span>
              <span className="w-full truncate text-center text-[10px] text-text-muted">{app.name}</span>
            </button>
          ))}
        </nav>
      )}
      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(projectPath) => {
            setIntakePending(true) // the workspace opens on the intake empty-state
            setProjectPath(projectPath)
          }}
        />
      )}
      {deleting && (
        <DeleteProjectModal
          path={deleting.path}
          name={deleting.name}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            setNote(`${deleting.name} moved to the Trash.`)
            refetch()
          }}
        />
      )}
      <div className="text-center">
        <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent font-display text-xl font-semibold text-white shadow-soft">
          K
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Open a project</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-text-muted">
          Start something new, or pick a folder you already have. Koda runs the agent there. Its
          sessions, files, and history all live with the project.
        </p>
      </div>

      <div className="flex items-center gap-2.5">
        <Button size="lg" onClick={() => setCreating(true)} disabled={busy}>
          + New project
        </Button>
        <button
          onClick={() => void choose()}
          disabled={busy}
          className="rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-text shadow-soft transition-colors hover:bg-bg disabled:opacity-50"
        >
          Choose folder…
        </button>
      </div>

      {note && <p className="text-xs text-text-muted">{note}</p>}

      {plainRecents.length > 0 && (
        <div className="w-full max-w-md">
          <h2 className="mb-2 px-1 font-display text-xs font-semibold uppercase tracking-wider text-text-muted">
            Recent
          </h2>
          <ul className="flex flex-col gap-1">
            {plainRecents.map((path) => (
              <li
                key={path}
                className="group flex items-center gap-1 rounded-xl border border-transparent transition-colors hover:border-border hover:bg-surface"
              >
                <button
                  onClick={() => void open(path)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setDeleting({ path, name: basename(path) })
                  }}
                  disabled={busy}
                  title={path}
                  className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-2 text-left disabled:opacity-50"
                >
                  <span className="truncate text-sm text-text">{basename(path)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{path}</span>
                </button>
                <button
                  onClick={() => setDeleting({ path, name: basename(path) })}
                  disabled={busy}
                  aria-label={`Delete ${basename(path)}`}
                  title="Delete project…"
                  className="mr-1.5 rounded-lg p-1.5 text-text-muted opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * "New project" — name it + pick where it lives; Koda makes the folder and opens it. The default
 * location is ~/Koda (main owns that default — we pass parentDir undefined). "Change…" swaps to an
 * absolute folder via the native picker. On success the caller swaps the window to the workspace
 * (where the intake empty-state greets the fresh project).
 */
function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (projectPath: string) => void
}) {
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState<string | null>(null) // null ⇒ default (~/Koda)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const location = parentDir ?? '~/Koda'
  const canCreate = trimmed.length > 0 && !busy

  // Esc dismisses the modal, matching the backdrop click-out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function changeLocation(): Promise<void> {
    const { path } = await window.koda.chooseFolder()
    if (path) setParentDir(path)
  }

  async function create(): Promise<void> {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.koda.createProject({
        name: trimmed,
        parentDir: parentDir ?? undefined,
      })
      onCreated(res.projectPath)
    } catch (e) {
      // Main throws a friendly message (name clash / invalid name) — surface it verbatim.
      setError(stripErrorPrefix(String(e)))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg font-semibold tracking-tight">New project</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
          Koda makes a folder for it. Nothing else on your Mac changes.
        </p>

        <div className="mt-4">
          <label className="mb-1.5 block text-xs font-medium text-text">Project name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="recipe-app"
            className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-text-muted focus:border-accent"
          />
        </div>

        <div className="mt-3.5">
          <label className="mb-1.5 block text-xs font-medium text-text">Location</label>
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text-muted">
              <span className="truncate">{location}</span>
            </div>
            <button
              onClick={() => void changeLocation()}
              disabled={busy}
              className="flex-none rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-bg disabled:opacity-50"
            >
              Change…
            </button>
          </div>
          {trimmed && (
            <p className="mt-2 text-[11px] text-text-muted">
              Creates <span className="font-mono">{joinDisplay(location, trimmed)}</span>
            </p>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-xl border border-border bg-bg px-3 py-2 text-xs text-red-500">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm text-text-muted transition-colors hover:text-text disabled:opacity-40"
          >
            Cancel
          </button>
          <Button size="lg" onClick={() => void create()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create & open'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * "Delete project" confirm — deletion is a move to the Trash (recoverable), and the copy says so.
 * Main enforces the real rules (path must be a known project, no open window); this modal just makes
 * the choice explicit and surfaces main's friendly refusals verbatim.
 */
function DeleteProjectModal({
  path,
  name,
  onClose,
  onDeleted,
}: {
  path: string
  name: string
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Type-to-confirm (the GitHub pattern): deleting a whole project shouldn't ride a reflex click —
  // typing the name is the proof the user read which project this is.
  const [typed, setTyped] = useState('')
  const confirmed = typed.trim() === name

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function remove(): Promise<void> {
    if (!confirmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.koda.deleteProject({ path })
      onDeleted()
    } catch (e) {
      setError(stripErrorPrefix(String(e)))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg font-semibold tracking-tight">Delete {name}?</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
          Its folder moves to the Trash — chats, files, and everything in it. You can put it back
          from the Trash anytime.
        </p>
        <p className="mt-2 truncate text-[11px] font-mono text-text-muted" title={path}>
          {path}
        </p>

        <div className="mt-4">
          <label className="mb-1.5 block text-xs font-medium text-text">
            Type <span className="font-mono">{name}</span> to confirm
          </label>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void remove()}
            placeholder={name}
            className="w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-text-muted focus:border-accent"
          />
        </div>

        {error && (
          <p className="mt-3 rounded-xl border border-border bg-bg px-3 py-2 text-xs text-red-500">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm text-text-muted transition-colors hover:text-text disabled:opacity-40"
          >
            Cancel
          </button>
          <Button size="lg" onClick={() => void remove()} disabled={!confirmed || busy}>
            {busy ? 'Moving…' : 'Move to Trash'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Join a (possibly `~`-prefixed) location with the project name for display only. */
function joinDisplay(location: string, name: string): string {
  return `${location.replace(/\/$/, '')}/${name}`
}

/** Electron wraps IPC handler throws as "Error: <msg>" — show just the message. */
function stripErrorPrefix(msg: string): string {
  return msg.replace(/^Error:\s*/, '')
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}
