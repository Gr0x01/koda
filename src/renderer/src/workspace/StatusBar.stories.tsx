import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RateLimitInfo } from '@shared/ipc'
import { AccountSignInBanner, BillingFallbackBanner, DataIntegrityBanner, StatusBar } from './StatusBar'
import { useWorkspace, type SessionState } from './store'

function baseSession(overrides: Partial<SessionState> & Pick<SessionState, 'id' | 'label'>): SessionState {
  return {
    userNamed: true,
    cwd: '/Users/rb/Documents/coding_projects/koda',
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

function window5h(usedPercent: number, status: string): RateLimitInfo {
  return { rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 * 2, status, usedPercent }
}

/** The footer chassis reads a wide slice of the workspace store — this resets it to a full baseline
 *  every render so switching between stories never leaks a previous one's billing/rate-limit/git
 *  state, then layers the story's own overrides on top. */
function withFooterState(partial: Partial<ReturnType<typeof useWorkspace.getState>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({
      sessions: {},
      activeId: null,
      rateLimits: {},
      providerDown: {},
      engineSignedOut: {},
      apiActive: false,
      memoryWeight: null,
      gitRepo: false,
      gitFiles: [],
      gitWorktreesDirty: false,
      billingFallbackPrompt: null,
      ...partial,
    })
    return <Story />
  }
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="w-[860px] overflow-hidden rounded-lg border border-border">{children}</div>
}

const meta = {
  title: 'Workspace/StatusBar',
  component: StatusBar,
  decorators: [withFooterState({ rateLimits: { claude: { five_hour: window5h(32, 'allowed') } } }), (Story) => <Frame><Story /></Frame>],
} satisfies Meta<typeof StatusBar>

export default meta
type Story = StoryObj<typeof meta>

/** Healthy subscription billing: the 5-hour window is well under its cap, a few unsaved edits show
 *  the Versions dot. */
export const Default: Story = {
  decorators: [
    withFooterState({
      rateLimits: { claude: { five_hour: window5h(32, 'allowed') } },
      gitRepo: true,
      gitFiles: [{ path: 'src/renderer/src/workspace/StatusBar.tsx', status: 'modified' }],
    }),
  ],
}

/** The 5-hour window is getting close — the gauge turns amber and the popout hedges the read since
 *  the stream doesn't give an exact threshold. */
export const RateLimitWarning: Story = {
  decorators: [withFooterState({ rateLimits: { claude: { five_hour: window5h(79, 'warning') } } })],
}

/** The plan limit was hit — rejected/blocked band, full red gauge. */
export const RateLimitReached: Story = {
  decorators: [withFooterState({ rateLimits: { claude: { five_hour: window5h(100, 'rejected') } } })],
}

/** The whole plan picture, which is what the account usage poll delivers (usage-poll.ts): the 5-hour
 *  window, the weekly cap, and the per-model weekly that a heavy Fable week runs into first. */
export const AllPlanWindows: Story = {
  decorators: [
    withFooterState({
      rateLimits: {
        claude: {
          five_hour: window5h(53, 'allowed'),
          seven_day: { rateLimitType: 'seven_day', resetsAt: Math.floor(Date.now() / 1000) + 3600 * 72, status: 'allowed', usedPercent: 37 },
          seven_day_fable: { rateLimitType: 'seven_day_fable', resetsAt: Math.floor(Date.now() / 1000) + 3600 * 72, status: 'warning', usedPercent: 82 },
        },
      },
    }),
  ],
}

/** Two engines with window data both earn a chip — a Claude session hit its cap while Codex is
 *  still fresh, so switching engines to keep working is visible right in the footer. */
export const MultiEngine: Story = {
  decorators: [
    withFooterState({
      rateLimits: {
        claude: { five_hour: window5h(96, 'rejected') },
        codex: { weekly: { rateLimitType: 'weekly', resetsAt: Math.floor(Date.now() / 1000) + 3600 * 40, status: 'allowed', usedPercent: 12 } },
      },
    }),
  ],
}

/** Billing has fallen back to the API key (an 'auto'-mode overflow, or API-only mode) — the center
 *  cluster swaps the plan gauges for a running-spend chip. */
export const ApiBillingActive: Story = {
  decorators: [
    withFooterState({
      apiActive: true,
      sessions: {
        's-1': baseSession({ id: 's-1', label: 'Fix the login flow', spendUsd: 8.42 }),
        's-2': baseSession({ id: 's-2', label: 'Rewrite the pricing page', spendUsd: 3.91 }),
      },
    }),
  ],
}

/** Anthropic reports a feed-confirmed incident — the honest severity word rides the engine's chip
 *  (subscription mode) inline, no separate outage banner. */
export const ProviderIncident: Story = {
  decorators: [
    withFooterState({
      rateLimits: { claude: { five_hour: window5h(41, 'allowed') } },
      providerDown: { claude: { kind: 'degraded', note: 'Elevated error rates reported by Anthropic' } },
    }),
  ],
}

/** Signed out of the engine the active session runs on — the chip becomes a "sign in" prompt instead
 *  of a usage gauge. */
export const SignedOut: Story = {
  decorators: [
    withFooterState({
      activeId: 's-1',
      sessions: { 's-1': baseSession({ id: 's-1', label: 'Fix the login flow', engineId: 'codex' }) },
      engineSignedOut: { codex: true },
    }),
  ],
}

/** The project's always-injected memory has grown heavy — a quiet amber pill next to Settings, the
 *  surface it opens. */
export const MemoryNeedsTidy: Story = {
  decorators: [
    withFooterState({
      rateLimits: { claude: { five_hour: window5h(18, 'allowed') } },
      memoryWeight: { present: true, chars: 42_000, heavy: true },
    }),
  ],
}

/** The plan limit was just hit in 'auto' billing mode — a one-time consent banner above the footer
 *  before spending real money on the API key. */
export const BillingFallback: Story = {
  render: () => <BillingFallbackBanner />,
  decorators: [withFooterState({ billingFallbackPrompt: { resetsAt: Math.floor(Date.now() / 1000) + 3600 * 3 } })],
}

// ── Data integrity ───────────────────────────────────────────────────────────
// Every state this banner can render, because the wording IS the feature: each one is a promise about
// the user's data, and the two situations (saving off vs saving on) must never read alike.
const integrity = (patch: Partial<ReturnType<typeof useWorkspace.getState>>) =>
  withFooterState({
    sessionsLoadFailed: false,
    archiveLoadFailed: false,
    sessionsBackupKept: null,
    archiveBackupKept: null,
    droppedSessions: 0,
    droppedArchives: 0,
    archiveWriteFailed: false,
    archiveRestoreFailed: false,
    ...patch,
  })

/** The saved-chat store couldn't be read at all, and the copy landed. Chat saving is off for the run. */
export const DataIntegritySessionsUnreadable: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ sessionsLoadFailed: true, sessionsBackupKept: true })],
}

