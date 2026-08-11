import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { EffortControl } from './EffortControl'
import { useWorkspace } from './store'

/** Seeds a pending approval for `sessionId` so the pill locks — the same guard `busy` gives, but
 *  driven by the store's `pending` list instead of the prop. */
function withPendingApproval(Story: React.ComponentType): React.ReactElement {
  useWorkspace.setState({
    pending: [{ sessionId: 'locked-by-pending', requestId: 'req_1', toolName: 'Bash', input: { command: 'rm -rf dist' } }],
  })
  return <Story />
}

// The control lives at the app's footer, so its menu opens UPWARD (`bottom-full`) — every story
// gets a bottom-anchored frame or an opened menu clips at the canvas top.
const footerFrame = (Story: React.ComponentType): React.ReactElement => (
  <div className="flex min-h-[340px] flex-col items-start justify-end">
    <Story />
  </div>
)

const meta = {
  title: 'Workspace/EffortControl',
  component: EffortControl,
  decorators: [footerFrame],
  args: { sessionId: 's-1', effort: undefined, busy: false },
  argTypes: {
    effort: { control: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    busy: { control: 'boolean' },
  },
} satisfies Meta<typeof EffortControl>

export default meta
type Story = StoryObj<typeof meta>

/** Click the pill to open the level menu — Default (engine decides) through Max. */
export const Playground: Story = {}

export const MenuOpen: Story = {
  args: { effort: 'medium' },
  parameters: { controls: { disable: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByTitle('Reasoning effort: medium')
    await userEvent.click(trigger)
    await waitFor(() => expect(canvas.getByText('xhigh')).toBeInTheDocument())
  },
}

/** Every level the engine accepts, plus the locked state — reattaching with a new `--effort` can't
 *  happen mid-turn, so the pill disables while busy or while an approval is pending. */
export const Gallery: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-wrap items-center gap-6">
      {(
        [
          { label: 'Default (engine decides)', effort: undefined },
          { label: 'Low', effort: 'low' },
          { label: 'Medium', effort: 'medium' },
          { label: 'High', effort: 'high' },
          { label: 'xhigh', effort: 'xhigh' },
          { label: 'Max', effort: 'max' },
          { label: 'Busy — locked mid-turn', effort: 'high', busy: true },
        ]
      ).map((s) => (
        <div key={s.label} className="flex flex-col items-start gap-1.5">
          <span className="text-[11px] text-text-muted">{s.label}</span>
          <EffortControl sessionId="s-1" effort={s.effort} busy={s.busy} />
        </div>
      ))}
    </div>
  ),
}

export const LockedByPendingApproval: Story = {
  parameters: { controls: { disable: true } },
  decorators: [withPendingApproval],
  render: () => (
    <div className="flex flex-col items-start gap-1.5">
      <span className="text-[11px] text-text-muted">A tool call is awaiting approval — the pill locks even though `busy` is false</span>
      <EffortControl sessionId="locked-by-pending" effort="medium" />
    </div>
  ),
}
