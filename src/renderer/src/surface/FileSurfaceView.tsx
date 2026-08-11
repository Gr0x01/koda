import { Suspense, useEffect, useState } from 'react'
import type { ReadFileResult } from '@shared/ipc'
import { lazyWithRetry } from '../ui'

// Lazy so `monaco-editor` is NOT in the conversation-only bundle — it loads only when a file is
// actually opened (the editor + its workers are a heavy chunk).
const MonacoFileEditor = lazyWithRetry(() => import('./MonacoFileEditor'))

/**
 * A `file` surface's view (ui-workspace.md §4). Reads the file through the contained `fs:readFile`
 * IPC, then hands a non-binary file to the lazy, editable, theme-bridged Monaco editor. The fetch +
 * loading/error/binary/truncated states are the stable shell around it.
 *
 * A truncated file opens read-only: we only loaded the leading slice, so saving would destroy the
 * rest of the file.
 */
export function FileSurfaceView({
  path,
  gotoLine,
  gotoNonce,
  className = '',
}: {
  path: string
  gotoLine?: number
  gotoNonce?: number
  className?: string
}) {
  const [file, setFile] = useState<ReadFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped when the open file changes on disk (agent, another session, external editor) so we re-read.
  const [reloadNonce, setReloadNonce] = useState(0)

  // Switching files: blank to the loading state so the previous file's content never lingers.
  useEffect(() => {
    setFile(null)
    setError(null)
  }, [path])

  // Read on open/switch and on each disk change. A disk-change reload does NOT null `file` first, so
  // the mounted editor swaps content in place (keeps cursor/scroll) instead of flashing "Loading…".
  useEffect(() => {
    let alive = true
    window.koda
      .readFile({ path })
      .then((r) => alive && setFile(r))
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [path, reloadNonce])

  // Watch the open file for on-disk edits; unwatch when the surface unmounts or the path changes.
  useEffect(() => {
    window.koda.watchFile({ path })
    const off = window.koda.onFileChanged((changed) => {
      if (changed === path) setReloadNonce((n) => n + 1)
    })
    return () => {
      window.koda.unwatchFile({ path })
      off()
    }
  }, [path])

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">Couldn't open this file: {error}</p>
        ) : !file ? (
          <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>
        ) : file.imageUrl ? (
          <div className="flex h-full items-center justify-center overflow-auto p-6">
            <img
              src={file.imageUrl}
              alt={path.split('/').pop() ?? 'image'}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : file.binary ? (
          <p className="px-4 py-3 text-xs text-text-muted">Binary file: can't display.</p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-text-muted">Loading editor…</p>}>
            <MonacoFileEditor
              path={path}
              initialContent={file.content}
              readOnly={file.truncated}
              gotoLine={gotoLine}
              gotoNonce={gotoNonce}
              className="h-full"
            />
          </Suspense>
        )}
      </div>
      {file?.truncated && (
        <p className="border-t border-border px-4 py-1.5 text-[11px] text-text-muted">
          Large file: showing the first part only (read-only).
        </p>
      )}
    </div>
  )
}
