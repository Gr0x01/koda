import type { Meta, StoryObj } from '@storybook/react-vite'
import { AssistantMarkdown } from './AssistantMarkdown'

const SAMPLE = `Done — the toggle is live in **Settings → Appearance**.

What changed:

- A new \`ThemeToggle\` in the appearance section
- Your choice is remembered between launches
- \`System\` follows your Mac's appearance automatically

| Mode | What you see |
| --- | --- |
| Light | Warm paper canvas |
| Dark | Ink surface |

The wiring, if you're curious:

\`\`\`tsx
const { preference, setPreference } = useTheme()
setPreference('dark')
\`\`\`

Try it and tell me if the dark contrast feels right.`

const meta = {
  title: 'Transcript/AssistantMarkdown',
  component: AssistantMarkdown,
  args: { markdown: SAMPLE },
  argTypes: { markdown: { control: 'text' } },
} satisfies Meta<typeof AssistantMarkdown>

export default meta
type Story = StoryObj<typeof meta>

export const Prose: Story = {
  render: (args) => (
    <div className="max-w-xl">
      <AssistantMarkdown {...args} />
    </div>
  ),
}
