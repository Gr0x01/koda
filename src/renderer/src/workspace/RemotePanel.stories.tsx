import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { RemoteState, RemoteRelayState } from '@shared/ipc'
import { RemotePanel } from './RemotePanel'

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return { running: false, url: null, hosts: [], code: null, devices: [], connectedClients: 0, ...overrides }
}

/** RemotePanel is prop-driven for its display; only `setLan` (Turn on / Try again) reaches the bridge
 *  directly. Override `setRemoteEnabled` to reject the way a real port conflict does, so the friendly
 *  EADDRINUSE-rewrite path renders. */
function withSetRemoteEnabledError(message: string) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    window.koda = new Proxy(base, {
      get: (target, prop: string) =>
        prop === 'setRemoteEnabled' ? () => Promise.reject(new Error(message)) : target[prop],
    }) as unknown as typeof window.koda
    return <Story />
  }
}

function withPairRelayDevice(blob: string, state: RemoteRelayState) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      pairRelayDevice: { blob, state },
    }
    return <Story />
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[300px] overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
      {children}
    </div>
  )
}

const meta = {
  title: 'Workspace/RemotePanel',
  component: RemotePanel,
  args: {
    tab: 'lan',
    cloud: false,
    remote: null,
    auth: null,
    relay: null,
    onRemoteChange: () => {},
    onRelayChange: () => {},
    setTab: () => {},
    toSettings: () => {},
  },
  parameters: { controls: { disable: true } },
  decorators: [(Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof RemotePanel>

export default meta
type Story = StoryObj<typeof meta>

/** Cloud flagged off, LAN server not started yet — an explicit "Turn on" rather than a silent open port. */
export const LanOff: Story = {}

/** LAN is on, a phone is connected — the QR still shows (re-pairing is always available) with the live
 *  connected-device count. */
export const LanConnected: Story = {
  args: {
    remote: remoteState({ running: true, url: 'http://10.2.0.42:4321', hosts: ['10.2.0.42'], code: '482913', connectedClients: 1 }),
  },
}

/** LAN is on, nothing paired yet. */
export const LanNoDevices: Story = {
  args: {
    remote: remoteState({ running: true, url: 'http://10.2.0.42:4321', hosts: ['10.2.0.42'], code: '119284' }),
  },
}

/** The LAN port is already in use (another Koda or dev instance) — "Turn on" surfaces the friendly
 *  version of the EADDRINUSE error instead of the raw IPC message. */
export const LanPortInUse: Story = {
  decorators: [
    withSetRemoteEnabledError(
      "Error invoking remote method 'remote:setEnabled': Error: listen EADDRINUSE: address already in use :::4321",
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Turn on'))
    await waitFor(() => expect(canvas.getByText(/Port 4321 is in use/)).toBeInTheDocument())
  },
}

/** Cloud relay flagged on, not signed in yet — the from-anywhere pane leads with a sign-in CTA instead
 *  of a QR nobody can use. */
export const CloudSignedOut: Story = {
  args: { cloud: true, tab: 'anywhere', auth: { signedIn: false, email: null, userId: null, needsReSignin: false } },
}

/** Signed in, not yet paired — an auto-issued QR (via pairRelayDevice) ready to scan. */
export const CloudPairingQR: Story = {
  args: {
    cloud: true,
    tab: 'anywhere',
    auth: { signedIn: true, email: 'rb@kodahq.io', userId: 'u_1', needsReSignin: false },
    relay: { signedIn: true, running: true, paired: false },
  },
  decorators: [
    withPairRelayDevice('koda-relay-pair:eyJhbGciOiJFUzI1NiJ9.example', {
      signedIn: true,
      running: true,
      paired: false,
    }),
  ],
}

/** A phone is already paired — end-to-end encrypted, replace-or-manage instead of a stale QR. */
export const CloudPaired: Story = {
  args: {
    cloud: true,
    tab: 'anywhere',
    auth: { signedIn: true, email: 'rb@kodahq.io', userId: 'u_1', needsReSignin: false },
    relay: { signedIn: true, running: true, paired: true },
  },
}
