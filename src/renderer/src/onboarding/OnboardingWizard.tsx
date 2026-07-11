import { useEffect, useState, type ReactNode } from 'react'
import type { RuntimeId } from '@shared/ipc'
import { useRuntime, useBrowserTesting } from '../workspace/useProvisioning'
import { AnimatePresence, fadeVariants, motion } from '../motion'
import { Button, PixelGlyph } from '../ui'

/**
 * First-run onboarding wizard (architecture/onboarding.md). A one-time linear flow, shown by App.tsx
 * when `hasOnboarded` is false, before the ProjectHome/workspace. On finish it persists
 * `hasOnboarded: true` and hands back to App (→ ProjectHome opens the first project).
 *
 * This is the MACHINE-onboarding half (welcome → connect-your-AI → local toolkit → safety). The
 * per-project intake ("what is this project for?") is a later step that hangs off ProjectHome. Sign-in
 * offers BOTH engines (Claude subscription OAuth via auth.ts, ChatGPT via codex login) and gates on at
 * least one; the toolkit step drives the Koda-managed runtimes.
 */
type StepId = 'welcome' | 'signin' | 'toolkit' | 'teach'

const STEPS: { id: StepId; skippable: boolean }[] = [
  { id: 'welcome', skippable: false },
  { id: 'signin', skippable: false },
  { id: 'toolkit', skippable: true },
  { id: 'teach', skippable: false },
]

