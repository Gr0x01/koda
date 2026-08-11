import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RemoteState } from '@shared/ipc'
import { KodaAccountSection, RemoteSection } from './RemoteSection'

// Two components share this source file (the nav's "Koda account" and "Remote" categories) — grouped
// under one title, like GuardrailsSection.stories.tsx.

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

const meta = {
  title: 'Settings/Remote',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl space-y-8">{children}</div>
}

// ── Koda account (identity + the cloud-plans placeholder) ───────────────────────────

/** From-anywhere is release-flagged off (LAN-only first release) — the account door is hidden and
 *  "Koda Cloud" reads as a coming-soon note. The everyday state right now. */
export const AccountCloudFlagOff: Story = {
  decorators: [withBridgeFixtures({ getCloudRelayEnabled: false, getRemoteAuth: { signedIn: false, email: null, userId: null } })],
  render: () => (
    <Frame>
      <KodaAccountSection />
    </Frame>
  ),
}

/** The cloud-relay flag on and signed into the Koda account — this is the identity the phone pairs
 *  against under Remote → Connect from anywhere. */
export const AccountCloudSignedIn: Story = {
  decorators: [
    withBridgeFixtures({
      getCloudRelayEnabled: true,
      getRemoteAuth: { signedIn: true, email: 'rb@koda.dev', userId: 'u_8f2a1c' },
    }),
  ],
  render: () => (
    <Frame>
      <KodaAccountSection />
    </Frame>
  ),
}

/** The cloud-relay flag on, signed out — the email-OTP sign-in form. */
export const AccountCloudSignInForm: Story = {
  decorators: [
    withBridgeFixtures({
      getCloudRelayEnabled: true,
      getRemoteAuth: { signedIn: false, email: null, userId: null },
    }),
  ],
  render: () => (
    <Frame>
      <KodaAccountSection />
    </Frame>
  ),
}

// ── Remote (drive Koda from your phone) ──────────────────────────────────────────────
function remoteState(overrides: Partial<RemoteState>): RemoteState {
  return {
    running: false,
    url: null,
    hosts: [],
    code: null,
    devices: [],
    connectedClients: 0,
    ...overrides,
  }
}

/** Same-Wi-Fi remote control is off — the default, dogfood-only posture. */
export const RemoteOff: Story = {
  decorators: [withBridgeFixtures({ getCloudRelayEnabled: false, getRemoteAuth: { signedIn: false, email: null, userId: null }, getRemoteState: remoteState({}) })],
  render: () => (
    <Frame>
      <RemoteSection />
    </Frame>
  ),
}

/** Running on the same Wi-Fi — the pairing QR, the manual address/code fallback, and one connected
 *  phone plus a previously paired device. */
export const RemoteRunning: Story = {
  decorators: [
    withBridgeFixtures({
      getCloudRelayEnabled: false,
      getRemoteAuth: { signedIn: false, email: null, userId: null },
      getRemoteState: remoteState({
        running: true,
        url: 'http://10.0.0.14:4321',
        hosts: ['10.0.0.14', '192.168.64.1'],
        code: '482913',
        connectedClients: 1,
        devices: [
          { id: 'dev-1', label: "Rashaad's iPhone", pairedAt: Date.now() - 86_400_000 * 3 },
        ],
      }),
    }),
  ],
  render: () => (
    <Frame>
      <RemoteSection />
    </Frame>
  ),
}

/** The open-source build ships without the phone-control stack — the section says why instead of
 *  showing a toggle that can never work. */
export const RemoteUnavailable: Story = {
  decorators: [
    withBridgeFixtures({
      getCloudRelayEnabled: false,
      getRemoteAuth: { signedIn: false, email: null, userId: null },
      getRemoteState: remoteState({ available: false }),
    }),
  ],
  render: () => (
    <Frame>
      <RemoteSection />
    </Frame>
  ),
}

/** Cloud relay on + signed in, not yet paired — the "Connect from anywhere" QR issues on its own
 *  above the Same Wi-Fi section (real behavior: RelayPairingSection auto-calls pairRelayDevice on
 *  mount when signed in and unpaired). */
export const RemoteCloudPairingQr: Story = {
  decorators: [
    withBridgeFixtures({
      getCloudRelayEnabled: true,
      getRemoteAuth: { signedIn: true, email: 'rb@koda.dev', userId: 'u_8f2a1c' },
      getRelayState: { signedIn: true, running: true, paired: false },
      pairRelayDevice: { blob: 'koda-pair-v1.eyJraWQiOiJyYzoifQ.blindpairingpayload', state: { signedIn: true, running: true, paired: false } },
      getRemoteState: remoteState({}),
    }),
  ],
  render: () => (
    <Frame>
      <RemoteSection />
    </Frame>
  ),
}
