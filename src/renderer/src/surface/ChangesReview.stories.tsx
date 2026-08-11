import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { ChangeGroup, Footer, SavedStrip, BranchGlyph, CheckCircleGlyph } from './ChangesReview'
import type { SessionChangeGroup } from '../workspace/store'

// ChangesReview's pure, prop-driven pieces — the desk's review sheet assembles them in
// ChangesSurface.tsx (storied whole there as StageDesk); gathered here since none is its own screen.
const meta = {
  title: 'Surface/ChangesReview',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const WORKOUT_GROUP: SessionChangeGroup = {
  sessionId: 's-workout',
  label: 'Add workout logging',
  files: [
    { path: 'src/features/workout/Logger.tsx', status: 'added' },
    { path: 'src/features/workout/api.ts', status: 'modified' },
  ],
}

const MEALS_GROUP: SessionChangeGroup = {
  sessionId: 's-meals',
  label: 'Fix meal totals rounding',
  files: [{ path: 'src/features/meals/totals.ts', status: 'modified' }],
}

const NO_SESSION_GROUP: SessionChangeGroup = {
  sessionId: null,
  label: 'Loose changes',
  files: [{ path: 'package-lock.json', status: 'modified' }],
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="w-[380px] rounded-lg border border-border bg-bg">{children}</div>
}

export const SessionGroupWithAlsoBy: Story = {
  render: () => (
    <Frame>
      <ChangeGroup
        group={WORKOUT_GROUP}
        alsoBy={{ 'src/features/workout/api.ts': ['Fix meal totals rounding'] }}
        stagedPath="src/features/workout/Logger.tsx"
        onSelect={() => {}}
        onOpen={() => {}}
        onReveal={() => {}}
        onDiscard={async () => null}
      />
    </Frame>
  ),
}

export const NoSessionGroup: Story = {
  render: () => (
    <Frame>
      <ChangeGroup
        group={NO_SESSION_GROUP}
        alsoBy={{}}
        stagedPath={null}
        onSelect={() => {}}
        onOpen={() => {}}
        onReveal={() => {}}
        onDiscard={async () => null}
      />
    </Frame>
  ),
}

export const FooterSingleSession: Story = {
  render: () => (
    <Frame>
      <Footer groups={[WORKOUT_GROUP]} fileCount={2} onSaved={() => {}} />
    </Frame>
  ),
}

/** More than one session's work is dirty at once — the footer falls back to a plain "Saved N changes"
 *  name instead of picking one session's title. */
export const FooterMultiSession: Story = {
  render: () => (
    <Frame>
      <Footer groups={[WORKOUT_GROUP, MEALS_GROUP]} fileCount={3} onSaved={() => {}} />
    </Frame>
  ),
}

// Save fails (no git identity configured yet) — exercises the footer's inline retryable error line.
export const FooterSaveFails: Story = {
  render: () => (
    <Frame>
      <Footer groups={[WORKOUT_GROUP]} fileCount={2} onSaved={() => {}} />
    </Frame>
  ),
  decorators: [
    (Story) => {
      ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
        gitCommit: { ok: false, code: 'no_identity', message: 'no identity configured' },
      }
      return <Story />
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Save version'))
    await waitFor(() => expect(canvas.getByText(/Git needs your name and email/)).toBeInTheDocument())
  },
}

export const SavedStripDefault: Story = {
  render: () => (
    <Frame>
      <SavedStrip saved={{ sha: 'a1b2c3d', name: 'Add workout logging' }} onDone={() => {}} onRenamed={() => {}} />
    </Frame>
  ),
}

export const SavedStripRenaming: Story = {
  render: () => (
    <Frame>
      <SavedStrip saved={{ sha: 'a1b2c3d', name: 'Add workout logging' }} onDone={() => {}} onRenamed={() => {}} />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Rename'))
    await waitFor(() => expect(canvas.getByDisplayValue('Add workout logging')).toBeInTheDocument())
  },
}

export const Icons: Story = {
  render: () => (
    <div className="flex items-center gap-6 text-text">
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3">
        <CheckCircleGlyph />
        <span className="text-[10px] text-text-muted">All saved</span>
      </div>
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3">
        <BranchGlyph />
        <span className="text-[10px] text-text-muted">No version history</span>
      </div>
    </div>
  ),
}
