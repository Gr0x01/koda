import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { AttachMenu } from './AttachMenu'

const meta = {
  title: 'Conversation/AttachMenu',
  component: AttachMenu,
  args: {
    onAttach: () => {},
    onInsertPaths: () => {},
    onRefused: () => {},
  },
  decorators: [
    (Story) => (
      // The menu opens upward AND leftward (`bottom-full right-0`) from the composer's + button,
      // so the trigger needs room above and a full menu-width of room to its left.
      <div className="flex h-44 w-80 items-end justify-end rounded-lg border border-border bg-surface p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AttachMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const Open: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByLabelText('Attach')
    await userEvent.click(trigger)
    await waitFor(() => expect(canvas.getByText('Attach a file…')).toBeInTheDocument())
  },
}
