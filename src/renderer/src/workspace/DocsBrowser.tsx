import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ProjectDoc } from '@shared/ipc'
import { AnimatePresence } from '../motion'
import { Caret } from '../Caret'
import { useWorkspace, activeEditor } from './store'
import { ContextMenu, DeleteConfirm, DRAG_MIME, type Menu } from './FileTree'

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
 *
 * Beyond browsing, this is also where a non-engineer ORGANIZES their writing without dropping into a
 * file tree: right-click a doc to rename, reveal, copy its path, or delete it, and drag a doc onto a
 * folder to file it there. Every mutation is the same path-contained, safety-git-checkpointed main
 * handler the Files tree uses — so it's recoverable from the timeline (see FilesBrowser).
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

/** A `Documents/` sub-folder folded into a tree so nesting renders as indentation, not `a/b` flat rows.
 *  `key` is the full rel path within Documents/ ("smart-home/plans"); `name` is just its last segment. */
interface FolderNode {
  key: string
  name: string
  path: string | null
  docs: ProjectDoc[]
  children: FolderNode[]
}

/** Row interactions shared by every DocRow / FolderHeader / FolderTree without prop-drilling — mirrors
 *  FileTree's TreeContext, but this surface renames inline and only moves docs *into* folders. */
interface DocsCtx {
  openMenu: (e: React.MouseEvent, path: string, kind?: 'file' | 'dir') => void
  renamingPath: string | null
  startRename: (path: string) => void
  commitRename: (path: string, name: string) => void
  cancelRename: () => void
  draggingPath: string | null
  setDraggingPath: (path: string | null) => void
  dropTarget: string | null
  setDropTarget: (path: string | null) => void
  moveDoc: (from: string, toDir: string) => void
  importDocs: (destDir: string, files: Iterable<File>) => void
  setSelected: (path: string, kind: 'file' | 'dir') => void
  selectedPath: string | null
  collapsed: Set<string>
  toggle: (key: string) => void
}
const DocsContext = createContext<DocsCtx | null>(null)
const useDocs = (): DocsCtx => {
  const ctx = useContext(DocsContext)
  if (!ctx) throw new Error('DocsContext missing')
  return ctx
}

