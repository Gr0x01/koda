import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { GitWorktree } from '@shared/ipc'
import { LooseEnds } from './LooseEnds'

const SIDE_LINES = [
  { name: 'agent/add-export-button', ahead: 1 },
  { name: 'agent/try-dark-mode', ahead: 3 },
]

const WORKTREES: GitWorktree[] = [
  {
    path: '/Users/rb/koda-demo-worktrees/spike',
    branch: 'agent/spike-search',
    isCurrent: false,
    dirtyCount: 4,
    statusKnown: true,
    lastActivity: '2 days ago',
    locked: false,
    prunable: false,
  },
  {
    path: '/Users/rb/koda-demo-worktrees/gone',
    branch: 'agent/old-experiment',
    isCurrent: false,
    dirtyCount: 0,
    statusKnown: false,
    lastActivity: '3 weeks ago',
    locked: false,
    prunable: true,
  },
]

const meta = {
  title: 'Source Control/LooseEnds',
  component: LooseEnds,
  args: { tidiedCount: 0, sideLines: [], worktrees: [], onReview: () => {}, onChanged: () => {} },
  decorators: [
    (Story) => (
      <div className="w-[340px] rounded-lg border border-border bg-bg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LooseEnds>

export default meta
type Story = StoryObj<typeof meta>

// Renders null when there's nothing to report — the common case.
export const Nothing: Story = {
  decorators: [
    (Story) => (
      <div className="p-3">
        <p className="mb-2 text-[11px] italic text-text-muted">Renders nothing when there's nothing to report.</p>
        <Story />
      </div>
    ),
  ],
}

// Only the auto-tidy happened — a standalone confirmation line, no "Loose ends" section chrome.
export const TidiedOnly: Story = {
  args: { tidiedCount: 2 },
}

export const SideLinesOnly: Story = {
  args: { sideLines: SIDE_LINES },
}

export const FullLooseEnds: Story = {
  args: { tidiedCount: 3, sideLines: SIDE_LINES, worktrees: WORKTREES },
}

export const StatusUnavailable: Story = {
  args: {
    worktrees: [
      {
        ...WORKTREES[0],
        path: '/Users/rb/koda-demo-worktrees/unreadable',
        branch: 'agent/unreadable-topic',
        dirtyCount: 0,
        statusKnown: false,
        lastActivity: '',
      },
    ],
  },
}

// The one confirmable destructive op here: discarding a side line the agent never brought in.
export const DiscardConfirm: Story = {
  args: { sideLines: [{ name: 'agent/add-export-button', ahead: 1 }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Discard'))
    await waitFor(() => expect(canvas.getByText(/Throw/)).toBeInTheDocument())
  },
}
