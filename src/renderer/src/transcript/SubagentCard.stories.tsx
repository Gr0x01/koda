import type { Meta, StoryObj } from '@storybook/react-vite'
import { SubagentCard } from './SubagentCard'
import type { SubagentItem } from './types'

const running: SubagentItem = {
  kind: 'subagent',
  toolUseId: 'tu_1',
  taskId: 'task_1',
  subagentType: 'scout',
  description: 'Find every caller of applyThemeVars',
  liveStatus: 'Searching src/renderer…',
  lastActivityAt: Date.now(),
  prompt: 'Find every caller of applyThemeVars and report the file list.',
  status: 'running',
  children: [
    { id: 1, kind: 'tool', toolUseId: 'tu_2', name: 'Grep', input: { pattern: 'applyThemeVars' } },
    { id: 2, kind: 'assistant', markdown: 'Two callers so far: `theme.tsx` and the Storybook preview…' },
  ],
}

const completed: SubagentItem = {
  kind: 'subagent',
  toolUseId: 'tu_3',
  subagentType: 'code-reviewer',
  description: 'Review the theme switching change',
  status: 'completed',
  usage: { totalTokens: 11549, durationMs: 8300 },
  children: [
    {
      id: 1,
      kind: 'tool',
      toolUseId: 'tu_4',
      name: 'Read',
      input: { file_path: 'src/renderer/src/theme.tsx' },
      result: '…156 lines',
    },
  ],
  resultText: 'One real issue: the meta theme-color update runs before the vars apply. Fix the order.',
}

const meta = {
  title: 'Transcript/SubagentCard',
  component: SubagentCard,
  parameters: { controls: { disable: true } },
  args: { item: running },
} satisfies Meta<typeof SubagentCard>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {
  render: () => (
    <div className="max-w-xl">
      <SubagentCard item={running} onStop={() => {}} />
    </div>
  ),
}

export const InterruptedAndUnknown: Story = {
  render: () => (
    <div className="max-w-xl space-y-3">
      <SubagentCard item={{ ...running, status: 'interrupted' }} />
      <SubagentCard item={{ ...running, toolUseId: 'tu_2', status: 'unknown' }} />
    </div>
  ),
}

export const Completed: Story = {
  render: () => (
    <div className="max-w-xl">
      <SubagentCard item={completed} />
    </div>
  ),
}
