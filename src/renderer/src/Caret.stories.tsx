import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Caret } from './Caret'

const meta = {
  title: 'Primitives/Caret',
  component: Caret,
  args: { dir: 'down', size: 14 },
  argTypes: {
    dir: { control: 'inline-radio', options: ['down', 'up', 'left', 'right'] },
    size: { control: { type: 'range', min: 10, max: 24, step: 1 } },
  },
} satisfies Meta<typeof Caret>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => <Caret {...args} className="text-text-muted" />,
}

export const Disclosure: Story = {
  parameters: { controls: { disable: true } },
  render: function Disclosure() {
    const [open, setOpen] = useState(false)
    return (
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[12.5px] text-text"
      >
        <Caret dir={open ? 'down' : 'right'} className="text-text-muted" />
        Advanced options
      </button>
    )
  },
}
