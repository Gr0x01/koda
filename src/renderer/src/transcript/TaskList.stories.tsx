import type { Meta, StoryObj } from '@storybook/react-vite'
import { TaskList } from './TaskList'

const meta = {
  title: 'Transcript/TaskList',
  component: TaskList,
  args: {
    tasks: [
      { id: '1', subject: 'Read the existing settings page', status: 'completed' },
      { id: '2', subject: 'Add the dark mode toggle', status: 'completed' },
      { id: '3', subject: 'Wire the toggle to the theme store', status: 'in_progress' },
      { id: '4', subject: 'Verify both modes in the app', status: 'pending' },
    ],
  },
} satisfies Meta<typeof TaskList>

export default meta
type Story = StoryObj<typeof meta>

export const InProgress: Story = {
  render: (args) => (
    <div className="max-w-md">
      <TaskList {...args} />
    </div>
  ),
}

export const AllDone: Story = {
  render: () => (
    <div className="max-w-md">
      <TaskList
        tasks={[
          { id: '1', subject: 'Read the existing settings page', status: 'completed' },
          { id: '2', subject: 'Add the dark mode toggle', status: 'completed' },
        ]}
      />
    </div>
  ),
}
