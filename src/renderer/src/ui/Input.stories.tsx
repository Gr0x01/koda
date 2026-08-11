import type { Meta, StoryObj } from '@storybook/react-vite'
import { Field, Input } from './Input'

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { placeholder: 'sk-ant-…', mono: true, disabled: false },
  argTypes: { placeholder: { control: 'text' } },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {
  render: (args) => (
    <div className="max-w-sm">
      <Input {...args} />
    </div>
  ),
}

export const InAField: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex max-w-sm flex-col gap-6">
      <Field
        label="API key"
        description="Stored in the macOS Keychain, only used when you switch billing."
        htmlFor="sb-key"
      >
        <Input id="sb-key" placeholder="sk-ant-…" />
      </Field>
      <Field label="Project name" htmlFor="sb-name">
        <Input id="sb-name" mono={false} placeholder="My fitness tracker" />
      </Field>
      <Field label="Relay URL" error="That doesn't look like a URL." htmlFor="sb-url">
        <Input id="sb-url" defaultValue="not a url" />
      </Field>
    </div>
  ),
}
