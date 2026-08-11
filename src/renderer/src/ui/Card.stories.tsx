import type { Meta, StoryObj } from '@storybook/react-vite'
import { Card } from './Card'

const meta = {
  title: 'Primitives/Card',
  component: Card,
  args: {
    title: 'Appearance',
    divide: false,
    children: <div className="p-4 text-text-muted">A white card floating on the warm canvas.</div>,
  },
  argTypes: { title: { control: 'text' }, children: { control: false } },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-md">
      <Card {...args} />
    </div>
  ),
}

export const DividedRows: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="max-w-md">
      <Card title="Sessions" divide>
        {['Fix the login flow', 'Add workout charts', 'Rename the project'].map((row) => (
          <div key={row} className="flex items-center justify-between px-4 py-3">
            <span>{row}</span>
            <span className="text-[11px] text-text-muted">2m ago</span>
          </div>
        ))}
      </Card>
    </div>
  ),
}
