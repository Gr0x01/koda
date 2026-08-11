import type { Meta, StoryObj } from '@storybook/react-vite'
import { Alert } from './Alert'

const meta = {
  title: 'Primitives/Alert',
  component: Alert,
  args: {
    tone: 'warning',
    title: 'Heads up',
    children: 'Switching to an API key changes how you are billed.',
  },
  argTypes: {
    tone: { control: 'inline-radio', options: ['warning', 'danger', 'info', 'success'] },
    title: { control: 'text' },
    children: { control: 'text' },
  },
} satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const AllTones: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex max-w-md flex-col gap-3">
      <Alert tone="warning" title="Plan limit near">
        You have used most of this week's Claude limit.
      </Alert>
      <Alert tone="danger" title="This cannot be undone">
        Deleting the project removes its history too.
      </Alert>
      <Alert tone="info">Koda saves a checkpoint before every change.</Alert>
      <Alert tone="success" title="Connected">
        Your phone is paired with this Mac.
      </Alert>
    </div>
  ),
}
