import { useEffect, useState } from 'react'
import type { GitBranchOverview } from '@shared/ipc'
import { Button } from '../../ui'
import { useWorkspace } from '../store'
import { Section, FileButton } from './shared'

export function BranchReview({
  branch,
  headBranch,
  activeFile,
  onBack,
  onOpenFile,
  onLeave,
  onDiscarded,
}: {
  branch: string
  headBranch: string | null
  activeFile: string | null
  onBack: () => void
  onOpenFile: (path: string) => void
  onLeave: () => void
  onDiscarded: () => void
}) {
  const [overview, setOverview] = useState<GitBranchOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const sendBranchAction = useWorkspace((s) => s.sendBranchAction)
  const anyBusy = useWorkspace((s) => Object.values(s.sessions).some((sess) => sess.busy))
  const hasSession = useWorkspace((s) => !!s.activeId)

  useEffect(() => {
    let alive = true
    setOverview(null)
    setError(null)
    window.koda
      .gitBranchOverview({ branch })
      .then((o) => alive && setOverview(o))
      .catch((e) => {
        if (alive) setError('Could not load this branch.')
        console.error('gitBranchOverview failed', e)
      })
    return () => {
      alive = false
    }
  }, [branch])

  async function askClaude(): Promise<void> {
    const ok = await sendBranchAction({ branch, headBranch })
    if (ok) onLeave() // close Versions and return to the workspace to watch the agent
  }

  async function discard(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.koda.gitDiscardBranch({ branch })
      onDiscarded()
    } catch (e) {
      setError('Could not discard the branch.')
      console.error('gitDiscardBranch failed', e)
      setBusy(false)
    }
  }

  const into = headBranch ?? 'your project'

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-3 py-3">
        <button
          onClick={onBack}
          className="mb-2 flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text"
        >
          ‹ All versions
        </button>
        <p className="font-display text-sm font-medium text-text">{branch}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
          {overview
            ? overview.ahead === 0
              ? `Nothing here that isn't already in ${into}.`
              : `${overview.ahead} ${overview.ahead === 1 ? 'version' : 'versions'} not in ${into}.`
            : 'Loading…'}
        </p>

        {/* Primary: hand it to the agent (safe, conflict-aware). Advanced: discard. */}
        <div className="mt-3 flex flex-col gap-1.5">
          <Button
            variant="primary"
            size="sm"
            onClick={askClaude}
            disabled={anyBusy || !hasSession}
            title={
              !hasSession
                ? 'Open a session first'
                : anyBusy
                  ? 'Wait for the agent to finish first'
                  : undefined
            }
            className="w-full justify-center"
          >
            Ask Claude to handle it
          </Button>
          {!hasSession && (
            <p className="text-[11px] leading-relaxed text-text-muted/80">
              Start a session to have Claude bring this in or clean it up.
            </p>
          )}
          {!confirming ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirming(true)}
              className="w-full justify-center"
            >
              Discard this branch
            </Button>
          ) : (
            // The one user-confirmed destructive git op in user-git. Amber box keeps its custom color
            // (not danger Button) so it reads visually distinct from the red danger variant.
            <div className="rounded-lg border border-[#b5862f]/40 bg-[#b5862f]/10 p-2.5">
              <p className="text-[11px] leading-relaxed text-[#7a5b14] dark:text-[#d8b765]">
                This deletes "{branch}" and its unmerged work. Unlike Koda's normal undo, this{' '}
                <b>can't be easily brought back</b>.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={discard}
                  disabled={busy}
                  className="rounded-lg bg-[#b5862f] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Discarding…' : 'Discard branch'}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
        {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
      </div>

      <Section label="What's on this branch" count={overview?.files.length ?? 0}>
        {!overview ? (
          <p className="px-3 py-1.5 text-xs text-text-muted">Loading…</p>
        ) : overview.files.length === 0 ? (
          <p className="px-3 py-1.5 text-xs text-text-muted">No file changes vs {into}.</p>
        ) : (
          <ul className="flex flex-col px-1.5">
            {overview.files.map((f) => (
              <li key={f.path}>
                <FileButton
                  file={f}
                  active={activeFile === f.path}
                  onClick={() => onOpenFile(f.path)}
                  title={`What "${branch}" changed in ${f.path}`}
                />
              </li>
            ))}
            {overview.truncated && (
              <li className="px-1.5 py-1 text-[11px] text-text-muted/70">+ more files not shown.</li>
            )}
          </ul>
        )}
      </Section>
    </div>
  )
}
