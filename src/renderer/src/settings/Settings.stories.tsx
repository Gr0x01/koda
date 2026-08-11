import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Settings } from './Settings'
import { useWorkspace } from '../workspace/store'
import { ThemeProvider } from '../theme'
import { TextSizeProvider } from '../text-size'

/** The shell composes nearly every settings section behind its nav, so its bridge fixtures cover the
 *  handful of on-mount calls the DEFAULT-landing section (General) and the shell itself make. Clicking
 *  into another category exercises that section's own real bridge calls (unfixtured ones just resolve
 *  `undefined` via the baseline mock, same as any other unfixtured story). */
function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

function withStoreState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      settingsSection: null,
      memoryWeight: null,
      projectPath: '/Users/rb/Documents/coding_projects/koda',
      sidebarWidth: 260,
      ...partial,
    })
    return <Story />
  }
}

const GENERAL_SETTINGS = {
  notificationsEnabled: true,
  usageResetNotify: true,
  providerStatusNotify: true,
  imageDetail: 'balanced',
  scratchRetentionDays: 7,
  assistEnabled: true,
  telemetryEnabled: true,
  previewAutoStart: true,
  archiveRetentionDays: 0,
}

function withProviders(Story: React.ComponentType): React.ReactElement {
  return (
    <ThemeProvider>
      <TextSizeProvider>
        <div className="h-[720px] w-[980px] overflow-hidden rounded-lg border border-border">
          <Story />
        </div>
      </TextSizeProvider>
    </ThemeProvider>
  )
}

const meta = {
  title: 'Settings/Settings',
  component: Settings,
  decorators: [
    withBridgeFixtures({ getSettings: GENERAL_SETTINGS, getBackupStatus: { enabled: false, signedIn: false, state: 'idle', lastBackupAt: null, sizeBytes: null } }),
    withStoreState({}),
    withProviders,
  ],
} satisfies Meta<typeof Settings>

export default meta
type Story = StoryObj<typeof meta>

/** Lands on General — the grouped nav, the resizable category rail, and the reading column. Backup is
 *  dogfood-flagged off here, so its nav row is absent (real behavior). */
export const Default: Story = {}

/** Deep-linked to Memory with the project's notes grown heavy — the amber warning glyph rides the nav
 *  row (the same cue the status-bar pill uses) as well as the section content. */
export const MemoryHeavyWarning: Story = {
  decorators: [
    withBridgeFixtures({
      getSettings: GENERAL_SETTINGS,
      getBackupStatus: { enabled: false, signedIn: false, state: 'idle', lastBackupAt: null, sizeBytes: null },
      getMemoryWeight: { present: true, chars: 42_000, heavy: true },
    }),
    withStoreState({ settingsSection: 'memory', memoryWeight: { present: true, chars: 42_000, heavy: true } }),
  ],
}

/** Backup is dogfood-flagged on — its nav row appears under History & recovery, deep-linked open. */
export const BackupEnabled: Story = {
  decorators: [
    withBridgeFixtures({
      getSettings: GENERAL_SETTINGS,
      getBackupStatus: { enabled: true, signedIn: true, state: 'idle', lastBackupAt: Date.now() - 1000 * 60 * 12, sizeBytes: 84_500_000 },
    }),
    withStoreState({ settingsSection: 'backup' }),
  ],
}

/** Clicking a nav row switches the reading column to that category — proves the shell's own routing,
 *  not just a single section's render. */
export const NavigateToAppearance: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Appearance'))
    await waitFor(() => expect(canvas.getByText('Reading text size')).toBeInTheDocument())
  },
}
