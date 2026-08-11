import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import type { BillingState, CodexAuthStatus, RateLimitInfo, UsageHistoryDay } from '@shared/ipc'
import { ProvidersSection } from './ProvidersSection'
import { useWorkspace } from '../workspace/store'

function withBridgeFixtures(fixtures: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as any).__kodaBridgeFixtures = fixtures
    return <Story />
  }
}

/** Cross-engine rate-limit windows read straight off the workspace store (the same field the
 *  status-bar footer reads), so a Providers story is a store-seeded composite too. */
function withRateLimits(rateLimits: Record<string, Record<string, RateLimitInfo>>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    useWorkspace.setState({ rateLimits })
    return <Story />
  }
}

function billing(overrides: Partial<BillingState>): BillingState {
  return {
    mode: 'subscription',
    hasKey: false,
    apiActive: false,
    verdict: { mode: 'subscription', apiKeyTrap: false, email: 'rb@koda.dev', plan: 'max', detail: 'Signed in via ~/.claude' },
    hasCodexKey: false,
    codexMode: 'subscription',
    codexApiActive: false,
    ...overrides,
  }
}

const HISTORY: UsageHistoryDay[] = [
  {
    date: new Date().toISOString().slice(0, 10),
    costUsd: 4.12,
    inputTokens: 210_000,
    outputTokens: 38_000,
    cacheReadTokens: 1_800_000,
    cacheCreationTokens: 90_000,
    turns: 22,
    byModel: { 'claude-sonnet-4-6': { costUsd: 4.12, inputTokens: 210_000, outputTokens: 38_000, cacheReadTokens: 1_800_000, cacheCreationTokens: 90_000 } },
    byEngine: { claude: 4.12 },
  },
  {
    date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    costUsd: 2.87,
    inputTokens: 140_000,
    outputTokens: 21_000,
    cacheReadTokens: 900_000,
    cacheCreationTokens: 40_000,
    turns: 14,
    byModel: { 'claude-sonnet-4-6': { costUsd: 2.87, inputTokens: 140_000, outputTokens: 21_000, cacheReadTokens: 900_000, cacheCreationTokens: 40_000 } },
    byEngine: { claude: 2.87 },
  },
]

const MULTI_ENGINE_HISTORY: UsageHistoryDay[] = [
  {
    date: new Date().toISOString().slice(0, 10),
    costUsd: 6.5,
    inputTokens: 300_000,
    outputTokens: 52_000,
    cacheReadTokens: 2_200_000,
    cacheCreationTokens: 110_000,
    turns: 31,
    byModel: {
      'claude-sonnet-4-6': { costUsd: 4.1, inputTokens: 210_000, outputTokens: 38_000, cacheReadTokens: 1_800_000, cacheCreationTokens: 90_000 },
      'gpt-5.2-codex': { costUsd: 2.4, inputTokens: 90_000, outputTokens: 14_000, cacheReadTokens: 400_000, cacheCreationTokens: 20_000 },
    },
    byEngine: { claude: 4.1, codex: 2.4 },
  },
]

const meta = {
  title: 'Settings/Providers',
  component: ProvidersSection,
  parameters: { controls: { disable: true } },
  decorators: [withRateLimits({ claude: { five_hour: { rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'allowed', usedPercent: 32 } } })],
} satisfies Meta<typeof ProvidersSection>

export default meta
type Story = StoryObj<typeof meta>

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl">{children}</div>
}

/** Signed into a Claude subscription, well under its 5-hour window; Codex not set up yet. */
export const ClaudeSubscribed: Story = {
  decorators: [
    withBridgeFixtures({
      getBillingState: billing({}),
      getUsageHistory: HISTORY,
      getCodexAuthStatus: { signedIn: false, authMethod: null, requiresOpenaiAuth: null } satisfies CodexAuthStatus,
      miniAppsBridgeInfo: [],
    }),
  ],
  render: () => (
    <Frame>
      <ProvidersSection />
    </Frame>
  ),
}

/** Billing switched to "Always" on a stored API key — the amber real-money warning + the stored-key row. */
export const ApiKeyAlwaysOn: Story = {
  decorators: [
    withBridgeFixtures({
      getBillingState: billing({ mode: 'api', hasKey: true, apiActive: true, verdict: { mode: 'api-key', apiKeyTrap: false, email: null, plan: null, detail: 'Billing the stored API key' } }),
      getUsageHistory: HISTORY,
      getCodexAuthStatus: { signedIn: false, authMethod: null, requiresOpenaiAuth: null } satisfies CodexAuthStatus,
      miniAppsBridgeInfo: [],
    }),
  ],
  render: () => (
    <Frame>
      <ProvidersSection />
    </Frame>
  ),
}

/** Both providers signed in — Claude on a Max plan, Codex on a ChatGPT plan — usage split by engine
 *  in the shared History card. Opens the OpenAI tab to show its account + usage. */
export const BothProvidersSignedIn: Story = {
  decorators: [
    withBridgeFixtures({
      getBillingState: billing({}),
      getUsageHistory: MULTI_ENGINE_HISTORY,
      getCodexAuthStatus: { signedIn: true, authMethod: 'chatgpt', requiresOpenaiAuth: false } satisfies CodexAuthStatus,
      miniAppsBridgeInfo: [
        { dir: '/Users/rb/Documents/coding_projects/koda-apps/habit-tracker', name: 'Habit Tracker', consent: true, spend: { inputTokens: 42_000, outputTokens: 8_100, usd: 0.34 } },
      ],
    }),
    withRateLimits({
      claude: { five_hour: { rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'allowed', usedPercent: 32 } },
      codex: { weekly: { rateLimitType: 'weekly', resetsAt: Math.floor(Date.now() / 1000) + 3600 * 40, status: 'warning', usedPercent: 81 } },
    }),
  ],
  render: () => (
    <Frame>
      <ProvidersSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('tab', { name: /OpenAI/ }))
    await waitFor(() => canvas.getByText('ChatGPT plan'))
  },
}

/** Nobody signed in anywhere — just the two sign-in cards, no usage history yet. */
export const NoneSignedIn: Story = {
  decorators: [
    withBridgeFixtures({
      getBillingState: billing({ verdict: { mode: 'logged-out', apiKeyTrap: false, email: null, plan: null, detail: 'Not signed in' } }),
      getUsageHistory: [],
      getCodexAuthStatus: { signedIn: false, authMethod: null, requiresOpenaiAuth: null } satisfies CodexAuthStatus,
      miniAppsBridgeInfo: [],
    }),
    withRateLimits({}),
  ],
  render: () => (
    <Frame>
      <ProvidersSection />
    </Frame>
  ),
}

/** The Codex process could not answer, so Settings stays honest instead of claiming the account is out. */
export const CodexCheckFailed: Story = {
  decorators: [
    withBridgeFixtures({
      getBillingState: billing({}),
      getUsageHistory: [],
      getCodexAuthStatus: {
        signedIn: false,
        authMethod: null,
        requiresOpenaiAuth: null,
        probeFailed: true,
      } satisfies CodexAuthStatus,
      miniAppsBridgeInfo: [],
    }),
  ],
  render: () => (
    <Frame>
      <ProvidersSection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByRole('tab', { name: /OpenAI Codex · check failed/ })).toBeVisible()
    await userEvent.click(canvas.getByRole('tab', { name: /OpenAI/ }))
    await expect(await canvas.findByRole('button', { name: 'Check again' })).toBeVisible()
    await expect(canvas.getByText(/Your account may still be connected/)).toBeVisible()
    await expect(canvas.queryByText(/Sign in with your ChatGPT plan/)).not.toBeInTheDocument()
  },
}
