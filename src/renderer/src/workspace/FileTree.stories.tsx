import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { FsEntry } from '@shared/ipc'
import { ContextMenu, DeleteConfirm, DirNode, TreeContext, type Menu, type TreeCtx } from './FileTree'

const ROOT = '/Users/rb/Documents/coding_projects/koda'

const ENTRIES: FsEntry[] = [
  { name: 'src', kind: 'dir' },
  { name: 'shared', kind: 'dir' },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'package.json', kind: 'file' },
  { name: 'README.md', kind: 'file' },
]

function withReadDirFixture(entries: FsEntry[]) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      readDir: { root: ROOT, path: ROOT, entries },
    }
    return <Story />
  }
}

/**
 * A minimal TreeContext host — the same menu/rename/drag wiring FilesBrowser gives DirNode, at leaf
 * scale, so DirNode/ContextMenu/DeleteConfirm can be exercised without pulling in the whole browser
 * (readDir + Documents watchers). Every DirNode expansion resolves the SAME bridge fixture regardless
 * of which sub-directory it asks for (the mock keys fixtures by method name, not args) — expanding a
 * folder here just re-shows the root's entries nested one level deeper. Harmless for a leaf story;
 * FilesBrowser's own story is where a believable multi-level tree matters.
 */
function TreeDemo({
  initialMenu,
  initialRenaming,
}: {
  initialMenu?: Menu
  initialRenaming?: string
}) {
  const [renamingPath, setRenamingPath] = useState<string | null>(initialRenaming ?? null)
  const [menu, setMenu] = useState<Menu | null>(initialMenu ?? null)
  const [confirmDel, setConfirmDel] = useState<{ path: string; name: string } | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const ctx: TreeCtx = {
    renamingPath,
    startRename: (path) => setRenamingPath(path),
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
      <div className="w-[260px] rounded-lg border border-border bg-bg p-1.5 font-mono text-xs">
        <DirNode path={ROOT} name="koda" depth={0} isRoot defaultOpen />
      </div>
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpen={() => setMenu(null)}
          onReveal={() => setMenu(null)}
          onCopyPath={() => setMenu(null)}
          onRename={() => {
            setRenamingPath(menu.path)
            setMenu(null)
          }}
          onNewFolder={() => setMenu(null)}
          onDuplicate={() => setMenu(null)}
          onDelete={() => {
            setConfirmDel({ path: menu.path, name: basename(menu.path) })
            setMenu(null)
          }}
        />
      )}
      {confirmDel && (
        <DeleteConfirm name={confirmDel.name} onCancel={() => setConfirmDel(null)} onConfirm={() => setConfirmDel(null)} />
      )}
    </TreeContext.Provider>
  )
}

function basename(path: string): string {
  return path.split('/').pop() || path
}

const meta = {
  title: 'Workspace/FileTree',
  component: DirNode,
  // Every story below renders its own TreeDemo instead of `<DirNode {...args}/>` — these just satisfy
  // DirNode's required props so `StoryObj<typeof meta>` type-checks.
  args: { path: ROOT, name: 'koda', depth: 0, isRoot: true, defaultOpen: true },
  decorators: [withReadDirFixture(ENTRIES)],
} satisfies Meta<typeof DirNode>

export default meta
type Story = StoryObj<typeof meta>

/** The expanded root — folders and files, hover/click affordances live (try right-click a row). */
export const Tree: Story = {
  render: () => <TreeDemo />,
}

/** A file mid-inline-rename — replaces the row with an editable input, stem pre-selected. */
export const RenamingFile: Story = {
  render: () => <TreeDemo initialRenaming={`${ROOT}/README.md`} />,
}

/** The right-click menu, opened on a file row — Open/Reveal/Copy path plus Rename/Duplicate/Delete. */
export const ContextMenuOpen: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <TreeDemo initialMenu={{ path: `${ROOT}/README.md`, kind: 'file', isRoot: false, x: 60, y: 70 }} />
  ),
}

/** The delete confirmation — destructive, so always confirmed, but reassuring (it's recoverable). */
export const DeleteConfirmDialog: Story = {
  parameters: { controls: { disable: true } },
  render: () => <DeleteConfirm name="old-notes.md" onCancel={() => {}} onConfirm={() => {}} />,
}
