import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { GitBranchOverview } from '@shared/ipc'
import { BranchReview } from './BranchReview'
import { useWorkspace } from '../store'

function withSession(hasSession: boolean) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ activeId: hasSession ? 's-1' : null, sessions: {} })
    return (
      <div className="w-[320px] rounded-lg border border-border bg-bg">
        <Story />
      </div>
    )
  }
}

function withOverview(overview: GitBranchOverview) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      gitBranchOverview: overview,
    }
    return <Story />
  }
}

const WITH_CHANGES: GitBranchOverview = {
  name: 'agent/add-export-button',
  commits: [{ sha: 'f1e2d3c', subject: 'Add the export button', relativeDate: '10 minutes ago', authorName: 'RB' }],
  files: [
    { path: 'src/features/export/Button.tsx', status: 'added' },
    { path: 'src/features/export/index.ts', status: 'modified' },
  ],
  ahead: 1,
  truncated: false,
}

const NOTHING_NEW: GitBranchOverview = {
  name: 'agent/old-experiment',
  commits: [],
  files: [],
  ahead: 0,
  truncated: false,
}

const meta = {
  title: 'Source Control/BranchReview',
  component: BranchReview,
  args: {
    branch: 'agent/add-export-button',
    headBranch: 'main',
    activeFile: null,
    onBack: () => {},
    onOpenFile: () => {},
    onLeave: () => {},
    onDiscarded: () => {},
  },
  decorators: [withSession(true), withOverview(WITH_CHANGES)],
} satisfies Meta<typeof BranchReview>

export default meta
type Story = StoryObj<typeof meta>

export const WithChanges: Story = {}

export const NothingToBringIn: Story = {
  args: { branch: 'agent/old-experiment' },
  decorators: [withOverview(NOTHING_NEW)],
}

export const NoSessionOpen: Story = {
  decorators: [withSession(false)],
}

export const ActiveFileSelected: Story = {
  args: { activeFile: 'src/features/export/Button.tsx' },
}

// The one user-confirmed destructive git op in user-git — an inline confirm, not a modal.
export const ConfirmDiscard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const discard = await canvas.findByText('Discard this branch')
    await userEvent.click(discard)
    await waitFor(() => expect(canvas.getByText(/can't be easily brought back/)).toBeInTheDocument())
  },
}
