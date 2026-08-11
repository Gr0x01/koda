import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkflowCard } from './WorkflowCard'

const meta = {
  title: 'Transcript/WorkflowCard',
  component: WorkflowCard,
  parameters: { controls: { disable: true } },
  args: {
    item: { runId: 'wf_1', name: 'review-changes', status: 'running', agents: [] },
  },
} satisfies Meta<typeof WorkflowCard>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {
  render: () => (
    <div className="max-w-xl">
      <WorkflowCard
        item={{
          runId: 'wf_1',
          name: 'review-changes',
          status: 'running',
          agents: [
            { agentId: 'a1', status: 'done', result: 'No issues in the theme change.' },
            { agentId: 'a2', status: 'running' },
            { agentId: 'a3', status: 'running' },
          ],
        }}
      />
    </div>
  ),
}

export const Completed: Story = {
  render: () => (
    <div className="max-w-xl">
      <WorkflowCard
        item={{
          runId: 'wf_2',
          name: 'find-flaky-tests',
          status: 'completed',
          agents: [
            { agentId: 'a1', status: 'done', result: 'Found 2 flaky tests in the engine contract suite.' },
            { agentId: 'a2', status: 'done', result: 'Both trace to a shared temp-dir race.' },
          ],
        }}
      />
    </div>
  ),
}
