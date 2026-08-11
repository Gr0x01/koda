import type { Meta, StoryObj } from '@storybook/react-vite'
import { PanelHeader } from './PanelHeader'
import { Segmented } from '../ui'

const meta = {
  title: 'Workspace/PanelHeader',
  component: PanelHeader,
  args: { label: 'Sessions' },
  argTypes: {
    label: { control: 'text' },
  },
} satisfies Meta<typeof PanelHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-xs rounded-lg border border-border bg-bg">
      <PanelHeader {...args} />
    </div>
  ),
}

/** Bare caps-label header — the Sessions/Files/Source Control panels. */
export const LabelOnly: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="max-w-xs rounded-lg border border-border bg-bg">
      <PanelHeader label="Source Control" />
    </div>
  ),
}

function NewSessionButton() {
  return (
    <button
      title="Run another agent on this project"
      aria-label="New session"
      className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface hover:text-text"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  )
}

/** Label + a right-slot action — the Sessions panel's "new session" button. */
export const WithAction: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="max-w-xs rounded-lg border border-border bg-bg">
      <PanelHeader label="Sessions">
        <NewSessionButton />
      </PanelHeader>
    </div>
  ),
}

/** `title` overrides the caps-label with a control of its own — the Docs⇄Files segmented switch. */
export const CustomTitleControl: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="max-w-xs rounded-lg border border-border bg-bg">
      <PanelHeader
        title={
          <Segmented
            aria-label="Documents or file tree"
            options={[
              { value: 'docs', label: 'Docs' },
              { value: 'tree', label: 'Files' },
            ]}
            value="docs"
            onChange={() => {}}
          />
        }
      >
        <NewSessionButton />
      </PanelHeader>
    </div>
  ),
}
