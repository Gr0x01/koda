import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace, computeSessionChanges, activeEditor } from '../workspace/store'
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
 * CHANGES — user-git working-tree review, on stage as a tab like everything else (it used to expand out
 * of a strip pinned under the stage, which made it the one surface with its own way of appearing).
 * Grouped by the session that made each change: git has ONE tree per project (changes are aggregate),
 * but Koda attributes them per session from its turn-boundary evidence, with edit history as an
 * in-flight fallback (see computeSessionChanges). Clicking a file opens its diff as its own tab
 * (openFile as a `diff` view with no sessionId → the diff is vs HEAD = "since last version", matching
 * this surface's framing), so this tab stays one click away in the strip. Saving is ONE version of
 * everything: the footer's Save commits the whole working tree, auto-named from the lone session, and a
 * green strip lets you rename that fresh version. Per-session granular saves are a rare, advanced case
 * — ask Claude — so they don't cost a button here.
 */
export function ChangesSurface() {
  const gitRepo = useWorkspace((s) => s.gitRepo)
  const files = useWorkspace((s) => s.gitFiles)
  const truncated = useWorkspace((s) => s.gitChangesTruncated)
  const sessions = useWorkspace((s) => s.sessions)
  const order = useWorkspace((s) => s.order)
  const completionBySession = useWorkspace((s) => s.completionBySession)
  const changesFocus = useWorkspace((s) => s.changesFocus)
  const refreshGitStatus = useWorkspace((s) => s.refreshGitStatus)
  const setVersionsOpen = useWorkspace((s) => s.setVersionsOpen)
  const openFile = useWorkspace((s) => s.openFile)
  const closeSurface = useWorkspace((s) => s.closeSurface)

  // Which file is on the stage right now (a diff surface) — drives the active row + its "shown above"
  // cue. Reads the ACTIVE session's editor (openFile stages there), so the list and the stage agree.
  const stagedPath = useWorkspace((s) => {
    const ed = activeEditor(s)
    const cur = ed.surfaces.find((x) => x.path === ed.activeSurfaceId)
    return cur && cur.view === 'diff' ? cur.path : null
  })

  const [saved, setSaved] = useState<SavedInfo | null>(null)

  const { groups, alsoBy } = useMemo(
    () => computeSessionChanges(sessions, order, files, completionBySession),
    [sessions, order, files, completionBySession],
  )

  // Refresh whenever the surface is shown (a turn may have landed while another tool was up).
  useEffect(() => {
    void refreshGitStatus()
  }, [refreshGitStatus])

  // Consume a focus hint from openChanges(sessionId): scroll that session's group into view. It must
  // NOT stage a diff — that would select the diff's tab and switch straight back off this one.
  const groupEls = useRef(new Map<string, HTMLDivElement>())
  const holdGroup = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) groupEls.current.set(id, el)
    else groupEls.current.delete(id)
  }, [])
  useEffect(() => {
    if (!changesFocus) return
    groupEls.current.get(changesFocus)?.scrollIntoView({ block: 'nearest' })
    useWorkspace.setState({ changesFocus: null })
  }, [changesFocus, groups])

  async function onSaved(info: SavedInfo): Promise<void> {
    setSaved(info)
    await refreshGitStatus()
  }

  // Open the file's diff as its own tab. No sessionId ⇒ the diff is vs HEAD (last saved version),
  // which is what "Changes" means here (not the narrower since-this-turn baseline agent edits use).
  const onSelect = (path: string): void => openFile(path, undefined, { view: 'diff' })

  // Open the actual file on the stage (its editable/doc view, not the diff) — "let me read or edit it".
  const onOpen = (path: string): void => openFile(path)

  // Reveal in Finder — a Mac table-stakes for "where does this live?". Contained to the project root
  // in the main process, so a bad path is refused there rather than guarded here.
  const onReveal = (path: string): void => void window.koda.revealPath({ path })

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
      {/* Section header. The tab already names the surface, so this row exists for the count and for
          History — closing is the tab's ✕, like every other surface. */}
      <div className="flex items-stretch pr-3">
        <div className="flex flex-1 items-center gap-2 px-3 pb-2 pt-3">
          <span className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Changes
          </span>
        </div>
        <button
          onClick={() => setVersionsOpen(true)}
          className="shrink-0 self-center text-[11px] font-medium text-text-muted transition-colors hover:text-text"
          title="Open the full history — versions, branches, and review"
        >
          History →
        </button>
      </div>

      {/* The list scrolls; the footer stays anchored at the surface's bottom edge (below). */}
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
            <div key={g.sessionId ?? 'no-session'} ref={(el) => holdGroup(g.sessionId ?? 'no-session', el)}>
              <ChangeGroup
                group={g}
                alsoBy={alsoBy}
                stagedPath={stagedPath}
                onSelect={onSelect}
                onOpen={onOpen}
                onReveal={onReveal}
                onDiscard={onDiscard}
              />
            </div>
          ))
        )}
        {truncated && (
          <p className="shrink-0 px-3 py-1.5 text-[11px] text-text-muted/70">
            + more changes. Ask the agent to "save a version" for very large changes.
          </p>
        )}
      </div>

      {/* One anchored footer: a quiet count label on the left, one real Save button on the right. Flush
          at the bottom — no floating hero, no internal rule. Collapse lives on the header above. */}
      {files.length > 0 && (
        <Footer groups={groups} fileCount={files.length} truncated={truncated} onSaved={onSaved} />
      )}
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
