import type { Meta, StoryObj } from '@storybook/react-vite'
import { BusyText, PixelGlyph } from './PixelGlyph'

const meta = {
  title: 'Primitives/PixelGlyph',
  component: PixelGlyph,
  args: { glyph: 'check', loader: false, variant: 'twinkle', size: 13 },
  argTypes: {
    glyph: {
      control: 'select',
      options: ['check', 'ring', 'bang', 'cross', 'dot', 'dotRound', 'dotBlock'],
    },
    variant: { control: 'inline-radio', options: ['twinkle', 'diamond', 'snake'] },
    size: { control: { type: 'range', min: 11, max: 48, step: 1 } },
  },
} satisfies Meta<typeof PixelGlyph>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => <PixelGlyph {...args} className="text-text" />,
}

export const AllGlyphs: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-end gap-6">
      {(['check', 'ring', 'bang', 'cross', 'dot', 'dotRound', 'dotBlock'] as const).map((g) => (
        <div key={g} className="flex flex-col items-center gap-2">
          <PixelGlyph glyph={g} size={20} className="text-text" />
          <span className="font-mono text-[10px] text-text-muted">{g}</span>
        </div>
      ))}
    </div>
  ),
}

export const Loaders: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-end gap-8">
      {(['twinkle', 'diamond', 'snake'] as const).map((v) => (
        <div key={v} className="flex flex-col items-center gap-2">
          <PixelGlyph loader variant={v} size={20} className="text-text" />
          <span className="font-mono text-[10px] text-text-muted">{v}</span>
        </div>
      ))}
    </div>
  ),
}

export const BusyTextInline: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex flex-col gap-3 text-[13px] text-text-muted">
      <BusyText>Working…</BusyText>
      <BusyText variant="diamond">Thinking…</BusyText>
    </div>
  ),
}
