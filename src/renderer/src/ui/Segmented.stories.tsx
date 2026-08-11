import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Segmented } from './Segmented'

// Segmented is controlled, so stories hold the value in local state to keep the chip sliding.
function Demo({ options }: { options: readonly { value: string; label: string }[] }) {
  const [value, setValue] = useState(options[0].value)
  return <Segmented options={options} value={value} onChange={setValue} aria-label="Demo switch" />
}

const meta = {
  title: 'Primitives/Segmented',
  component: Segmented,
  parameters: { controls: { disable: true } },
  // Satisfies the required controlled props; every story renders the stateful Demo instead.
  args: { options: [], value: '', onChange: () => {} },
} satisfies Meta<typeof Segmented>

export default meta
type Story = StoryObj<typeof meta>

export const TwoCells: Story = {
  render: () => (
    <Demo
      options={[
        { value: 'docs', label: 'Docs' },
        { value: 'files', label: 'Files' },
      ]}
    />
  ),
}

export const ThreeCells: Story = {
  render: () => (
    <Demo
      options={[
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'System' },
      ]}
    />
  ),
}
