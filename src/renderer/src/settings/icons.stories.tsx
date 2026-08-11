import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  IconSliders,
  IconAppearance,
  IconShield,
  IconToolbox,
  IconRemote,
  IconBlocks,
  IconCode,
  IconRewind,
  IconInfo,
  IconChat,
  IconArchive,
  IconCloudLock,
  IconTrash,
  IconUser,
  IconChip,
  IconWarning,
  IconMemory,
  IconBook,
  IconPlug,
} from './icons'

// The full Settings nav + action icon set — inline stroke SVGs (currentColor), matches the rail set.
const meta = {
  title: 'Settings/Icons',
  parameters: { controls: { disable: true } },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const ICONS: { label: string; Icon: () => React.JSX.Element }[] = [
  { label: 'Sliders', Icon: IconSliders },
  { label: 'Appearance', Icon: IconAppearance },
  { label: 'Shield', Icon: IconShield },
  { label: 'Toolbox', Icon: IconToolbox },
  { label: 'Remote', Icon: IconRemote },
  { label: 'Blocks', Icon: IconBlocks },
  { label: 'Code', Icon: IconCode },
  { label: 'Rewind', Icon: IconRewind },
  { label: 'Info', Icon: IconInfo },
  { label: 'Chat', Icon: IconChat },
  { label: 'Archive', Icon: IconArchive },
  { label: 'CloudLock', Icon: IconCloudLock },
  { label: 'Trash', Icon: IconTrash },
  { label: 'User', Icon: IconUser },
  { label: 'Chip', Icon: IconChip },
  { label: 'Warning', Icon: IconWarning },
  { label: 'Memory', Icon: IconMemory },
  { label: 'Book', Icon: IconBook },
  { label: 'Plug', Icon: IconPlug },
]

export const AllIcons: Story = {
  render: () => (
    <div className="grid grid-cols-5 gap-4 text-text">
      {ICONS.map(({ label, Icon }) => (
        <div
          key={label}
          className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-3"
        >
          <Icon />
          <span className="text-[10px] text-text-muted">{label}</span>
        </div>
      ))}
    </div>
  ),
}
