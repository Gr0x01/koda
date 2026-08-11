import type { Meta, StoryObj } from '@storybook/react-vite'
import type { UpdateStatus, WhatsNew } from '@shared/ipc'
import { UpdateSurface } from './UpdateSurface'

/** UpdateSurface reads its state once on mount (getUpdateStatus/getWhatsNew) — seed the window bridge
 *  fixture map per story. Both surfaces are `fixed`-positioned (bottom-center banner, bottom-right
 *  toast) — mounted plain, like the app mounts them once at the window root. */
function withUpdateFixtures(status: UpdateStatus, whatsNew: WhatsNew = null) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      getUpdateStatus: status,
      getWhatsNew: whatsNew,
    }
    return <Story />
  }
}

const meta = {
  title: 'Workspace/UpdateSurface',
  component: UpdateSurface,
  parameters: { controls: { disable: true } },
  decorators: [(Story) => <div className="relative h-[420px] w-full"><Story /></div>],
} satisfies Meta<typeof UpdateSurface>

export default meta
type Story = StoryObj<typeof meta>

/** Nothing to show — no console errors, no surfaces mounted. */
export const NoUpdate: Story = {
  decorators: [withUpdateFixtures({ state: 'idle' })],
}

/** A build finished downloading — the passive "restart to update" banner, never forced. */
export const ReadyToInstall: Story = {
  decorators: [withUpdateFixtures({ state: 'ready', version: '0.1.10' })],
}

/** The first window after an update — a one-time "What's New" toast read from the bundled changelog. */
export const WhatsNewToast: Story = {
  decorators: [
    withUpdateFixtures({ state: 'idle' }, {
      version: '0.1.9',
      markdown:
        '### Documents that finally feel like documents\n\nWide blocks, live links, and an outline rail — the doc surface reads like a real editor now, not a text box.\n\n### Mac-native basics\n\nQuit-and-reopen remembers where you left off, and the app behaves like other Mac apps should.',
    }),
  ],
}

/** Both surfaces can be live at once — a downloaded build waiting to install, and the toast from the
 *  update that just landed. */
export const BannerAndToast: Story = {
  decorators: [
    withUpdateFixtures({ state: 'ready', version: '0.1.10' }, { version: '0.1.9', markdown: 'Small fixes and polish.' }),
  ],
}
