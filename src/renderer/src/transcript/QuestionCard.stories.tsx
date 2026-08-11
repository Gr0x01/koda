import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { QuestionCard } from './QuestionCard'

/**
 * QuestionCard is store-welded (answerQuestion/dismissQuestion call the workspace store), but both
 * actions guard on `pending.some(r => r.requestId === toolUseId)` — with the default empty `pending`
 * (no seeding needed) they no-op on the store side while the card's own local state still locks to
 * the answered view, so every interactive path renders correctly with zero store setup.
 */
const oneQuestion = {
  questions: [
    {
      question: 'Where should the search index live?',
      header: 'Storage',
      options: [
        { label: 'In the project, next to the docs', description: 'Simple, versioned with the repo' },
        { label: 'In a hidden .koda folder', description: "Won't show up in the file tree" },
      ],
    },
  ],
}

const twoQuestions = {
  questions: [
    {
      question: 'Should search match tags, titles, or both?',
      header: 'Matching',
      options: [{ label: 'Titles only' }, { label: 'Tags only' }, { label: 'Both' }],
    },
    {
      question: 'Show the tag filter as a dropdown or a row of chips?',
      header: 'Filter UI',
      options: [
        { label: 'Dropdown', description: 'Compact, one click to open' },
        { label: 'Chips', description: 'Every tag visible at once' },
      ],
    },
  ],
}

const multiSelect = {
  questions: [
    {
      question: 'Which file types should the search cover?',
      header: 'Scope',
      multiSelect: true,
      options: [
        { label: 'Markdown docs' },
        { label: 'Code comments' },
        { label: 'Commit messages' },
      ],
    },
  ],
}

const meta = {
  title: 'Transcript/QuestionCard',
  component: QuestionCard,
  args: { toolUseId: 'tu_q1', input: oneQuestion },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof QuestionCard>

export default meta
type Story = StoryObj<typeof meta>

export const SingleQuestion: Story = {
  render: (args) => (
    <div className="max-w-xl">
      <QuestionCard {...args} />
    </div>
  ),
}

/** Two questions — the pager reads "1 of 2"; Next stays disabled until an option (or Skip) decides
 *  the current one. */
export const MultiQuestion: Story = {
  args: { toolUseId: 'tu_q2', input: twoQuestions },
  render: (args) => (
    <div className="max-w-xl">
      <QuestionCard {...args} />
    </div>
  ),
}

/** multiSelect: true lets more than one option stay picked at once ("Pick one or more" hint, no
 *  auto-deselect on a second click). */
export const MultiSelect: Story = {
  args: { toolUseId: 'tu_q3', input: multiSelect },
  render: (args) => (
    <div className="max-w-xl">
      <QuestionCard {...args} />
    </div>
  ),
}

/** Pick an option and Submit — the card locks to the read-only "Your answer" summary the instant you
 *  click, before any engine echo comes back. */
export const Submitted: Story = {
  args: { toolUseId: 'tu_q4', input: oneQuestion },
  render: (args) => (
    <div className="max-w-xl">
      <QuestionCard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('In a hidden .koda folder'))
    await userEvent.click(canvas.getByText('Submit'))
    await waitFor(() => expect(canvas.getByText('In a hidden .koda folder')).toBeInTheDocument())
    await expect(canvas.getByText('Your answer')).toBeInTheDocument()
  },
}

/** "Reply instead" bails out of picking — denies the tool and drops the cursor into the composer,
 *  the card locking to a plain "you replied in your own words" summary. */
export const RepliedInstead: Story = {
  args: { toolUseId: 'tu_q5', input: oneQuestion },
  render: (args) => (
    <div className="max-w-xl">
      <QuestionCard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Reply instead'))
    await waitFor(() =>
      expect(canvas.getByText('You replied in your own words instead.')).toBeInTheDocument(),
    )
  },
}

/** A fresh render/reload with no local state — the answer is recovered entirely from the engine's
 *  echoed tool result (parseAnsweredResult), so a returning session still shows what was picked. */
export const PersistedOnReload: Story = {
  args: {
    toolUseId: 'tu_q6',
    input: oneQuestion,
    result: 'Your questions have been answered: "Where should the search index live?"="In the project, next to the docs" selected.',
  },
  render: (args) => (
    <div className="max-w-xl">
      <QuestionCard {...args} />
    </div>
  ),
}
