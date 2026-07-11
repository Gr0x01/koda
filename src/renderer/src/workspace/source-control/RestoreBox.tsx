import { useEffect, useState } from 'react'
import type { GitCommitResult } from '@shared/ipc'
import { Button } from '../../ui'

// Non-destructive by construction (restoreVersion never rewrites history — a restore is undone by
// restoring forward again), so one light inline confirm is enough. The two expected refusals get
// plain copy: unsaved changes (not_clean) and "already matches" (nothing_to_commit).
export function RestoreBox({ sha, onRestored }: { sha: string; onRestored: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A new selection is a new question — drop any half-finished confirm/error from the last one.
  useEffect(() => {
    setConfirming(false)
    setError(null)
  }, [sha])

  async function restore(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await window.koda.gitRestoreVersion({ sha })
      if (res.ok) {
        setConfirming(false)
        onRestored()
      } else {
        setError(restoreErrorCopy(res.code))
      }
    } catch (err) {
      setError('Could not restore this version.')
      console.error('gitRestoreVersion failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-border px-3 py-2">
      {!confirming ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(true)}
          className="w-full justify-center hover:border-accent/40 hover:text-text"
        >
          Restore this version
        </Button>
      ) : (
        <div className="rounded-lg border border-accent/25 bg-accent/[0.07] p-2.5">
          <p className="text-[11px] leading-relaxed text-text-muted">
            Your files go back to how they were at this version, saved as a{' '}
            <b className="text-text">new version on top</b> — nothing is lost, and you can restore
            forward again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void restore()}
              disabled={busy}
            >
              {busy ? 'Restoring…' : 'Restore'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirming(false)
                setError(null)
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-1.5 text-[11px] leading-relaxed text-red-400">{error}</p>}
    </div>
  )
}

type CommitErrorCode = Extract<GitCommitResult, { ok: false }>['code']

function restoreErrorCopy(code: CommitErrorCode): string {
  switch (code) {
    case 'not_clean':
      return 'You have unsaved changes — save a version (or discard them) before restoring.'
    case 'nothing_to_commit':
      return 'Your files already match this version.'
    default:
      return 'Could not restore this version.'
  }
}
