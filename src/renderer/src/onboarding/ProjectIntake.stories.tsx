import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { ProjectIntake } from './ProjectIntake'
import { useWorkspace } from '../workspace/store'

/** ProjectIntake reads `projectPath` and calls the `startProjectIntake`/`skipIntake` store actions.
 *  `startProjectIntake` for real spins up a whole session (startSession + a dispatched turn) — out of
 *  scope for a story, so busy/error stories override the ACTION itself (store actions are ordinary
 *  state, swappable like any other slice) instead of faking the bridge calls underneath it. */
function withIntake(overrides: Partial<ReturnType<typeof useWorkspace.getState>> = {}) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      projectPath: '/Users/rb/Documents/coding_projects/recipe-week',
      startProjectIntake: async () => true,
      skipIntake: () => {},
      ...overrides,
    })
    return <Story />
  }
}

const meta = {
  title: 'Onboarding/ProjectIntake',
  component: ProjectIntake,
  parameters: { controls: { disable: true } },
  decorators: [withIntake()],
} satisfies Meta<typeof ProjectIntake>

export default meta
type Story = StoryObj<typeof meta>

/** A named project folder — the "Set up · <name>" badge leads the card. */
export const NewProject: Story = {}

/** No project path yet (rare — the very first window before a folder is chosen) — the form still
 *  works, just without the name badge. */
export const NoProjectName: Story = {
  decorators: [withIntake({ projectPath: null })],
}

/** Typing a description unlocks "Get started" (it's disabled on an empty textarea). */
export const Typing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByPlaceholderText(/a recipe app/)
    await userEvent.type(
      textarea,
      'A recipe app my wife and I both use to plan the week together on Sundays.',
    )
    await waitFor(() => expect(canvas.getByText('Get started →')).toBeEnabled())
  },
}

/** Submitted — the button disables the instant you click (guards a double-submit) while the session
 *  spins up underneath. */
export const Submitting: Story = {
  decorators: [withIntake({ startProjectIntake: () => new Promise(() => {}) })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByPlaceholderText(/a recipe app/)
    await userEvent.type(textarea, 'A recipe app for the two of us.')
    await userEvent.click(canvas.getByText('Get started →'))
    await waitFor(() => expect(canvas.getByText('Get started →')).toBeDisabled())
  },
}

/** The session couldn't start — the form recovers (not stuck busy) with an inline retry message. */
export const CouldNotStart: Story = {
  decorators: [withIntake({ startProjectIntake: async () => false })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const textarea = canvas.getByPlaceholderText(/a recipe app/)
    await userEvent.type(textarea, 'A recipe app for the two of us.')
    await userEvent.click(canvas.getByText('Get started →'))
    await waitFor(() => expect(canvas.getByText(/Couldn.t start the project/)).toBeInTheDocument())
    await expect(canvas.getByText('Get started →')).toBeEnabled()
  },
}
