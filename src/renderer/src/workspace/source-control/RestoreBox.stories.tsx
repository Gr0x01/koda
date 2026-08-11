import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { RestoreBox } from './RestoreBox'

function withFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

const meta = {
  title: 'Source Control/RestoreBox',
  component: RestoreBox,
  args: { sha: 'a1b2c3d', onRestored: () => {} },
  decorators: [
    withFixtures({}),
    (Story) => (
      <div className="w-[280px] rounded-lg border border-border bg-bg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RestoreBox>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

// Non-destructive by construction, but the confirm is still an inline gate before it fires.
export const Confirming: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Restore this version'))
    await waitFor(() => expect(canvas.getByText('Restore')).toBeInTheDocument())
  },
}

// The expected refusal: unsaved changes exist, so restoring would silently eat them.
export const RestoreFails: Story = {
  decorators: [withFixtures({ gitRestoreVersion: { ok: false, code: 'not_clean', message: 'dirty tree' } })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Restore this version'))
    await userEvent.click(await canvas.findByText('Restore'))
    await waitFor(() =>
      expect(canvas.getByText(/save a version \(or discard them\) before restoring/)).toBeInTheDocument(),
    )
  },
}

export const RestoreNeedsIdentity: Story = {
  decorators: [withFixtures({ gitRestoreVersion: { ok: false, code: 'no_identity', message: 'missing identity' } })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Restore this version'))
    await userEvent.click(await canvas.findByText('Restore'))
    await waitFor(() =>
      expect(canvas.getByText('Git needs your name and email first. Ask Koda to set them up.')).toBeInTheDocument(),
    )
  },
}