export function DocsBrowser(): React.JSX.Element {
  const [docs, setDocs] = useState<ProjectDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [reloadNonce, setReloadNonce] = useState(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ path: string; name: string } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [subdirs, setSubdirs] = useState<string[]>([])
  const [dropActive, setDropActive] = useState(false)
  const [selected, setSelected] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)
  const dropDepth = useRef(0)
  const filesRev = useWorkspace((s) => s.filesRev)
  const setFilesView = useWorkspace((s) => s.setFilesView)
  const deleteEntry = useWorkspace((s) => s.deleteEntry)
  const duplicateEntry = useWorkspace((s) => s.duplicateEntry)
  const renameEntry = useWorkspace((s) => s.renameEntry)
  const moveEntry = useWorkspace((s) => s.moveEntry)
  const importFiles = useWorkspace((s) => s.importFiles)
  const newDocument = useWorkspace((s) => s.newDocument)
  const newFolder = useWorkspace((s) => s.newFolder)
  const treeError = useWorkspace((s) => s.treeError)
  const clearTreeError = useWorkspace((s) => s.clearTreeError)

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

  // The project root (absolute), so a drop onto a folder can name its destination, and the immediate
  // Documents/ sub-folders — so a folder the user just made shows up (and is droppable) even before it
  // holds any docs. Re-read with the doc list. A missing Documents/ (new project) settles to none.
  useEffect(() => {
    let alive = true
    window.koda.readDir({}).then(async (r) => {
      if (!alive) return
      setRoot(r.path)
      const base = `${r.path}/${HOME.slice(0, -1)}`
      const pending: Array<{ path: string; rel: string }> = [{ path: base, rel: '' }]
      const found: string[] = []
      while (pending.length && found.length < 200) {
        const current = pending.shift()!
        try {
          const listed = await window.koda.readDir({ path: current.path })
          for (const entry of listed.entries) {
            if (entry.kind !== 'dir') continue
            const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
            found.push(rel)
            pending.push({ path: `${current.path}/${entry.name}`, rel })
          }
        } catch {
          // A missing Documents/ is normal in a new project.
        }
      }
      if (alive) setSubdirs(found)
    }).catch(() => alive && setSubdirs([]))
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

  useEffect(() => {
    const onRename = (e: Event): void => {
      const path = (e as CustomEvent<string>).detail
      setSelected({ path, kind: 'dir' })
      window.dispatchEvent(new CustomEvent('koda:docs-folder-selected', { detail: path }))
      setRenamingPath(path)
    }
    window.addEventListener('koda:rename-doc-folder', onRename)
    return () => window.removeEventListener('koda:rename-doc-folder', onRename)
  }, [])

  if (error)
    return <p className="px-4 py-3 text-xs leading-relaxed text-red-400">Couldn't list documents: {error}</p>
  if (!docs) return <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>

  // The user's writing (Documents/ + loose root) is the list; everything else is repo markdown that
  // only earns a footer pointer to Files. Group home docs by their sub-folder (a full rel path within
  // Documents/, e.g. "smart-home/plans"), keeping main's newest-first within each folder.
  const loose: ProjectDoc[] = []
  const docsByFolder = new Map<string, ProjectDoc[]>()
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
      const bucket = docsByFolder.get(sub) ?? []
      bucket.push(d)
      docsByFolder.set(sub, bucket)
    }
  }
  // Every folder we show: those holding docs, plus every walked sub-dir (so a just-made / empty folder
  // still appears), plus every ANCESTOR of those — a nested folder can't render without its parent node.
  const folderKeys = new Set<string>([...docsByFolder.keys(), ...subdirs])
  for (const key of [...folderKeys]) {
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) folderKeys.add(parts.slice(0, i).join('/'))
  }

  // Absolute `Documents/` path, so a drop onto a folder can name its destination.
  const docsBase = root ? `${root}/${HOME.slice(0, -1)}` : null

  // Fold the flat rel-keys into a real tree so sub-folders nest & indent instead of showing as
  // "smart-home/Default" flat rows. Each node carries its own direct docs; children sort by name.
  const nodeByKey = new Map<string, FolderNode>()
  for (const key of folderKeys) {
    nodeByKey.set(key, {
      key,
      name: key.split('/').pop()!,
      path: docsBase ? `${docsBase}/${key}` : null,
      docs: docsByFolder.get(key) ?? [],
      children: [],
    })
  }
  const rootFolders: FolderNode[] = []
  for (const node of nodeByKey.values()) {
    const slash = node.key.lastIndexOf('/')
    const parent = slash === -1 ? null : nodeByKey.get(node.key.slice(0, slash))
    if (parent) parent.children.push(node)
    else rootFolders.push(node)
  }
  const sortTree = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of nodes) sortTree(n.children)
  }
  sortTree(rootFolders)

  const homeEmpty = loose.length === 0 && rootFolders.length === 0

  // The flattened, in-render-order list (honoring collapse) that arrow-key nav walks — docs first, then
  // each folder followed by its docs and expanded descendants, matching what's painted below.
  const visibleItems: Array<{ path: string; kind: 'file' | 'dir'; folderKey?: string }> = [
    ...loose.map((doc) => ({ path: doc.path, kind: 'file' as const })),
  ]
  const walkVisible = (nodes: FolderNode[]): void => {
    for (const node of nodes) {
      if (node.path) visibleItems.push({ path: node.path, kind: 'dir', folderKey: node.key })
      if (!collapsed.has(node.key)) {
        for (const d of node.docs) visibleItems.push({ path: d.path, kind: 'file' })
        walkVisible(node.children)
      }
    }
  }
  walkVisible(rootFolders)

  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const ctx: DocsCtx = {
    openMenu: (e, path, kind = 'file') => {
      e.preventDefault()
      setSelected({ path, kind })
      setMenu({ path, kind, isRoot: false, x: e.clientX, y: e.clientY })
    },
    renamingPath,
    startRename: (path) => setRenamingPath(path),
    commitRename: (path, name) => {
      setRenamingPath(null)
      setSelected(null)
      window.dispatchEvent(new CustomEvent('koda:docs-folder-selected', { detail: null }))
      void renameEntry(path, name)
    },
    cancelRename: () => setRenamingPath(null),
    draggingPath,
    setDraggingPath,
    dropTarget,
    setDropTarget,
    moveDoc: (from, toDir) => void moveEntry(from, toDir),
    importDocs: (destDir, files) => void importFiles(destDir, files),
    setSelected: (path, kind) => {
      setSelected({ path, kind })
      window.dispatchEvent(new CustomEvent('koda:docs-folder-selected', { detail: kind === 'dir' ? path : null }))
    },
    selectedPath: selected?.path ?? null,
    collapsed,
    toggle,
  }

  // Finder-drag import onto the panel background lands in Documents/ (a drop onto a folder row is
  // handled by that row → into that folder). Count depth: dragenter/leave fire per child.
  const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

  return (
    <DocsContext.Provider value={ctx}>
      <div
        tabIndex={0}
        onKeyDown={(e) => {
          if (renamingPath) return
          const selectedIndex = selected ? visibleItems.findIndex((item) => item.path === selected.path) : -1
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!visibleItems.length) return
            const delta = e.key === 'ArrowDown' ? 1 : -1
            const index = selectedIndex < 0 ? (delta > 0 ? 0 : visibleItems.length - 1) : Math.max(0, Math.min(visibleItems.length - 1, selectedIndex + delta))
            const item = visibleItems[index]
            ctx.setSelected(item.path, item.kind)
            return
          }
          if (!selected) return
          if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected.kind === 'dir') {
            e.preventDefault()
            const item = visibleItems[selectedIndex]
            if (item?.folderKey) setCollapsed((prev) => {
              const next = new Set(prev)
              if (e.key === 'ArrowLeft') next.add(item.folderKey!)
              else next.delete(item.folderKey!)
              return next
            })
          } else
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && selected.kind === 'dir') {
            e.preventDefault()
            void newDocument(selected.path)
          } else if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault()
            setRenamingPath(selected.path)
          } else if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault()
            setConfirmDel({ path: selected.path, name: basename(selected.path) })
          } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
            e.preventDefault()
            void duplicateEntry(selected.path)
          }
        }}
        onDragEnter={(e) => {
          if (!isFileDrag(e)) return
          dropDepth.current += 1
          setDropActive(true)
        }}
        onDragLeave={(e) => {
          if (!isFileDrag(e)) return
          dropDepth.current = Math.max(0, dropDepth.current - 1)
          if (dropDepth.current === 0) setDropActive(false)
        }}
        onDragOver={(e) => {
          if (isFileDrag(e)) e.preventDefault()
        }}
        // Capture always fires, even when a folder row handles the drop and stops propagation — so
        // the highlight always clears. The bubble handler below imports only a background drop.
        onDropCapture={(e) => {
          if (!isFileDrag(e)) return
          dropDepth.current = 0
          setDropActive(false)
        }}
        onDrop={(e) => {
          if (!isFileDrag(e)) return
          e.preventDefault()
          if (e.dataTransfer.files.length) void importFiles(undefined, e.dataTransfer.files)
        }}
        className={`min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 pt-2 ${
          dropActive ? 'rounded-md bg-accent/5 ring-1 ring-inset ring-accent/30' : ''
        }`}
      >
        {treeError && (
          <button
            onClick={clearTreeError}
            title="Dismiss"
            className="mb-1 w-full rounded-md bg-red-500/10 px-2 py-1 text-left text-[11px] leading-snug text-red-400 transition-colors hover:bg-red-500/15"
          >
            {treeError}
          </button>
        )}

        {homeEmpty ? (
          <p className="px-2.5 py-1.5 text-xs leading-relaxed text-text-muted">
            No documents yet. Hit <span className="text-text">New document</span> to start writing.
          </p>
        ) : (
          <>
            <ul className="flex flex-col">
              {loose.map((d) => (
                <DocRow key={d.path} doc={d} depth={0} />
              ))}
            </ul>

            {rootFolders.map((node) => (
              <FolderTree key={node.key} node={node} depth={0} />
            ))}
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

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpen={() => {
            setMenu(null)
            void window.koda.openPath({ path: menu.path })
          }}
          onReveal={() => {
            setMenu(null)
            void window.koda.revealPath({ path: menu.path })
          }}
          onCopyPath={() => {
            setMenu(null)
            void navigator.clipboard.writeText(menu.path)
          }}
          onRename={() => {
            setMenu(null)
            setRenamingPath(menu.path)
          }}
          onNewFolder={() => {
            setMenu(null)
            void newFolder(menu.path).then((path) => path && setRenamingPath(path))
          }}
          onDuplicate={() => {
            setMenu(null)
            void duplicateEntry(menu.path)
          }}
          onDelete={() => {
            setMenu(null)
            setConfirmDel({ path: menu.path, name: basename(menu.path) })
          }}
        />
      )}

      <AnimatePresence>
        {confirmDel && (
          <DeleteConfirm
            name={confirmDel.name}
            onCancel={() => setConfirmDel(null)}
            onConfirm={() => {
              void deleteEntry(confirmDel.path)
              setSelected(null)
              window.dispatchEvent(new CustomEvent('koda:docs-folder-selected', { detail: null }))
              setConfirmDel(null)
            }}
          />
        )}
      </AnimatePresence>
    </DocsContext.Provider>
  )
}