export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  // An engine login is a hard precondition (no engine runs without one), so Continue is gated until at
  // least one provider (Claude or ChatGPT) is signed in — adaptive ✓ when one already is.
  const [signedIn, setSignedIn] = useState(false)
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const blocked = current.id === 'signin' && !signedIn

  const finish = (): void => {
    window.koda.updateSettings({ hasOnboarded: true }).catch(console.error)
    onDone()
  }
  const next = (): void => {
    if (blocked) return
    if (isLast) finish()
    else setStep((s) => s + 1)
  }
  const back = (): void => setStep((s) => Math.max(0, s - 1))

  return (
    <div className="relative flex h-screen w-screen flex-col items-center justify-center bg-bg px-6 text-text">
      {/* No Chassis title bar on the onboarding screen — add its top drag strip so the frameless
          window can still be moved (a full-screen drag region would block edge-resize on macOS). */}
      <div className="app-drag absolute inset-x-0 top-0 h-9" />
      <div className="flex w-full max-w-md flex-col">
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            className="rounded-2xl border border-border bg-surface p-8 shadow-soft"
          >
            {current.id === 'welcome' && <WelcomeStep />}
            {current.id === 'signin' && <SignInStep onSignedInChange={setSignedIn} />}
            {current.id === 'toolkit' && <ToolkitStep />}
            {current.id === 'teach' && <TeachStep />}
          </motion.div>
        </AnimatePresence>

        {/* Footer: back · dots · primary, with an optional skip for skippable steps. */}
        <div className="mt-6 flex items-center justify-between px-1">
          <div className="flex w-24">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={back}>
                ← Back
              </Button>
            )}
          </div>
          <div className="flex gap-1.5">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-4 bg-accent' : 'w-1.5 bg-border'
                }`}
              />
            ))}
          </div>
          <div className="flex w-24 items-center justify-end gap-3">
            {current.skippable && !isLast && (
              <Button variant="ghost" size="sm" onClick={() => setStep((s) => s + 1)}>
                Skip
              </Button>
            )}
            <Button size="lg" onClick={next} disabled={blocked} className="whitespace-nowrap">
              {isLast ? 'Get started' : 'Continue'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function WelcomeStep() {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent font-display text-xl font-semibold text-white shadow-soft">
        K
      </span>
      <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">Welcome to Koda</h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-muted">
        You tell an agent what you want, and it builds it on your Mac. Koda saves every step, so you
        can always go back.
      </p>
    </div>
  )
}

/**
 * The connect-your-AI step. Koda runs on either engine's plan, so both providers are offered and
 * Continue gates on AT LEAST ONE login (not Claude specifically). Claude drives `claude auth login`
 * (browser + paste-code); ChatGPT drives `codex login` (loopback callback — completes on its own).
 * Adaptive: an existing login shows ✓ with no action. No plan at all → the claude.ai sign-up link.
 */
type ClaudePhase =
  | { kind: 'checking' }
  | { kind: 'signed-in'; email: string | null; plan: string | null }
  | { kind: 'idle' } // logged out, ready to start
  | { kind: 'awaiting-code'; url: string }
  | { kind: 'verifying' }
  | { kind: 'error'; message: string }

type CodexPhase =
  | { kind: 'checking' }
  | { kind: 'signed-in' }
  | { kind: 'idle' }
  | { kind: 'in-flight'; url: string | null } // browser open (or about to); no code to paste
  | { kind: 'error'; message: string }

function SignInStep({ onSignedInChange }: { onSignedInChange: (v: boolean) => void }) {
  const [claude, setClaude] = useState<ClaudePhase>({ kind: 'checking' })
  const [codex, setCodex] = useState<CodexPhase>({ kind: 'checking' })
  const [code, setCode] = useState('')
  const [trap, setTrap] = useState<string | null>(null)

  // Detect both providers on mount (adaptive ✓), and subscribe to each login flow's progress.
  useEffect(() => {
    let alive = true
    window.koda
      .detectAuth()
      .then((r) => {
        if (!alive) return
        if (r.ok && r.verdict.mode !== 'logged-out') {
          setTrap(r.verdict.apiKeyTrap ? r.verdict.detail : null)
          setClaude({ kind: 'signed-in', email: r.verdict.email, plan: r.verdict.plan })
        } else {
          setClaude({ kind: 'idle' })
        }
      })
      .catch(() => alive && setClaude({ kind: 'idle' }))

    window.koda
      .getCodexAuthStatus()
      .then((s) => alive && setCodex(s.signedIn ? { kind: 'signed-in' } : { kind: 'idle' }))
      .catch(() => alive && setCodex({ kind: 'idle' }))

    const offClaude = window.koda.onAuthProgress((e) => {
      if (!alive) return
      switch (e.state) {
        case 'awaiting-code':
          setClaude({ kind: 'awaiting-code', url: e.url })
          break
        case 'verifying':
          setClaude({ kind: 'verifying' })
          break
        case 'completed':
          setClaude({
            kind: 'signed-in',
            email: e.verdict?.email ?? null,
            plan: e.verdict?.plan ?? null,
          })
          break
        case 'failed':
          setClaude({ kind: 'error', message: e.message })
          break
        case 'timeout':
          setClaude({ kind: 'error', message: 'Sign-in timed out. Try again.' })
          break
        case 'cancelled':
          setClaude({ kind: 'idle' })
          break
      }
    })
    const offCodex = window.koda.onCodexLoginProgress((e) => {
      if (!alive) return
      if (e.state === 'awaiting-browser') setCodex({ kind: 'in-flight', url: e.url })
      else if (e.state === 'verifying')
        setCodex((p) => (p.kind === 'in-flight' ? p : { kind: 'in-flight', url: null }))
      else if (e.state === 'completed') setCodex({ kind: 'signed-in' })
      else if (e.state === 'failed') setCodex({ kind: 'error', message: e.message })
      else setCodex({ kind: 'idle' }) // cancelled / timeout
    })
    return () => {
      alive = false
      offClaude()
      offCodex()
      // Don't leave a spawned login child blocked if the user backs out mid-flow. Both no-op when
      // nothing is in flight (already signed-in / idle).
      window.koda.cancelLogin().catch(() => {})
      window.koda.cancelCodexLogin().catch(() => {})
    }
  }, [])

  // At least one connected engine unlocks Continue.
  const ready = claude.kind === 'signed-in' || codex.kind === 'signed-in'
  useEffect(() => {
    onSignedInChange(ready)
  }, [ready, onSignedInChange])

  const startClaude = (): void => {
    setClaude({ kind: 'verifying' }) // brief "starting…" until awaiting-code arrives
    window.koda
      .startLogin()
      .catch(() => setClaude({ kind: 'error', message: 'Could not start sign-in.' }))
  }
  const submitCode = (): void => {
    const c = code.trim()
    if (!c) return
    window.koda.submitAuthCode(c).catch(() => {})
    setCode('')
    setClaude({ kind: 'verifying' })
  }
  const startCodex = (): void => {
    setCodex({ kind: 'in-flight', url: null })
    window.koda
      .startCodexLogin()
      .then((r) => {
        if (!r.ok) setCodex({ kind: 'error', message: r.reason ?? 'Could not start sign-in.' })
      })
      .catch(() => setCodex({ kind: 'error', message: 'Could not start sign-in.' }))
  }

  const claudeSub =
    claude.kind === 'checking'
      ? 'Checking…'
      : claude.kind === 'signed-in'
        ? [
            claude.email,
            claude.plan && `${claude.plan.charAt(0).toUpperCase()}${claude.plan.slice(1)} plan`,
          ]
            .filter(Boolean)
            .join(' · ') || 'Signed in'
        : claude.kind === 'verifying'
          ? 'Signing you in…'
          : claude.kind === 'awaiting-code'
            ? 'Approve in your browser, then paste the code below'
            : claude.kind === 'error'
              ? claude.message
              : 'Uses your Claude Pro or Max plan'

  const codexSub =
    codex.kind === 'checking'
      ? 'Checking…'
      : codex.kind === 'signed-in'
        ? 'Signed in with your ChatGPT plan'
        : codex.kind === 'in-flight'
          ? 'Approve in your browser'
          : codex.kind === 'error'
            ? codex.message
            : 'Uses your ChatGPT plan'

  return (
    <div className="flex flex-col">
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {ready ? "You're connected" : 'Connect your AI'}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        Koda is free to use. It runs on your Claude or ChatGPT plan, so sign in with one or both.
      </p>

      <div className="mt-5 flex flex-col gap-2.5">
        <CapabilityRow
          title="Claude"
          sub={claudeSub}
          ready={claude.kind === 'signed-in'}
          installing={claude.kind === 'verifying' || claude.kind === 'checking'}
          action={
            claude.kind === 'idle' || claude.kind === 'error' ? (
              <CapabilityButton onClick={startClaude}>
                {claude.kind === 'error' ? 'Try again' : 'Sign in'}
              </CapabilityButton>
            ) : null
          }
        >
          {claude.kind === 'awaiting-code' && (
            <div className="mt-3 flex flex-col gap-2 pl-8">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCode()}
                  placeholder="Paste the code"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
                <CapabilityButton onClick={submitCode}>Confirm</CapabilityButton>
              </div>
              <p className="break-all text-[11px] leading-relaxed text-text-muted">
                Browser didn't open? Visit this link:{' '}
                <span className="select-all font-mono">{claude.url}</span>
              </p>
            </div>
          )}
        </CapabilityRow>

        <CapabilityRow
          title="ChatGPT"
          sub={codexSub}
          ready={codex.kind === 'signed-in'}
          installing={codex.kind === 'in-flight' || codex.kind === 'checking'}
          action={
            codex.kind === 'idle' || codex.kind === 'error' ? (
              <CapabilityButton onClick={startCodex}>
                {codex.kind === 'error' ? 'Try again' : 'Sign in'}
              </CapabilityButton>
            ) : null
          }
        >
          {codex.kind === 'in-flight' && (
            <p className="mt-3 pl-8 text-xs leading-relaxed text-text-muted">
              A browser window opened. Approve there and this finishes on its own.{' '}
              {codex.url && (
                <a href={codex.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  Reopen the page
                </a>
              )}{' '}
              <button
                onClick={() => window.koda.cancelCodexLogin().catch(() => {})}
                className="text-text-muted underline transition-colors hover:text-text"
              >
                Cancel
              </button>
            </p>
          )}
        </CapabilityRow>
      </div>

      {claude.kind !== 'signed-in' && claude.kind !== 'checking' && (
        <p className="mt-4 text-xs leading-relaxed text-text-muted">
          New to Claude?{' '}
          <a href="https://claude.ai" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Create an account at claude.ai
          </a>
          , pick a plan, then come back and sign in.
        </p>
      )}

      {trap && (
        <p className="mt-4 rounded-xl border border-border bg-bg px-3 py-2 text-xs leading-relaxed text-text-muted">
          Heads up: {trap} Koda ignores it, so your turns bill your plan and not API rates.
        </p>
      )}
    </div>
  )
}

/**
 * The LOCAL toolkit step — how the user works on their Mac (cross-project, set up ~once). NOT the
 * project's own services (Supabase/Vercel) — those are wired by the agent inside a project. Reuses the
 * Koda-managed runtime + playwright capabilities (no terminal, no admin).
 */
function ToolkitStep() {
  return (
    <div className="flex flex-col">
      <h1 className="font-display text-xl font-semibold tracking-tight">Set up your toolkit</h1>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        Koda installs a few tools on your Mac for you, with no terminal. Anything a project needs
        later, like a database or hosting, gets connected inside the project.
      </p>
      <div className="mt-5 flex flex-col gap-2.5">
        <RuntimeCapability id="node" title="Building apps" idleSub="For apps that save data or run a server" />
        <RuntimeCapability id="python" title="Data & scripts" idleSub="For Python: data, automation & AI tools" />
        <BrowserTestingCapability />
      </div>
    </div>
  )
}

/** A provisionable runtime (Node / Python) — downloaded + verified on demand by main into a Koda dir.
 *  `system` means the user already has it (login-shell PATH), so we show ✓ and never offer to install. */
function RuntimeCapability({ id, title, idleSub }: { id: RuntimeId; title: string; idleSub: string }) {
  const { status, progress, ready, installing, error, install } = useRuntime(id)
  const sub = ready
    ? status?.state === 'system'
      ? 'Already on your Mac'
      : 'Ready'
    : installing
      ? (progress?.message ?? 'Setting up…')
      : error
        ? `Couldn't set up: ${error}`
        : idleSub

  return (
    <CapabilityRow
      title={title}
      sub={sub}
      ready={ready}
      installing={installing}
      action={
        !ready && !installing ? (
          <CapabilityButton onClick={install}>{error ? 'Try again' : 'Set up'}</CapabilityButton>
        ) : null
      }
    />
  )
}

