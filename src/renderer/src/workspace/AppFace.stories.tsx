import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { MiniAppInfo } from '@shared/ipc'
import { AppFace } from './AppFace'
import { useWorkspace, type SessionState } from './store'

const APP: MiniAppInfo = {
  dir: '/Users/rb/Koda/lift-log',
  projectPath: '/Users/rb/Koda/lift-log',
  name: 'Lift Log',
  state: 'running',
  url: 'http://localhost:5301',
}

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: APP.projectPath,
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

/** miniAppsStart never resolves — the "cold start" spinner, which is what a Storybook render can show
 *  without a real supervisor-managed process behind it. */
function withStartPending() {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => (prop === 'miniAppsStart' ? () => new Promise(() => {}) : target[prop]),
    }) as unknown as typeof window.koda
    return <Story />
  }
}

/** A real Proxy override (not the fixture seam, which only ever resolves) so miniAppsStart genuinely
 *  rejects — mirrors ModelControl's withCodexFixtures pattern. */
function withStartError(message: string) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => (prop === 'miniAppsStart' ? () => Promise.reject(new Error(message)) : target[prop]),
    }) as unknown as typeof window.koda
    return <Story />
  }
}

function withFaceState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      miniAppsStart: { url: APP.url },
    }
    useWorkspace.setState({
      miniApps: [APP],
      faceDir: APP.dir,
      sessions: {},
      activeId: null,
      pending: [],
      ...partial,
    })
    return <Story />
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[560px] w-[900px] overflow-hidden rounded-lg border border-border bg-bg">{children}</div>
}

const meta = {
  title: 'Workspace/AppFace',
  component: AppFace,
  decorators: [withFaceState({}), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof AppFace>

export default meta
type Story = StoryObj<typeof meta>

/** The app running full-bleed — Koda's summon pill floats at the bottom, its own chrome otherwise. */
export const Ready: Story = {}

/** Cold start — the supervisor is warming the app's process up. */
export const Starting: Story = {
  decorators: [withStartPending()],
}

/** The app failed to start — a friendly error plus the escape hatch to the workshop. */
export const StartError: Story = {
  decorators: [withStartError('lift-log exited before it started serving')],
}

/** A turn dispatched from the summon is mid-flight and hit the approval gate — the pill hands off to
 *  "the agent needs you" instead of shimmering forever. */
export const NeedsApproval: Story = {
  decorators: [
    withFaceState({
      sessions: { 's-1': baseSession({ id: 's-1', label: 'Ask lift-log', busy: true }) },
      activeId: 's-1',
      pending: [{ sessionId: 's-1', requestId: 'req-1', toolName: 'Write', input: { file_path: 'src/App.tsx' } }],
    }),
  ],
}

/** Click the pill to open the compose line — "Ask or fix this app" going straight to the project's agent. */
export const SummonOpen: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByText('Ask or fix this app'))
    await waitFor(() => expect(canvas.getByPlaceholderText(/Log something/)).toBeInTheDocument())
  },
}

/** Drive the summon through a full dispatch so its internal `working` flag is real: open, type, send
 *  (sendFaceTurn stubbed to dispatch into the seeded session). The seeded session starts busy so the
 *  turn reads as mid-flight. */
async function dispatchFromSummon(canvasElement: HTMLElement): Promise<ReturnType<typeof within>> {
  const canvas = within(canvasElement)
  useWorkspace.setState({ sendFaceTurn: async () => 's-1' })
  await userEvent.click(await canvas.findByText('Ask or fix this app'))
  // findBy*: the pill → compose swap animates, so the input mounts a beat after the click.
  await userEvent.type(await canvas.findByPlaceholderText(/Log something/), 'log my usual')
  await userEvent.click(canvas.getByText('Send'))
  return canvas
}

/** The agent asked a clarifying question mid-turn — it renders as answerable option chips over the
 *  face (the same QuestionCard the workshop shows), never a bounce to the workshop. */
export const AsksAQuestion: Story = {
  decorators: [
    withFaceState({
      sessions: { 's-1': baseSession({ id: 's-1', label: 'Ask lift-log', busy: true }) },
      activeId: 's-1',
    }),
  ],
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = await dispatchFromSummon(canvasElement)
    useWorkspace.setState({
      pending: [
        {
          sessionId: 's-1',
          requestId: 'q-1',
          toolName: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Log which usual?',
                header: 'Usual',
                multiSelect: false,
                options: [
                  { label: 'Push day', description: 'bench, OHP, dips' },
                  { label: 'Pull day', description: 'rows, pulldowns, curls' },
                ],
              },
            ],
          },
        },
      ],
    })
    await waitFor(() => expect(canvas.getByText('Log which usual?')).toBeInTheDocument())
  },
}

/** The turn landed — the agent's closing message surfaces in the face as a reply bubble (the answer
 *  half of the ask-or-fix loop), with Reply / Done. */
export const ReplyBubble: Story = {
  decorators: [
    withFaceState({
      sessions: { 's-1': baseSession({ id: 's-1', label: 'Ask lift-log' }) },
      activeId: 's-1',
    }),
  ],
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = await dispatchFromSummon(canvasElement)
    const land = (busy: boolean, items: SessionState['items'] = []): void =>
      useWorkspace.setState((s) => ({
        sessions: { 's-1': { ...s.sessions['s-1'], busy, items } },
      }))
    land(true)
    // Let React render the busy state before landing — the summon detects the busy true→false EDGE,
    // and two synchronous flips coalesce into one render where no edge ever existed.
    await new Promise((r) => setTimeout(r, 50))
    land(false, [{ id: 1, kind: 'assistant', markdown: 'Logged — that puts you at 1,840 calories today.' }])
    await waitFor(() => expect(canvas.getByText(/1,840 calories/)).toBeInTheDocument())
  },
}

/** An app that declares manifest theme tokens — Koda's overlay chrome (here the pill) wears the
 *  app's accent/surface instead of Koda's own, so it reads as part of the app. */
export const ThemedSummon: Story = {
  decorators: [
    withFaceState({
      miniApps: [
        {
          ...APP,
          theme: { accent: '#0d9488', surface: '#f0fdfa', text: '#134e4a', border: '#99f6e4' },
        },
      ],
    }),
  ],
}
