import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { OnboardingWizard } from './OnboardingWizard'

/**
 * The wizard's step is internal `useState` — reached only by clicking Continue, gated on the sign-in
 * step's `signedIn`. Every story below drives it forward with `play`, seeding the bridge fixtures each
 * step's hooks read on mount. Push-only events (`onAuthProgress`, `onRuntimeProgress`, …) are no-ops in
 * the baseline mock, so states that only arrive via a push (awaiting-code, installing…) wrap
 * `window.koda` in a local Proxy that invokes the listener on subscribe — same pattern ModelControl.stories
 * uses for per-arg fixtures. The delivery is deferred a macrotask (`setTimeout(…, 0)`), not synchronous:
 * SignInStep's effect ALSO kicks off `detectAuth()` (a microtask) in the same mount, and when a live event
 * writes the same `claude` state, firing synchronously landed BEFORE detectAuth's `.then()` resolved,
 * so detectAuth's own state write clobbered it right back. Deferring past the microtask queue guarantees
 * the push always lands last, like a real later event would.
 */
function withOnboardingFixtures(
  fixtures: Record<string, unknown>,
  liveEvents: Record<string, unknown> = {},
) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    ;(window as unknown as { __kodaBridgeFixtures: Record<string, unknown> }).__kodaBridgeFixtures = {
      getSettings: { telemetryEnabled: true },
      getCodexAuthStatus: { signedIn: false, authMethod: null, requiresOpenaiAuth: true },
      playwrightStatus: { state: 'not-installed', enabled: false },
      ...fixtures,
    }
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => unknown>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => {
        if (prop in liveEvents) {
          return (listener: (e: unknown) => void) => {
            setTimeout(() => listener(liveEvents[prop]), 0)
            return () => {}
          }
        }
        return target[prop]
      },
    }) as unknown as typeof window.koda
    return <Story />
  }
}

/** getRuntimeStatus is called once per runtime id ('node' | 'python') — the global fixture map can't
 *  tell them apart (it's keyed by method name only), so this inspects the call argument directly. */
function withRuntimeStatuses(byId: Record<string, unknown>) {
  return function decorate(Story: React.ComponentType): React.ReactElement {
    const base = window.koda as unknown as Record<string, (...args: unknown[]) => unknown>
    window.koda = new Proxy(base, {
      get: (target, prop: string) => {
        if (prop === 'getRuntimeStatus') return (id: string) => Promise.resolve(byId[id])
        return target[prop]
      },
    }) as unknown as typeof window.koda
    return <Story />
  }
}

/** Click Continue/Get started, waiting for it to be enabled first (the sign-in step's Continue starts
 *  disabled until its async `detectAuth` check resolves). Callers wait for the NEXT step's own heading
 *  to appear before calling this again — under the wizard's `AnimatePresence mode="wait"`, the outgoing
 *  step only unmounts once its exit animation finishes, so re-querying "Continue" too early can still
 *  find the OLD (exiting but not-yet-unmounted) button and double-advance. */
async function clickContinue(canvas: ReturnType<typeof within>): Promise<void> {
  const btn = await waitFor(() => {
    const b = canvas.getByRole('button', { name: /Continue|Get started/ })
    expect(b).toBeEnabled()
    return b
  })
  await userEvent.click(btn)
}

const meta = {
  title: 'Onboarding/OnboardingWizard',
  component: OnboardingWizard,
  args: { onDone: () => {} },
  parameters: { controls: { disable: true } },
  decorators: [(Story) => <div className="relative h-[560px] w-full overflow-hidden rounded-xl border border-border"><Story /></div>],
} satisfies Meta<typeof OnboardingWizard>

export default meta
type Story = StoryObj<typeof meta>

/** Step 1 of 4 — the app intro, no bridge calls yet. */
export const Welcome: Story = {}

