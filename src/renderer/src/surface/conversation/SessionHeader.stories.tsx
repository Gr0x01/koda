import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { SessionHeader } from './SessionHeader'
import { useWorkspace } from '../../workspace/store'

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-9 w-[440px] items-center rounded-lg border border-border bg-surface px-3">{children}</div>
}

// Mirrors the real call site (ConversationSurface.tsx) — a borderless title row, dockOpen read
// straight from the workspace store.
const withDock =
  (open: boolean) =>
  (Story: React.ComponentType): React.ReactElement => {
    useWorkspace.setState({ dockOpen: open })
    return (
      <Frame>
        <Story />
      </Frame>
    )
  }

const meta = {
  title: 'Conversation/SessionHeader',
  component: SessionHeader,
  args: {
    label: 'Refactor the billing settings panel',
    onRename: () => {},
    onArchive: () => {},
  },
  argTypes: {
    label: { control: 'text' },
  },
  decorators: [withDock(true)],
} satisfies Meta<typeof SessionHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const DockOpen: Story = {
  parameters: { controls: { disable: true } },
  decorators: [withDock(true)],
}

export const DockClosed: Story = {
  parameters: { controls: { disable: true } },
  decorators: [withDock(false)],
}

export const Renaming: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const title = canvas.getByTitle('Double-click to rename')
    await userEvent.dblClick(title)
    await waitFor(() => expect(canvas.getByDisplayValue('Refactor the billing settings panel')).toBeInTheDocument())
  },
}

export const MenuOpen: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const kebab = canvas.getByLabelText('Session options')
    await userEvent.click(kebab)
    await waitFor(() => expect(canvas.getByText('Archive session')).toBeInTheDocument())
  },
}
