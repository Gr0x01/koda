import { useState } from 'react'
import type { GitWorktree } from '@shared/ipc'
import { Button } from '../../ui'
import { Section, basename } from './shared'

/**
 * Loose ends — the odds and ends an agent leaves behind, gathered into one place instead of three
 * quiet sections. Only what needs a human decision shows: clean side lines ready to review
 * (bring in / discard) and other workspaces with loose or unreadable state (open to pick it up). The
 * provably-safe leftovers — fully-merged branches + their clean checkouts — are auto-tidied on refresh
 * (SourceControl), so `tidiedCount` just reports how many, turning "Claude left branches everywhere"
 * into "Koda cleaned up after it." Renders nothing when there's nothing to say.
 */
export function LooseEnds({
  tidiedCount,
  sideLines,
  worktrees,
  onReview,
  onChanged,
}: {
  tidiedCount: number
  sideLines: Array<{ name: string; ahead: number }>
  /** Sibling checkouts worth surfacing — loose, unreadable, or missing. */
  worktrees: GitWorktree[]
  onReview: (branch: string) => void
  onChanged: () => void
}) {
  const hasItems = sideLines.length > 0 || worktrees.length > 0
  if (!hasItems && tidiedCount === 0) return null

  // Only the auto-tidy happened — a quiet standalone confirmation, no "loose ends" chrome (there are none).
  if (!hasItems) return <TidyLine count={tidiedCount} standalone />

  return (
    <Section label="Loose ends" count={sideLines.length + worktrees.length}>
      <p className="px-3 pb-2 text-[11px] leading-relaxed text-text-muted/85">
        Agent work waiting for your decision. Clean side lines are ready to review; other workspaces
        still need cleanup or a quick check. Review, discard, or clean them up when you’re ready.
      </p>
      {tidiedCount > 0 && <TidyLine count={tidiedCount} />}
      <ul className="flex flex-col gap-1.5 px-3 pb-1">
        {sideLines.map((b) => (
          <SideLineRow
            key={b.name}
            branch={b.name}
            commitCount={b.ahead}
            onReview={() => onReview(b.name)}
            onDiscarded={onChanged}
          />
        ))}
        {worktrees.map((w) => (
          <WorkspaceRow key={w.path} worktree={w} />
        ))}
      </ul>
    </Section>
  )
}

/** The auto-tidy confirmation — positive, never a to-do. `standalone` adds its own vertical padding. */
function TidyLine({ count, standalone }: { count: number; standalone?: boolean }) {
  return (
    <p className={`text-[11px] leading-relaxed text-text-muted/80 ${standalone ? 'px-3 py-2' : 'px-3 pb-2'}`}>
      Tidied up {count} finished side {count === 1 ? 'line' : 'lines'} — fully saved, so nothing was lost.
    </p>
  )
}

// A side line the agent never brought in: review it (see what's there, bring it in) or discard it.
// Discard is the one destructive move here, so it takes an inline confirm before it fires.
function SideLineRow({
  branch,
  commitCount,
  onReview,
  onDiscarded,
}: {
  branch: string
  commitCount: number
  onReview: () => void
  onDiscarded: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function discard(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.koda.gitDiscardBranch({ branch })
      onDiscarded()
    } catch (e) {
      setError('Could not discard it. Ask the agent to take a look.')
      console.error('gitDiscardBranch failed', e)
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-[#b5862f]/30 bg-[#b5862f]/[0.07] px-2.5 py-2">
      <div className="min-w-0">
        <span className="block truncate font-mono text-[12.5px] text-text" title={branch}>
          {branch}
        </span>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-emerald-500/80">
            Ready · clean · {commitCount} {commitCount === 1 ? 'commit' : 'commits'}
          </span>
          {!confirming && (
            <div className="flex shrink-0 gap-1.5">
              <Button variant="secondary" size="sm" onClick={onReview}>
                Review
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Discard
              </Button>
            </div>
          )}
        </div>
      </div>
      {confirming && (
        <div className="mt-2 rounded-md border border-border bg-surface px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-text-muted">
            Throw “{branch}” away for good? Its versions can’t be brought back after this.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button variant="danger" size="sm" onClick={discard} disabled={busy}>
              {busy ? 'Discarding…' : 'Yes, discard'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
          {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
        </div>
      )}
    </li>
  )
}

// A separate checkout the agent left with loose work (or whose folder is gone). Open it in its own
// window to pick the work back up — its uncommitted changes live nowhere else.
function WorkspaceRow({ worktree: w }: { worktree: GitWorktree }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function open(): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.koda.openWorktree({ path: w.path })
      if (res.alreadyOpen) setNote('Already open in another window.')
    } catch (e) {
      setNote('Could not open it.')
      console.error('openWorktree failed', e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`rounded-lg border border-border px-2.5 py-2 ${w.prunable ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-text" title={w.path}>
            {basename(w.path)}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-text-muted/85">
            {w.branch ?? 'detached'}
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-text-muted/85">
            {w.prunable ? (
              <span className="whitespace-nowrap text-red-400">folder missing</span>
            ) : !w.statusKnown ? (
              <span className="whitespace-nowrap text-[#9a6f1e] dark:text-[#e0c178]">
                Needs a check · status unavailable
              </span>
            ) : (
              <span className="whitespace-nowrap text-[#9a6f1e] dark:text-[#e0c178]">
                Needs cleanup · {w.dirtyCount} loose {w.dirtyCount === 1 ? 'file' : 'files'}
              </span>
            )}
            {w.lastActivity && (
              <span className="whitespace-nowrap text-text-muted/60">· {w.lastActivity}</span>
            )}
          </div>
          {note && <p className="mt-0.5 text-[11px] text-text-muted/70">{note}</p>}
        </div>
        {!w.prunable && (
          <Button variant="secondary" size="sm" onClick={open} disabled={busy} className="shrink-0">
            {busy ? 'Opening…' : 'Open'}
          </Button>
        )}
      </div>
    </li>
  )
}
