import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type {
  GitBranchOverview,
  GitCommitGraphResult,
  GitGraphRow,
  GitStatusFile,
} from '@shared/ipc'
import { SourceControl } from './SourceControl'
import { useWorkspace } from './store'

// SourceControl fetches its own data through window.koda (gitDetect/gitStatus/gitGraph/…) rather than
// the store, so every story seeds the bridge fixture seam (storybook-coverage.md). A flat "no textual
// changes" diff fixture keeps every right-pane state real without ever mounting Monaco (tier-4
// territory) — before === after short-circuits DiffPane straight to its text branch.
const NO_DIFF = { path: '', before: 'same', after: 'same', truncated: false, binary: false }

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

// Ledger only reads rows filtered to lane 0 + `truncated` (git-graph.ts's lane-drawing is out of
// scope here — VersionLedger.stories.tsx covers the rail itself), so laneCount/laneKinds/segments
// don't need to be geometrically real.
function mkGraph(rows: GitGraphRow[], opts: { truncated?: boolean; unmerged?: string[] } = {}): GitCommitGraphResult {
  return {
    layout: { rows, laneCount: 1, laneKinds: { '0': 'main' } },
    unmergedBranches: (opts.unmerged ?? []).map((name, index) => ({ name, ahead: index + 1 })),
    headBranch: 'main',
    truncated: opts.truncated ?? false,
  }
}

const VERSIONS = mkGraph([
  mkRow('a1b2c3d', 'Add workout logging', '2 hours ago'),
  mkRow('e4f5a6b', 'Fix meal totals rounding', 'yesterday'),
  mkRow('c7d8e9f', 'Set up the project', '3 days ago'),
])

const CHANGED_FILES: GitStatusFile[] = [
  { path: 'src/features/workout/Logger.tsx', status: 'added' },
  { path: 'src/features/workout/api.ts', status: 'modified' },
  { path: 'src/features/meals/totals.ts', status: 'modified' },
]

const BRANCH_OVERVIEW: GitBranchOverview = {
  name: 'agent/add-export-button',
  commits: [
    { sha: 'f1e2d3c', subject: 'Add the export button', relativeDate: '10 minutes ago', authorName: 'RB' },
  ],
  files: [{ path: 'src/features/export/Button.tsx', status: 'added' }],
  ahead: 1,
  truncated: false,
}

function withGit(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ sidebarWidth: 300, activeId: 's-1', sessions: {} })
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      gitMergedStrays: [],
      gitFileDiff: NO_DIFF,
      gitBranchFileDiff: NO_DIFF,
      gitCommitChanges: { files: [], truncated: false },
      gitBranchOverview: BRANCH_OVERVIEW,
      ...fixtures,
    }
    return (
      <div className="h-[640px] w-[980px] overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    )
  }
}

const meta = {
  title: 'Workspace/SourceControl',
  component: SourceControl,
  args: { onLeave: () => {} },
} satisfies Meta<typeof SourceControl>

export default meta
type Story = StoryObj<typeof meta>

export const NotTracked: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: false, repoRoot: null, isSubdir: false, branch: null, defaultBranch: null },
    }),
  ],
}

/** Everything saved, versions exist, and the last push reached GitHub — the calm all-green resting
 *  state. The right pane defaults to the latest version's file (CommitDetail → RestoreBox). */
export const AllSavedOnGitHub: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: true, repoRoot: '/Users/rb/koda-demo', isSubdir: false, branch: 'main', defaultBranch: 'main' },
      gitStatus: { files: [], truncated: false },
      gitGraph: VERSIONS,
      gitWorktrees: [],
      gitSyncState: {
        hasRemote: true,
        remoteName: 'origin',
        remoteUrl: 'git@github.com:rb/koda-demo.git',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        upstreamTip: 'a1b2c3d',
        verified: true,
      },
      gitCommitChanges: { files: [{ path: 'src/features/workout/Logger.tsx', status: 'added' }], truncated: false },
    }),
  ],
}

/** Unsaved edits plus versions only on this Mac — the everyday "there's work to review" state. The
 *  right pane defaults to the first changed file's diff. */
export const PendingChangesToPush: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: true, repoRoot: '/Users/rb/koda-demo', isSubdir: false, branch: 'main', defaultBranch: 'main' },
      gitStatus: { files: CHANGED_FILES, truncated: false },
      gitGraph: VERSIONS,
      gitWorktrees: [],
      gitSyncState: {
        hasRemote: true,
        remoteName: 'origin',
        remoteUrl: 'git@github.com:rb/koda-demo.git',
        upstream: 'origin/main',
        ahead: 2,
        behind: 0,
        upstreamTip: 'e4f5a6b',
        verified: true,
      },
    }),
  ],
}

/** A repo that's tracked but has never had a version saved — History shows its own empty copy and
 *  the Changes/CommitBox drives the very first save. */
export const NoVersionsYet: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: true, repoRoot: '/Users/rb/koda-demo', isSubdir: false, branch: 'main', defaultBranch: 'main' },
      gitStatus: { files: CHANGED_FILES.slice(0, 1), truncated: false },
      gitGraph: mkGraph([]),
      gitWorktrees: [],
    }),
  ],
}

/** On a side branch (SideBranchBanner), with unmerged branches + a dirty sibling checkout the agent
 *  left behind (LooseEnds) — the composite's busiest, most edge-case-heavy state. */
export const SideBranchWithLooseEnds: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: true, repoRoot: '/Users/rb/koda-demo', isSubdir: false, branch: 'agent/redesign-nav', defaultBranch: 'main' },
      gitStatus: { files: CHANGED_FILES.slice(0, 1), truncated: false },
      gitGraph: mkGraph([mkRow('9f8e7d6', 'Start the nav redesign', 'an hour ago'), ...VERSIONS.layout.rows], {
        unmerged: ['agent/add-export-button', 'agent/try-dark-mode'],
      }),
      gitWorktrees: [
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
      ],
      gitSyncState: {
        hasRemote: true,
        remoteName: 'origin',
        remoteUrl: 'git@github.com:rb/koda-demo.git',
        upstream: 'origin/agent/redesign-nav',
        ahead: 1,
        behind: 0,
        upstreamTip: null,
        verified: false,
      },
    }),
  ],
}

/** Versions exist but only on this Mac — Publish is a conversation handed to the agent, not a button. */
export const NoRemoteYet: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: true, repoRoot: '/Users/rb/koda-demo', isSubdir: false, branch: 'main', defaultBranch: 'main' },
      gitStatus: { files: [], truncated: false },
      gitGraph: VERSIONS,
      gitWorktrees: [],
      gitSyncState: {
        hasRemote: false,
        remoteName: null,
        remoteUrl: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstreamTip: null,
        verified: false,
      },
    }),
  ],
}

// Drills into the Branch Review sub-view — clicking a Loose End's "Review" swaps the whole left panel.
export const BranchReviewOpened: Story = {
  decorators: [
    withGit({
      gitDetect: { isRepo: true, repoRoot: '/Users/rb/koda-demo', isSubdir: false, branch: 'main', defaultBranch: 'main' },
      gitStatus: { files: [], truncated: false },
      gitGraph: mkGraph(VERSIONS.layout.rows, { unmerged: ['agent/add-export-button'] }),
      gitWorktrees: [],
      gitSyncState: {
        hasRemote: false,
        remoteName: null,
        remoteUrl: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        upstreamTip: null,
        verified: false,
      },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const review = await canvas.findByText('Review')
    await userEvent.click(review)
    await waitFor(() => expect(canvas.getByText('agent/add-export-button')).toBeInTheDocument())
  },
}
