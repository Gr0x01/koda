import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test'
import type { MiniAppInfo } from '@shared/ipc'
import { ProjectHome } from './ProjectHome'

const RECENTS = [
  '/Users/rb/Documents/coding_projects/koda',
  '/Users/rb/Documents/coding_projects/driftwatch',
  '/Users/rb/Documents/coding_projects/policy-canary',
]

const APPS: MiniAppInfo[] = [
  { dir: '/Users/rb/Koda/lift-log', projectPath: '/Users/rb/Koda/lift-log', name: 'Lift Log', state: 'running', url: 'http://localhost:5301' },
  { dir: '/Users/rb/Koda/recipe-box', projectPath: '/Users/rb/Koda/recipe-box', name: 'Recipe Box', state: 'stopped' },
]

function withHomeFixtures(
  opts: { recents?: string[]; apps?: MiniAppInfo[]; integrity?: Record<string, unknown> } = {},
) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      getRecentProjects: opts.recents ?? [],
      miniAppsList: opts.apps ?? [],
      getDataIntegrity: {
        projectListUnreadable: false,
        projectListBackupKept: null,
        billingModeReset: false,
        ...opts.integrity,
      },
    }
    return <Story />
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="h-[640px] w-[900px] overflow-hidden rounded-lg border border-border">{children}</div>
}

const meta = {
  title: 'Workspace/ProjectHome',
  component: ProjectHome,
  args: { openCreate: false },
  decorators: [withHomeFixtures({ recents: RECENTS }), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof ProjectHome>

export default meta
type Story = StoryObj<typeof meta>

/** A returning user: recent projects to jump back into. */
export const Default: Story = {}

/** A user with graduated mini apps — the left rail, recents list shrunk to whatever hasn't graduated. */
export const WithAppsRail: Story = {
  decorators: [withHomeFixtures({ recents: RECENTS, apps: APPS })],
}

/** First launch — no recents, no apps, just the two ways in. */
export const FirstLaunch: Story = {
  decorators: [withHomeFixtures({})],
}

/** The screen above is what a lost project list ALSO looks like, which is the whole problem: this story
 *  and FirstLaunch must never be mistakable for each other. Opening a project from here is what rebuilds
 *  the list, so the notice may promise that. */
export const ProjectListUnreadable: Story = {
  decorators: [withHomeFixtures({ integrity: { projectListUnreadable: true, projectListBackupKept: true } })],
}

/** The same failure with no copy kept (a read-only userData, a full disk). The way out is gone with the
 *  copy, so the notice drops the promise and points at the agent instead of claiming a fix. */
export const ProjectListUnreadableNoCopy: Story = {
  decorators: [withHomeFixtures({ integrity: { projectListUnreadable: true, projectListBackupKept: false } })],
}

/** "New project…" landed with the create modal already up (opened via the app menu). */
export const CreateModalOpen: Story = {
  args: { openCreate: true },
}

/** Right-click a recent project to delete it — type-to-confirm before it moves to the Trash. */
export const DeleteConfirm: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByTitle(RECENTS[1])
    fireEvent.contextMenu(row)
    await waitFor(() => expect(canvas.getByText('Delete driftwatch?')).toBeInTheDocument())
    await userEvent.type(canvas.getByPlaceholderText('driftwatch'), 'driftwatch')
  },
}
