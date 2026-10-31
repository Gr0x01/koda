import { Suspense, useEffect, useState } from 'react'
import type { ReadFileResult } from '@shared/ipc'
import { lazyWithRetry } from '../ui'
import { ZoomableImage } from './ZoomableImage'

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
  gotoColumn,
  gotoNonce,
  className = '',
}: {
  path: string
  gotoLine?: number
  gotoColumn?: number
  gotoNonce?: number
  className?: string
}) {
  const [file, setFile] = useState<ReadFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped when the open file changes on disk (agent, another session, external editor) so we re-read.
  const [reloadNonce, setReloadNonce] = useState(0)

  // Read on open, on a rename, and on each disk change. None of them null `file` first, so the mounted
  // editor keeps its cursor, scroll and unsaved buffer. The pane is keyed per document (`paneKey`), so
  // `path` only changes here when the open file is renamed or moved, never to a different file.
  useEffect(() => {
    let alive = true
    setError(null)
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
          <ZoomableImage
            src={file.imageUrl}
            alt={path.split('/').pop() ?? 'image'}
            className="h-full"
          />
        ) : file.binary ? (
          <p className="px-4 py-3 text-xs text-text-muted">Binary file: can't display.</p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-text-muted">Loading editor…</p>}>
            <MonacoFileEditor
              path={file.path}
              surfacePath={path}
              initialContent={file.content}
              readOnly={file.truncated}
              gotoLine={gotoLine}
              gotoColumn={gotoColumn}
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
