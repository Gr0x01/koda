import type { Meta, StoryObj } from '@storybook/react-vite'
import { ApprovalsSection } from './ApprovalsSection'
import { useWorkspace } from '../workspace/store'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

/** `defaultApprovalMode` is a real store field the section reads AND writes (SegmentedControl.onChange
 *  calls setDefaultApprovalMode), so seeding it here makes the control genuinely interactive. */
function withApprovalMode(mode: 'auto' | 'ask') {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ defaultApprovalMode: mode })
    return <Story />
  }
}

const meta = {
  title: 'Settings/Approvals',
  component: ApprovalsSection,
  decorators: [withBridgeFixtures({ getSettings: { previewAutoStart: true } }), withApprovalMode('auto')],
} satisfies Meta<typeof ApprovalsSection>

export default meta
type Story = StoryObj<typeof meta>

/** The safe default: new sessions build on their own, preview auto-starts. */
export const Default: Story = {}

/** The cautious default: new sessions check before every edit and command. */
export const CheckFirstDefault: Story = {
  decorators: [withApprovalMode('ask')],
}

/** Preview auto-start turned off — the agent confirms before running a dev server. */
export const PreviewAutoStartOff: Story = {
  decorators: [withBridgeFixtures({ getSettings: { previewAutoStart: false } }), withApprovalMode('auto')],
}