/** One folder node and its descendants — the header plus, when open, its direct docs and child folders
 *  (each one level deeper). Recursion is what turns the flat rel-keys into a real indented tree. */
function FolderTree({ node, depth }: { node: FolderNode; depth: number }): React.JSX.Element {
  const docs = useDocs()
  const open = !docs.collapsed.has(node.key)
  const destDir = node.path
  return (
    <div className={depth === 0 ? 'mt-1' : undefined}>
      <FolderHeader
        label={node.name}
        depth={depth}
        open={open}
        count={node.docs.length}
        destDir={destDir}
        onClick={() => docs.toggle(node.key)}
        selected={docs.selectedPath === destDir}
        renaming={docs.renamingPath === destDir}
        onSelect={() => destDir && docs.setSelected(destDir, 'dir')}
        onMenu={(e) => destDir && docs.openMenu(e, destDir, 'dir')}
        onStartRename={() => destDir && docs.startRename(destDir)}
        onRename={(name) => destDir && docs.commitRename(destDir, name)}
        onCancelRename={docs.cancelRename}
      />
      {open && (
        <>
          <ul className="flex flex-col">
            {node.docs.map((d) => (
              <DocRow key={d.path} doc={d} depth={depth + 1} />
            ))}
          </ul>
          {node.children.map((child) => (
            <FolderTree key={child.key} node={child} depth={depth + 1} />
          ))}
        </>
      )}
    </div>
  )
}

