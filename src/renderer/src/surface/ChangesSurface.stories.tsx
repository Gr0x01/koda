import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { GitStatusFile } from '@shared/ipc'
import { StageDesk } from './ChangesSurface'
import { useWorkspace, type SessionState } from '../workspace/store'

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: '/Users/rb/Documents/coding_projects/koda-demo',
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

function editItem(id: number, tool: 'Write' | 'Edit', path: string) {
  return { id, kind: 'tool' as const, toolUseId: `tu_${id}`, name: tool, input: { file_path: path }, result: 'ok' }
}

const FILES: GitStatusFile[] = [
  { path: 'src/features/workout/Logger.tsx', status: 'added' },
  { path: 'src/features/workout/api.ts', status: 'modified' },
  { path: 'src/features/meals/totals.ts', status: 'modified' },
  { path: 'package-lock.json', status: 'modified' },
]

// s-workout is newest in `order`, so it primary-owns the file both sessions touched; s-meals shows up
// as an "also edited by" hint on that row (computeSessionChanges: last writer wins, others are hints).
const SESSIONS: Record<string, SessionState> = {
  's-workout': baseSession({
    id: 's-workout',
    label: 'Add workout logging',
    items: [
      editItem(1, 'Write', 'src/features/workout/Logger.tsx'),
      editItem(2, 'Edit', 'src/features/workout/api.ts'),
      editItem(3, 'Edit', 'src/features/meals/totals.ts'),
    ],
  }),
  's-meals': baseSession({
    id: 's-meals',
    label: 'Fix meal totals rounding',
    items: [editItem(4, 'Edit', 'src/features/meals/totals.ts')],
  }),
}
const ORDER = ['s-workout', 's-meals']

/** StageDesk's expanded sheet re-reads git state itself (a mount-time refreshGitStatus() effect), so
 *  the bridge fixtures below must mirror the store seed — otherwise an "open" story would flash from
 *  the seeded state to whatever the default gitDetect/gitStatus mock returns. */
function withDeskState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      gitRepo: true,
      gitFiles: [],
      gitChangesTruncated: false,
      sessions: {},
      order: [],
      activeId: null,
      editors: {},
      changesFocus: null,
      deskOpen: false,
      dockOpen: true,
      ...partial,
    })
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      gitDetect: {
        isRepo: partial.gitRepo ?? true,
        repoRoot: '/Users/rb/koda-demo',
        isSubdir: false,
        branch: 'main',
        defaultBranch: 'main',
      },
      gitStatus: { files: partial.gitFiles ?? [], truncated: partial.gitChangesTruncated ?? false },
      gitWorktrees: [],
    }
    return (
      <div className="w-[420px] rounded-lg border border-border bg-bg">
        <Story />
      </div>
    )
  }
}

const meta = {
  title: 'Surface/ChangesSurface',
  component: StageDesk,
} satisfies Meta<typeof StageDesk>

export default meta
type Story = StoryObj<typeof meta>

export const CollapsedNoRepo: Story = {
  decorators: [withDeskState({ gitRepo: false, gitFiles: [] })],
}

export const CollapsedAllSaved: Story = {
  decorators: [withDeskState({ gitRepo: true, gitFiles: [] })],
}

export const CollapsedWithChanges: Story = {
  decorators: [withDeskState({ gitRepo: true, gitFiles: FILES })],
}

/** The review sheet expanded: changes grouped by the session that made them, incl. the "also edited
 *  by" hint on the file both sessions touched. */
export const ExpandedGroupedChanges: Story = {
  decorators: [withDeskState({ gitRepo: true, gitFiles: FILES, sessions: SESSIONS, order: ORDER, deskOpen: true })],
}

export const ExpandedAllSaved: Story = {
  decorators: [withDeskState({ gitRepo: true, gitFiles: [], deskOpen: true })],
}

export const ExpandedNoRepo: Story = {
  decorators: [withDeskState({ gitRepo: false, gitFiles: [], deskOpen: true })],
}

export const ExpandedTruncated: Story = {
  decorators: [
    withDeskState({
      gitRepo: true,
      gitFiles: FILES,
      gitChangesTruncated: true,
      sessions: SESSIONS,
      order: ORDER,
      deskOpen: true,
    }),
  ],
}

// Clicking the collapsed peek strip opens the sheet (the Collapse mount transition).
export const OpensOnClick: Story = {
  decorators: [withDeskState({ gitRepo: true, gitFiles: FILES, sessions: SESSIONS, order: ORDER })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Review & save'))
    await waitFor(() => expect(canvas.getByText('Add workout logging')).toBeInTheDocument())
  },
}