/** Same failure, but the copy itself failed (ENOSPC, a read-only userData). The banner drops the
 *  promise instead of pointing the user at a recovery file that doesn't exist. */
export const DataIntegrityNoCopyKept: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ sessionsLoadFailed: true, sessionsBackupKept: false })],
}

/** Both stores unreadable: two lines, because the archive failure used to be silent behind the
 *  sessions one and "ask Koda to recover it" then meant a file the user was never told about. */
export const DataIntegrityBothUnreadable: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [
    integrity({
      sessionsLoadFailed: true,
      sessionsBackupKept: true,
      archiveLoadFailed: true,
      archiveBackupKept: true,
    }),
  ],
}

/** The likeliest case, and the one that shipped silent: the store read fine, one chat drifted out of
 *  schema and was set aside. Saving stays ON here, so the tone is different on purpose. */
export const DataIntegrityChatsSetAside: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ droppedSessions: 1 })],
}

/** The plural of the above, plus a drifted archive row alongside it. */
export const DataIntegrityManySetAside: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ droppedSessions: 3, droppedArchives: 2 })],
}

/** The action-triggered one: the archive index reads fine, but the write behind an archive / reopen /
 *  delete came back refused, so the move was declined and the chat is still in the sidebar. The wording
 *  has to lead with "nothing moved" — the user just clicked something and watched nothing happen. */
export const DataIntegrityArchiveWriteRefused: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ archiveWriteFailed: true })],
}

/** The refused write on top of a boot that already set a drifted archive row aside: two separate facts
 *  about the same file, and neither one may swallow the other. */
export const DataIntegrityArchiveWriteRefusedAfterDrop: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ droppedArchives: 1, archiveWriteFailed: true })],
}

/** The other action-triggered one: the list is fine, one archived chat's saved conversation could not be
 *  read, so Restore stopped instead of reopening it empty. Settings closes on that click either way, so
 *  this line is the whole of what the user gets told. */
export const DataIntegrityArchiveReopenFailed: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [integrity({ archiveRestoreFailed: true })],
}

/** The app-global one, fed by main rather than the workspace store: the settings file was unreadable and
 *  had recorded "bill through my API key", so billing quietly went back to the subscription. CLAUDE.md
 *  says a billing switch is never silent, which makes this line the mechanism rather than a courtesy. */
export const DataIntegrityBillingModeReset: Story = {
  render: () => <DataIntegrityBanner />,
  decorators: [
    integrity({}),
    (Story) => {
      ;(window as any).__kodaBridgeFixtures = {
        getDataIntegrity: { projectListUnreadable: false, projectListBackupKept: null, billingModeReset: true },
      }
      return <Story />
    },
  ],
}

/** The Mac's cloud sign-in is dead for good (revoked token family) — the workspace banner that
 *  replaces a day of silent background retries; Sign in jumps to Settings → Koda account. */
export const AccountSignIn: Story = {
  render: () => <AccountSignInBanner />,
  decorators: [
    withFooterState({}),
    (Story) => {
      ;(window as any).__kodaBridgeFixtures = {
        getRemoteAuth: { signedIn: false, email: null, userId: null, needsReSignin: true },
      }
      return <Story />
    },
  ],
}
