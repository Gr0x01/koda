import type { Meta, StoryObj } from '@storybook/react-vite'
import type { FsEntry, ProjectDoc } from '@shared/ipc'
import { DocsBrowser } from './DocsBrowser'
import { useWorkspace } from './store'

const ROOT = '/Users/rb/Documents/coding_projects/koda'
const now = Date.now()

function doc(rel: string, mtimeAgoMs: number): ProjectDoc {
  const name = rel.split('/').pop()!
  return { path: `${ROOT}/${rel}`, rel, name, mtimeMs: now - mtimeAgoMs }
}

const DOCS: ProjectDoc[] = [
  doc('Documents/brief.md', 10 * 60_000),
  doc('Documents/release/ship-checklist-iphone.md', 45 * 60_000),
  doc('Documents/release/ship-checklist-desktop.md', 3 * 3_600_000),
  doc('Documents/design/storybook-status.md', 26 * 3_600_000),
  doc('Documents/guides/vibecoding-tips-plan.md', 4 * 86_400_000),
  // A stray: markdown that lives inside code, not in Documents/ — the panel's honest footer pointer.
  doc('src/renderer/README.md', 9 * 86_400_000),
]

/** listDocs is the doc list; readDir backs the Documents/ sub-folder walk (used only to surface
 *  empty/just-made folders). No `dir` entries here on purpose — the mock resolves the same fixture for
 *  every path, so any dirs would make that walk "discover" the same folder at every depth. Real
 *  sub-folders (Documents/release, Documents/design, …) still render because DocsBrowser derives them
 *  straight from each doc's `rel` path, independent of this walk. */
function withDocsFixtures(docs: ProjectDoc[]) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      listDocs: { root: ROOT, docs },
      readDir: { root: ROOT, path: ROOT, entries: [] satisfies FsEntry[] },
    }
    return <Story />
  }
}

/** Seeds the per-project open-folder memory the panel reads on mount, so a story can show either the
 *  fresh-launch shape (nothing open) or a tree the user has opened into. */
function withOpenFolders(keys: string[]) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    localStorage.setItem(`koda:doc-folders-open:${ROOT}`, JSON.stringify(keys))
    return <Story />
  }
}

function withDocsState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ treeError: null, filesRev: 0, ...partial })
    return <Story />
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[420px] w-[280px] flex-col overflow-hidden rounded-lg border border-border bg-bg">
      {children}
    </div>
  )
}

const meta = {
  title: 'Workspace/DocsBrowser',
  component: DocsBrowser,
  args: { view: 'tree' },
  // The open-folder memory is real localStorage, so it would leak between stories — seed the
  // fresh-launch shape for every story (a story-level decorator runs first and can override it).
  decorators: [withDocsFixtures(DOCS), withOpenFolders([]), withDocsState({}), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof DocsBrowser>

export default meta
type Story = StoryObj<typeof meta>

/** The doc-first tree as it looks on a fresh launch: loose docs at the top, then Documents/
 *  sub-folders closed (release, design, guides), and a quiet pointer to the one stray markdown file
 *  living outside Documents/. */
export const Default: Story = {}

/** The same tree with folders the user has opened — that shape is remembered per project, so this is
 *  what they come back to rather than everything hanging open. */
export const FoldersOpen: Story = {
  decorators: [withOpenFolders(['release', 'design'])],
}

/** The Recent lens — the same docs flattened by last-edited, grouped by day. */
export const Recent: Story = {
  args: { view: 'recent' },
}

/** A brand-new project: no writing yet, "New document" is the way in. */
export const Empty: Story = {
  decorators: [withDocsFixtures([])],
}

/** A dismissible error line above the list, from a failed rename/move. */
export const WithTreeError: Story = {
  decorators: [withDocsState({ treeError: "Couldn't move “brief.md” — a file with that name already exists there." })],
}
