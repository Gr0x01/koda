import type { Meta, StoryObj } from '@storybook/react-vite'
import { SystemNotice } from './SystemNotice'
import { ThinkingIndicator } from './ThinkingIndicator'
import { FileChip } from './FileChip'
import { CanvasEditChip } from './CanvasEditChip'

// The transcript's small status/receipt pieces, gathered in one gallery — each is a one-prop leaf
// that doesn't warrant its own stories file.
const meta = {
  title: 'Transcript/Status pieces',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const SystemNotices: Story = {
  render: () => (
    <div className="max-w-xl">
      <SystemNotice text="Session started · Claude" />
      <SystemNotice text="Turn interrupted" />
    </div>
  ),
}

export const Thinking: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-1">
      <ThinkingIndicator active estimatedTokens={2431} />
      <ThinkingIndicator active={false} estimatedTokens={5120} />
    </div>
  ),
}

export const FileChips: Story = {
  render: () => (
    <div className="flex items-center gap-1.5">
      <FileChip name="expenses-2026.csv" />
      <FileChip name="a-really-long-export-file-name-from-the-bank.pdf" />
    </div>
  ),
}

export const CanvasEdit: Story = {
  render: () => (
    <div className="max-w-xl">
      <CanvasEditChip
        docTitle="Build plan"
        instruction="Make this section shorter and move the risks list above it."
      />
    </div>
  ),
}
