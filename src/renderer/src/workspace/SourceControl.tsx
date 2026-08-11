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
import { Section, FileButton, basename, shortRoot } from './source-control/shared'
import { BranchGlyph } from './source-control/icons'
import { Ledger } from './source-control/VersionLedger'
import { BackupSection } from './source-control/BackupSection'
import { BranchReview } from './source-control/BranchReview'
import { LooseEnds } from './source-control/LooseEnds'
import { RestoreBox } from './source-control/RestoreBox'
import { SideBranchBanner } from './source-control/SideBranchBanner'
import { Button, lazyWithRetry } from '../ui'
import { gitErrorCopy } from '../git-error-copy'

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
 * set up a repo for them. A self-contained full-area view (like Settings → Recovery): a quiet
 * Save-a-version action, the working Changes, a GitHub section (one-click push, or hand "publish me
 * to GitHub" to the agent), and a calm linear History LEDGER of your current line (VersionLedger) —
 * NOT a lane graph. Anything off that line becomes a plain decision in Loose Ends: side lines the
 * agent never brought in (Review → bring-in / discard), stranded workspaces (Open), while the
 * provably-safe leftovers are auto-tidied. NOT a git IDE (no stage-hunks/rebase/branch switching).
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

  // Fetch on mount and whenever the window regains focus — no file watcher (this view is for
  // deliberately saving a version / reviewing history, not live-watching the agent).
  useEffect(() => {
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Esc leaves the whole surface back to the workspace (matches Settings / the recovery drawer). This
  // is the full-area escape; the branch-review sub-view keeps its own "‹ All versions" back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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
            <EmptyState onChanged={refresh} />
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
                void refresh()
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
              onCommitted={refresh}
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
      <RightPane view={right} onChanged={refresh} />
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
  const unmerged = graph?.unmergedBranches ?? []
  // Only OTHER checkouts are worth surfacing — this window's own is fully covered by Changes above.
  // (Merged-leftover checkouts are already gone: they're auto-tidied on refresh.)
  const siblings = worktrees.filter((w) => !w.isCurrent)
  const looseWorktrees = siblings.filter((w) => !w.statusKnown || w.dirtyCount > 0 || w.prunable)
  const branchesNotReady = new Set(
    looseWorktrees
      .filter((w) => (!w.statusKnown || w.dirtyCount > 0) && w.branch)
      .map((w) => w.branch as string),
  )
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
      <CommitBox hasChanges={files.length > 0} changeCount={files.length} onCommitted={onCommitted} />

      <Section label="Changes" count={files.length}>
        {files.length === 0 ? (
          <p className="px-3 py-1.5 text-xs text-text-muted">Nothing changed since your last version.</p>
        ) : (
          <ul className="flex flex-col px-1.5">
            {files.map((f) => (
              <li key={f.path}>
                <FileButton
                  file={f}
                  active={right.t === 'change' && right.path === f.path}
                  onClick={() => onOpenChange(f.path)}
                  title={`See what changed in ${f.path}`}
                />
              </li>
            ))}
            {changesTruncated && (
              <li className="px-1.5 py-1 text-[11px] text-text-muted/70">
                + more changes. Save from chat for very large changes.
              </li>
            )}
          </ul>
        )}
      </Section>

      {/* The GitHub section only makes sense once there's a version to push. */}
      {sync && hasVersions && (
        <BackupSection sync={sync} onPushed={onCommitted} onRecheck={onCommitted} onLeave={onLeave} />
      )}

      <LooseEnds
        tidiedCount={tidiedCount}
        // A dirty or unreadable checkout is not "ready" merely because its committed tip is
        // reviewable. Its one truthful row is below; once confirmed clean, the ready side line returns.
        sideLines={unmerged.filter((branch) => !branchesNotReady.has(branch.name))}
        // A clean sibling checkout is already represented by its side line (or was auto-tidied); only
        // surface the ones holding work that lives nowhere else, a failed status check, or a missing folder.
        worktrees={looseWorktrees}
        onReview={onReview}
        onChanged={onCommitted}
      />

      <Section label="History">
        {!hasVersions ? (
          <p className="px-3 py-1.5 text-xs text-text-muted">
            No versions yet. Save one to start your history.
          </p>
        ) : (
          <Ledger
            graph={graph}
            selectedSha={right.t === 'commit' ? right.sha : null}
            // How many newest versions aren't on GitHub yet — only when we've confirmed a real remote
            // tip for this branch (verified + has an upstream). Anything less is a stale-cache guess, and
            // the rail must never claim "safe" it can't back up; null then ⇒ no safe/unsafe split shown.
            localOnlyCount={
              sync?.verified && sync.hasRemote && sync.upstream ? sync.ahead : null
            }
            onOpenCommit={onOpenCommit}
          />
        )}
      </Section>
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
      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft">
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

// ── Save a version (quiet button → inline compose) ──────────────────────────────────
// `paths` (optional) scopes the commit to just those files — the per-session "Save this session's
// work". Omitted ⇒ save everything (gitCommit). `label`/`hint` let callers retitle the button.
export function CommitBox({
  hasChanges,
  changeCount,
  onCommitted,
  paths,
  label = 'Save a version',
  hint = true,
}: {
  hasChanges: boolean
  changeCount: number
  onCommitted: () => void
  paths?: string[]
  label?: string
  hint?: boolean
}) {
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    const msg = message.trim()
    if (!msg || busy) return
    setBusy(true)
    setError(null)
    try {
      const res =
        paths && paths.length > 0
          ? await window.koda.gitCommitPaths({ message: msg, paths })
          : await window.koda.gitCommit({ message: msg })
      if (res.ok) {
        setMessage('')
        setComposing(false)
        onCommitted()
      } else {
        setError(gitErrorCopy(res.code, 'save'))
      }
    } catch (err) {
      setError('Could not save a version.')
      console.error('git commit failed', err)
    } finally {
      setBusy(false)
    }
  }

  if (!hasChanges) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-3 py-3 text-xs text-text-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        You're all saved — nothing's changed since your last version.
      </div>
    )
  }

  return (
    <div className="border-b border-border px-3 py-3">
      {!composing ? (
        <>
          <button
            onClick={() => setComposing(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] font-medium text-text transition-colors hover:border-accent/40"
          >
            <span aria-hidden>＋</span> {label}
            <span className="text-text-muted">
              {changeCount} {changeCount === 1 ? 'change' : 'changes'}
            </span>
          </button>
          {hint && (
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted/80">
              or ask Claude to <span className="text-text">“save a version.”</span>
            </p>
          )}
        </>
      ) : (
        <>
          <textarea
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void save()
              } else if (e.key === 'Escape') {
                setComposing(false)
                setError(null)
              }
            }}
            rows={2}
            placeholder="Describe this version, e.g. “add the login page”"
            className="w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] text-text placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={save} disabled={busy || !message.trim()}>{busy ? 'Saving…' : 'Save version'}</Button>
            <Button variant="ghost" size="sm" onClick={() => { setComposing(false); setError(null) }} disabled={busy}>Cancel</Button>
          </div>
        </>
      )}
      {error && <p className="mt-1.5 text-[11px] leading-relaxed text-red-400">{error}</p>}
    </div>
  )
}
