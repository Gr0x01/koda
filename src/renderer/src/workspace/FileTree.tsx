import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FsEntry } from '@shared/ipc'
import { Overlay, cardVariants, motion } from '../motion'
import { Caret } from '../Caret'
import { useWorkspace, activeEditor } from './store'

/**
 * Hand a row's drag gesture to the OS as a native file drag (shared with the Documents surface).
 * One gesture covers both worlds: our own folder rows still see it as a drop (move), and outside
 * the window it lands in Finder/Mail/a browser as the real file. The source path travels as view
 * state (draggingPath), not dataTransfer — a native drag only carries the file.
 *
 * `onDone` clears that state. Its listeners attach only after main confirms the drag is underway:
 * mousemove is suppressed for a drag's whole lifetime, so the first one after that means the
 * gesture ended without hitting one of our drop targets (e.g. dropped in Finder); blur covers the
 * user switching apps. Both may fire after a normal internal drop too — clearing twice is harmless.
 */
export function beginNativeDrag(e: React.DragEvent, path: string, onDone: () => void): void {
  e.preventDefault()
  window.koda.startDrag?.({ path })
    .then(() => {
      const done = (): void => {
        window.removeEventListener('mousemove', done)
        window.removeEventListener('blur', done)
        onDone()
      }
      window.addEventListener('mousemove', done)
      window.addEventListener('blur', done)
    })
    .catch(onDone)
}

export interface TreeCtx {
  renamingPath: string | null
  startRename: (path: string) => void
  endRename: () => void
  openMenu: (e: React.MouseEvent, path: string, kind: 'file' | 'dir', isRoot: boolean) => void
  draggingPath: string | null
  setDraggingPath: (path: string | null) => void
  dropTarget: string | null
  setDropTarget: (path: string | null) => void
}
export const TreeContext = createContext<TreeCtx | null>(null)
const useTree = (): TreeCtx => {
  const ctx = useContext(TreeContext)
  if (!ctx) throw new Error('TreeContext missing')
  return ctx
}

export type Menu = { path: string; kind: 'file' | 'dir'; isRoot: boolean; x: number; y: number }

