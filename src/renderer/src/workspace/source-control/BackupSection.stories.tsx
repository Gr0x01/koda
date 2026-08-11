import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { GitSyncState } from '@shared/ipc'
import { BackupSection } from './BackupSection'
import { useWorkspace, type SessionState } from '../store'

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: '/Users/rb/koda-demo',
    items: [],
    streaming: '',
    busy: false,
    errored: false,
    draft: '',
    attachments: [],
    live: true,
    attention: false,
    approvalMode: 'auto',
    engineId: 'claude',
    spendUsd: 0,
    byModel: {},
    ...overrides,
  }
}

function withSession(hasSession: boolean, busy = false) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      activeId: hasSession ? 's-1' : null,
      sessions: busy ? { 's-1': baseSession({ id: 's-1', label: 'Fix the login flow', busy: true }) } : {},
    })
    return (
      <div className="w-[320px] rounded-lg border border-border bg-bg">
        <Story />
      </div>
    )
  }
}

const NO_REMOTE: GitSyncState = {
  hasRemote: false,
  remoteName: null,
  remoteUrl: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamTip: null,
  verified: false,
}

const meta = {
  title: 'Source Control/BackupSection',
  component: BackupSection,
  args: { onPushed: () => {}, onRecheck: () => {}, onLeave: () => {} },
  decorators: [withSession(true)],
} satisfies Meta<typeof BackupSection>

export default meta
type Story = StoryObj<typeof meta>

export const NoRemote: Story = { args: { sync: NO_REMOTE } }

export const NoRemoteNoSession: Story = {
  args: { sync: NO_REMOTE },
  decorators: [withSession(false)],
}

export const NoRemoteAgentBusy: Story = {
  args: { sync: NO_REMOTE },
  decorators: [withSession(true, true)],
}

export const VersionsToPush: Story = {
  args: {
    sync: {
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'git@github.com:rb/koda-demo.git',
      upstream: 'origin/main',
      ahead: 3,
      behind: 0,
      upstreamTip: 'a1b2c3d',
      verified: true,
    },
  },
}

export const VersionsToPushUnverified: Story = {
  args: {
    sync: {
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'git@github.com:rb/koda-demo.git',
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      upstreamTip: null,
      verified: false,
    },
  },
}

export const OnGitHub: Story = {
  args: {
    sync: {
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'git@github.com:rb/koda-demo.git',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      upstreamTip: 'a1b2c3d',
      verified: true,
    },
  },
}

export const BehindRemote: Story = {
  args: {
    sync: {
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'git@github.com:rb/koda-demo.git',
      upstream: 'origin/main',
      ahead: 0,
      behind: 2,
      upstreamTip: 'a1b2c3d',
      verified: true,
    },
  },
}

export const CouldNotConfirm: Story = {
  args: {
    sync: {
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'git@github.com:rb/koda-demo.git',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      upstreamTip: null,
      verified: false,
    },
  },
}

export const PushFailed: Story = {
  args: {
    sync: {
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'git@github.com:rb/koda-demo.git',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      upstreamTip: null,
      verified: true,
    },
  },
  decorators: [
    (Story) => {
      ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
        gitPush: { ok: false, code: 'push_auth', message: 'auth refused' },
      }
      return <Story />
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Push to GitHub'))
    await waitFor(() =>
      expect(canvas.getByText(/didn't accept this computer's credentials/)).toBeInTheDocument(),
    )
  },
}
