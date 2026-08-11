import type { Meta, StoryObj } from '@storybook/react-vite'
import { AnsweredQuestions } from './AnsweredQuestions'

const questions = [
  {
    question: 'Where should the app run?',
    header: 'Platform',
    options: [{ label: 'Just my Mac' }, { label: 'My Mac and phone' }, { label: 'Shared with family' }],
  },
  {
    question: 'Should workouts be editable after logging?',
    header: 'Editing',
    options: [{ label: 'Yes' }, { label: 'No, log-only' }],
  },
]

const meta = {
  title: 'Transcript/AnsweredQuestions',
  component: AnsweredQuestions,
  parameters: { controls: { disable: true } },
  args: {
    questions,
    answered: {
      replied: false,
      answers: {
        'Where should the app run?': 'My Mac and phone',
        'Should workouts be editable after logging?': 'Yes',
      },
    },
  },
} satisfies Meta<typeof AnsweredQuestions>

export default meta
type Story = StoryObj<typeof meta>

export const Answered: Story = {
  render: (args) => (
    <div className="max-w-xl">
      <AnsweredQuestions {...args} />
    </div>
  ),
}

export const RepliedInsteadOfPicking: Story = {
  render: () => (
    <div className="max-w-xl">
      <AnsweredQuestions questions={questions} answered={{ replied: true }} />
    </div>
  ),
}

export const OneSkipped: Story = {
  render: () => (
    <div className="max-w-xl">
      <AnsweredQuestions
        questions={questions}
        answered={{ replied: false, answers: { 'Where should the app run?': 'Just my Mac' } }}
      />
    </div>
  ),
}
