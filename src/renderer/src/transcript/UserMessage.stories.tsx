import type { Meta, StoryObj } from '@storybook/react-vite'
import { UserMessage } from './UserMessage'

// Valid image attachments without binary fixtures: solid-color SVG tiles encoded at module load.
const tile = (fill: string) =>
  btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="${fill}"/></svg>`)

const meta = {
  title: 'Transcript/UserMessage',
  component: UserMessage,
  args: { text: 'Add a dark mode toggle to the settings page.' },
  argTypes: { text: { control: 'text' } },
} satisfies Meta<typeof UserMessage>

export default meta
type Story = StoryObj<typeof meta>

export const TextOnly: Story = {}

export const WithAttachments: Story = {
  parameters: { controls: { disable: true } },
  args: {
    text: 'Here is the screenshot and the export — make the chart look like this.',
    images: [
      { mediaType: 'image/svg+xml', dataBase64: tile('#2549a8') },
      { mediaType: 'image/svg+xml', dataBase64: tile('#8a7d5c') },
    ],
    files: ['expenses-2026.csv', 'plan.pdf'],
  },
}

export const ImagesOnly: Story = {
  parameters: { controls: { disable: true } },
  args: {
    text: '',
    images: [
      { mediaType: 'image/svg+xml', dataBase64: tile('#2549a8') },
      { mediaType: 'image/svg+xml', dataBase64: tile('#5f5f67') },
    ],
  },
}