/** A directory row that lazily loads + reveals its children on first expand, and accepts drops. */
export function DirNode({
  path,
  name,
  depth,
  isRoot = false,
  defaultOpen = false,
}: {
  path: string
  name: string
  depth: number
  isRoot?: boolean
  defaultOpen?: boolean
}) {
  const tree = useTree()
  // Expansion lives in the store (keyed by path) so the tree keeps its shape across sidebar
  // remounts; entries stay local and re-fetch lazily when a dir is (re)opened.
  const open = useWorkspace((s) => s.openDirs.includes(path))
  const setDirOpen = useWorkspace((s) => s.setDirOpen)
  const moveEntry = useWorkspace((s) => s.moveEntry)
  const importFiles = useWorkspace((s) => s.importFiles)
  // Re-read open dirs when the tree's contents change (new file/folder, rename, move, delete).
  const filesRev = useWorkspace((s) => s.filesRev)
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [readError, setReadError] = useState(false)

  // Seed the root open once — its expansion is the default; collapsible like any other afterward.
  useEffect(() => {
    if (defaultOpen) setDirOpen(path, true)
  }, [defaultOpen, path, setDirOpen])

  useEffect(() => {
    // (Re)load when this dir is open — on first expand, and again when filesRev bumps. Keep a read
    // failure distinct from an empty folder: hiding files behind a blank row is an unsafe lie.
    if (!open) return
    let alive = true
    window.koda
      .readDir({ path })
      .then((r) => {
        if (!alive) return
        setEntries(r.entries)
        setReadError(false)
      })
      .catch(() => {
        if (!alive) return
        setEntries(null)
        setReadError(true)
      })
    return () => {
      alive = false
    }
  }, [open, path, filesRev])

  // A drop is valid unless it's a no-op (already here) or a folder onto itself/a descendant. A Finder
  // drag (external files) is always a valid target — it imports INTO this folder.
  const from = tree.draggingPath
  const dropValid = !!from && parentDir(from) !== path && from !== path && !path.startsWith(from + '/')
  const isDropTarget = tree.dropTarget === path

  return (
    <div
      onDragOver={(e) => {
        // Our own drag (draggingPath set) is a move — gate on validity. Anything else with files is
        // a Finder drag — always a valid import target.
        if (tree.draggingPath ? !dropValid : !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        if (tree.dropTarget !== path) tree.setDropTarget(path)
      }}
      onDrop={(e) => {
        const src = tree.draggingPath
        if (src) {
          if (!dropValid) return
          e.preventDefault()
          e.stopPropagation()
          tree.setDropTarget(null)
          tree.setDraggingPath(null)
          void moveEntry(src, path)
          return
        }
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          e.stopPropagation()
          tree.setDropTarget(null)
          void importFiles(path, e.dataTransfer.files)
        }
      }}
    >
      {tree.renamingPath === path ? (
        <RenameRow path={path} name={name} depth={depth} isDir />
      ) : (
        <Row
          depth={depth}
          highlight={isDropTarget}
          onClick={() => setDirOpen(path, !open)}
          onDoubleClick={isRoot ? undefined : () => tree.startRename(path)}
          onContextMenu={(e) => tree.openMenu(e, path, 'dir', isRoot)}
          draggable={!isRoot}
          onDragStart={(e) => {
            tree.setDraggingPath(path)
            beginNativeDrag(e, path, () => {
              tree.setDraggingPath(null)
              tree.setDropTarget(null)
            })
          }}
        >
          <Caret dir={open ? 'down' : 'right'} size={12} className="text-text-muted" />
          <span className="truncate">{name}</span>
        </Row>
      )}
      {open &&
        entries?.map((e) =>
          e.kind === 'dir' ? (
            <DirNode key={e.name} path={`${path}/${e.name}`} name={e.name} depth={depth + 1} />
          ) : (
            <FileNode key={e.name} path={`${path}/${e.name}`} name={e.name} depth={depth + 1} />
          ),
        )}
      {open && readError && (
        <p className="py-1 pr-2 text-[11px] leading-snug text-red-400" style={{ paddingLeft: 22 + depth * 14 }}>
          Couldn't read this folder. Close and reopen it to try again.
        </p>
      )}
    </div>
  )
}

/** A file row — opens (or re-focuses) the file as a surface; highlighted while it's the open tab. */
function FileNode({ path, name, depth }: { path: string; name: string; depth: number }) {
  const tree = useTree()
  const openFile = useWorkspace((s) => s.openFile)
  const active = useWorkspace((s) => activeEditor(s).activeSurfaceId === path)

  if (tree.renamingPath === path) return <RenameRow path={path} name={name} depth={depth} />

  return (
    <Row
      depth={depth}
      active={active}
      onClick={() => openFile(path)}
      onDoubleClick={() => tree.startRename(path)}
      onContextMenu={(e) => tree.openMenu(e, path, 'file', false)}
      draggable
      onDragStart={(e) => {
        tree.setDraggingPath(path)
        beginNativeDrag(e, path, () => {
          tree.setDraggingPath(null)
          tree.setDropTarget(null)
        })
      }}
    >
      <span className="w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </Row>
  )
}

/** Inline rename input — replaces a row while editing. Commits on Enter/blur, cancels on Escape;
 *  pre-selects the basename stem (extension left out of the selection, Finder-style). */
function RenameRow({ path, name, depth, isDir = false }: { path: string; name: string; depth: number; isDir?: boolean }) {
  const tree = useTree()
  const renameEntry = useWorkspace((s) => s.renameEntry)
  const ref = useRef<HTMLInputElement>(null)
  const committed = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = isDir ? -1 : name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : name.length)
  }, [name, isDir])

  function commit(): void {
    if (committed.current) return
    committed.current = true
    const next = ref.current?.value ?? ''
    if (next && next !== name) void renameEntry(path, next)
    tree.endRename()
  }

  return (
    <div style={{ paddingLeft: depth * 12 + 8 }} className="flex items-center gap-1.5 py-1 pr-2">
      <span className="w-3 shrink-0" />
      <input
        ref={ref}
        defaultValue={name}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') {
            committed.current = true
            tree.endRename()
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-0.5 font-mono text-xs text-text outline-none"
      />
    </div>
  )
}

