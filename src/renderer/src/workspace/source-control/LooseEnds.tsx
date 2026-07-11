import { useState } from 'react'
import type { GitWorktree } from '@shared/ipc'
import { Button } from '../../ui'
import { Section, basename } from './shared'

/**
 * Loose ends — the odds and ends the agent leaves behind, gathered into one place instead of three
 * quiet sections. Only what needs a human decision shows: side lines never brought into your project
 * (review → bring in / discard) and other workspaces left with UNSAVED work (open to pick it up). The
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
  sideLines: string[]
  /** Sibling checkouts worth surfacing — those with unsaved work or a missing folder. */
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
        Bits Claude left open — side lines it never brought in, and workspaces with unsaved work.
        Nothing here is lost; sort them out whenever.
      </p>
      {tidiedCount > 0 && <TidyLine count={tidiedCount} />}
      <ul className="flex flex-col gap-1.5 px-3 pb-1">
        {sideLines.map((b) => (
          <SideLineRow key={b} branch={b} onReview={() => onReview(b)} onDiscarded={onChanged} />
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
  onReview,
  onDiscarded,
}: {
  branch: string
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
      setError('Could not discard it. Ask Claude to take a look.')
      console.error('gitDiscardBranch failed', e)
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-[#b5862f]/30 bg-[#b5862f]/[0.07] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12.5px] text-text" title={branch}>
            {branch}
          </span>
          <span className="text-[11px] text-text-muted">Not in your project yet</span>
        </div>
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

// A separate checkout the agent left with unsaved work (or whose folder is gone). Open it in its own
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
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted/85">
            <span className="truncate font-mono">{w.branch ?? 'detached'}</span>
            <span aria-hidden>·</span>
            {w.prunable ? (
              <span className="shrink-0 whitespace-nowrap text-red-400">folder missing</span>
            ) : (
              <span className="shrink-0 whitespace-nowrap text-[#9a6f1e] dark:text-[#e0c178]">
                {w.dirtyCount} unsaved {w.dirtyCount === 1 ? 'change' : 'changes'}
              </span>
            )}
            {w.lastActivity && (
              <span className="shrink-0 whitespace-nowrap text-text-muted/60">· {w.lastActivity}</span>
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
