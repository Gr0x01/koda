import { useEffect, useMemo, useState } from 'react'
import { useWorkspace, computeSessionChanges, activeEditor } from '../workspace/store'
import { Collapse } from '../motion'
import { Caret } from '../Caret'
import { DockEmpty } from './Dock'
import { Button } from '../ui'
import {
  ChangeGroup,
  Footer,
  SavedStrip,
  BranchGlyph,
  CheckCircleGlyph,
  type SavedInfo,
} from './ChangesReview'

/**
 * The DESK — the slim strip under the stage that owns "what did the agent change?". Collapsed it's a
 * one-line ambient read (count + a dirty dot); clicking expands the review sheet (the session-grouped
 * changes list + saving) up out of it. Clicking a file stages its diff on the STAGE above — the desk
 * is the selector, the stage shows the change: one review unit, not a second diff pane walled off
 * inside the desk.
 */
export function StageDesk() {
  const gitRepo = useWorkspace((s) => s.gitRepo)
  const fileCount = useWorkspace((s) => s.gitFiles.length)
  const deskOpen = useWorkspace((s) => s.deskOpen)
  const setDeskOpen = useWorkspace((s) => s.setDeskOpen)
  return (
    // The single hairline at the stage↔desk edge — the one honest section boundary. When open, the
    // sheet owns its own footer (count + Save), so the peek strip renders only while COLLAPSED (there'd
    // be nothing to re-open otherwise). No stacked bottom rules.
    <div className="shrink-0 border-t border-border">
      <Collapse open={deskOpen}>
        <div className="h-[46vh] min-h-[240px]">
          <ChangesSurface onCollapse={() => setDeskOpen(false)} />
        </div>
      </Collapse>
      {!deskOpen && (
        <button
          onClick={() => setDeskOpen(true)}
          title="Review what changed, and save a version"
          aria-expanded={false}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-muted transition-colors hover:bg-surface hover:text-text"
        >
          <BranchGlyph size={13} />
          {!gitRepo ? (
            <span>No version history</span>
          ) : fileCount > 0 ? (
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              <span className="font-medium text-text">
                {fileCount} {fileCount === 1 ? 'change' : 'changes'}
              </span>
            </span>
          ) : (
            <span>All saved</span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {gitRepo && fileCount > 0 && <span>Review &amp; save</span>}
            <Caret dir="up" size={12} />
          </span>
        </button>
      )}
    </div>
  )
}

/**
 * The desk's review sheet — user-git working-tree review, grouped by the session that made each change.
 * Git has ONE tree per project (changes are aggregate), but Koda attributes them per session from its
 * own edit history (see computeSessionChanges). Clicking a file stages its diff on the stage above
 * (openFile as a `diff` view with no sessionId → the diff is vs HEAD = "since last version", matching
 * this surface's framing). Saving is ONE version of everything: the footer's Save commits the whole
 * working tree, auto-named from the lone session, and a green strip lets you rename that fresh version.
 * Per-session granular saves are a rare, advanced case — ask Claude — so they don't cost a button here.
 */
function ChangesSurface({ onCollapse }: { onCollapse: () => void }) {
  const gitRepo = useWorkspace((s) => s.gitRepo)
  const files = useWorkspace((s) => s.gitFiles)
  const truncated = useWorkspace((s) => s.gitChangesTruncated)
  const sessions = useWorkspace((s) => s.sessions)
  const order = useWorkspace((s) => s.order)
  const changesFocus = useWorkspace((s) => s.changesFocus)
  const refreshGitStatus = useWorkspace((s) => s.refreshGitStatus)
  const setVersionsOpen = useWorkspace((s) => s.setVersionsOpen)
  const openFile = useWorkspace((s) => s.openFile)
  const closeSurface = useWorkspace((s) => s.closeSurface)

  // Which file is on the stage right now (a diff surface) — drives the active row + its "shown above"
  // cue. Reads the ACTIVE session's editor (openFile stages there), so the desk and the stage agree.
  const stagedPath = useWorkspace((s) => {
    const ed = activeEditor(s)
    const cur = ed.surfaces.find((x) => x.path === ed.activeSurfaceId)
    return cur && cur.view === 'diff' ? cur.path : null
  })

  const [saved, setSaved] = useState<SavedInfo | null>(null)

  const { groups, alsoBy } = useMemo(
    () => computeSessionChanges(sessions, order, files),
    [sessions, order, files],
  )

  // Refresh whenever the surface is shown (a turn may have landed while another tool was up).
  useEffect(() => {
    void refreshGitStatus()
  }, [refreshGitStatus])

  // Consume a focus hint from openChanges(sessionId): stage that session's first changed file.
  useEffect(() => {
    if (!changesFocus) return
    const g = groups.find((x) => x.sessionId === changesFocus)
    if (g?.files[0]) openFile(g.files[0].path, undefined, { view: 'diff' })
    useWorkspace.setState({ changesFocus: null })
  }, [changesFocus, groups, openFile])

  async function onSaved(info: SavedInfo): Promise<void> {
    setSaved(info)
    await refreshGitStatus()
  }

  // Stage the file's diff on the stage above. No sessionId ⇒ the diff is vs HEAD (last saved version),
  // which is what "Changes" means here (not the narrower since-this-turn baseline agent edits use).
  const onSelect = (path: string): void => openFile(path, undefined, { view: 'diff' })

  // Discard one file's change — revert an edit to the last version, or remove a new file. The main
  // process checkpoints the tree first (undoable from Recovery). On success, close its diff if staged
  // (it no longer has a change to show) and refresh. Returns error copy for the row, or null.
  const onDiscard = async (path: string): Promise<string | null> => {
    try {
      const res = await window.koda.gitDiscardFile({ path })
      if (!res.ok) return discardErrorCopy(res.code)
    } catch (err) {
      console.error('discard change failed', err)
      return 'Could not discard.'
    }
    if (stagedPath === path) closeSurface(path)
    await refreshGitStatus()
    return null
  }

  if (!gitRepo) {
    return (
      <div className="h-full bg-bg">
        <DockEmpty
          icon={<BranchGlyph />}
          title="No version history yet"
          hint="This project isn't tracked by Git, so there's nothing to save versions of."
          action={
            <Button variant="secondary" size="sm" onClick={() => setVersionsOpen(true)}>
              Set up version control
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Section header — the whole title row collapses the sheet, mirroring the full-width strip that
          expands it (a lone far-right caret made closing needlessly hard to reach). Always present: the
          footer's handle disappears once everything's saved, so this is the "All saved" sheet's only close.
          History stays its own action on the right. */}
      <div className="flex items-stretch pr-3">
        <button
          onClick={onCollapse}
          title="Collapse the review sheet"
          aria-label="Collapse"
          aria-expanded
          className="group flex flex-1 items-center gap-2 px-3 pb-2 pt-4 text-left transition-colors hover:text-text"
        >
          <span className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted transition-colors group-hover:text-text">
            Changes
          </span>
          <Caret dir="down" size={12} className="text-text-muted transition-colors group-hover:text-text" />
        </button>
        <button
          onClick={() => setVersionsOpen(true)}
          className="shrink-0 self-center text-[11px] font-medium text-text-muted transition-colors hover:text-text"
          title="Open the full history — versions, branches, and review"
        >
          History →
        </button>
      </div>

      {/* The list scrolls; the footer stays anchored at the sheet's bottom edge (below). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {saved && (
          <SavedStrip saved={saved} onDone={() => setSaved(null)} onRenamed={(n) => setSaved(n)} />
        )}

        {groups.length === 0 ? (
          !saved && (
            <DockEmpty
              icon={<CheckCircleGlyph />}
              title="All saved"
              hint="Nothing changed since your last version."
            />
          )
        ) : (
          groups.map((g) => (
            <ChangeGroup
              key={g.sessionId ?? 'no-session'}
              group={g}
              alsoBy={alsoBy}
              stagedPath={stagedPath}
              onSelect={onSelect}
              onDiscard={onDiscard}
            />
          ))
        )}
        {truncated && (
          <p className="shrink-0 px-3 py-1.5 text-[11px] text-text-muted/70">
            + more changes. Ask Claude to "save a version" for very large changes.
          </p>
        )}
      </div>

      {/* One anchored footer: a quiet count label on the left, one real Save button on the right. Flush
          at the bottom — no floating hero, no internal rule. Collapse lives on the header above. */}
      {files.length > 0 && <Footer groups={groups} fileCount={files.length} onSaved={onSaved} />}
    </div>
  )
}

/** Plain-language copy for a discard failure (shown inline on the row). */
function discardErrorCopy(code: 'not_a_repo' | 'no_checkpoint' | 'git_failed'): string {
  switch (code) {
    case 'not_a_repo':
      return "This project isn't tracked by Git yet."
    case 'no_checkpoint':
      return "Couldn't make an undo point, so nothing was removed."
    default:
      return 'Could not discard. See the logs for details.'
  }
}
