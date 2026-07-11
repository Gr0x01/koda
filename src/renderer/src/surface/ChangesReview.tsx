import { useEffect, useRef, useState } from 'react'
import { type SessionChangeGroup } from '../workspace/store'
import { FileButton } from '../workspace/source-control/shared'
import { Button } from '../ui'

/** A version we just saved — kept so the calm "Saved as …" strip can offer a rename while it's fresh. */
export type SavedInfo = { sha: string; name: string }

/** A session's auto-generated version name (its title); falls back when a title isn't set yet. */
function nameForGroup(group: SessionChangeGroup): string {
  return group.label.trim() || 'Saved changes'
}

// One session's group of changes: a header (colored dot + label + count) and its files (with an "also
// edited by" hint when a sibling session touched the same file). Attribution only — saving is one
// version of everything, from the footer, so there's no per-group Save button competing here.
export function ChangeGroup({
  group,
  alsoBy,
  stagedPath,
  onSelect,
  onDiscard,
}: {
  group: SessionChangeGroup
  alsoBy: Record<string, string[]>
  stagedPath: string | null
  onSelect: (path: string) => void
  /** Discard one file's change (revert an edit, or remove a new file); returns error copy or null. */
  onDiscard: (path: string) => Promise<string | null>
}) {
  const isSession = group.sessionId !== null
  return (
    <div className="shrink-0 border-b border-border pb-1.5 last:border-b-0">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSession ? 'bg-accent' : 'bg-text-muted/50'}`}
          aria-hidden
        />
        {/* The group label is a session NAME (its title), not a section header — sentence-case + readable
            so it's clearly subordinate to the panel's "CHANGES" micro-label and reads as content. The
            no-session bucket is a category, so it stays muted. */}
        <span
          title={isSession ? group.label : undefined}
          className={`min-w-0 flex-1 truncate font-display text-[12.5px] leading-tight ${
            isSession ? 'font-medium text-text' : 'text-text-muted'
          }`}
        >
          {group.label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-text-muted/50">{group.files.length}</span>
      </div>
      <ul className="flex flex-col px-1.5">
        {group.files.map((f) => (
          <li key={f.path}>
            <FileButton
              file={f}
              active={stagedPath === f.path}
              onClick={() => onSelect(f.path)}
              title={`See what changed in ${f.path}`}
              onDiscard={() => onDiscard(f.path)}
              trailing={
                stagedPath === f.path ? (
                  // Fade on row hover so it clears the way for the discard ✕ sharing this right edge.
                  <span className="shrink-0 text-[10px] text-accent transition-opacity group-hover:opacity-0">
                    shown above ↑
                  </span>
                ) : undefined
              }
            />
            {alsoBy[f.path] && (
              <p className="ml-[26px] -mt-0.5 pb-0.5 text-[10px] italic text-text-muted/70">
                also edited by {alsoBy[f.path].join(', ')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// The desk's anchored footer: a quiet count label (what Save will save) on the left, one real Save
// button on the right. Collapse lives on the header now, so the footer no longer competes with a second
// caret. Saving commits the whole working tree as a single version, auto-named from the lone session.
export function Footer({
  groups,
  fileCount,
  onSaved,
}: {
  groups: SessionChangeGroup[]
  fileCount: number
  onSaved: (info: SavedInfo) => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sessionGroups = groups.filter((g) => g.sessionId !== null)
  const name =
    sessionGroups.length === 1
      ? nameForGroup(sessionGroups[0])
      : `Saved ${fileCount} ${fileCount === 1 ? 'change' : 'changes'}`

  async function save(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.koda.gitCommit({ message: name })
      if (res.ok) await onSaved({ sha: res.sha, name })
      else setError(saveErrorCopy(res.code))
    } catch (err) {
      setError('Could not save.')
      console.error('save version failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="flex items-center gap-2 text-xs text-text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span className="font-medium text-text">
            {fileCount} {fileCount === 1 ? 'change' : 'changes'}
          </span>
        </span>
        <Button
          onClick={save}
          disabled={busy}
          title="Save a version of everything that changed"
          className="ml-auto"
        >
          {busy ? 'Saving…' : 'Save version'}
        </Button>
      </div>
      {error && <p className="px-3 pb-2 text-[11px] text-red-400">{error}</p>}
    </div>
  )
}

// The green confirmation after a save. Lingers a few seconds so the fresh version can be renamed in
// place — a safe HEAD amend (gitRenameHead), never a history rewrite. Auto-dismisses.
export function SavedStrip({
  saved,
  onDone,
  onRenamed,
}: {
  saved: SavedInfo
  onDone: () => void
  onRenamed: (info: SavedInfo) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(saved.name)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-dismiss only while at rest — a rename in progress must not vanish under the user. Key the timer
  // on the save's identity (sha), NOT on onDone/saved object identity: the parent re-renders on every
  // store tick (streaming session, git refresh) with a fresh inline onDone, which would otherwise reset
  // the timer forever and pin the strip open.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    if (renaming) return
    const t = setTimeout(() => onDoneRef.current(), 6000)
    return () => clearTimeout(t)
  }, [renaming, saved.sha])

  function beginRename(): void {
    setDraft(saved.name)
    setNote(null)
    setRenaming(true)
    requestAnimationFrame(() => inputRef.current?.select())
  }

  async function commitRename(): Promise<void> {
    const next = draft.trim()
    if (!next || busy) return
    if (next === saved.name) {
      setRenaming(false)
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const res = await window.koda.gitRenameHead({ sha: saved.sha, message: next })
      if (res.ok) {
        onRenamed({ sha: res.sha, name: next })
        setRenaming(false)
      } else if (res.code === 'not_head') {
        setNote("This isn't the latest version anymore — rename it from History.")
      } else {
        setNote(saveErrorCopy(res.code))
      }
    } catch (err) {
      setNote('Could not rename.')
      console.error('rename failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-border bg-emerald-500/[0.06] px-3 py-2.5">
      {!renaming ? (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12px] text-emerald-500" aria-hidden>
            ✓
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-muted">
            Saved as <span className="font-medium text-text">"{saved.name}"</span>
          </span>
          <Button variant="ghost" size="sm" onClick={beginRename} className="shrink-0">
            Rename
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12px] text-emerald-500" aria-hidden>
            ✓
          </span>
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commitRename()
              } else if (e.key === 'Escape') {
                setRenaming(false)
                setNote(null)
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-accent bg-surface px-2.5 py-1 text-[13px] text-text focus:outline-none"
          />
          <Button
            size="sm"
            onClick={commitRename}
            disabled={busy || !draft.trim()}
            className="shrink-0"
          >
            {busy ? 'Saving…' : 'Save name'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRenaming(false)
              setNote(null)
            }}
            disabled={busy}
            className="shrink-0"
          >
            Cancel
          </Button>
        </div>
      )}
      {note && <p className="mt-1 pl-5 text-[11px] leading-relaxed text-text-muted/80">{note}</p>}
    </div>
  )
}

// ── Empty-state glyphs (26px, stroke, currentColor — match the dock-tab icon family) ──────────────
export function CheckCircleGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </svg>
  )
}
export function BranchGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 3-2.5 4.5-6 4.5" />
    </svg>
  )
}

/** Plain-language copy for a tagged commit failure (shared by the save / rename paths). */
function saveErrorCopy(
  code: 'no_identity' | 'nothing_to_commit' | 'not_a_repo' | 'not_head' | 'not_clean' | 'git_failed',
): string {
  switch (code) {
    case 'no_identity':
      return 'Git needs your name and email first. Ask Claude to set them up.'
    case 'nothing_to_commit':
      return 'Nothing changed to save.'
    case 'not_a_repo':
      return "This project isn't tracked by Git yet."
    case 'not_head':
      return "This isn't the latest version anymore."
    case 'not_clean':
      return 'Save or discard your other changes first.'
    default:
      return 'Could not save. See the logs for details.'
  }
}
