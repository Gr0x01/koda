import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemorySection } from './MemorySection'
import { useWorkspace } from '../workspace/store'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

/** The section re-fetches on mount via refreshMemoryWeight (window.koda.getMemoryWeight), which
 *  overwrites any store-seeded value almost immediately — so the bridge fixture is what actually
 *  drives the rendered state; seeding the store is just for the brief pre-fetch paint. */
function withProject(hasProject: boolean) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ projectPath: hasProject ? '/Users/rb/Documents/coding_projects/koda' : '' })
    return <Story />
  }
}

const meta = {
  title: 'Settings/Memory',
  component: MemorySection,
  decorators: [withProject(true)],
} satisfies Meta<typeof MemorySection>

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl space-y-8">{children}</div>
}

/** No memory notes yet — a brand-new project. */
export const NoMemoryYet: Story = {
  decorators: [withBridgeFixtures({ getMemoryWeight: { present: false, chars: 0, heavy: false } })],
  render: () => (
    <Frame>
      <MemorySection />
    </Frame>
  ),
}

/** A healthy always-loaded pair — well under the weight that dulls the agent. */
export const Healthy: Story = {
  decorators: [withBridgeFixtures({ getMemoryWeight: { present: true, chars: 8_200, heavy: false } })],
  render: () => (
    <Frame>
      <MemorySection />
    </Frame>
  ),
}

/** The index + active-context pair has grown heavy — the amber warning + the primary Tidy button,
 *  the same cue the status-bar pill shows. */
export const Heavy: Story = {
  decorators: [withBridgeFixtures({ getMemoryWeight: { present: true, chars: 42_000, heavy: true } })],
  render: () => (
    <Frame>
      <MemorySection />
    </Frame>
  ),
}

/** The overnight tidy is ON — the dream toggle reflects the persisted setting. */
export const OvernightTidyOn: Story = {
  decorators: [
    withBridgeFixtures({
      getMemoryWeight: { present: true, chars: 8_200, heavy: false },
      getSettings: { dreamEnabled: true },
    }),
  ],
  render: () => (
    <Frame>
      <MemorySection />
    </Frame>
  ),
}

/** No project open — Tidy has nothing to run against, so it stays disabled. */
export const NoProjectOpen: Story = {
  decorators: [withProject(false), withBridgeFixtures({ getMemoryWeight: { present: true, chars: 12_000, heavy: false } })],
  render: () => (
    <Frame>
      <MemorySection />
    </Frame>
  ),
}
