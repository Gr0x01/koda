import type { Meta, StoryObj } from '@storybook/react-vite'
import { StatusIcon } from './SessionStatusIcon'
import type { SessionStatus } from './store'

const meta = {
  title: 'Workspace/SessionStatusIcon',
  component: StatusIcon,
  args: { status: 'idle', fresh: false, attention: false },
  argTypes: {
    status: { control: 'inline-radio', options: ['idle', 'thinking', 'waiting', 'error'] },
    fresh: { control: 'boolean' },
    attention: { control: 'boolean' },
  },
} satisfies Meta<typeof StatusIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const AllStates: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-4">
      {(
        [
          { status: 'idle', fresh: true, label: 'fresh — never sent a turn' },
          { status: 'idle', fresh: false, label: 'idle — ready' },
          { status: 'thinking', fresh: false, label: 'thinking — twinkling' },
          { status: 'waiting', fresh: false, label: 'waiting — needs approval' },
          { status: 'waiting', fresh: false, attention: true, label: 'waiting + attention (pulses)' },
          { status: 'error', fresh: false, label: 'error — stopped' },
        ] as { status: SessionStatus; fresh: boolean; attention?: boolean; label: string }[]
      ).map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <StatusIcon status={s.status} fresh={s.fresh} attention={s.attention} />
          <span className="text-[12px] text-text-muted">{s.label}</span>
        </div>
      ))}
    </div>
  ),
}
