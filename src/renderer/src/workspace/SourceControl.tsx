import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type {
  DiffFileResult,
  GitCommitGraphResult,
  GitRepoInfo,
  GitStatusFile,
  GitSyncState,
  GitWorktree,
} from '@shared/ipc'
import { SIDEBAR_MIN_WIDTH } from '@shared/ipc'
import { PanelHeader } from './PanelHeader'
import { ResizeHandle } from './ResizeHandle'
import { useWorkspace } from './store'
import { FileButton, basename, shortRoot } from './source-control/shared'
import { BranchGlyph } from './source-control/icons'
import { VersionTimeline } from './source-control/VersionTimeline'
import { WorkingTip } from './source-control/WorkingTip'
import { BackupSection } from './source-control/BackupSection'
import { BranchReview } from './source-control/BranchReview'
import { RestoreBox } from './source-control/RestoreBox'
import { SideBranchBanner } from './source-control/SideBranchBanner'
import { Button, lazyWithRetry } from '../ui'
import { windowHasOpenModal } from '../window-modal'

// Reuse the live-edits diff body (lazy — keeps monaco out of the bundle until a diff is shown).
const MonacoDiffEditor = lazyWithRetry(() => import('../surface/MonacoDiffEditor'))

/** What the right pane shows. Exactly one at a time; the left panel's selection drives it. */
type RightView =
  | { t: 'empty' }
  | { t: 'change'; path: string } // a working-tree change (HEAD → now)
  | { t: 'commit'; sha: string } // a version: its changed files + diffs
  | { t: 'branchFile'; branch: string; path: string } // a file inside a branch Review

/**
 * Source Control — the "Versions" surface (dual-git.md §3). The user's REAL git, the only place Koda
 * touches it; safety-git's invisible undo store never appears here, so a vibecoder never thinks Koda
 * set up a repo for them. A self-contained full-area view (like Settings → Recovery), and one
 * timeline rather than a stack of sections: the working tip (your unsaved work, and the button that
 * saves it) sits at the top as the newest moment, history runs below it as a lane graph, open side
 * lines sit in that graph where the work happened, and the GitHub boundary is a seam on the line with
 * the push action on it. NOT a git IDE (no stage-hunks/rebase/branch switching).
 */