/** A collapsible sub-folder disclosure — part of the list (a chevron + folder glyph + name), NOT a
 *  panel section header, so the user's own `Documents/` sub-folders read as structure, not a divider.
 *  Indents by `depth` so nesting is visible. Doubles as a drop target: dragging a doc onto it files
 *  that doc into the folder. The chevron toggles expand *without* selecting — so merely opening a
 *  folder to look inside doesn't silently make it the "New folder/document" target; clicking the name
 *  does (which also opens it), and that target is shown in the panel's create-button tooltips. */
function FolderHeader({
  label,
  depth,
  open,
  count,
  destDir,
  onClick,
  selected,
  renaming,
  onSelect,
  onMenu,
  onStartRename,
  onRename,
  onCancelRename,
}: {
  label: string
  depth: number
  open: boolean
  count: number
  destDir: string | null
  onClick: () => void
  selected: boolean
  renaming: boolean
  onSelect: () => void
  onMenu: (e: React.MouseEvent) => void
  onStartRename: () => void
  onRename: (name: string) => void
  onCancelRename: () => void
}): React.JSX.Element {
  const docs = useDocs()
  // Internal move is valid unless the dragged doc already lives here (moveEntry no-ops it anyway; this
  // just skips the highlight). A Finder drag (external files) always targets the folder — it imports
  // INTO it. We only ever drag docs (files), so the folder-into-itself case can't arise.
  const from = docs.draggingPath
  const internalValid = !!from && !!destDir && parentDir(from) !== destDir
  // Identify the drop target by its unique path, not the display name (two folders can share a name).
  const isDropTarget = !!destDir && docs.dropTarget === destDir

  if (renaming && destDir)
    return (
      <FolderRenameRow
        name={basename(destDir)}
        depth={depth}
        onCommit={onRename}
        onCancel={onCancelRename}
      />
    )

  return (
    <button
      onClick={() => {
        onSelect()
        if (!open) onClick() // clicking the name selects + opens; the chevron alone toggles closed
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        onStartRename()
      }}
      onContextMenu={onMenu}
      onDragOver={(e) => {
        if (!destDir) return
        if (!e.dataTransfer.types.includes('Files') && !internalValid) return
        e.preventDefault()
        if (docs.dropTarget !== destDir) docs.setDropTarget(destDir)
      }}
      onDrop={(e) => {
        if (!destDir) return
        if (e.dataTransfer.files.length) {
          // stop the panel's background handler from also importing (it lands in Documents/).
          e.preventDefault()
          e.stopPropagation()
          docs.setDropTarget(null)
          docs.importDocs(destDir, e.dataTransfer.files)
          return
        }
        if (!internalValid) return
        e.preventDefault()
        e.stopPropagation()
        const src = e.dataTransfer.getData(DRAG_MIME)
        docs.setDropTarget(null)
        if (src) docs.moveDoc(src, destDir)
      }}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={`group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left transition-colors ${
        isDropTarget
          ? 'bg-accent/15 text-text ring-1 ring-inset ring-accent/40'
          : selected
            ? 'bg-surface text-text'
            : 'text-text-muted hover:bg-surface hover:text-text'
      }`}
    >
      <span
        role="button"
        aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className="-my-1 flex h-6 w-4 shrink-0 items-center justify-center"
      >
        <Caret dir={open ? 'down' : 'right'} size={12} />
      </span>
      <FolderGlyph />
      <span className="truncate text-[12px] font-medium leading-tight">{label}</span>
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-muted/60">{count}</span>
      <span
        role="button"
        aria-label={`More actions for ${label}`}
        title="More actions"
        onClick={(e) => {
          e.stopPropagation()
          onMenu(e)
        }}
        className="-mr-1 hidden rounded px-1 text-base leading-none text-text-muted hover:bg-bg hover:text-text group-hover:block"
      >
        ···
      </span>
    </button>
  )
}

