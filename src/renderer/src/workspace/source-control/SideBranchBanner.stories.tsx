import type { Meta, StoryObj } from '@storybook/react-vite'
import { SideBranchBanner } from './SideBranchBanner'
import { useWorkspace, type SessionState } from '../store'

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: '/Users/rb/koda-demo',
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

function withSession(hasSession: boolean, busy = false) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      activeId: hasSession ? 's-1' : null,
      sessions: busy ? { 's-1': baseSession({ id: 's-1', label: 'Fix the login flow', busy: true }) } : {},
    })
    return (
      <div className="w-[320px]">
        <Story />
      </div>
    )
  }
}

const meta = {
  title: 'Source Control/SideBranchBanner',
  component: SideBranchBanner,
  args: { branch: 'agent/redesign-nav', trunk: 'main', onLeave: () => {} },
  decorators: [withSession(true)],
} satisfies Meta<typeof SideBranchBanner>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const NoSessionOpen: Story = {
  decorators: [withSession(false)],
}

export const AgentBusy: Story = {
  decorators: [withSession(true, true)],
}
