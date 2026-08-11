import type { Meta, StoryObj } from '@storybook/react-vite'
import { ComposerPrimaryButton } from './ComposerPrimaryButton'

// The third mode (recording) is reachable only by clicking through a live on-device dictation
// backend (window.koda.startVoice) — no fixture path exists for it under Storybook's plain-browser
// mock, so it's left out; the mic/send modes below are the two the component actually renders from
// props.
const meta = {
  title: 'Conversation/ComposerPrimaryButton',
  component: ComposerPrimaryButton,
  args: {
    hasContent: false,
    draft: '',
    setText: () => {},
    onSend: () => {},
  },
  argTypes: {
    hasContent: { control: 'boolean' },
    draft: { control: 'text' },
  },
} satisfies Meta<typeof ComposerPrimaryButton>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const AllModes: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <ComposerPrimaryButton hasContent={false} draft="" setText={() => {}} onSend={() => {}} />
        <span className="font-mono text-[11px] text-text-muted">mic</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <ComposerPrimaryButton
          hasContent
          draft="Add a dark mode toggle to Settings"
          setText={() => {}}
          onSend={() => {}}
        />
        <span className="font-mono text-[11px] text-text-muted">send</span>
      </div>
    </div>
  ),
}
