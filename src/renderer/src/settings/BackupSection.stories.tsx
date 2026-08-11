import { useEffect } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { BackupSection } from './BackupSection'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

function BackupListRetryBridge({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const base = window.koda
    let attempts = 0
    window.koda = new Proxy(base, {
      get: (target, prop) => {
        if (prop !== 'listCloudBackups') return Reflect.get(target, prop)
        return () => {
          attempts += 1
          return attempts === 1
            ? Promise.reject(new Error('Could not reach the backup server'))
            : Promise.resolve([
                {
                  schemaVersion: 1 as const,
                  projectHash: 'a1b2c3d4e5f60718',
                  projectName: 'koda',
                  lastBackupAt: NOW - 1000 * 60 * 12,
                  sizeBytes: 84_500_000,
                },
              ])
        }
      },
    })
    return () => {
      window.koda = base
    }
  }, [])
  return children
}

function withBackupListRetry(Story: React.ComponentType): React.ReactElement {
  return (
    <BackupListRetryBridge>
      <Story />
    </BackupListRetryBridge>
  )
}

const NOW = Date.now()

const meta = {
  title: 'Settings/Backup',
  component: BackupSection,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof BackupSection>

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl">{children}</div>
}

/** Backed up a few minutes ago — the everyday state once signed in. */
export const BackedUp: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: {
        enabled: true,
        signedIn: true,
        state: 'idle',
        lastBackupAt: NOW - 1000 * 60 * 12,
        sizeBytes: 84_500_000,
      },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
}

/** A backup is running right now. */
export const BackingUp: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: { enabled: true, signedIn: true, state: 'backing-up', lastBackupAt: NOW - 86_400_000, sizeBytes: 60_000_000 },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
}

/** The last attempt failed — the status row surfaces the reason plainly. */
export const BackupFailed: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: {
        enabled: true,
        signedIn: true,
        state: 'error',
        error: 'Could not reach the backup server',
        lastBackupAt: NOW - 86_400_000 * 2,
        sizeBytes: 60_000_000,
      },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
}

/** The project is too big for the current backup ceiling. */
export const TooLarge: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: { enabled: true, signedIn: true, state: 'too-large', lastBackupAt: null, sizeBytes: null },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
}

/** Not signed into the Koda account yet — Back up now stays disabled with a pointer to Koda account. */
export const NotSignedIn: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: { enabled: true, signedIn: false, state: 'idle', lastBackupAt: null, sizeBytes: null },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
}

/** Revealing the recovery code — the one key to every backup, shown only on request. */
export const RecoveryCodeRevealed: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: { enabled: true, signedIn: true, state: 'idle', lastBackupAt: NOW - 1000 * 60 * 12, sizeBytes: 84_500_000 },
      getBackupRecoveryCode: { code: 'KODA-7F2A-91QX-3M0P', unreadable: false },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Reveal'))
    await waitFor(() => expect(canvas.getByText('KODA-7F2A-91QX-3M0P')).toBeInTheDocument())
  },
}

/** The Mac can't open its existing key (Keychain reset, corrupt file). The two halves of this state
 * are split across the two rows, never repeated: the status row (verbatim from the main process)
 * says new backups are paused and points at the recovery code, and Reveal says only what Reveal
 * knows — there's no code to show here. */
export const RecoveryKeyUnreadable: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: {
        enabled: true,
        signedIn: true,
        state: 'error',
        error:
          'This Mac can’t open its backup key. New backups are paused. Your saved recovery code still opens the backups already in the cloud, so make sure you have it somewhere safe.',
        lastBackupAt: NOW - 86_400_000,
        sizeBytes: 60_000_000,
      },
      getBackupRecoveryCode: { code: null, unreadable: true },
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Reveal'))
    await waitFor(() => expect(canvas.getByText(/there.s no code to show here/)).toBeInTheDocument())
  },
}

/** "Show backed-up projects" lists every project on the account, ready to restore into a fresh folder. */
export const RestoreList: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: { enabled: true, signedIn: true, state: 'idle', lastBackupAt: NOW - 1000 * 60 * 12, sizeBytes: 84_500_000 },
      listCloudBackups: [
        { schemaVersion: 1, projectHash: 'a1b2c3d4e5f60718', projectName: 'koda', lastBackupAt: NOW - 1000 * 60 * 12, sizeBytes: 84_500_000 },
        { schemaVersion: 1, projectHash: '9988776655443322', projectName: 'peerpush', lastBackupAt: NOW - 86_400_000 * 3, sizeBytes: 12_100_000 },
      ],
    }),
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Show backed-up projects'))
    await waitFor(() => expect(canvas.getByText('peerpush')).toBeInTheDocument())
  },
}

/** A failed cloud read is not an empty account. The user sees the failure and can retry in place. */
export const RestoreListFailed: Story = {
  decorators: [
    withBridgeFixtures({
      getBackupStatus: { enabled: true, signedIn: true, state: 'idle', lastBackupAt: NOW - 1000 * 60 * 12, sizeBytes: 84_500_000 },
    }),
    withBackupListRetry,
  ],
  render: () => (
    <Frame>
      <BackupSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Show backed-up projects'))
    await waitFor(() => expect(canvas.getByText(/couldn.t load your backed-up projects/i)).toBeInTheDocument())
    expect(canvas.queryByText('No backups on this account yet.')).not.toBeInTheDocument()
    await userEvent.click(canvas.getByText('Try again'))
    await waitFor(() => expect(canvas.getByText('koda')).toBeInTheDocument())
    expect(canvas.queryByText(/couldn.t load your backed-up projects/i)).not.toBeInTheDocument()
  },
}
