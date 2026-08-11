import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionRow } from './SessionRow'
import type { SessionState, SessionStatus } from './store'

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: '/Users/rb/Documents/coding_projects/koda',
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

const freshSession = baseSession({ id: 's-fresh', label: 'New session' })

const idleSession = baseSession({
  id: 's-idle',
  label: 'Fix the login flow',
  items: [{ id: 1, kind: 'assistant', markdown: 'Done — the redirect loop is fixed.' }],
  model: 'sonnet',
  activeModel: 'claude-sonnet-4-6',
  context: { contextTokens: 42_000, contextWindow: 200_000, inputTokens: 6_200, cacheReadTokens: 30_000, cacheCreationTokens: 4_000, outputTokens: 1_800 },
})

const thinkingSession = baseSession({
  id: 's-thinking',
  label: 'Add the export-to-CSV button',
  busy: true,
  model: 'opus',
  activeModel: 'claude-opus-4-8',
  items: [{ id: 1, kind: 'tool', toolUseId: 'tu_1', name: 'Grep', input: { pattern: 'exportToCsv' } }],
  context: { contextTokens: 88_000, contextWindow: 200_000, inputTokens: 12_000, cacheReadTokens: 70_000, cacheCreationTokens: 6_000, outputTokens: 900 },
})

const writingSession = baseSession({
  id: 's-writing',
  label: 'Rewrite the pricing page copy',
  busy: true,
  streaming: 'Here is a tighter version of the hero section',
  model: 'sonnet',
  activeModel: 'claude-sonnet-4-6',
  items: [],
})

const waitingSession = baseSession({
  id: 's-waiting',
  label: 'Delete the old migrations folder',
  model: 'sonnet',
  activeModel: 'claude-sonnet-4-6',
  items: [{ id: 1, kind: 'tool', toolUseId: 'tu_1', name: 'Bash', input: { command: 'rm -rf migrations/legacy' } }],
})

const errorSession = baseSession({
  id: 's-error',
  label: 'Wire up Stripe webhooks',
  errored: true,
  model: 'sonnet',
  activeModel: 'claude-sonnet-4-6',
})

const remoteSession = baseSession({
  id: 's-remote',
  label: 'Draft the release notes',
  fromRemote: true,
  model: 'haiku',
  activeModel: 'claude-haiku-4-5',
  context: { contextTokens: 12_000, contextWindow: 200_000, inputTokens: 3_000, cacheReadTokens: 8_000, cacheCreationTokens: 1_000, outputTokens: 400 },
})

const meta = {
  title: 'Workspace/SessionRow',
  component: SessionRow,
  args: {
    session: idleSession,
    status: 'idle' as SessionStatus,
    active: false,
    attention: false,
    dirtyCount: 0,
    onSelect: () => {},
    onOpenChanges: () => {},
    onRename: () => {},
    onArchive: () => {},
  },
  argTypes: {
    status: { control: 'inline-radio', options: ['idle', 'thinking', 'waiting', 'error'] },
  },
} satisfies Meta<typeof SessionRow>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <ul className="max-w-xs list-none space-y-0.5 rounded-lg border border-border bg-bg p-1.5">
      <SessionRow {...args} />
    </ul>
  ),
}

/** The full range of rows the sidebar renders: fresh, idle, thinking (tool running), writing
 *  (streaming text), waiting on approval, errored, with unsaved edits, and one started from the
 *  phone — active/attention states mixed in. */
export const Gallery: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <ul className="max-w-xs list-none space-y-0.5 rounded-lg border border-border bg-bg p-1.5">
      <SessionRow
        session={freshSession}
        status="idle"
        active={false}
        attention={false}
        dirtyCount={0}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
      <SessionRow
        session={idleSession}
        status="idle"
        active
        attention={false}
        dirtyCount={0}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
      <SessionRow
        session={thinkingSession}
        status="thinking"
        active={false}
        attention={false}
        dirtyCount={0}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
      <SessionRow
        session={writingSession}
        status="thinking"
        active={false}
        attention={false}
        dirtyCount={3}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
      <SessionRow
        session={waitingSession}
        status="waiting"
        active={false}
        attention
        dirtyCount={0}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
      <SessionRow
        session={errorSession}
        status="error"
        active={false}
        attention
        dirtyCount={0}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
      <SessionRow
        session={remoteSession}
        status="idle"
        active={false}
        attention={false}
        dirtyCount={1}
        onSelect={() => {}}
        onOpenChanges={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />
    </ul>
  ),
}
