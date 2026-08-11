import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../workspace/store'

/**
 * The doc's editable title — it IS the file name (RB's call). Editing renames the `.md` through the
 * store's `renameEntry`, which rebases open tabs + the tree, so this stays the one source of truth for
 * the page's name rather than a second title smuggled into the body. Renders inside the doc's scroll
 * host so it scrolls with the body.
 *
 * Notion-style icon + cover chrome was removed (2026-06-26): decoration that only pays off inside
 * Notion's linking/database web, which Koda doesn't have. The `.koda/docmeta/` sidecar still carries
 * table column widths — it just no longer carries icon/cover.
 */
export function DocPageChrome({
  path,
  readOnly,
  fullWidth = false,
}: {
  path: string
  readOnly: boolean
  /** Mirrors the doc body's per-doc full-width mode so the title tracks the same column. */
  fullWidth?: boolean
}): React.JSX.Element {
  const renameEntry = useWorkspace((s) => s.renameEntry)

  // File name parts: title = stem, the extension is preserved verbatim on rename.
  const file = path.split('/').pop() ?? ''
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  const [title, setTitle] = useState(stem)
  const titleRef = useRef<HTMLTextAreaElement>(null)

  // Reset the editable title when the file (path) changes.
  useEffect(() => {
    setTitle(stem)
  }, [path, stem])

  const commitTitle = (): void => {
    const clean = title.trim()
    if (!clean || clean === stem) {
      setTitle(stem) // empty or unchanged → snap back
      return
    }
    void renameEntry(path, clean + ext)
  }

  return (
    <div className={`mx-auto px-[3.25rem] pt-9 ${fullWidth ? 'max-w-none' : 'max-w-[46rem]'}`}>
      {/* Title = file name. A textarea so a long name wraps; Enter commits (no newlines in a name). */}
      <textarea
        ref={titleRef}
        value={title}
        readOnly={readOnly}
        rows={1}
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            titleRef.current?.blur()
          } else if (e.key === 'Escape') {
            setTitle(stem)
            titleRef.current?.blur()
          }
        }}
        spellCheck={false}
        className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-bold tracking-tight text-text outline-none placeholder:text-text-muted"
        style={{ fontFamily: 'var(--font-display)', fontSize: '2.3em', lineHeight: 1.15 }}
        placeholder="Untitled"
      />
    </div>
  )
}
