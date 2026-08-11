import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { ApprovalModeControl } from './ApprovalModeControl'

// The control lives at the app's footer, so its menu opens UPWARD (`bottom-full`) — every story
// gets a bottom-anchored frame or an opened menu clips at the canvas top.
const footerFrame = (Story: React.ComponentType): React.ReactElement => (
  <div className="flex min-h-[340px] flex-col items-start justify-end">
    <Story />
  </div>
)

const meta = {
  title: 'Workspace/ApprovalModeControl',
  component: ApprovalModeControl,
  decorators: [footerFrame],
  args: { sessionId: 's-1', mode: 'auto', busy: false },
  argTypes: {
    mode: { control: 'inline-radio', options: ['auto', 'plan', 'ask', 'acceptEdits'] },
    busy: { control: 'boolean' },
  },
} satisfies Meta<typeof ApprovalModeControl>

export default meta
type Story = StoryObj<typeof meta>

/** Click the pill to open the mode menu — Auto / Plan first / Check first. */
export const Playground: Story = {}

export const MenuOpen: Story = {
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByTitle('Auto-approve everything (destructive git + recovery still confirm) · Shift+Tab to cycle')
    await userEvent.click(trigger)
    await waitFor(() => expect(canvas.getByText('Check first')).toBeInTheDocument())
  },
}

/** The three pickable postures, the legacy `acceptEdits` label (still rendered for a session
 *  persisted in it), and a mid-turn Plan crossing (blocked — the pill still opens, the Plan row
 *  grays out inside the menu). */
export const Gallery: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    const cases: {
      label: string
      mode: 'auto' | 'plan' | 'ask' | 'acceptEdits'
      busy?: boolean
    }[] = [
      { label: 'Auto', mode: 'auto' },
      { label: 'Plan first', mode: 'plan' },
      { label: 'Check first', mode: 'ask' },
      { label: 'Legacy acceptEdits (still renders "Auto")', mode: 'acceptEdits' },
      { label: 'Busy — crossing Plan blocks mid-turn', mode: 'ask', busy: true },
    ]
    return (
      <div className="flex flex-wrap items-center gap-6">
        {cases.map((s) => (
          <div key={s.label} className="flex flex-col items-start gap-1.5">
            <span className="max-w-44 text-[11px] leading-snug text-text-muted">{s.label}</span>
            <ApprovalModeControl sessionId="s-1" mode={s.mode} busy={s.busy} />
          </div>
        ))}
      </div>
    )
  },
}
