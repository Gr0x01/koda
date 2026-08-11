import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { RemoteState } from '@shared/ipc'
import { RemoteMenu } from './RemoteMenu'

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return { running: false, url: null, hosts: [], code: null, devices: [], connectedClients: 0, ...overrides }
}

/** RemoteMenu fetches its own state on mount (getRemoteState/getCloudRelayEnabled/getRemoteAuth/
 *  getRelayState) — seed the window bridge fixture map per story. Resets to a clean baseline every
 *  render so switching stories never leaks a previous one's connection state. */
function withRemoteFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      getRemoteState: remoteState(),
      getCloudRelayEnabled: false,
      getRemoteAuth: { signedIn: false, email: null, userId: null },
      getRelayState: { signedIn: false, running: false, paired: false },
      ...fixtures,
    }
    return <Story />
  }
}

// The trigger sits in the title bar; the popover it opens is a fixed-position portal, so the frame
// only needs to give the trigger a title-bar-like strip to sit in.
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-end rounded-lg border border-border bg-bg px-2">
      {children}
    </div>
  )
}

const meta = {
  title: 'Workspace/RemoteMenu',
  component: RemoteMenu,
  parameters: { controls: { disable: true } },
  decorators: [withRemoteFixtures({}), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof RemoteMenu>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing connected — a quiet muted dot, no badge count. */
export const Idle: Story = {}

/** A phone is live right now — the dot goes green and pulses, the label carries the connected count. */
export const LiveConnection: Story = {
  decorators: [
    withRemoteFixtures({
      getRemoteState: remoteState({ running: true, url: 'http://10.2.0.42:4321', hosts: ['10.2.0.42'], code: '482913', connectedClients: 1 }),
    }),
  ],
}

/** Tap the trigger to open the popover — LAN pane by default (cloud relay flagged off in this release). */
export const MenuOpen: Story = {
  decorators: [
    withRemoteFixtures({
      getRemoteState: remoteState({ running: true, url: 'http://10.2.0.42:4321', hosts: ['10.2.0.42'], code: '482913' }),
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByText('Remote')
    await userEvent.click(trigger)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(body.getByText('Remote access')).toBeInTheDocument())
  },
}
