import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SettingsSection, SettingsRow, Toggle, ThemeSelect, SegmentedControl } from './controls'
import { THEMES } from '../themes'

// Settings pane vocabulary — sectioned cards of label+description rows with a control on the right.
// Gathered in one gallery since each piece is a small building block, not a standalone screen.
const meta = {
  title: 'Settings/Controls',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Section: Story = {
  render: () => (
    <div className="max-w-md">
      <SettingsSection title="Appearance">
        <SettingsRow label="Send analytics" description="Content-free usage counts, never file contents." />
        <SettingsRow label="Default approval tier" description="How much Koda can do before asking." />
      </SettingsSection>
    </div>
  ),
}

export const Row: Story = {
  render: () => (
    <div className="max-w-md rounded-lg border border-border bg-surface">
      <SettingsRow
        label="Keep local backups"
        description="Snapshots of your project saved automatically as you work."
        control={<span className="text-[12.5px] text-text-muted">On</span>}
      />
    </div>
  ),
}

// Stateful — holds its own value so the switch actually flips when clicked.
function ToggleDemo() {
  const [on, setOn] = useState(true)
  return <Toggle checked={on} onChange={setOn} label="Send analytics" />
}

export const ToggleOnOff: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <ToggleDemo />
      <Toggle checked={false} onChange={() => {}} label="Auto-update" />
    </div>
  ),
}

function ThemeSelectDemo() {
  const light = THEMES.filter((t) => t.mode === 'light')
  const [value, setValue] = useState(light[1].id)
  return <ThemeSelect value={value} options={light} onChange={setValue} ariaLabel="Light theme" />
}

export const ThemePicker: Story = {
  render: () => (
    <div className="flex min-h-[280px] items-start">
      <ThemeSelectDemo />
    </div>
  ),
}

function SegmentedControlDemo() {
  const [value, setValue] = useState<'ask' | 'auto' | 'off'>('ask')
  return (
    <SegmentedControl
      value={value}
      onChange={setValue}
      ariaLabel="Default approval tier"
      options={[
        { value: 'ask', label: 'Ask' },
        { value: 'auto', label: 'Auto-allow' },
        { value: 'off', label: 'Off' },
      ]}
    />
  )
}

export const SegmentedControlPick: Story = {
  render: () => <SegmentedControlDemo />,
}
