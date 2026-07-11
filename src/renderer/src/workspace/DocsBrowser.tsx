import { useEffect, useState } from 'react'
import type { ProjectDoc } from '@shared/ipc'
import { Caret } from '../Caret'
import { useWorkspace, activeEditor } from './store'

/**
 * The doc-first sidebar's **Documents** list — the everyday-user default (ui-workspace.md; the
 * two-tier doc model). For a vibecoder the document is the primary object, not a file in a tree they
 * must know the shape of, so this reads like Notion / Apple Notes: prose docs, by title, found at a
 * glance. The full file tree (organize/code view) is one toggle away in the panel header.
 *
 * Scope = the user's writing, and only that: docs under `Documents/` (their home — where "New
 * document" lands) plus loose docs at the project root, with sub-folders shown as light disclosures.
 * A real repo also has markdown scattered through its code (a package README, a spike's FINDINGS) —
 * that isn't a *document* in the product sense, so it doesn't appear here; it lives in the Files
 * tree. We never try to classify a folder as "code" (there's no honest way to) — the only line is
 * "in Documents/ (or root) or not." When such markdown exists, one quiet footer points to Files so
 * nothing's hidden, just out of the way. (memory-bank/.claude are already excluded upstream.)
 *
 * Data is the read-only `fs:listDocs` IPC (main walks + contains + excludes project-knowledge dirs);
 * the renderer only opens paths main already vetted. Re-reads when `filesRev` bumps (a new/renamed/
 * deleted doc), so the list stays live with the tree's mutations and the "New document" button.
 */

const DOC_EXT = /\.(md|markdown|mdx|txt|rst|org)$/i

/** Koda's home folder for the user's deliverable documents — where "New document" lands. */
const HOME = 'Documents/'

/** A clean, Notion-style title: extension stripped, dashes/underscores read as spaces so a slug
 *  filename doesn't look like `ls` output. Case stays the author's ("Ui Ux" title-casing reads
 *  worse); the raw filename is still on the row's hover. */
function titleOf(name: string): string {
  return name.replace(DOC_EXT, '').replace(/[-_]+/g, ' ').trim() || name
}

/** A doc is "home" (the user's writing) when it lives in `Documents/` or loose at the project root.
 *  Everything else is markdown that happens to sit inside a code folder — it belongs to Files. */
function isHomeDoc(rel: string): boolean {
  return rel.startsWith(HOME) || !rel.includes('/')
}

/** The home sub-folder a doc sits in, relative to `Documents/` — `''` for loose root docs and docs
 *  directly in `Documents/`. e.g. `Documents/clients/acme.md` → "clients"; `Documents/brief.md` → "". */
function homeSubfolder(rel: string): string {
  const inner = rel.startsWith(HOME) ? rel.slice(HOME.length) : rel
  const slash = inner.lastIndexOf('/')
  return slash === -1 ? '' : inner.slice(0, slash)
}

export function DocsBrowser(): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [reloadNonce, setReloadNonce] = useState(0)
  const filesRev = useWorkspace((s) => s.filesRev)
  const setFilesView = useWorkspace((s) => s.setFilesView)

  useEffect(() => {
    let alive = true
    window.koda
      .listDocs({})
      .then((r) => {
        if (!alive) return
        setDocs(r.docs)
        setError(null)
      })
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [filesRev, reloadNonce])

  // Watch the Documents/ folder so agent/external adds+removes show up live, not just UI-made changes.
  useEffect(() => {
    window.koda.watchDocs()
    const off = window.koda.onDocsChanged(() => setReloadNonce((n) => n + 1))
    return () => {
      window.koda.unwatchDocs()
      off()
    }
  }, [])

  if (error)
    return <p className="px-4 py-3 text-xs leading-relaxed text-red-400">Couldn't list documents: {error}</p>
  if (!docs) return <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>

  // The user's writing (Documents/ + loose root) is the list; everything else is repo markdown that
  // only earns a footer pointer to Files. Group home docs by sub-folder, keeping main's newest-first.
  const loose: ProjectDoc[] = []
  const folders = new Map<string, ProjectDoc[]>()
  let strayCount = 0
  for (const d of docs) {
    if (!isHomeDoc(d.rel)) {
      strayCount++
      continue
    }
    const sub = homeSubfolder(d.rel)
    if (!sub) {
      loose.push(d)
    } else {
      const bucket = folders.get(sub) ?? []
      bucket.push(d)
      folders.set(sub, bucket)
    }
  }
  const folderKeys = [...folders.keys()].sort((a, b) => a.localeCompare(b))
  const homeEmpty = loose.length === 0 && folderKeys.length === 0

  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 pt-2">
      {homeEmpty ? (
        <p className="px-2.5 py-1.5 text-xs leading-relaxed text-text-muted">
          No documents yet. Hit <span className="text-text">New document</span> to start writing.
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {loose.map((d) => (
              <DocRow key={d.path} doc={d} />
            ))}
          </ul>

          {folderKeys.map((key) => {
            const open = !collapsed.has(key)
            return (
              <div key={key} className="mt-1">
                <FolderHeader label={key} open={open} count={folders.get(key)!.length} onClick={() => toggle(key)} />
                {open && (
                  <ul className="flex flex-col">
                    {folders.get(key)!.map((d) => (
                      <DocRow key={d.path} doc={d} indent />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* Everything outside Documents/ lives in the Files tree — one honest pointer, no "code" claim. */}
      {strayCount > 0 && (
        <button
          onClick={() => setFilesView('tree')}
          className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11.5px] text-text-muted/80 transition-colors hover:text-text ${
            homeEmpty ? '' : 'mt-1'
          }`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-80" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          <span className="truncate">
            {strayCount} more in this project — in <span className="text-text">Files</span>
          </span>
        </button>
      )}
    </div>
  )
}

/** A collapsible sub-folder disclosure — part of the list (a chevron + folder glyph + name), NOT a
 *  panel section header, so the user's own `Documents/` sub-folders read as structure, not a divider. */
function FolderHeader({
  label,
  open,
  count,
  onClick,
}: {
  label: string
  open: boolean
  count: number
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-text-muted transition-colors hover:bg-surface hover:text-text"
    >
      <Caret dir={open ? 'down' : 'right'} size={12} />
      <FolderGlyph />
      <span className="truncate text-[12px] font-medium leading-tight">{label}</span>
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-muted/60">{count}</span>
    </button>
  )
}

/** One document row — a muted page glyph + title. Opens (markdown ⇒ Doc view) on click. */
function DocRow({ doc, indent = false }: { doc: ProjectDoc; indent?: boolean }): React.JSX.Element {
  const openFile = useWorkspace((s) => s.openFile)
  const active = useWorkspace((s) => activeEditor(s).activeSurfaceId === doc.path)
  return (
    <li>
      <button
        onClick={() => openFile(doc.path)}
        title={doc.rel}
        className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors ${
          indent ? 'pl-5' : 'pl-2'
        } ${active ? 'bg-surface text-text' : 'text-text-muted hover:bg-surface hover:text-text'}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center leading-none">
          <DefaultDocGlyph />
        </span>
        <span className="truncate text-[13px] leading-tight">{titleOf(doc.name)}</span>
      </button>
    </li>
  )
}

/** A quiet line-art folder (inherits the row color) for sub-folder disclosures. */
function FolderGlyph(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 opacity-70"
      aria-hidden
    >
      <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
    </svg>
  )
}

/** The doc row icon — a quiet line-art page (inherits the row color). */
function DefaultDocGlyph(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="opacity-70"
      aria-hidden
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  )
}
