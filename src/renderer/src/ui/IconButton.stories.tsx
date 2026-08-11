import type { Meta, StoryObj } from '@storybook/react-vite'
import { X, RefreshCw, ArrowLeft } from 'lucide-react'
import { Caret } from '../Caret'
import { IconButton } from './IconButton'

const meta = {
  title: 'Primitives/IconButton',
  component: IconButton,
  args: { label: 'Close', size: 'md', disabled: false, children: <X size={14} /> },
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    children: { control: false },
  },
} satisfies Meta<typeof IconButton>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const Toolbar: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-1">
      <IconButton label="Back">
        <ArrowLeft size={14} />
      </IconButton>
      <IconButton label="Refresh">
        <RefreshCw size={13} />
      </IconButton>
      <IconButton label="Collapse">
        <Caret dir="up" />
      </IconButton>
      <IconButton label="Close">
        <X size={14} />
      </IconButton>
      <IconButton label="Disabled" disabled>
        <X size={14} />
      </IconButton>
    </div>
  ),
}
