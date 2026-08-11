import type { Meta, StoryObj } from '@storybook/react-vite'
import { GeneralSection } from './GeneralSection'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

// Notifications, Images, Assist, and Privacy each read the SAME `getSettings()` call (one fixture
// object covers every section's field), matching the real single settings round-trip.
const DEFAULTS = {
  notificationsEnabled: true,
  usageResetNotify: true,
  providerStatusNotify: true,
  appDaySessions: true,
  critiquePass: true,
  imageDetail: 'balanced',
  scratchRetentionDays: 7,
  assistEnabled: true,
  telemetryEnabled: true,
}

const meta = {
  title: 'Settings/General',
  component: GeneralSection,
  decorators: [withBridgeFixtures({ getSettings: DEFAULTS })],
} satisfies Meta<typeof GeneralSection>

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl space-y-8">{children}</div>
}

/** Every toggle on its default: alerts, notifications, on-device assist, and telemetry all enabled;
 *  images balanced at a week's retention. */
export const Default: Story = {
  render: () => (
    <Frame>
      <GeneralSection />
    </Frame>
  ),
}

/** Everything quieted down: no notifications, no on-device assist, no telemetry — the "leave me
 *  alone" posture, a tighter image budget, and the app critique pass traded away for usage window. */
export const Quiet: Story = {
  decorators: [
    withBridgeFixtures({
      getSettings: {
        notificationsEnabled: false,
        usageResetNotify: false,
        providerStatusNotify: false,
        appDaySessions: false,
        critiquePass: false,
        imageDetail: 'max',
        scratchRetentionDays: 1,
        assistEnabled: false,
        telemetryEnabled: false,
      },
    }),
  ],
  render: () => (
    <Frame>
      <GeneralSection />
    </Frame>
  ),
}
