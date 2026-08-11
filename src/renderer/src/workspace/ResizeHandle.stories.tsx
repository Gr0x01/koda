import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ResizeHandle } from './ResizeHandle'

const meta = {
  title: 'Workspace/ResizeHandle',
  component: ResizeHandle,
  args: { orientation: 'vertical', onResize: () => {} },
  argTypes: {
    orientation: { control: 'inline-radio', options: ['vertical', 'horizontal'] },
  },
} satisfies Meta<typeof ResizeHandle>

export default meta
type Story = StoryObj<typeof meta>

/** Drag it — the resting strip is invisible; hovering (after a short delay) tints it, and dragging
 *  reports raw pointer coords to `onResize`. This story doesn't wire a real split, just the strip's
 *  hover/drag affordance. */
export const Playground: Story = {
  render: (args) => (
    <div className="relative h-40 w-40 rounded-lg border border-border bg-surface">
      <ResizeHandle {...args} style={{ right: 0 }} onResize={() => {}} />
    </div>
  ),
}

/** The sidebar split (vertical, drags width) and the terminal shelf (horizontal, drags height) — the
 *  same primitive rotated, each on the boundary it owns. */
export const Gallery: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    return (
      <div className="flex items-start gap-10">
        <div className="flex flex-col items-start gap-2">
          <span className="text-[11px] text-text-muted">vertical — sidebar width</span>
          <div className="relative flex h-40 w-56 overflow-hidden rounded-lg border border-border">
            <div className="w-40 bg-surface" />
            <div className="flex-1 bg-bg" />
            <ResizeHandle orientation="vertical" style={{ left: 160 }} onResize={() => {}} />
          </div>
        </div>
        <div className="flex flex-col items-start gap-2">
          <span className="text-[11px] text-text-muted">horizontal — terminal shelf height</span>
          <div className="relative flex h-40 w-56 flex-col overflow-hidden rounded-lg border border-border">
            <div className="flex-1 bg-bg" />
            <div className="h-12 bg-surface" />
            <ResizeHandle orientation="horizontal" style={{ top: 96 }} onResize={() => {}} />
          </div>
        </div>
      </div>
    )
  },
}

/** A live wired split — drag to resize, `onResizeEnd` fires once on release (where a real caller
 *  would persist the settled size). */
export const Wired: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    function Demo() {
      const [width, setWidth] = useState(160)
      return (
        <div className="relative flex h-40 w-72 overflow-hidden rounded-lg border border-border" id="wired-demo">
          <div className="shrink-0 bg-surface" style={{ width }} />
          <div className="flex-1 bg-bg" />
          <ResizeHandle
            orientation="vertical"
            style={{ left: width }}
            onResize={(clientX) => {
              const box = document.getElementById('wired-demo')?.getBoundingClientRect()
              if (!box) return
              setWidth(Math.min(240, Math.max(60, clientX - box.left)))
            }}
          />
        </div>
      )
    }
    return <Demo />
  },
}
