import { useEffect, useState } from 'react'
import { useWorkspace } from './store'
import { Button } from '../ui'

/**
 * The ProjectHome screen (ui-workspace.md §9) — a window with no project yet. Pick a folder (native
 * dialog) or reopen a recent one; that becomes this window's project in place (one project per
 * window). If the folder is already open elsewhere, main focuses that window and we stay here.
 */
export function ProjectHome() {
  const setProjectPath = useWorkspace((s) => s.setProjectPath)
  const setIntakePending = useWorkspace((s) => s.setIntakePending)
  const [recents, setRecents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    window.koda.getRecentProjects().then(setRecents).catch(() => {})
  }, [])

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

  return (
    // The Chassis title bar that normally moves the frameless window doesn't exist on this no-project
    // screen, so add the same top drag strip here. A full-screen drag region would swallow the OS
    // edge-resize border on macOS — keep it a top bar (matching Chassis) so the window still resizes.
    <div className="relative flex h-screen w-screen flex-col items-center justify-center gap-7 bg-bg px-6 text-text">
      <div className="app-drag absolute inset-x-0 top-0 h-9" />
      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(projectPath) => {
            setIntakePending(true) // the workspace opens on the intake empty-state
            setProjectPath(projectPath)
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

      {recents.length > 0 && (
        <div className="w-full max-w-md">
          <h2 className="mb-2 px-1 font-display text-xs font-semibold uppercase tracking-wider text-text-muted">
            Recent
          </h2>
          <ul className="flex flex-col gap-1">
            {recents.map((path) => (
              <li key={path}>
                <button
                  onClick={() => void open(path)}
                  disabled={busy}
                  title={path}
                  className="flex w-full items-baseline gap-2 rounded-xl border border-transparent px-3 py-2 text-left transition-colors hover:border-border hover:bg-surface disabled:opacity-50"
                >
                  <span className="truncate text-sm text-text">{basename(path)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-text-muted">{path}</span>
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
