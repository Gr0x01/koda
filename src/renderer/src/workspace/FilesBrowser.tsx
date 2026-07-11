import { useEffect, useState } from 'react'
import { AnimatePresence } from '../motion'
import { useWorkspace } from './store'
import { TreeContext, DirNode, ContextMenu, DeleteConfirm, type TreeCtx, type Menu } from './FileTree'

/**
 * The project Files browser (ui-workspace.md §9) — a lazy directory tree over the read-only
 * `fs:readDir` IPC, so Koda stands alone (no VSCode beside it). Clicking a file opens it as a
 * surface in the artifact zone; works with NO active session (files are project-level, not
 * session-level). Main contains every read to the project root — the renderer only ever holds
 * paths main already vetted.
 *
 * Beyond browsing, the tree is where a non-engineer ORGANIZES their own work: right-click (or
 * double-click) to rename, drag a file/folder onto a folder to move it, delete, and make new
 * folders. Every mutation routes through a path-contained, safety-git-checkpointed main handler —
 * so it's all recoverable from the timeline, on-thesis with "the human can" (the agent does file
 * ops too; this is the direct-manipulation path).
 */

export function FilesBrowser() {
  const [root, setRoot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ path: string; name: string } | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const newFolder = useWorkspace((s) => s.newFolder)
  const deleteEntry = useWorkspace((s) => s.deleteEntry)
  const treeError = useWorkspace((s) => s.treeError)
  const clearTreeError = useWorkspace((s) => s.clearTreeError)

  useEffect(() => {
    let alive = true
    window.koda
      .readDir({})
      .then((r) => alive && setRoot(r.path))
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [])

  if (error)
    return <p className="px-4 py-3 text-xs leading-relaxed text-red-400">Couldn't read the project folder: {error}</p>
  if (!root) return <p className="px-4 py-3 text-xs text-text-muted">Loading…</p>

  const ctx: TreeCtx = {
    renamingPath,
    startRename: (path) => {
      setMenu(null)
      setRenamingPath(path)
    },
    endRename: () => setRenamingPath(null),
    openMenu: (e, path, kind, isRoot) => {
      e.preventDefault()
      setMenu({ path, kind, isRoot, x: e.clientX, y: e.clientY })
    },
    draggingPath,
    setDraggingPath,
    dropTarget,
    setDropTarget,
  }

  return (
    <TreeContext.Provider value={ctx}>
      <div className="flex min-h-0 flex-1 flex-col">
        {treeError && (
          <button
            onClick={clearTreeError}
            title="Dismiss"
            className="mx-1.5 mb-1 shrink-0 rounded-md bg-red-500/10 px-2 py-1 text-left text-[11px] leading-snug text-red-400 transition-colors hover:bg-red-500/15"
          >
            {treeError}
          </button>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 pt-2 font-mono text-xs">
          <DirNode path={root} name={basename(root)} depth={0} isRoot defaultOpen />
        </div>
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={() => ctx.startRename(menu.path)}
          onNewFolder={() => {
            setMenu(null)
            void newFolder(menu.path)
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
              setConfirmDel(null)
            }}
          />
        )}
      </AnimatePresence>
    </TreeContext.Provider>
  )
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}
