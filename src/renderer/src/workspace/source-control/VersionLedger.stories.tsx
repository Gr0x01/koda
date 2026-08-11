import type { Meta, StoryObj } from '@storybook/react-vite'
import type { GitCommitGraphResult, GitGraphRow } from '@shared/ipc'
import { Ledger } from './VersionLedger'

function mkRow(sha: string, subject: string, relativeDate: string): GitGraphRow {
  return {
    sha,
    subject,
    relativeDate,
    authorName: 'RB',
    parents: [],
    lane: 0,
    color: 0,
    isMerge: false,
    segments: [],
    branchLabel: null,
    branchKind: null,
  }
}

function mkGraph(rows: GitGraphRow[], truncated = false): GitCommitGraphResult {
  return {
    layout: { rows, laneCount: 1, laneKinds: { '0': 'main' } },
    unmergedBranches: [],
    headBranch: 'main',
    truncated,
  }
}

const ROWS = [
  mkRow('a1b2c3d', 'Add workout logging', '2 hours ago'),
  mkRow('e4f5a6b', 'Fix meal totals rounding', 'yesterday'),
  mkRow('c7d8e9f', 'Add the login page', '2 days ago'),
  mkRow('9f8e7d6', 'Set up the project', '3 days ago'),
]

const meta = {
  title: 'Source Control/VersionLedger',
  component: Ledger,
  args: { graph: mkGraph(ROWS), selectedSha: null, localOnlyCount: null, onOpenCommit: () => {} },
  decorators: [
    (Story) => (
      <div className="w-[320px] rounded-lg border border-border bg-bg py-1">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Ledger>

export default meta
type Story = StoryObj<typeof meta>

/** No remote tracked (or unverified) — only the latest version gets the accent "not backed up" anchor,
 *  the rest sit quiet. No divider: there's no confirmed safe/unsafe split to draw. */
export const NoBackupTracking: Story = {}

/** The newest 2 versions are only on this Mac; the rest are already on GitHub — the divider marks
 *  the boundary. */
export const PartiallyBackedUp: Story = {
  args: { localOnlyCount: 2 },
}

/** Every version in view is local-only (never pushed) — no divider (nothing backed up to split
 *  against), every tick reads accent. */
export const AllLocalOnly: Story = {
  args: { localOnlyCount: ROWS.length },
}

/** Fully pushed — no divider (nothing local-only to split off), every tick reads muted. */
export const AllOnGitHub: Story = {
  args: { localOnlyCount: 0 },
}

export const SelectedVersion: Story = {
  args: { selectedSha: 'e4f5a6b', localOnlyCount: 1 },
}

export const Truncated: Story = {
  args: { graph: mkGraph(ROWS, true) },
}
