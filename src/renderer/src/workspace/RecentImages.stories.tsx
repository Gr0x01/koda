import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ScratchImage } from '@shared/ipc'
import { RecentImages } from './RecentImages'
import { useWorkspace } from './store'

// A 1x1 black pixel — Storybook has no `.koda/scratch/` folder on disk, so every thumbnail is this
// same placeholder; the point is the strip's layout/expand behavior, not real screenshot content.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function image(name: string, agoMs: number): ScratchImage {
  return { name, relPath: `.koda/scratch/${name}`, mediaType: 'image/png', dataBase64: PIXEL, mtime: Date.now() - agoMs }
}

const IMAGES: ScratchImage[] = [
  image('before.png', 5 * 60_000),
  image('after.png', 4 * 60_000),
  image('error-state.png', 3 * 60_000),
  image('mobile-nav.png', 2 * 60_000),
  image('color-picker.png', 60_000),
]

function withScratchFixture(images: ScratchImage[]) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      listScratchImages: { images, total: images.length },
    }
    return <Story />
  }
}

/** Resets the strip's own store slice per story — mirrors StatusBar's withFooterState. */
function withRecentImagesState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ scratchTick: 0, recentImagesExpanded: false, activeId: 's-1', ...partial })
    return <Story />
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[320px] w-[280px] flex-col justify-end overflow-hidden rounded-lg border border-border bg-bg">{children}</div>
}

const meta = {
  title: 'Workspace/RecentImages',
  component: RecentImages,
  decorators: [withScratchFixture(IMAGES), withRecentImagesState({}), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof RecentImages>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed one-row peek — the resting state under the Files section, with an active session so
 *  hovering a thumb offers "+ add to message". */
export const Default: Story = {}

/** Expanded into its vertical grid, scrunching the Files section above it. */
export const Expanded: Story = {
  decorators: [withRecentImagesState({ recentImagesExpanded: true })],
}

/** No active session — the "+" quick-attach badge is hidden (there's nowhere to add the image to). */
export const NoActiveSession: Story = {
  decorators: [withRecentImagesState({ activeId: null })],
}

// No "Empty" state story: the component intentionally renders `null` when the project has no scratch
// images at all, so there's nothing to show — it's already covered implicitly by every OTHER
// component's story that doesn't seed listScratchImages (RecentImages just doesn't mount).