export function SourceControl({ onLeave }: { onLeave: () => void }) {
  const [repo, setRepo] = useState<GitRepoInfo | null>(null)
  const [files, setFiles] = useState<GitStatusFile[]>([])
  const [changesTruncated, setChangesTruncated] = useState(false)
  const [graph, setGraph] = useState<GitCommitGraphResult | null>(null)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  // How many finished (fully-merged) side lines this refresh auto-tidied — a quiet confirmation line,
  // not a to-do. The leftovers themselves are gone; only the count is kept to say so.
  const [tidiedCount, setTidiedCount] = useState(0)
  const [sync, setSync] = useState<GitSyncState | null>(null)
  const [loading, setLoading] = useState(true)
  const [right, setRight] = useState<RightView>({ t: 'empty' })
  const [reviewBranch, setReviewBranch] = useState<string | null>(null)

  // The left list shares the workspace's one panel width (resizable, persisted).
  const width = useWorkspace((s) => s.sidebarWidth)
  const setWidth = useWorkspace((s) => s.setSidebarWidth)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  const refreshGitStatus = useWorkspace((s) => s.refreshGitStatus)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const info = await window.koda.gitDetect()
      setRepo(info)
      if (info.isRepo) {
        // Auto-tidy the provably-safe leftovers FIRST (fully-merged branches + their clean checkouts),
        // so the graph and worktrees fetched below already reflect the cleaned state. RB's call: Koda
        // cleans up after the agent instead of nagging. gitTidyStrays uses refusal-safe git, so nothing
        // can be lost; anything it can't remove cleanly just stays and reappears as a loose end.
        try {
          const found = (await window.koda.gitMergedStrays?.()) ?? []
          if (found.length > 0) {
            const res = await window.koda.gitTidyStrays?.()
            setTidiedCount(res?.removed.length ?? 0)
          } else setTidiedCount(0)
        } catch (err) {
          console.error('auto-tidy strays failed', err)
          setTidiedCount(0)
        }

        const [status, g] = await Promise.all([
          window.koda.gitStatus(),
          window.koda.gitGraph({ limit: 60 }),
        ])
        setFiles(status.files)
        setChangesTruncated(status.truncated)
        setGraph(g)
        // Additive + skew-proof: optional-call so a stale preload (no gitWorktrees/gitSyncState) can't
        // throw and break the core Changes/history load; a rejected IPC just leaves the section empty.
        try {
          setWorktrees((await window.koda.gitWorktrees?.()) ?? [])
        } catch (err) {
          console.error('gitWorktrees failed', err)
          setWorktrees([])
        }
        try {
          setSync((await window.koda.gitSyncState?.()) ?? null)
        } catch (err) {
          console.error('gitSyncState failed', err)
          setSync(null)
        }
      } else {
        setFiles([])
        setGraph(null)
        setWorktrees([])
        setTidiedCount(0)
        setSync(null)
      }
    } catch (err) {
      console.error('source control refresh failed', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Source Control owns the detailed local view while the footer keeps the lightweight global cue.
  // Refresh them as one operation after every mutation so they cannot disagree until the next focus.
  const refreshAll = useCallback(async () => {
    await refresh()
    await refreshGitStatus()
  }, [refresh, refreshGitStatus])

  // Fetch on mount and whenever the window regains focus — no file watcher (this view is for
  // deliberately saving a version / reviewing history, not live-watching the agent).
  useEffect(() => {
    void refreshAll()
    const onFocus = (): void => void refreshAll()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshAll])

  // Esc leaves the whole surface back to the workspace (matches Settings / the recovery drawer). This
  // is the full-area escape; the branch-review sub-view keeps its own "‹ All versions" back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (windowHasOpenModal()) return
      if (e.key === 'Escape') onLeave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLeave])

  // The right pane should open showing something real, not a "select a file" prompt: default to the
  // first working change, else the latest version. Also heals a selection that no longer exists (the
  // change was just committed) instead of leaving a stale "no textual changes" diff up. Never fires
  // inside a branch Review (its right pane belongs to the review).
  useEffect(() => {
    if (loading || reviewBranch) return
    const staleChange = right.t === 'change' && !files.some((f) => f.path === right.path)
    if (right.t !== 'empty' && !staleChange) return
    if (files.length > 0) setRight({ t: 'change', path: files[0].path })
    else if (graph?.layout.rows[0]) setRight({ t: 'commit', sha: graph.layout.rows[0].sha })
    else if (staleChange) setRight({ t: 'empty' })
  }, [loading, reviewBranch, right, files, graph])

  const openReview = (branch: string): void => {
    setReviewBranch(branch)
    setRight({ t: 'empty' })
  }
  const closeReview = (): void => {
    setReviewBranch(null)
    setRight({ t: 'empty' })
  }

  return (
    <div className="flex h-full min-h-0 bg-bg">
      {/* Left: the panel */}
      <div
        ref={panelRef}
        style={{ width, minWidth: SIDEBAR_MIN_WIDTH }}
        className="relative flex shrink-0 flex-col border-r border-border"
      >
        <PanelHeader
          title={
            <button
              onClick={onLeave}
              title="Back to your project"
              aria-label="Back to your project"
              className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m15 18-6-6 6-6" />
              </svg>
              <span className="font-display text-[11px] font-semibold uppercase tracking-wider">Versions</span>
            </button>
          }
        >
          {repo?.isRepo && repo.branch && (
            <span
              title={`On branch ${repo.branch}`}
              className="flex min-w-0 items-center gap-1 text-[11px] text-text-muted"
            >
              <BranchGlyph />
              <span className="truncate font-mono">{repo.branch}</span>
            </span>
          )}
        </PanelHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-2 text-xs text-text-muted">Loading…</p>
          ) : !repo?.isRepo ? (
            <EmptyState onChanged={refreshAll} />
          ) : reviewBranch ? (
            <BranchReview
              branch={reviewBranch}
              headBranch={repo.branch}
              activeFile={right.t === 'branchFile' ? right.path : null}
              onBack={closeReview}
              onOpenFile={(path) => setRight({ t: 'branchFile', branch: reviewBranch, path })}
              onLeave={onLeave}
              onDiscarded={() => {
                closeReview()
                void refreshAll()
              }}
            />
          ) : (
            <BrowseView
              files={files}
              changesTruncated={changesTruncated}
              graph={graph}
              worktrees={worktrees}
              tidiedCount={tidiedCount}
              sync={sync}
              branch={repo.branch}
              trunk={repo.defaultBranch}
              enclosingRoot={repo.isSubdir ? repo.repoRoot : null}
              right={right}
              onCommitted={refreshAll}
              onOpenChange={(path) => setRight({ t: 'change', path })}
              onOpenCommit={(sha) => setRight({ t: 'commit', sha })}
              onReview={openReview}
              onLeave={onLeave}
            />
          )}
        </div>

        {/* Drag the list ⇆ diff split (over the right border). */}
        <ResizeHandle
          orientation="vertical"
          onResize={(x) => {
            const left = panelRef.current?.getBoundingClientRect().left ?? 0
            setWidth(x - left)
          }}
          onResizeEnd={persistLayout}
        />
      </div>

      {/* Right: the diff / commit detail */}
      <RightPane view={right} onChanged={refreshAll} />
    </div>
  )
}