/** Browser testing — the opt-in Playwright capability (Koda-managed download, system Chrome / bundled
 *  Chromium). A toggle: enabling kicks the background install. */
function BrowserTestingCapability() {
  const { pw, enabled, ready, installing, toggle } = useBrowserTesting()

  const sub = !enabled
    ? 'Let the agent click through real pages (~150 MB)'
    : installing
      ? (pw?.message ?? 'Downloading…')
      : ready
        ? 'Ready'
        : 'Enabled'

  return (
    <CapabilityRow
      title="Browser testing"
      sub={sub}
      ready={ready}
      installing={installing}
      action={<Toggle on={enabled} onClick={() => toggle(!enabled)} />}
    />
  )
}

function CapabilityRow({
  title,
  sub,
  ready,
  installing,
  action,
  children,
}: {
  title: string
  sub: string
  ready: boolean
  installing: boolean
  action: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-bg px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-5 w-5 flex-none items-center justify-center">
          {/* One glyph for all three states — idle dot → twinkle → check morph in place. */}
          {/* Idle takes the rounded dot in half-muted ink — the small 2×2 in the hairline tone read
              as a rendering artifact at row scale. */}
          <PixelGlyph
            glyph={ready || installing ? 'check' : 'dotRound'}
            loader={installing}
            size={14}
            className={ready || installing ? 'text-accent' : 'text-text-muted/50'}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-semibold leading-tight">{title}</div>
          <div className="truncate text-xs text-text-muted">{sub}</div>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function CapabilityButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="flex-none rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
    >
      {children}
    </button>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className={`relative h-5 w-9 flex-none rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
          on ? 'left-[1.125rem]' : 'left-0.5'
        }`}
      />
    </button>
  )
}

