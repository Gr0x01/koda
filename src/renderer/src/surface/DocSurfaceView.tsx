import { Suspense, useEffect, useState } from 'react'
import type { ReadFileResult } from '@shared/ipc'
import { lazyWithRetry } from '../ui'

// Lazy so Crepe/Milkdown is NOT in the conversation-only bundle — it loads only when a doc is opened.
const CrepeDocEditor = lazyWithRetry(() => import('./CrepeDocEditor'))

/**
 * A markdown file rendered as a WYSIWYG document (the everyday-user surface). The file stays canonical
 * markdown on disk; this is the rich VIEW. Reads through the contained `fs:readFile` IPC, then hands a
 * non-binary file to the lazy, themed Crepe editor.
 *
 * `readOnly` here means one thing only: this file CANNOT be written back, because we loaded a leading
 * slice of it and saving would destroy the rest. It is not "the user isn't editing yet" — every
 * document opens in reading state and the editor owns that; see `docEditorGuards`. Passing truncation
 * as the same flag would leave a large file with an Edit action that could only ever lose text.
 *
 * The "show real markdown" path is the existing Monaco `file` view — the per-pane toggle in SurfaceHost.
 */
export function DocSurfaceView({
  path,
  rev = 0,
  sessionId,
  className = '',
}: {
  path: string
  /** Bumped by the store on each engine edit (showEditDoc). `path` is constant per mount (SurfacePane
   *  is path-keyed), so re-fetching on `rev` — without nulling `file` — keeps Crepe mounted and lets it
   *  swap content in place, so the user watches the agent build the doc live. */
  rev?: number
  /** The session that last edited this doc (stamped by showEditDoc). Lets the editor detect a NEW agent
   *  turn (busy rising edge) to re-baseline the Keep/Revert review window. */
  sessionId?: string
  className?: string
}) {
  const [file, setFile] = useState<ReadFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  }, [path, rev])

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div className="min-h-0 flex-1 overflow-hidden">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">Couldn't open this document: {error}</p>
        ) : !file ? (
          <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>
        ) : file.binary ? (
          <p className="px-4 py-3 text-xs text-text-muted">Binary file: can't display.</p>
        ) : (
          <Suspense fallback={<p className="px-4 py-3 text-xs text-text-muted">Loading editor…</p>}>
            <CrepeDocEditor
              path={file.path}
              surfacePath={path}
              initialContent={file.content}
              readOnly={file.truncated}
              sessionId={sessionId}
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