// ── Right pane router ─────────────────────────────────────────────────────────────
function RightPane({ view, onChanged }: { view: RightView; onChanged: () => void }) {
  if (view.t === 'change')
    return (
      <DiffPane
        title={view.path}
        subtitle="since last version"
        loader={() => window.koda.gitFileDiff({ path: view.path })}
      />
    )
  if (view.t === 'branchFile')
    return (
      <DiffPane
        title={view.path}
        subtitle={`on “${view.branch}”`}
        loader={() => window.koda.gitBranchFileDiff({ branch: view.branch, path: view.path })}
      />
    )
  if (view.t === 'commit') return <CommitDetail sha={view.sha} onRestored={onChanged} />
  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <p className="max-w-xs text-center text-sm text-text-muted">
        Select a changed file or a version to see what changed.
      </p>
    </div>
  )
}

// ── Browse: save + changes + history graph ─────────────────────────────────────────
function BrowseView({
  files,
  changesTruncated,
  graph,
  worktrees,
  tidiedCount,
  sync,
  branch,
  trunk,
  enclosingRoot,
  right,
  onCommitted,
  onOpenChange,
  onOpenCommit,
  onReview,
  onLeave,
}: {
  files: GitStatusFile[]
  changesTruncated: boolean
  graph: GitCommitGraphResult | null
  worktrees: GitWorktree[]
  tidiedCount: number
  sync: GitSyncState | null
  branch: string | null
  trunk: string | null
  enclosingRoot: string | null
  right: RightView
  onCommitted: () => void
  onOpenChange: (path: string) => void
  onOpenCommit: (sha: string) => void
  onReview: (branch: string) => void
  onLeave: () => void
}) {
  const hasVersions = !!graph && graph.layout.rows.length > 0
  return (
    <div className="flex flex-col">
      {enclosingRoot && (
        <p className="border-b border-border px-3 py-2 text-[11px] leading-relaxed text-text-muted/80">
          This folder is inside a Git project at{' '}
          <span className="text-text-muted">{shortRoot(enclosingRoot)}</span>, showing that project.
        </p>
      )}
      {branch && trunk && branch !== trunk && (
        <SideBranchBanner branch={branch} trunk={trunk} onLeave={onLeave} />
      )}

      {/* The newest moment on the line: what's changed right now, and the one button that saves it. */}
      <WorkingTip
        files={files}
        truncated={changesTruncated}
        activePath={right.t === 'change' ? right.path : null}
        onOpenChange={onOpenChange}
        onCommitted={onCommitted}
      />

      {/* Publishing only makes sense once there's a version to publish; every other GitHub fact rides
          the timeline's seam. */}
      {sync && hasVersions && <BackupSection sync={sync} onLeave={onLeave} />}

      <VersionTimeline
        graph={graph}
        sync={sync}
        worktrees={worktrees}
        trunk={trunk}
        tidiedCount={tidiedCount}
        selectedSha={right.t === 'commit' ? right.sha : null}
        onOpenCommit={onOpenCommit}
        onReview={onReview}
        onChanged={onCommitted}
        onLeave={onLeave}
      />
    </div>
  )
}

