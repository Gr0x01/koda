import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { FeedbackSection } from './FeedbackSection'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

const meta = {
  title: 'Settings/Feedback',
  component: FeedbackSection,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof FeedbackSection>

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl">{children}</div>
}

/** The blank form — every send is local state until Send fires. */
export const Default: Story = {
  render: () => (
    <Frame>
      <FeedbackSection />
    </Frame>
  ),
}

/** A filled bug report, ready to send. */
export const Filled: Story = {
  render: () => (
    <Frame>
      <FeedbackSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Idea'))
    await userEvent.type(
      canvas.getByPlaceholderText("What's on your mind?"),
      'Would love a keyboard shortcut to jump straight to Recovery.',
    )
  },
}

/** Submitting lands the private "thanks" note and resets the form. */
export const Sent: Story = {
  decorators: [withBridgeFixtures({ submitFeedback: { ok: true } })],
  render: () => (
    <Frame>
      <FeedbackSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByPlaceholderText("What's on your mind?"), 'The preview pane flickers on resize.')
    await userEvent.click(canvas.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(canvas.getByText(/Thanks, that's in/)).toBeInTheDocument())
  },
}

/** A failed send surfaces the reason inline and keeps the draft intact to retry. */
export const SendFailed: Story = {
  decorators: [withBridgeFixtures({ submitFeedback: { ok: false, error: 'Could not reach the server. Try again in a moment.' } })],
  render: () => (
    <Frame>
      <FeedbackSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByPlaceholderText("What's on your mind?"), 'The preview pane flickers on resize.')
    await userEvent.click(canvas.getByRole('button', { name: 'Send feedback' }))
    await waitFor(() => expect(canvas.getByText(/Could not reach the server/)).toBeInTheDocument())
  },
}