/** Step 2 — neither engine connected yet; Continue stays disabled until one signs in. */
export const SignInIdle: Story = {
  decorators: [
    withOnboardingFixtures({
      detectAuth: { ok: true, verdict: { mode: 'logged-out', apiKeyTrap: false, email: null, plan: null, detail: '' } },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(canvas.getByText('Connect your AI')).toBeInTheDocument())
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Continue' })).toBeDisabled())
  },
}

/** A completed browser flow whose verification probe failed stays unconfirmed and retryable. */
export const CodexVerificationFailed: Story = {
  decorators: [
    withOnboardingFixtures(
      {
        detectAuth: { ok: true, verdict: { mode: 'logged-out', apiKeyTrap: false, email: null, plan: null, detail: '' } },
      },
      {
        onCodexLoginProgress: {
          state: 'completed',
          status: { signedIn: false, authMethod: null, requiresOpenaiAuth: null, probeFailed: true },
        },
      },
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(canvas.getByText('Could not verify ChatGPT sign-in.')).toBeInTheDocument())
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Check again' })).toBeVisible())
    await expect(canvas.getByRole('button', { name: 'Continue' })).toBeDisabled()
  },
}

/** Claude's OAuth flow paused on the code-paste step (browser opened, waiting for the pasted code). */
export const SignInAwaitingCode: Story = {
  decorators: [
    withOnboardingFixtures(
      {
        detectAuth: { ok: true, verdict: { mode: 'logged-out', apiKeyTrap: false, email: null, plan: null, detail: '' } },
      },
      { onAuthProgress: { state: 'awaiting-code', url: 'https://claude.ai/oauth/authorize?code=…' } },
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(canvas.getByPlaceholderText('Paste the code')).toBeInTheDocument())
  },
}

/** Already signed in (adaptive ✓) — Continue unlocks with no action needed. */
export const SignInConnected: Story = {
  decorators: [
    withOnboardingFixtures({
      detectAuth: {
        ok: true,
        verdict: { mode: 'subscription', apiKeyTrap: false, email: 'rb@kodahq.io', plan: 'max', detail: '' },
      },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(canvas.getByText("You're connected")).toBeInTheDocument())
    // The child SignInStep lifts `ready` up to the parent's `signedIn` (and its `blocked`/disabled
    // computation) through its own effect — a render cycle behind the "You're connected" text itself.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Continue' })).toBeEnabled())
  },
}

/** A stray env API key is shadowing the subscription — the wizard flags it so the user knows Koda
 *  ignores it and bills the plan, not the key. */
export const SignInApiKeyTrap: Story = {
  decorators: [
    withOnboardingFixtures({
      detectAuth: {
        ok: true,
        verdict: {
          mode: 'subscription',
          apiKeyTrap: true,
          email: 'rb@kodahq.io',
          plan: 'pro',
          detail: 'An ANTHROPIC_API_KEY is set in your shell environment.',
        },
      },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(canvas.getByText(/Heads up:/)).toBeInTheDocument())
  },
}

/** Step 3 — the local toolkit: Node already on the system, Python not yet set up, browser testing off. */
export const Toolkit: Story = {
  decorators: [
    withOnboardingFixtures({
      detectAuth: {
        ok: true,
        verdict: { mode: 'subscription', apiKeyTrap: false, email: 'rb@kodahq.io', plan: 'max', detail: '' },
      },
    }),
    withRuntimeStatuses({
      node: { id: 'node', state: 'system', installedVersion: null, pinnedVersion: '22.11.0' },
      python: { id: 'python', state: 'not_installed', installedVersion: null, pinnedVersion: '3.12.7' },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await clickContinue(canvas) // Welcome -> Sign in (already connected, unlocked)
    await waitFor(() => expect(canvas.getByText("You're connected")).toBeInTheDocument())
    await clickContinue(canvas) // Sign in -> Toolkit
    await waitFor(() => expect(canvas.getByText('Set up your toolkit')).toBeInTheDocument())
    // "Already on your Mac" only lands once RuntimeCapability's own getRuntimeStatus('node') resolves —
    // an async tick after the step's static heading mounts.
    await waitFor(() => expect(canvas.getByText('Already on your Mac')).toBeInTheDocument())
  },
}

/** Python downloading mid-install, browser testing toggled on and downloading too — the twinkle
 *  progress line + the toggle's on state. */
export const ToolkitInstalling: Story = {
  decorators: [
    withOnboardingFixtures(
      {
        detectAuth: {
          ok: true,
          verdict: { mode: 'subscription', apiKeyTrap: false, email: 'rb@kodahq.io', plan: 'max', detail: '' },
        },
        playwrightStatus: { state: 'installing', enabled: true, message: 'Downloading Chromium…' },
      },
      { onRuntimeProgress: { runtime: 'python', phase: 'download', message: 'Downloading Python 3.12…', progress: 0.42 } },
    ),
    withRuntimeStatuses({
      node: { id: 'node', state: 'system', installedVersion: null, pinnedVersion: '22.11.0' },
      python: { id: 'python', state: 'not_installed', installedVersion: null, pinnedVersion: '3.12.7' },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await clickContinue(canvas) // Welcome -> Sign in
    await waitFor(() => expect(canvas.getByText("You're connected")).toBeInTheDocument())
    await clickContinue(canvas) // Sign in -> Toolkit
    await waitFor(() => expect(canvas.getByText('Downloading Python 3.12…')).toBeInTheDocument())
  },
}

/** Step 4 — the safety explainer + the presented usage-sharing consent toggle (defaults to what
 *  getSettings reports, so re-running onboarding after opting out doesn't flip it back on). */
export const Teach: Story = {
  decorators: [
    withOnboardingFixtures({
      detectAuth: {
        ok: true,
        verdict: { mode: 'subscription', apiKeyTrap: false, email: 'rb@kodahq.io', plan: 'max', detail: '' },
      },
      getSettings: { telemetryEnabled: true },
    }),
    withRuntimeStatuses({
      node: { id: 'node', state: 'system', installedVersion: null, pinnedVersion: '22.11.0' },
      python: { id: 'python', state: 'system', installedVersion: null, pinnedVersion: '3.12.7' },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await clickContinue(canvas) // Welcome -> Sign in
    await waitFor(() => expect(canvas.getByText("You're connected")).toBeInTheDocument())
    await clickContinue(canvas) // Sign in -> Toolkit
    await waitFor(() => expect(canvas.getByText('Set up your toolkit')).toBeInTheDocument())
    await clickContinue(canvas) // Toolkit -> Teach
    await waitFor(() => expect(canvas.getByText('How Koda keeps you safe')).toBeInTheDocument())
    await expect(canvas.getByRole('button', { name: 'Get started' })).toBeInTheDocument()
  },
}