// ── Commit detail (right pane for a selected version) ───────────────────────────────
function CommitDetail({ sha, onRestored }: { sha: string; onRestored: () => void }) {
  const [files, setFiles] = useState<GitStatusFile[] | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setFiles(null)
    setActiveFile(null)
    window.koda
      .gitCommitChanges({ sha })
      .then((r) => {
        if (!alive) return
        setFiles(r.files)
        setActiveFile(r.files[0]?.path ?? null) // auto-open the first file
      })
      .catch((e) => {
        if (alive) setFiles([])
        console.error('gitCommitChanges failed', e)
      })
    return () => {
      alive = false
    }
  }, [sha])

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border px-4 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {files && files.length > 0 ? `What this version changed · ${files.length}` : 'This version'}
          </p>
        </div>
        <RestoreBox sha={sha} onRestored={onRestored} />
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
          {files === null ? (
            <p className="px-2 py-1 text-xs text-text-muted">Loading…</p>
          ) : files.length === 0 ? (
            <p className="px-2 py-1 text-xs text-text-muted">No file changes.</p>
          ) : (
            files.map((f) => (
              <FileButton
                key={f.path}
                file={f}
                active={f.path === activeFile}
                onClick={() => setActiveFile(f.path)}
                title={f.path}
              />
            ))
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {activeFile ? (
          <DiffPane
            key={activeFile}
            title={activeFile}
            subtitle={`version ${sha}`}
            loader={() => window.koda.gitFileDiff({ path: activeFile, ref: sha })}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8">
            <p className="text-sm text-text-muted">Select a file to see what changed.</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Restore (make the files match this version, as a NEW version on top) ─────────────
// ── Diff body (shared by change / commit-file / branch-file) ─────────────────────────
export function DiffPane({
  title,
  subtitle,
  loader,
}: {
  title: string
  subtitle: string
  loader: () => Promise<DiffFileResult>
}) {
  const [diff, setDiff] = useState<DiffFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDiff(null)
    setError(null)
    loader()
      .then((d) => alive && setDiff(d))
      .catch((e) => {
        if (alive) setError(String(e))
        console.error('diff load failed', e)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle])

  return (
    // `h-full` so we fill the height whether the parent stretches us as a flex child (the Changes /
    // branch-file panes) or just contains us in a plain block (CommitDetail's file+diff split).
    // Without it the Monaco body collapses to 0px in the block case and the diff renders invisibly.
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <p className="truncate font-mono text-[12px] text-text-muted" title={title}>
          {basename(title)}
        </p>
        <span className="ml-auto shrink-0 text-[11px] text-text-muted/70">{subtitle}</span>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">Couldn't show this change: {error}</p>
        ) : !diff ? (
          <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>
        ) : diff.binary ? (
          <p className="px-4 py-3 text-xs text-text-muted">Binary file: can't show a diff.</p>
        ) : diff.truncated ? (
          <p className="px-4 py-3 text-xs text-text-muted">File too large to diff here.</p>
        ) : diff.before === diff.after ? (
          <p className="px-4 py-3 text-xs text-text-muted">No textual changes to show.</p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-text-muted">Loading editor…</p>}>
            <MonacoDiffEditor path={title} before={diff.before} after={diff.after} className="h-full" />
          </Suspense>
        )}
      </div>
    </div>
  )
}

// ── Not tracked yet ──────────────────────────────────────────────────────────────────
function EmptyState({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  async function setup(): Promise<void> {
    setBusy(true)
    try {
      await window.koda.gitInit()
      onChanged()
    } catch (err) {
      console.error('git init failed', err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="px-3 py-4">
      <div className="rounded-xl bg-surface p-4 shadow-soft">
        <p className="font-display text-sm font-medium text-text">Not tracked by Git</p>
        <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
          Version control lets you save snapshots of your project and look back at them. Koda's
          automatic recovery works either way. This is for keeping named versions.
        </p>
        <Button variant="primary" size="sm" onClick={setup} disabled={busy} className="mt-3 w-full">{busy ? 'Setting up…' : 'Set up version control'}</Button>
        <p className="mt-2 text-[11px] leading-relaxed text-text-muted/70">
          Or just ask Claude: “set up version control for this project.”
        </p>
      </div>
    </div>
  )
}
