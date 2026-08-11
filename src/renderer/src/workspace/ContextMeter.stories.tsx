import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ContextUsage } from '@shared/ipc'
import { ContextMeter, ContextReadout, ContinueFreshButton } from './ContextMeter'

function usage(contextTokens: number, contextWindow = 200_000): ContextUsage {
  return {
    contextTokens,
    contextWindow,
    inputTokens: Math.round(contextTokens * 0.15),
    cacheReadTokens: Math.round(contextTokens * 0.75),
    cacheCreationTokens: Math.round(contextTokens * 0.1),
    outputTokens: 640,
  }
}

const LOW = usage(18_200)
const MID = usage(104_000)
const AMBER = usage(156_000)
const RED = usage(188_400)

const meta = {
  title: 'Workspace/ContextMeter',
  component: ContextMeter,
  args: { context: MID },
} satisfies Meta<typeof ContextMeter>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** The sidebar row's glance gauge — empty before turn 1, then green→amber→red as the window fills. */
export const FillLevels: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-3">
      {[
        { label: 'no turns yet (omitted from the row)', context: undefined },
        { label: `low · ${LOW.contextTokens.toLocaleString()} / 200k`, context: LOW },
        { label: `mid · ${MID.contextTokens.toLocaleString()} / 200k`, context: MID },
        { label: `amber · ${AMBER.contextTokens.toLocaleString()} / 200k`, context: AMBER },
        { label: `red · ${RED.contextTokens.toLocaleString()} / 200k`, context: RED },
      ].map((row) => (
        <div key={row.label} className="flex items-center gap-3">
          <ContextMeter context={row.context} />
          <span className="text-[11px] text-text-muted">{row.label}</span>
        </div>
      ))}
    </div>
  ),
}

/** The focused composer readout — flat 10-segment bar + percentage, click to expand the token
 *  breakdown. Shown at a calm fill and a near-full one (where `ContinueFreshButton` also appears). */
export const Readout: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
        <span className="text-[11px] text-text-muted">mid fill, nothing to do yet</span>
        <div className="ml-auto">
          <ContextReadout context={MID} />
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
        <span className="text-[11px] text-text-muted">near-full — offers the fresh-chat handoff</span>
        <ContinueFreshButton context={RED} onClick={() => {}} />
        <div className="ml-auto">
          <ContextReadout context={RED} openUpward />
        </div>
      </div>
    </div>
  ),
}
