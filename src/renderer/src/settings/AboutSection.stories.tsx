import type { Meta, StoryObj } from '@storybook/react-vite'
import { AboutSection, DeveloperSection } from './AboutSection'

/** Seeds the bridge mock's per-story override map (koda-bridge-mock.ts) — the window seam, not an
 *  import, so this file never touches `.storybook/` (see storybook-coverage.md's harness facts). */
function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

const APP_INFO = {
  appVersion: '0.1.9',
  electron: '38.5.0',
  chrome: '140.0.7339.16',
  node: '22.14.0',
  platform: 'darwin',
}
const ENGINE_PROBE = {
  version: '2.1.207 (Claude Code)',
  path: '/Applications/Koda.app/Contents/Resources/engine/claude',
  source: 'bundled',
}

const meta = {
  title: 'Settings/About',
  parameters: { controls: { disable: true } },
  decorators: [
    withBridgeFixtures({
      getAppInfo: APP_INFO,
      probeEngine: ENGINE_PROBE,
      // `import.meta.env.DEV` is true under Storybook's own dev server, so the Updates row always
      // renders its dev-build note here regardless of this fixture — the ready/downloading states
      // are packaged-build-only and unreachable in this harness (see the coverage report).
      getUpdateStatus: { state: 'up-to-date' },
    }),
  ],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl">{children}</div>
}

/** Koda + engine + Electron versions, read from the app-info bridge calls on mount. */
export const Default: Story = {
  render: () => (
    <Frame>
      <AboutSection />
    </Frame>
  ),
}

/** DEV-only retest panel (stripped from packaged builds) — replay onboarding, re-offer project
 *  intake, or wipe all settings, without hand-editing koda-settings.json. */
export const Developer: Story = {
  render: () => (
    <Frame>
      <DeveloperSection />
    </Frame>
  ),
}
