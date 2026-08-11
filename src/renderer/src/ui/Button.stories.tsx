import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Save changes', variant: 'primary', size: 'md', disabled: false },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost', 'danger'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    children: { control: 'text' },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const AllVariants: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-6">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <div key={size} className="flex items-center gap-3">
          <span className="w-8 font-mono text-[11px] text-text-muted">{size}</span>
          <Button size={size}>Save changes</Button>
          <Button size={size} variant="secondary">
            Cancel
          </Button>
          <Button size={size} variant="ghost">
            Skip for now
          </Button>
          <Button size={size} variant="danger">
            Delete project
          </Button>
          <Button size={size} disabled>
            Disabled
          </Button>
        </div>
      ))}
    </div>
  ),
}
