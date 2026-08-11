import type { Meta, StoryObj } from '@storybook/react-vite'
import type { FsEntry } from '@shared/ipc'
import { expect, userEvent, within } from 'storybook/test'
import { FilesBrowser } from './FilesBrowser'
import { useWorkspace } from './store'

const ROOT = '/Users/rb/Documents/coding_projects/koda'

const ENTRIES: FsEntry[] = [
  { name: 'src', kind: 'dir' },
  { name: 'shared', kind: 'dir' },
  { name: 'Documents', kind: 'dir' },
  { name: 'ios', kind: 'dir' },
  { name: '.koda', kind: 'dir' },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'CHANGELOG.md', kind: 'file' },
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

/** A local override on top of the global mock, mirroring ModelControl's withCodexFixtures pattern —
 *  the shared fixture seam only ever RESOLVES (never rejects), so a genuine failure needs a real
 *  Proxy override on window.koda instead of a fixture value. */
function withReadDirError(message: string) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => (prop === 'readDir' ? () => Promise.reject(new Error(message)) : target[prop]),
    }) as unknown as typeof window.koda
    return <Story />
  }
}

function withUnreadableFolder(folder: string, message: string) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => {
        if (prop !== 'readDir') return target[prop]
        return (args: { path?: string }) =>
          args.path === folder
            ? Promise.reject(new Error(message))
            : Promise.resolve({ root: ROOT, path: args.path ?? ROOT, entries: [{ name: 'locked', kind: 'dir' }] })
      },
    }) as unknown as typeof window.koda
    return <Story />
  }
}

/** Resets the tree's transient UI state (a stale error line / filesRev bump from a previous story)
 *  before each render. */
function withTreeState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ treeError: null, filesRev: 0, openDirs: [], ...partial })
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
  title: 'Workspace/FilesBrowser',
  component: FilesBrowser,
  decorators: [withReadDirFixture(ENTRIES), withTreeState({}), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof FilesBrowser>

export default meta
type Story = StoryObj<typeof meta>

/** A real project root, expanded — folders and files, right-click for the manage menu. */
export const Default: Story = {}

/** A brand-new project with nothing in it yet. */
export const Empty: Story = {
  decorators: [withReadDirFixture([])],
}

/** A dismissible error line above the tree — a rename clash or similar, surfaced from `treeError`. */
export const WithTreeError: Story = {
  decorators: [withTreeState({ treeError: "Couldn't rename “old-notes.md” — a file with that name already exists." })],
}

/** The project root itself couldn't be read (permissions, a moved/deleted folder). */
export const ReadError: Story = {
  decorators: [withReadDirError('EACCES: permission denied')],
}

/** A folder that exists but can't be read stays visibly failed instead of masquerading as empty. */
export const NestedReadError: Story = {
  decorators: [withUnreadableFolder(`${ROOT}/locked`, 'EACCES: permission denied')],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'locked' }))
    await expect(await canvas.findByText("Couldn't read this folder. Close and reopen it to try again.")).toBeVisible()
  },
}
