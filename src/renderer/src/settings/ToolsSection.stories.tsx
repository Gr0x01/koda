import type { Meta, StoryObj } from '@storybook/react-vite'
import { ToolsSection } from './ToolsSection'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

const meta = {
  title: 'Settings/Tools',
  component: ToolsSection,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof ToolsSection>

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl">{children}</div>
}

// NOTE: `getRuntimeStatus` is called once per runtime (node, python) with the id as an argument, but
// the bridge mock (koda-bridge-mock.ts) keys its fixture map by METHOD NAME only — it can't distinguish
// the two calls. Both RuntimeRows below always render the SAME status; a story can't show e.g. Node
// already installed while Python still needs setup. Documented harness limitation, not a story bug.

/** Both runtimes already on the Mac (a dev machine), browser testing off. */
export const AllInstalled: Story = {
  decorators: [
    withBridgeFixtures({
      getRuntimeStatus: { id: 'node', state: 'system', installedVersion: null, pinnedVersion: '22.14.0' },
      playwrightStatus: { state: 'not-installed', enabled: false },
    }),
  ],
  render: () => (
    <Frame>
      <ToolsSection />
    </Frame>
  ),
}

/** A fresh Mac — neither runtime is set up yet, browser testing ready for the agent to use. */
export const NeedsSetup: Story = {
  decorators: [
    withBridgeFixtures({
      getRuntimeStatus: { id: 'node', state: 'not_installed', installedVersion: null, pinnedVersion: '22.14.0' },
      playwrightStatus: { state: 'ready', enabled: true },
    }),
  ],
  render: () => (
    <Frame>
      <ToolsSection />
    </Frame>
  ),
}

/** A runtime install is in flight — the row shows "Setting up…" while it downloads. */
export const SettingUp: Story = {
  decorators: [
    withBridgeFixtures({
      getRuntimeStatus: { id: 'node', state: 'installing', installedVersion: null, pinnedVersion: '22.14.0' },
      playwrightStatus: { state: 'installing', enabled: true, message: 'Downloading the browser…' },
    }),
  ],
  render: () => (
    <Frame>
      <ToolsSection />
    </Frame>
  ),
}
