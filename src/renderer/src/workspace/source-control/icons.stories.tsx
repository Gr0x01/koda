import type { Meta, StoryObj } from '@storybook/react-vite'
import { BranchGlyph, UploadGlyph } from './icons'

// Shared SVG glyphs used across the Versions surface.
const meta = {
  title: 'Source Control/Icons',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const AllIcons: Story = {
  render: () => (
    <div className="flex items-center gap-6 text-text">
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3">
        <BranchGlyph />
        <span className="text-[10px] text-text-muted">Branch</span>
      </div>
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3">
        <UploadGlyph />
        <span className="text-[10px] text-text-muted">Upload</span>
      </div>
    </div>
  ),
}