function FolderRenameRow({ name, depth, onCommit, onCancel }: { name: string; depth: number; onCommit: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (): void => {
    if (done.current) return
    done.current = true
    const next = ref.current?.value.trim() ?? ''
    if (next && next !== name) onCommit(next)
    else onCancel()
  }
  return (
    <div className="flex items-center gap-1.5 py-1.5 pr-2" style={{ paddingLeft: depth * 12 + 8 }}>
      <FolderGlyph />
      <input ref={ref} defaultValue={name} onBlur={commit} onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') { done.current = true; onCancel() }
      }} className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-0.5 text-xs text-text outline-none" />
    </div>
  )
}

/** One document row — a muted page glyph + title. Opens (markdown ⇒ Doc view) on click; right-click
 *  for the manage menu, drag onto a folder to file it, and becomes an inline editor while renaming. */
function DocRow({ doc, depth }: { doc: ProjectDoc; depth: number }): React.JSX.Element {
  const openFile = useWorkspace((s) => s.openFile)
  const active = useWorkspace((s) => activeEditor(s).activeSurfaceId === doc.path)
  const docs = useDocs()

  if (docs.renamingPath === doc.path)
    return (
      <li>
        <RenameRow doc={doc} depth={depth} onCommit={docs.commitRename} onCancel={docs.cancelRename} />
      </li>
    )

  return (
    <li>
      <button
        onClick={() => {
          docs.setSelected(doc.path, 'file')
          openFile(doc.path)
        }}
        onContextMenu={(e) => docs.openMenu(e, doc.path)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, doc.path)
          e.dataTransfer.effectAllowed = 'move'
          docs.setDraggingPath(doc.path)
        }}
        onDragEnd={() => {
          docs.setDraggingPath(null)
          docs.setDropTarget(null)
        }}
        title={doc.rel}
        style={{ paddingLeft: depth * 12 + 8 }}
        className={`group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors ${
          active ? 'bg-surface text-text' : 'text-text-muted hover:bg-surface hover:text-text'
        }`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center leading-none">
          <DefaultDocGlyph />
        </span>
        <span className="truncate text-[13px] leading-tight">{titleOf(doc.name)}</span>
        <span
          role="button"
          aria-label={`More actions for ${titleOf(doc.name)}`}
          title="More actions"
          onClick={(e) => {
            e.stopPropagation()
            docs.openMenu(e, doc.path)
          }}
          className="ml-auto hidden rounded px-1 text-base leading-none text-text-muted hover:bg-bg hover:text-text group-hover:block"
        >
          ···
        </span>
      </button>
    </li>
  )
}

/** Inline rename editor — replaces a doc row while editing. Seeds the raw filename (not the prettied
 *  title, so the extension is preserved) and pre-selects the stem; commits on Enter/blur, cancels on
 *  Escape. Reuses the store's project-wide `renameEntry` via the parent. */
function RenameRow({
  doc,
  depth,
  onCommit,
  onCancel,
}: {
  doc: ProjectDoc
  depth: number
  onCommit: (path: string, name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = doc.name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : doc.name.length)
  }, [doc.name])

  function commit(): void {
    if (done.current) return
    done.current = true
    const next = ref.current?.value ?? ''
    if (next && next !== doc.name) onCommit(doc.path, next)
    else onCancel()
  }

  return (
    <div className="flex items-center gap-2 py-1.5 pr-2" style={{ paddingLeft: depth * 12 + 8 }}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center leading-none">
        <DefaultDocGlyph />
      </span>
      <input
        ref={ref}
        defaultValue={doc.name}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') {
            done.current = true
            onCancel()
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-0.5 text-[13px] text-text outline-none"
      />
    </div>
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

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
