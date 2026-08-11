import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { ModelControl } from './ModelControl'
import { useWorkspace, type SessionState } from './store'

const CODEX_MODELS = [
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', isDefault: true },
  { id: 'gpt-5.2-codex-mini', label: 'GPT-5.2 Codex Mini', isDefault: false },
]

/**
 * The Codex model list + auth status are fetched async on mount/open — override just those three
 * bridge calls on top of the global mock Proxy (koda-bridge-mock.ts) so the OpenAI group renders real
 * rows instead of "Checking…". A story-local override rather than importing `setBridgeFixtures`: that
 * module's `declare global { interface Window { koda } }` collides with the preload's own ambient
 * type when pulled into tsc's project graph, so it stays out of the story's import graph entirely.
 * `signedIn` lets a story show the signed-out empty state instead.
 */
function withCodexFixtures(signedIn = true) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const overrides: Record<string, () => Promise<unknown>> = {
      getCodexModels: () => Promise.resolve(signedIn ? CODEX_MODELS : []),
      getCodexAuthStatus: () =>
        Promise.resolve({ signedIn, authMethod: signedIn ? 'chatgpt' : null, requiresOpenaiAuth: !signedIn }),
      getRecentModels: () => Promise.resolve(['claude-opus-4-8', 'claude-sonnet-4-6-1m']),
    }
    window.koda = new Proxy(base, {
      get: (target, prop: string) => overrides[prop] ?? target[prop],
    }) as unknown as typeof window.koda
    return <Story />
  }
}

function withCodexProbeFailure() {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => {
        if (prop === 'getCodexModels') return () => Promise.resolve(CODEX_MODELS)
        if (prop === 'getCodexAuthStatus')
          return () => Promise.resolve({ signedIn: false, authMethod: null, requiresOpenaiAuth: null, probeFailed: true })
        return target[prop]
      },
    }) as unknown as typeof window.koda
    return <Story />
  }
}

function withCodexProbeRace() {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    let calls = 0
    window.koda = new Proxy(base, {
      get: (target, prop: string) => {
        if (prop === 'getCodexModels') return () => Promise.resolve(CODEX_MODELS)
        if (prop === 'getCodexAuthStatus')
          return () => {
            calls += 1
            if (calls === 1)
              return new Promise((resolve) =>
                setTimeout(
                  () => resolve({ signedIn: true, authMethod: 'chatgpt', requiresOpenaiAuth: false }),
                  80,
                ),
              )
            return Promise.resolve({ signedIn: false, authMethod: null, requiresOpenaiAuth: null, probeFailed: true })
          }
        return target[prop]
      },
    }) as unknown as typeof window.koda
    return <Story />
  }
}

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

/** Seeds a session with a real turn on the board, so `conversationStarted` locks the other engine's
 *  rows in the dropdown (the conversation is bound to its engine's process). */
function withStartedSession(sessionId: string, engineId: 'claude' | 'codex') {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      sessions: {
        [sessionId]: baseSession({
          id: sessionId,
          label: 'Fix the login flow',
          engineId,
          items: [{ id: 1, kind: 'user', text: 'Fix the login redirect loop' }],
        }),
      },
    })
    return <Story />
  }
}

// The control lives at the app's footer, so its menu opens UPWARD (`bottom-full`) — every story
// gets a bottom-anchored frame or an opened menu clips at the canvas top. Taller than the other
// footer controls: the two-engine model list is the biggest menu in the app.
const footerFrame = (Story: React.ComponentType): React.ReactElement => (
  <div className="flex min-h-[420px] flex-col items-start justify-end">
    <Story />
  </div>
)

const meta = {
  title: 'Workspace/ModelControl',
  component: ModelControl,
  args: { sessionId: 's-1', model: undefined, activeModel: 'claude-sonnet-4-6', busy: false },
  decorators: [withCodexFixtures(true), footerFrame],
} satisfies Meta<typeof ModelControl>

export default meta
type Story = StoryObj<typeof meta>

/** Click the pill to open the picker — Claude aliases + recents, OpenAI (Codex) models below. */
export const Playground: Story = {}

export const MenuOpen: Story = {
  args: { model: 'opus' },
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByTitle('Model: Opus')
    await userEvent.click(trigger)
    await waitFor(() => expect(canvas.getByText('GPT-5.2 Codex')).toBeInTheDocument())
  },
}

/** The pill's states before opening the menu: engine-default, a picked alias, a typed full id, and
 *  locked mid-turn. */
export const Gallery: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      {(
        [
          { label: 'Default (engine picks)', model: undefined, activeModel: 'claude-sonnet-4-6' },
          { label: 'Opus picked', model: 'opus', activeModel: 'claude-opus-4-8' },
          { label: 'Full id typed', model: 'claude-sonnet-4-6-1m', activeModel: 'claude-sonnet-4-6-1m' },
          { label: 'Busy — locked mid-turn', model: 'sonnet', activeModel: 'claude-sonnet-4-6', busy: true },
        ]
      ).map((s) => (
        <div key={s.label} className="flex flex-col items-start gap-1.5">
          <span className="text-[11px] text-text-muted">{s.label}</span>
          <ModelControl sessionId="s-1" model={s.model} activeModel={s.activeModel} busy={s.busy} />
        </div>
      ))}
    </div>
  ),
}

/** After the first real turn, the conversation is bound to its engine — opening the picker still
 *  works, but the other engine's rows gray out (a respawn would drop the running context). */
export const EngineLockedAfterFirstTurn: Story = {
  args: { sessionId: 'started', model: undefined, activeModel: 'claude-sonnet-4-6' },
  decorators: [withCodexFixtures(true), withStartedSession('started', 'claude')],
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Display is preference-first: no picked model + activeModel set → the engine's resolved model.
    const trigger = canvas.getByTitle('Model: Sonnet 4.6')
    await userEvent.click(trigger)
    await waitFor(() => expect(canvas.getByText('GPT-5.2 Codex')).toBeInTheDocument())
  },
}

/** Signed out of Codex — the OpenAI group points at Settings instead of listing models. */
export const CodexSignedOut: Story = {
  args: { model: undefined, activeModel: 'claude-sonnet-4-6' },
  decorators: [withCodexFixtures(false)],
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByTitle('Model: Sonnet 4.6')
    await userEvent.click(trigger)
    await waitFor(() => expect(canvas.getByText(/Sign in to OpenAI/)).toBeInTheDocument())
  },
}

/** A failed auth check outranks stale/cached models; none are offered as currently usable. */
export const CodexCheckFailed: Story = {
  args: { model: undefined, activeModel: 'claude-sonnet-4-6' },
  decorators: [withCodexProbeFailure()],
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTitle('Model: Sonnet 4.6'))
    await waitFor(() => expect(canvas.getByText('Couldn’t check sign-in.')).toBeInTheDocument())
    await expect(canvas.queryByText('GPT-5.2 Codex')).not.toBeInTheDocument()
  },
}

/** A slower old success cannot overwrite the newer failed check triggered by opening the menu. */
export const CodexLatestCheckWins: Story = {
  args: { model: undefined, activeModel: 'claude-sonnet-4-6' },
  decorators: [withCodexProbeRace()],
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTitle('Model: Sonnet 4.6'))
    await waitFor(() => expect(canvas.getByText('Couldn’t check sign-in.')).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect(canvas.getByText('Couldn’t check sign-in.')).toBeInTheDocument()
    await expect(canvas.queryByText('GPT-5.2 Codex')).not.toBeInTheDocument()
  },
}
