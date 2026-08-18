import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from 'react'
import { AnimatePresence } from '../motion'
import { HoverCard } from '../ui'
import {
  DocumentContextMenu,
  DocumentDeleteConfirm,
  type DocumentMenuTarget,
} from './DocumentShelfMenu'
import { docTitle } from './library/library-format'
import { PanelHeader } from './PanelHeader'
import { activeEditor, useWorkspace } from './store'

/** Resolved metadata for the starred paths, from the exact `library:resolve` read. */
type StarredMeta = Record<string, { title: string; path: string }>

type DeleteTarget = Pick<DocumentMenuTarget, 'path' | 'title' | 'trigger'>

/**
 * The sidebar's compact **Documents** shelf — durable project shortcuts chosen in the Library.
 *
 * Membership already says that a row was starred, so the resting UI does not repeat that state in
 * both a heading and a large glyph on every item. The star remains where it is an actual toggle: in
 * the Library. Here a row is simply the document's title, with the complete item menu available from
 * right-click and from the keyboard-reachable overflow button.
 *
 * The payload stays deliberately small: project-relative paths and nothing else. Titles are re-read
 * from `library:resolve` only while the shelf has something in it. A path the Library cannot resolve
 * still renders from its filename, but only Unstar remains available — a stale shortcut is never
 * promoted into a filesystem target by reconstructing an absolute path.
 */
