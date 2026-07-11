import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../../workspace/store'
import { IconButton, Input } from '../../ui'

/**
 * The session's own header bar (ui-workspace.md §3) — the whole strip belongs to the session
 * (Cursor-style), not the window chrome. Title on the left (double-click to rename); on the right a
 * kebab menu (⋮) holding the session actions and a dock-toggle button. Keyed by session id upstream,
 * so rename/menu state is fresh per session.
 */
export function SessionHeader({
  label,
  onRename,
  onArchive,
}: {
  label: string
  onRename: (name: string) => void
  onArchive: () => void
}) {
  const dockOpen = useWorkspace((s) => s.dockOpen)
  const toggleDock = useWorkspace((s) => s.toggleDock)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(label)

  function startRename(): void {
    setDraft(label)
    setRenaming(true)
  }
  function commitRename(): void {
    const name = draft.trim()
    if (name && name !== label) onRename(name)
    setRenaming(false)
  }

  return (
    <div className="flex w-full items-center justify-between gap-3">
      {renaming ? (
        <Input
          autoFocus
          mono={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') setRenaming(false)
          }}
          onBlur={commitRename}
          // Override the Input default sizing to match the display-face title style
          className="min-w-0 flex-1 border-accent/50 bg-bg py-0.5 font-display text-sm font-semibold tracking-tight"
        />
      ) : (
        <h2
          onDoubleClick={startRename}
          title="Double-click to rename"
          className="min-w-0 cursor-text truncate font-display text-sm font-semibold tracking-tight"
        >
          {label}
        </h2>
      )}
      {/* Kebab on the left of the action group, dock toggle on the far right (nearest the dock it controls). */}
      <div className="flex shrink-0 items-center gap-1.5">
        <SessionMenu onRename={startRename} onArchive={onArchive} />
        <IconButton
          label={dockOpen ? 'Hide panel' : 'Show panel'}
          size="sm"
          onClick={toggleDock}
          className={dockOpen ? 'text-text' : 'text-text-muted hover:text-text'}
        >
          <IconPanel />
        </IconButton>
      </div>
    </div>
  )
}

/**
 * The session kebab (⋮) — replaces the bare ✕. Archive ends the live agent and puts the session away
 * (the whole conversation is kept — restore it from Settings → Archived sessions), so it's a plain,
 * non-destructive single click: no confirm.
 */
function SessionMenu({ onRename, onArchive }: { onRename: () => void; onArchive: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <IconButton
        label="Session options"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className={open ? 'bg-bg text-text' : 'text-text-muted'}
      >
        <IconKebab />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5 w-44 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-pop">
          <button
            onClick={() => {
              setOpen(false)
              onRename()
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-bg"
          >
            Rename
          </button>
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => {
              setOpen(false)
              onArchive()
            }}
            title="End this session and put it away. Restore it any time from Settings"
            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-bg"
          >
            Archive session
          </button>
        </div>
      )}
    </div>
  )
}

// The panel-toggle glyph (a framed pane with a divided right column) — the dock show/hide control.
function IconPanel() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  )
}

function IconKebab() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" className="shrink-0" aria-hidden>
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  )
}
