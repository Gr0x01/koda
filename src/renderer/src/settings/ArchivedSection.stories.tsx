import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { ArchivedSessionMeta } from '@shared/ipc'
import { ArchivedSection } from './ArchivedSection'
import { useWorkspace } from '../workspace/store'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

const NOW = Date.now()

function archived(overrides: Partial<ArchivedSessionMeta> & Pick<ArchivedSessionMeta, 'id' | 'label'>): ArchivedSessionMeta {
  return {
    cwd: '/Users/rb/Documents/coding_projects/koda',
    archivedAt: NOW - 1000 * 60 * 60 * 3,
    ...overrides,
  }
}

const SESSIONS: ArchivedSessionMeta[] = [
  archived({
    id: 'a-1',
    label: 'Fix the login redirect loop',
    archivedAt: NOW - 1000 * 60 * 40,
    preview: [
      { kind: 'user', text: 'The login redirect keeps bouncing back to /signin even after a good password.' },
      { kind: 'assistant', text: "Found it — the callback was checking the session before the cookie finished writing. Fixed and verified: it redirects to /dashboard now." },
    ],
  }),
  archived({
    id: 'a-2',
    label: 'Add the pricing page',
    archivedAt: NOW - 1000 * 60 * 60 * 26,
    preview: [
      { kind: 'user', text: 'Add a pricing page with three tiers, matching the marketing site fonts.' },
      { kind: 'assistant', text: 'Built /pricing with three tier cards and the Space Grotesk/Schibsted pairing from the site tokens.' },
    ],
  }),
  archived({
    id: 'a-3',
    label: 'Untitled session',
    archivedAt: NOW - 1000 * 60 * 60 * 24 * 9,
    preview: [],
  }),
]

/** `archived` is a real store slice (Settings → Archived sessions restore/delete it), so seeding it
 *  here makes Restore/Delete genuinely interactive. */
function withArchived(list: ArchivedSessionMeta[]) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ archived: list })
    return <Story />
  }
}

const meta = {
  title: 'Settings/Archived',
  component: ArchivedSection,
  decorators: [withBridgeFixtures({ getSettings: { archiveRetentionDays: 0 } }), withArchived(SESSIONS)],
} satisfies Meta<typeof ArchivedSection>

export default meta
type Story = StoryObj<typeof meta>

/** Three archived chats, kept forever by default. */
export const Default: Story = {}

/** No chats archived yet — the empty note explains what lands here. */
export const Empty: Story = {
  decorators: [withArchived([])],
}

/** A retention window is set — old archives get auto-deleted after it. */
export const RetentionSet: Story = {
  decorators: [withBridgeFixtures({ getSettings: { archiveRetentionDays: 30 } }), withArchived(SESSIONS)],
}

/** Clicking a row's label expands its last-turns preview so you can recognize the chat before restoring. */
export const PreviewExpanded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Fix the login redirect loop'))
    await waitFor(() => expect(canvas.getByText(/callback was checking the session/)).toBeInTheDocument())
  },
}

/** Delete is permanent (archives sit outside the undo timeline) — a small inline confirm before it fires. */
export const DeleteConfirm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByTitle('Delete permanently')[0])
    await waitFor(() => expect(canvas.getByText('Delete')).toBeInTheDocument())
  },
}
