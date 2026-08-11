import type { Meta, StoryObj } from '@storybook/react-vite'
import type { FsEntry, ProjectDoc, ScratchImage } from '@shared/ipc'
import { Sidebar } from './Sidebar'
import { useWorkspace, type SessionState } from './store'

// A 1x1 black pixel — enough for the Recent images strip to render a real <img> without a network
// round-trip (Storybook has no `.koda/scratch/` folder to read from).
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const PROJECT_ROOT = '/Users/rb/Documents/coding_projects/koda'

const TREE_ENTRIES: FsEntry[] = [
  { name: 'Documents', kind: 'dir' },
  { name: 'src', kind: 'dir' },
  { name: 'shared', kind: 'dir' },
  { name: '.koda', kind: 'dir' },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'package.json', kind: 'file' },
  { name: 'README.md', kind: 'file' },
]

const DOCS: ProjectDoc[] = [
  { path: `${PROJECT_ROOT}/Documents/release/ship-checklist-iphone.md`, rel: 'Documents/release/ship-checklist-iphone.md', name: 'ship-checklist-iphone.md', mtimeMs: Date.now() - 1000 * 60 * 20 },
  { path: `${PROJECT_ROOT}/Documents/design/storybook-status.md`, rel: 'Documents/design/storybook-status.md', name: 'storybook-status.md', mtimeMs: Date.now() - 1000 * 60 * 60 * 3 },
  { path: `${PROJECT_ROOT}/Documents/brief.md`, rel: 'Documents/brief.md', name: 'brief.md', mtimeMs: Date.now() - 1000 * 60 * 60 * 26 },
]

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: PROJECT_ROOT,
    items: [],
    streaming: '',
    busy: false,
    errored: false,
    draft: '',
    attachments: [],
    live: true,
    attention: false,
    approvalMode: 'auto',
    engineId: 'claude',
    spendUsd: 0,
    byModel: {},
    ...overrides,
  }
}

/** Bridge fixtures every Sidebar story needs — the Files/Docs section reads the project tree, the
 *  Recent images strip reads scratch images. Entries carry no nested dirs by default so DocsBrowser's
 *  Documents/ sub-folder walk (which reuses this same fixture for every path — the mock doesn't
 *  discriminate by args) settles to an empty list instead of a misleading recursive tree. */
function withBridgeFixtures(opts: { treeEntries?: FsEntry[]; docs?: ProjectDoc[]; images?: ScratchImage[] } = {}) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      readDir: { root: PROJECT_ROOT, path: PROJECT_ROOT, entries: opts.treeEntries ?? [] },
      listDocs: { root: PROJECT_ROOT, docs: opts.docs ?? [] },
      listScratchImages: { images: opts.images ?? [], total: (opts.images ?? []).length },
    }
    return <Story />
  }
}

/** Resets the whole slice Sidebar (+ its Sessions/Files/Recent-images children) reads, then layers
 *  the story's own overrides — mirrors StatusBar's withFooterState so switching stories never leaks a
 *  previous one's sessions/tree state. */
function withSidebarState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      sessions: {},
      order: [],
      activeId: null,
      pending: [],
      gitFiles: [],
      sidebarWidth: 320,
      sessionsFrac: 0.4,
      filesView: 'docs',
      openDirs: [],
      filesRev: 0,
      scratchTick: 0,
      recentImagesExpanded: false,
      ...partial,
    })
    return <Story />
  }
}

// The aside has no fixed height of its own (it stretches to fill its flex parent) — give every story
// a realistic viewport-height frame to scroll/resize within.
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[640px] overflow-hidden rounded-lg border border-border">{children}</div>
  )
}

const meta = {
  title: 'Workspace/Sidebar',
  component: Sidebar,
  decorators: [withBridgeFixtures({ docs: DOCS }), withSidebarState({}), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

/** A working project: a couple of sessions, the doc-first Documents list, no scratch images yet. */
export const Default: Story = {
  decorators: [
    withBridgeFixtures({ docs: DOCS }),
    withSidebarState({
      sessions: {
        's-1': baseSession({ id: 's-1', label: 'Fix the login flow', items: [{ id: 1, kind: 'assistant', markdown: 'Done — the redirect loop is fixed.' }] }),
        's-2': baseSession({ id: 's-2', label: 'Add the export-to-CSV button', busy: true, items: [{ id: 1, kind: 'tool', toolUseId: 'tu_1', name: 'Grep', input: { pattern: 'exportToCsv' } }] }),
      },
      order: ['s-2', 's-1'],
      activeId: 's-1',
      gitFiles: [{ path: 'src/renderer/src/workspace/Sidebar.tsx', status: 'modified' }],
    }),
  ],
}

/** Files ⇄ Docs toggled to the full tree — the organize/code view, project files instead of prose. */
export const FileTreeView: Story = {
  decorators: [
    withBridgeFixtures({ treeEntries: TREE_ENTRIES }),
    withSidebarState({
      sessions: { 's-1': baseSession({ id: 's-1', label: 'Rewrite the pricing page copy' }) },
      order: ['s-1'],
      activeId: 's-1',
      filesView: 'tree',
    }),
  ],
}

/** Recent images expanded into its grid — a few screenshots handed to the agent this session. */
export const WithRecentImages: Story = {
  decorators: [
    withBridgeFixtures({
      docs: DOCS,
      images: [
        { name: 'before.png', relPath: '.koda/scratch/before.png', mediaType: 'image/png', dataBase64: PIXEL, mtime: Date.now() - 60_000 },
        { name: 'after.png', relPath: '.koda/scratch/after.png', mediaType: 'image/png', dataBase64: PIXEL, mtime: Date.now() - 30_000 },
        { name: 'error-state.png', relPath: '.koda/scratch/error-state.png', mediaType: 'image/png', dataBase64: PIXEL, mtime: Date.now() },
      ],
    }),
    withSidebarState({
      sessions: { 's-1': baseSession({ id: 's-1', label: 'Fix the empty-state illustration' }) },
      order: ['s-1'],
      activeId: 's-1',
      recentImagesExpanded: true,
    }),
  ],
}

/** A brand-new project: no sessions, no documents, no images — every section shows its own empty copy. */
export const Empty: Story = {
  decorators: [withBridgeFixtures({}), withSidebarState({})],
}
