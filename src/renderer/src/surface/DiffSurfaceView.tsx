import { Suspense, useEffect, useState } from 'react'
import type { DiffFileResult } from '@shared/ipc'
import type { FileDiffSource } from '../workspace/store'
import { lazyWithRetry } from '../ui'

// Lazy like FileSurfaceView so `monaco-editor` loads only when a diff is actually shown.
const MonacoDiffEditor = lazyWithRetry(() => import('./MonacoDiffEditor'))

/**
 * A `diff` surface's view — fetches the before/after pair via `fs:diffFile` and renders the read-only
 * Monaco diff. Re-fetches whenever `rev` changes: each successive engine edit to this file bumps the
 * surface's rev (store.showEditDiff), so the diff updates live as the agent works. (Source Control's
 * git diffs render in their own full-area view, not here.)
 */
export function DiffSurfaceView({
  path,
  rev,
  diffSource,
  className = '',
}: {
  path: string
  rev: number
  diffSource?: FileDiffSource
  className?: string
}) {
  const [diff, setDiff] = useState<DiffFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    const read = diffSource?.kind === 'checkpoint'
      ? window.koda
          .checkpointFileDiff({
            checkpointId: diffSource.checkpointId,
            path: diffSource.path,
            sessionId: diffSource.sessionId,
          })
          .then((result) => ({ path, ...result }))
      : window.koda.diffFile({
          path,
          ...(diffSource?.kind === 'session' ? { sessionId: diffSource.sessionId } : {}),
        })
    read
      .then((r) => alive && setDiff(r))
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [path, rev, diffSource])

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">Couldn't diff this file: {error}</p>
        ) : !diff ? (
          <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>
        ) : diff.binary ? (
          <p className="px-4 py-3 text-xs text-text-muted">Binary file: can't show a diff.</p>
        ) : diff.truncated ? (
          // A side hit the size cap — the two sides cut at different lengths, so a rendered diff would
          // show a spurious trailing change. Show a notice instead of a misleading diff.
          <p className="px-4 py-3 text-xs text-text-muted">Large file: switch to File to view it.</p>
        ) : diff.before === diff.after ? (
          <p className="px-4 py-3 text-xs text-text-muted">No changes to show yet.</p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-text-muted">Loading editor…</p>}>
            <MonacoDiffEditor path={path} before={diff.before} after={diff.after} className="h-full" />
          </Suspense>
        )}
      </div>
    </div>
  )
}
