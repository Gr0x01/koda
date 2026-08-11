import type { Meta, StoryObj } from '@storybook/react-vite'
import type { EngineErrorBanner } from '../../workspace/store'
import { ComposerError, ComposerNotice } from './ComposerError'
import { RELAY_UNREACHABLE } from '@shared/engine-error'

const relayUnreachable: EngineErrorBanner = { message: RELAY_UNREACHABLE, fatal: false }
const signedOut: EngineErrorBanner = { message: '401 unauthorized: invalid x-api-key', fatal: false }
const outOfCredit: EngineErrorBanner = { message: 'Your credit balance is too low to make this request', fatal: false }
const rateLimited: EngineErrorBanner = { message: '429 rate_limit_error: too many requests', fatal: false }
const providerHiccup: EngineErrorBanner = { message: '529 overloaded_error: Claude is overloaded', fatal: false }
const connectionDropped: EngineErrorBanner = { message: 'fetch failed: ETIMEDOUT', fatal: false }
const engineStopped: EngineErrorBanner = { message: 'the engine process exited unexpectedly', fatal: true }
const genericFailure: EngineErrorBanner = { message: 'API Error: something odd happened while streaming.', fatal: false }

// Mirrors the real call site (ConversationSurface.tsx) — a quiet section fused above the composer,
// under a hairline divider, not a floating alert.
function Frame({ error }: { error: EngineErrorBanner }) {
  return (
    <div className="max-w-lg rounded-2xl border border-border bg-surface p-3 shadow-soft">
      <div className="mb-2 border-b border-border/60 px-0.5 pb-2">
        <ComposerError error={error} onRetry={() => {}} />
      </div>
      <div className="h-8 rounded-lg bg-bg" />
    </div>
  )
}

const meta = {
  title: 'Conversation/ComposerError',
  component: ComposerError,
  parameters: { controls: { disable: true } },
  args: { error: relayUnreachable, onRetry: () => {} },
} satisfies Meta<typeof ComposerError>

export default meta
type Story = StoryObj<typeof meta>

export const RelayUnreachable: Story = {
  render: () => <Frame error={relayUnreachable} />,
}

export const SignedOut: Story = {
  render: () => <Frame error={signedOut} />,
}

export const OutOfCredit: Story = {
  render: () => <Frame error={outOfCredit} />,
}

export const RateLimited: Story = {
  render: () => <Frame error={rateLimited} />,
}

export const ProviderHiccup: Story = {
  render: () => <Frame error={providerHiccup} />,
}

export const ConnectionDropped: Story = {
  render: () => <Frame error={connectionDropped} />,
}

export const EngineStopped: Story = {
  render: () => <Frame error={engineStopped} />,
}

export const GenericFailure: Story = {
  render: () => <Frame error={genericFailure} />,
}

// The other row in the same slot: a file the composer couldn't take. Copy already written (never run
// through friendlyEngineError), so these stories pass the finished sentence straight in.
function NoticeFrame({ text }: { text: string }) {
  return (
    <div className="max-w-lg rounded-2xl border border-border bg-surface p-3 shadow-soft">
      <div className="mb-2 border-b border-border/60 px-0.5 pb-2">
        <ComposerNotice text={text} onDismiss={() => {}} />
      </div>
      <div className="h-8 rounded-lg bg-bg" />
    </div>
  )
}

export const NoticeOneUnsupportedImage: Story = {
  render: () => <NoticeFrame text="Koda can't attach IMG_0042.heic. Export as JPEG or PNG." />,
}

export const NoticeSeveralUnsupportedImages: Story = {
  render: () => <NoticeFrame text="Koda can't attach .heic files. Export as JPEG or PNG." />,
}

export const NoticeUnsupportedDocument: Story = {
  render: () => (
    <NoticeFrame text="Koda can't attach notes.txt. Point at it with the attach menu so the agent reads it in place." />
  ),
}