function TeachStep() {
  // Presented consent: usage sharing defaults ON, and main gates every send on hasOnboarded — so this
  // visible toggle is what the user walks past before anything can flow. Reads the real setting (a
  // re-run of onboarding after opting out must not show it back on); writes apply immediately, so
  // backing out of the wizard keeps whatever the user chose.
  const [shareUsage, setShareUsage] = useState<boolean | null>(null)
  useEffect(() => {
    window.koda.getSettings().then((s) => setShareUsage(s.telemetryEnabled)).catch(console.error)
  }, [])
  const toggleShareUsage = (): void => {
    const next = !(shareUsage ?? true)
    setShareUsage(next)
    window.koda.updateSettings({ telemetryEnabled: next }).catch(console.error)
  }

  const rows = [
    {
      title: 'Go back anytime',
      body: 'Koda saves your work before every change. Ask in plain words, like "go back to before the login page", and it rewinds.',
    },
    {
      title: 'Good habits, built in',
      body: 'The agent follows a careful engineer\'s rules from the start. You can read and change them in Settings.',
    },
    {
      title: 'Stays on your Mac',
      body: 'Your files stay on your Mac. We never sell your data and never look inside your files.',
    },
  ]
  return (
    <div className="flex flex-col">
      <h1 className="font-display text-xl font-semibold tracking-tight">How Koda keeps you safe</h1>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        These work in the background from day one. There is nothing to set up.
      </p>
      <div className="mt-4 flex flex-col">
        {rows.map((r) => (
          <div key={r.title} className="border-b border-border py-3">
            <div className="font-display text-sm font-semibold">{r.title}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-text-muted">{r.body}</div>
          </div>
        ))}
        <div className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-display text-sm font-semibold">Help improve Koda</div>
            <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
              Optional. Sends counts of which features get used and which errors happen, so we know
              what to fix next. The counts carry a random id and nothing you make, so we could not
              see your work even if we wanted to. Change it anytime in Settings.
            </div>
          </div>
          <Toggle on={shareUsage ?? true} onClick={toggleShareUsage} />
        </div>
      </div>
    </div>
  )
}
