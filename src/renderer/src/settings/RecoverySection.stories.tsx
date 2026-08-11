import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent, waitFor, within } from 'storybook/test'
import type { Checkpoint } from '@shared/ipc'
import { RecoverySection } from './RecoverySection'
import { ThemeProvider } from '../theme'
import { TextSizeProvider } from '../text-size'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

// Selecting a checkpoint auto-opens the file diff (Monaco, lazy-loaded) — its useTheme/useTextSize
// reads need the real providers wrapped around every story here, not just the ones that select one.
function withProviders(Story: React.ComponentType): React.ReactElement {
  return (
    <ThemeProvider>
      <TextSizeProvider>
        <div className="h-[640px] w-[1080px] overflow-hidden rounded-lg border border-border">
          <Story />
        </div>
      </TextSizeProvider>
    </ThemeProvider>
  )
}

const NOW = Math.floor(Date.now() / 1000)

const CHECKPOINTS: Checkpoint[] = [
  { id: 'a1b2c3d', label: 'Fix the login redirect loop', createdAt: NOW - 60 * 12, humanized: true, kind: 'moment' },
  { id: 'b2c3d4e', label: 'Add the pricing page', createdAt: NOW - 3600 * 3, humanized: true, kind: 'moment' },
  { id: 'c3d4e5f', label: 'before recovery', createdAt: NOW - 3600 * 5, kind: 'moment' },
  { id: 'd4e5f6a', label: 'Restyle the sidebar', createdAt: NOW - 86_400, humanized: true, kind: 'moment' },
]

const meta = {
  title: 'Settings/Recovery',
  component: RecoverySection,
  parameters: { controls: { disable: true } },
  decorators: [withProviders],
} satisfies Meta<typeof RecoverySection>

export default meta
type Story = StoryObj<typeof meta>

/** The timeline of save points, nothing selected yet. */
export const Timeline: Story = {
  decorators: [withBridgeFixtures({ listCheckpoints: CHECKPOINTS })],
}

/** A save point where nothing changed since — the working tree already matches it. */
export const NothingChanged: Story = {
  decorators: [
    withBridgeFixtures({
      listCheckpoints: CHECKPOINTS,
      checkpointChanges: { files: [], truncated: false },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Fix the login redirect loop'))
    await waitFor(() => canvas.getByText('Nothing changed since this point. It matches your project now.'))
  },
}

/** Selecting a point shows what going back would undo — a changed-file list, and its first file's
 *  real before→after diff (Monaco). NOTE for browser verification: `monaco-editor` isn't in
 *  `.storybook/main.ts`'s `optimizeDeps.include`, so this is the one story likely to hit the
 *  documented "a dep discovered mid-session re-optimizes and throws a one-off Invalid hook call" —
 *  check this one first, and add it to optimizeDeps if so. */
export const ChangesWithDiff: Story = {
  decorators: [
    withBridgeFixtures({
      listCheckpoints: CHECKPOINTS,
      checkpointChanges: {
        files: [
          { path: 'src/renderer/src/workspace/Sidebar.tsx', status: 'modified', additions: 18, deletions: 6, binary: false },
          { path: 'src/renderer/src/settings/RecoverySection.tsx', status: 'added', additions: 40, deletions: 0, binary: false },
        ],
        truncated: false,
      },
      checkpointFileDiff: {
        before: "export function Sidebar() {\n  return <nav>old</nav>\n}\n",
        after: "export function Sidebar() {\n  return <nav className=\"border-r\">new</nav>\n}\n",
        binary: false,
        truncated: false,
      },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Restyle the sidebar'))
    await waitFor(() => canvas.getByText("Changes you'd undo · 2"))
  },
}
