import type { Meta, StoryObj } from '@storybook/react-vite'
import { QrCode } from './QrCode'

const meta = {
  title: 'Settings/QrCode',
  component: QrCode,
  args: {
    value: 'koda-pair://relay.koda.app/pair?token=b7f1c9a2-4e3d-4c8a-9f21-6a5d0e8c1b4f&host=Rashaads-MacBook-Pro',
    size: 220,
  },
  argTypes: {
    value: { control: 'text' },
    size: { control: { type: 'range', min: 120, max: 320, step: 10 } },
  },
} satisfies Meta<typeof QrCode>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const Small: Story = {
  args: { size: 140 },
}
