import type { Meta, StoryObj } from '@storybook/react-vite'
import { ToolCard } from './ToolCard'

const meta = {
  title: 'Transcript/ToolCard',
  component: ToolCard,
  args: {
    name: 'Write',
    input: { file_path: 'src/App.tsx', content: 'export function App() { … }' },
    result: 'File created successfully at: src/App.tsx',
    isError: false,
  },
  argTypes: { input: { control: 'object' } },
} satisfies Meta<typeof ToolCard>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const ToolRun: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="max-w-xl">
      <ToolCard
        name="Read"
        input={{ file_path: 'src/renderer/src/theme.tsx' }}
        result="import { createContext } from 'react'\n…156 lines"
      />
      <ToolCard
        name="Bash"
        input={{ command: 'npm run typecheck' }}
        liveOutput="> koda@0.1.9 typecheck\n> tsc --noEmit\nchecking…"
      />
      <ToolCard name="Grep" input={{ pattern: 'window.koda', path: 'src/renderer' }} />
      <ToolCard
        name="Edit"
        input={{ file_path: 'src/main/index.ts', old_string: 'a', new_string: 'b' }}
        result="String not found in file."
        isError
      />
    </div>
  ),
}