export function DocumentsShelf() {
  const starred = useWorkspace((s) => s.starredDocs)
  const activeSurfaceId = useWorkspace((s) => activeEditor(s).activeSurfaceId)
  const projectPath = useWorkspace((s) => s.projectPath)
  const hydrated = useWorkspace((s) => s.hydrated)
  const filesRev = useWorkspace((s) => s.filesRev)
  const openFile = useWorkspace((s) => s.openFile)
  const unstarDoc = useWorkspace((s) => s.unstarDoc)
  const deleteEntry = useWorkspace((s) => s.deleteEntry)
  const clearTreeError = useWorkspace((s) => s.clearTreeError)
  const migrateDocPins = useWorkspace((s) => s.migrateDocPins)
  const [meta, setMeta] = useState<StarredMeta>({})
  const [menu, setMenu] = useState<DocumentMenuTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  // Retain the last target through Menu's close animation.
  const lastMenu = useRef<DocumentMenuTarget | null>(null)
  if (menu) lastMenu.current = menu

  // Adopt the retired Documents pane's project-level pins after hydrate, so the restore cannot
  // overwrite the migration. No chat is required: project stars exist before and after conversations.
  useEffect(() => {
    if (hydrated && projectPath) migrateDocPins()
  }, [hydrated, projectPath, migrateDocPins])

  // Resolve the exact starred paths instead of consulting the Library's capped browse result. The same
  // response owns the small set of file watches, so external edits/deletes anywhere in the project
  // refresh metadata and availability without broadening the Documents-directory watcher.
  useEffect(() => {
    if (!starred.length || !projectPath) {
      setMeta({})
      return
    }
    let alive = true
    let request = 0
    const wanted = new Set(starred)
    const watched = new Set<string>()
    const refresh = async (): Promise<void> => {
      const current = ++request
      try {
        const r = await window.koda.libraryResolve({ rels: starred })
        if (!alive || current !== request) return
        const byRel: StarredMeta = {}
        for (const doc of r.docs)
          if (wanted.has(doc.rel)) byRel[doc.rel] = { title: docTitle(doc), path: doc.path }

        const nextPaths = new Set(Object.values(byRel).map((entry) => entry.path))
        for (const path of watched) if (!nextPaths.has(path)) window.koda.unwatchFile({ path })
        for (const path of nextPaths) if (!watched.has(path)) window.koda.watchFile({ path })
        watched.clear()
        for (const path of nextPaths) watched.add(path)
        setMeta(byRel)
      } catch {
        // A failed exact read must not leave filesystem actions enabled for a target whose current
        // identity was not confirmed. Keep any existing watch alive so a later change can retry.
        if (alive && current === request) setMeta({})
      }
    }
    const off = window.koda.onFileChanged((changed) => {
      if (watched.has(changed)) void refresh()
    })
    void refresh()
    return () => {
      alive = false
      request += 1
      off()
      for (const path of watched) window.koda.unwatchFile({ path })
    }
  }, [starred, filesRev, projectPath])

  if (!starred.length) return null

  return (
    <section aria-labelledby="documents-shelf-heading" className="flex shrink-0 flex-col">
      <PanelHeader
        title={
          <h2
            id="documents-shelf-heading"
            className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted"
          >
            Documents
          </h2>
        }
      />
      {/* Sessions and documents share the rail's one scroll owner, so this list never nests another
          scrollbar or pushes the pinned utilities off the bottom. */}
      <ul className="flex flex-col px-1.5 pb-2">
        {starred.map((rel) => {
          const hit = meta[rel]
          const filenameTitle = docTitle({ name: basename(rel) })
          // A path with no Library entry still gets a row: the filename, cleaned up the same way an
          // un-frontmattered document's is, so a starred thing never disappears on a failed lookup.
          const title = hit?.title ?? filenameTitle
          const path = hit?.path ?? (projectPath ? `${projectPath}/${rel}` : rel)
          const available = !!hit
          const active = available && activeSurfaceId === path
          const trigger = (
            <DocumentButton
              path={path}
              label={title}
              active={active}
              available={available}
              onOpen={openFile}
            />
          )
          const expanded = menu?.rel === rel
          return (
            <li
              key={rel}
              onContextMenu={(e) => {
                e.preventDefault()
                const row = e.currentTarget
                setMenu({
                  rel,
                  path,
                  title,
                  available,
                  trigger: row.querySelector<HTMLButtonElement>('[data-document-open]'),
                  x: e.clientX,
                  y: e.clientY,
                })
              }}
              className={`group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-surface focus-within:bg-surface ${
                active || expanded ? 'bg-surface' : ''
              }`}
            >
              {/* A path is useful only when it disambiguates the title. Showing `CHANGELOG.md` when
                  the row already says CHANGELOG is repetition, not disclosure. */}
              {pathAddsContext(rel, title, filenameTitle) ? (
                <HoverCard trigger={trigger} disabled={!!menu || !!deleteTarget}>
                  <span className="break-all font-mono text-[11px]">{rel}</span>
                </HoverCard>
              ) : (
                trigger
              )}
              <button
                type="button"
                aria-label={`Actions for ${title}`}
                aria-haspopup="menu"
                aria-expanded={expanded}
                onClick={(e) => {
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  setMenu({
                    rel,
                    path,
                    title,
                    available,
                    trigger: e.currentTarget,
                    x: rect.right - 176,
                    y: rect.bottom + 4,
                  })
                }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 outline-none transition group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-text/[0.08] hover:text-text focus-visible:bg-text/[0.08] focus-visible:text-text ${
                  expanded ? 'bg-text/[0.08] text-text opacity-100' : ''
                }`}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden
                >
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
            </li>
          )
        })}
      </ul>

      {lastMenu.current && (
        <DocumentContextMenu
          open={!!menu}
          target={lastMenu.current}
          onClose={() => setMenu(null)}
          onOpen={() => {
            if (lastMenu.current!.available) openFile(lastMenu.current!.path)
          }}
          onReveal={() => {
            if (lastMenu.current!.available)
              void window.koda.revealPath({ path: lastMenu.current!.path })
          }}
          onUnstar={() => unstarDoc(lastMenu.current!.rel)}
          onDelete={() => {
            if (!lastMenu.current!.available) return
            clearTreeError()
            setDeleteTarget({
              path: lastMenu.current!.path,
              title: lastMenu.current!.title,
              trigger: lastMenu.current!.trigger,
            })
          }}
        />
      )}

      <AnimatePresence>
        {deleteTarget && (
          <DocumentDeleteConfirm
            target={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={async () => {
              const result = await deleteEntry(deleteTarget.path, { document: true })
              if (result.ok) {
                setDeleteTarget(null)
                return null
              }
              return result.error
            }}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

/** The title is the row's one primary action. `forwardRef` + `...rest` lets HoverCard clone it in
 *  place for the minority of rows whose path actually adds information. */
const DocumentButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    path: string
    label: string
    active: boolean
    available: boolean
    onOpen: (path: string) => void
  }
>(function DocumentButton({ path, label, active, available, onOpen, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-document-open=""
      aria-disabled={!available}
      onClick={() => {
        if (available) onOpen(path)
      }}
      className={`flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left outline-none transition-colors focus-visible:bg-text/[0.05] ${
        active
          ? 'text-text'
          : available
            ? 'text-text-muted group-hover:text-text'
            : 'cursor-default text-text-muted/60'
      }`}
      {...rest}
    >
      <span className="truncate text-[13px] leading-tight">{label}</span>
    </button>
  )
})

/** The star is a toggle in the Library. It is intentionally absent from every row on the shelf,
 *  where membership already communicates the same state. */
export function StarGlyph({
  filled = true,
  size = 12,
  className = 'text-accent',
}: {
  filled?: boolean
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.4l-5.8 3.06 1.1-6.46-4.69-4.58 6.49-.94L12 2.6Z" />
    </svg>
  )
}

function pathAddsContext(rel: string, title: string, filenameTitle: string): boolean {
  return rel.includes('/') || normalizeLabel(title) !== normalizeLabel(filenameTitle)
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}
