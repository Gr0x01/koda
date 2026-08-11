import type { Meta, StoryObj } from '@storybook/react-vite'
import { AsideOverlay } from './AsideOverlay'

const meta = {
  title: 'Conversation/AsideOverlay',
  component: AsideOverlay,
  args: {
    aside: { id: 'a1', question: 'What port does the dev server run on?', answer: '', status: 'streaming' },
    onDismiss: () => {},
    onPromote: () => {},
  },
  parameters: { controls: { disable: true } },
  // Floats directly above the composer — frame it at the composer's width.
  decorators: [
    (Story) => (
      <div className="w-[420px] rounded-2xl border border-border bg-surface p-3 shadow-soft">
        <Story />
        <div className="rounded-xl border border-border bg-bg px-3 py-2 text-[13px] text-text-muted">
          Message Koda…
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AsideOverlay>

export default meta
type Story = StoryObj<typeof meta>

/** Waiting on the answer — no text yet, so the "Thinking…" busy line shows instead of a blank card. */
export const Waiting: Story = {}

/** The answer streamed in and finished — plain prose, "not saved to your chat" stays visible, and
 *  "Add to chat" offers promoting it into a real message. */
export const Answered: Story = {
  args: {
    aside: {
      id: 'a2',
      question: 'What port does the dev server run on?',
      answer: "Port 5173 — Vite's default. The Electron main process picks it up from electron.vite.config.ts.",
      status: 'done',
    },
  },
}

/** Still streaming, but the first line has already landed — the answer renders live instead of
 *  waiting for the full response. */
export const StreamingWithText: Story = {
  args: {
    aside: {
      id: 'a3',
      question: 'Is the search index case-sensitive?',
      answer: 'No — matching lowercases both the query and the',
      status: 'streaming',
    },
  },
}

/** The aside finished with nothing to say — points back at the main chat instead of showing a blank
 *  card. */
export const EmptyAnswer: Story = {
  args: {
    aside: { id: 'a4', question: 'How many docs are in this project?', answer: '', status: 'done' },
  },
}

/** The side question failed outright. */
export const Errored: Story = {
  args: {
    aside: {
      id: 'a5',
      question: 'What\'s the current git branch?',
      answer: '',
      status: 'error',
    },
  },
}
