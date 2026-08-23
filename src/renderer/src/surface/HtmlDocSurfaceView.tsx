import { useEffect, useState } from 'react'

/**
 * An HTML file rendered as a document (typed-documents plan §4). The sibling of `DocSurfaceView`: same
 * job — show the artifact the way its reader is meant to meet it — but the renderer for this format is
 * the browser, so the document runs inside a sandboxed frame instead of a rich editor.
 *
 * It is NOT the preview surface. The preview fronts a running app: a dev server, a liveness mark, its
 * own navigation chrome. A document is a finished, self-contained file. So this surface asks main for a
 * URL on the separate `koda-preview://doc-<token>` origin, which serves that one file, refuses every
 * other path, and stamps the no-network policy on the response (`DOCUMENT_PREVIEW_CSP`, preview.ts).
 * Scripts are allowed — interaction is the whole reason this format exists — and that is safe only
 * because the frame has an opaque origin, no privileged globals, and nowhere to send anything.
 *
 * `sandbox="allow-scripts"` alone: no `allow-same-origin` (no storage, cookies, or same-origin reads),
 * no `allow-popups` (a `target="_blank"` or `window.open` is inert rather than a way out), no
 * `allow-forms`, no `allow-modals` (a document may not hold Koda's UI thread on an `alert()`), and no
 * top-navigation, so the frame cannot drive Koda's window. The main-process CSP repeats the sandbox
 * from the side this attribute cannot weaken.
 *
 * The raw-source escape hatch is the existing Monaco `file` view — the per-pane toggle in the stage bar.
 */
export function HtmlDocSurfaceView({
  path,
  rev = 0,
  className = '',
}: {
  path: string
  /** Bumped by the store on each engine edit (showEditDoc), so an agent rewrite re-renders live. */
  rev?: number
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped when the document changes on disk (agent, another session, an external editor). Koda's one
  // narrow watcher is the only file-change source; this surface adds no second watch of its own.
  const [diskRev, setDiskRev] = useState(0)

  useEffect(() => {
    setUrl(null)
    setError(null)
  }, [path])

  // Re-resolved on every revision rather than cached: the same call is main's existence and containment
  // check, so a document deleted or moved out from under the surface reports that instead of leaving a
  // frame pointed at a path that no longer resolves.
  useEffect(() => {
    let alive = true
    // Optional-chained: a dev renderer can outlive the preload that introduced this call.
    const pending = window.koda.docDocumentUrl?.(path)
    if (!pending) {
      setError('This build cannot open HTML documents yet.')
      return
    }
    pending
      .then((next) => {
        if (!alive) return
        setUrl(next)
        setError(next ? null : "Koda couldn't open this document — the file may have moved.")
      })
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [path, rev, diskRev])

  useEffect(() => {
    window.koda.watchFile({ path })
    const off = window.koda.onFileChanged((changed) => {
      if (changed === path) setDiskRev((n) => n + 1)
    })
    return () => {
      window.koda.unwatchFile({ path })
      off()
    }
  }, [path])

  const version = `${rev}.${diskRev}`
  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div className="min-h-0 flex-1 overflow-hidden bg-white">
        {error ? (
          <p className="px-4 py-3 text-xs text-red-400">{error}</p>
        ) : !url ? (
          <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>
        ) : (
          <iframe
            // Tagged for the document surface only. The preview's `data-preview-iframe` marks the
            // capture target for the agent's view_preview; a document is not that, and must not become
            // whatever the agent screenshots when it asks to see the running app.
            data-html-document-frame=""
            // The version rides both the key and the URL: the key remounts the frame on an edit, and
            // the query defeats any cached copy of a path that did not change.
            key={`${url}:${version}`}
            src={`${url}?v=${encodeURIComponent(version)}`}
            title={`${path.split('/').pop() ?? 'Document'} (sandboxed document)`}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts"
          />
        )}
      </div>
    </div>
  )
}