function Row({
  depth,
  active = false,
  highlight = false,
  onClick,
  onDoubleClick,
  onContextMenu,
  draggable,
  onDragStart,
  children,
}: {
  depth: number
  active?: boolean
  highlight?: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors ${
        highlight
          ? 'bg-accent/15 text-text ring-1 ring-inset ring-accent/40'
          : active
            ? 'bg-accent/10 text-accent'
            : 'text-text-muted hover:bg-surface hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}

/** A right-click menu, positioned at the cursor. A full-screen transparent layer behind it closes
 *  the menu on any outside click (or scroll). Items vary by what was clicked. */
export function ContextMenu({
  menu,
  onClose,
  onOpen,
  onReveal,
  onCopyPath,
  onRename,
  onNewFolder,
  onDuplicate,
  onDelete,
  pinLabel,
  onPin,
}: {
  menu: Menu
  onClose: () => void
  onOpen: () => void
  onReveal: () => void
  onCopyPath: () => void
  onRename: () => void
  onNewFolder: () => void
  onDuplicate: () => void
  onDelete: () => void
  /** When set (the Docs panel's doc rows), Pin/Unpin leads the menu — see DocsBrowser's pinning. */
  pinLabel?: string
  onPin?: () => void
}) {
  // A file gets "Open" (default app); folders lean on "Reveal in Finder" instead. Both, plus
  // "Copy path", are the Mac table-stakes that work everywhere — including the project root.
  const hasManageRow = menu.kind === 'dir' || !menu.isRoot
  // Clamp inside the viewport: a click near the bottom/right edge would otherwise open the menu
  // half off-screen. Measured after mount (item count varies), applied before paint — no flicker.
  const cardRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    // offsetWidth/Height are layout size — immune to the enter animation's scale transform.
    const pad = 8
    setPos({
      x: Math.max(pad, Math.min(menu.x, window.innerWidth - el.offsetWidth - pad)),
      y: Math.max(pad, Math.min(menu.y, window.innerHeight - el.offsetHeight - pad)),
    })
  }, [menu.x, menu.y])
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      {/* Enter-only scale-fade from the cursor corner; menus dismiss instantly (no exit anim needed). */}
      <motion.div
        ref={cardRef}
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        style={{ top: pos.y, left: pos.x, transformOrigin: 'top left' }}
        onClick={(e) => e.stopPropagation()}
        className="absolute min-w-[160px] overflow-hidden rounded-lg border border-border bg-bg py-1 text-xs shadow-pop"
      >
        {pinLabel && onPin && menu.kind === 'file' && (
          <>
            <MenuItem label={pinLabel} onClick={onPin} />
            <div className="my-1 border-t border-border" />
          </>
        )}
        {menu.kind === 'file' && <MenuItem label="Open" onClick={onOpen} />}
        <MenuItem label="Reveal in Finder" onClick={onReveal} />
        <MenuItem label="Copy path" onClick={onCopyPath} />
        {hasManageRow && <div className="my-1 border-t border-border" />}
        {menu.kind === 'dir' && <MenuItem label="New folder" onClick={onNewFolder} />}
        {!menu.isRoot && <MenuItem label="Rename" onClick={onRename} />}
        {!menu.isRoot && <MenuItem label="Duplicate" onClick={onDuplicate} />}
        {!menu.isRoot && <MenuItem label="Delete" danger onClick={onDelete} />}
      </motion.div>
    </div>
  )
}

function MenuItem({ label, danger = false, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface ${
        danger ? 'text-red-400' : 'text-text'
      }`}
    >
      {label}
    </button>
  )
}

/** Delete confirmation — destructive, so always confirmed, but reassuring (it's recoverable). */
export function DeleteConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Overlay
      onDismiss={onCancel}
      align="center"
      className="w-[320px] rounded-xl border border-border bg-bg p-4 shadow-soft"
    >
        <p className="text-sm font-medium text-text">Delete “{name}”?</p>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          You can undo this from the recovery timeline.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
          >
            Delete
          </button>
        </div>
    </Overlay>
  )
}

function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}
