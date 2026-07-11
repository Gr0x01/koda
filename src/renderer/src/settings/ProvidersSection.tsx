import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  BillingMode,
  BillingState,
  CodexAuthStatus,
  CodexBillingMode,
  EngineId,
  ModelSpend,
  RateLimitInfo,
  UsageHistoryDay,
} from '@shared/ipc'
import { Collapse } from '../motion'
import { useWorkspace } from '../workspace/store'
import { engineLabel, engineOrder, engineAccent } from '../workspace/models'
import { SegmentedControl, SettingsRow, SettingsSection } from './controls'
import { BusyText, Button } from '../ui'

// ── AI providers (engine billing, grouped by provider) ──────────────────────────────
// How the LLM that powers each session is authenticated and paid for, organized as one self-contained
// block per provider (each is a separate account and bill, so they never share auth or usage): Anthropic
// (Claude plan, optional BYO API key, usage) and OpenAI (ChatGPT plan → the Codex engine, usage). Each
// block mirrors the same shape — sign-in/status, then usage — so the two read as peers, not one bolted
// under the other. Switching is user-visible here, never silent; a stored key is encrypted in main and
// never echoed back (the UI only learns whether one exists). Cross-engine daily history sits at the end.
export function ProvidersSection() {
  const [billing, setBilling] = useState<BillingState | null>(null)
  const [history, setHistory] = useState<UsageHistoryDay[]>([])
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null)
  const sessions = useWorkspace((s) => s.sessions)
  const rateLimits = useWorkspace((s) => s.rateLimits)

  const refresh = (): void => {
    window.koda.getBillingState().then(setBilling).catch(console.error)
  }
  // Stable identity so OpenAiPanel's progress-listener effect doesn't re-subscribe on every render (this
  // parent re-renders on session/rateLimit churn). When login completes it already carries fresh status,
  // so seed from that and skip a second probe; otherwise (initial mount) fetch it.
  const refreshCodex = useCallback((status?: CodexAuthStatus): void => {
    if (status) {
      setCodexAuth(status)
      return
    }
    window.koda
      .getCodexAuthStatus()
      .then(setCodexAuth)
      .catch(() => setCodexAuth({ signedIn: false, authMethod: null, requiresOpenaiAuth: null }))
  }, [])
  useEffect(() => {
    refresh()
    refreshCodex()
    window.koda.getUsageHistory().then(setHistory).catch(console.error)
  }, [refreshCodex])

  // Billing state is the ANTHROPIC account's (BYO Anthropic API key + 'auto' fallback). Codex is
  // subscription-only in v1, so its spend always reads as plan-covered regardless of this.
  const apiAlways = billing?.mode === 'api'
  const apiActive = billing?.apiActive ?? false

  // Per-engine spend + by-model aggregates from open/restored sessions: each engine is a separate
  // subscription, so these never mix across Anthropic and OpenAI.
  const perEngine = useMemo(() => {
    const agg: Record<string, { spend: number; byModel: Record<string, ModelSpend> }> = {}
    for (const s of Object.values(sessions)) {
      const eid = s.engineId ?? 'claude'
      const e = (agg[eid] ??= { spend: 0, byModel: {} })
      e.spend += s.spendUsd ?? 0
      for (const [model, m] of Object.entries(s.byModel ?? {})) {
        const a = e.byModel[model]
        e.byModel[model] = {
          costUsd: (a?.costUsd ?? 0) + m.costUsd,
          inputTokens: (a?.inputTokens ?? 0) + m.inputTokens,
          outputTokens: (a?.outputTokens ?? 0) + m.outputTokens,
          cacheReadTokens: (a?.cacheReadTokens ?? 0) + m.cacheReadTokens,
          cacheCreationTokens: (a?.cacheCreationTokens ?? 0) + m.cacheCreationTokens,
        }
      }
    }
    return agg
  }, [sessions])

  // Multi-engine = any engine other than the always-present Claude has spend or a reported window —
  // drives whether OpenAI shows a usage card and whether the history bars segment by engine.
  const codexHasUsage =
    (perEngine.codex?.spend ?? 0) > 0 || Object.keys(rateLimits.codex ?? {}).length > 0
  const multi =
    new Set(['claude', ...Object.keys(perEngine), ...Object.keys(rateLimits)]).size > 1

  // Hide a provider's advanced (API key) + usage rows until it's actually signed in — a logged-out pane
  // should read as one clean "sign in" card, not a wall of empty usage. Claude is ready on a subscription
  // OR a stored/active API key; OpenAI on a ChatGPT login. While billing is still loading (null), treat
  // Claude as not-ready so the extras don't flash in then vanish.
  const claudeReady = billing != null && (billing.verdict.mode !== 'logged-out' || billing.hasKey)
  // Codex is "ready" on a ChatGPT login OR a stored OpenAI API key (either credential can drive it).
  const codexReady = (codexAuth?.signedIn ?? false) || (billing?.hasCodexKey ?? false)
  const anyReady = claudeReady || codexReady

  return (
    <>
      <ProviderGroup brand="Anthropic" sub="Claude">
        <ClaudePanel billing={billing} onChanged={refresh} />
        {claudeReady && (
          <>
            <ApiKeyPanel billing={billing} onChanged={refresh} />
            <EngineUsage
              title="Usage"
              engineId="claude"
              windows={rateLimits.claude ?? {}}
              spend={perEngine.claude?.spend ?? 0}
              byModel={perEngine.claude?.byModel ?? {}}
              // Plan windows are meaningless under always-API billing; hide just that block.
              showPlanLimits={!apiAlways}
              apiActive={apiActive}
            />
          </>
        )}
      </ProviderGroup>

      <ProviderGroup brand="OpenAI" sub="ChatGPT · Codex">
        <OpenAiPanel auth={codexAuth} onChanged={refreshCodex} />
        <OpenAiApiKeyPanel
          billing={billing}
          onChanged={() => {
            refresh()
            refreshCodex() // auth.json flips between apikey/chatgpt after reconcile — re-read sign-in status
          }}
        />
        {codexReady && codexHasUsage && (
          <EngineUsage
            title="Usage"
            engineId="codex"
            windows={rateLimits.codex ?? {}}
            spend={perEngine.codex?.spend ?? 0}
            byModel={perEngine.codex?.byModel ?? {}}
            // Plan windows are meaningless when Codex bills the API key; hide just that block.
            showPlanLimits={!(billing?.codexApiActive ?? false)}
            apiActive={billing?.codexApiActive ?? false}
          />
        )}
      </ProviderGroup>

      {anyReady && history.length > 0 && (
        <HistorySection history={history} multi={multi} apiActive={apiActive} />
      )}
    </>
  )
}

/** One provider's whole story — a prominent brand header (company first, the framing the user thinks
 *  in: "Anthropic vs OpenAI") over its stack of cards (sign-in/status, key, usage). The header is a
 *  level above the cards' own uppercase titles, so each block reads as a self-contained unit. */
function ProviderGroup({ brand, sub, children }: { brand: string; sub: string; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="font-display text-[15px] font-semibold text-text">{brand}</h2>
        <span className="text-[12.5px] text-text-muted">{sub}</span>
      </div>
      {children}
    </div>
  )
}

/** OpenAI sign-in: a ChatGPT-plan OAuth login that drives `codex login` in main. Unlike Claude's
 *  paste-code flow, Codex uses a loopback callback, so there's no code to paste — the browser opens,
 *  the user approves, and it completes on its own. Koda never stores the OpenAI credential (the engine
 *  owns it). Signed in → OpenAI models become selectable in the model menu. */
function OpenAiPanel({
  auth,
  onChanged,
}: {
  auth: CodexAuthStatus | null
  onChanged: (status?: CodexAuthStatus) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'awaiting-browser' | 'verifying' | 'failed'>('idle')
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    return window.koda.onCodexLoginProgress((e) => {
      if (e.state === 'awaiting-browser') {
        setPhase('awaiting-browser')
        setUrl(e.url)
      } else if (e.state === 'verifying') setPhase('verifying')
      else if (e.state === 'completed') {
        setPhase('idle')
        onChanged(e.status) // completed already carries fresh status — no second probe
      } else if (e.state === 'failed') {
        setPhase('failed')
        setMsg(e.message)
      } else setPhase('idle') // cancelled / timeout
    })
  }, [onChanged])

  const start = (): void => {
    setMsg('')
    setPhase('verifying') // optimistic until the URL or a failure lands
    window.koda
      .startCodexLogin()
      .then((r) => {
        if (!r.ok) {
          setPhase('failed')
          setMsg(r.reason ?? 'Could not start sign-in.')
        }
      })
      .catch(() => setPhase('failed'))
  }

  const signedIn = auth?.signedIn ?? false
  const method = auth?.authMethod === 'chatgpt' ? 'ChatGPT' : auth?.authMethod ?? null
  const status = !auth ? '…' : signedIn ? `Signed in${method ? ` · ${method}` : ''}` : 'Not signed in'
  // Both pre-URL ('verifying') and post-URL ('awaiting-browser') are in-flight: a real child is running,
  // so Cancel must be reachable in either (otherwise a URL that never parses strands "Working…" until the
  // 5-min timeout with no escape).
  const inFlight = phase === 'verifying' || phase === 'awaiting-browser'

  return (
    <SettingsSection title="Subscription">
      <SettingsRow
        label="ChatGPT plan"
        description="Bills OpenAI's Codex engine against your ChatGPT plan. Pick an OpenAI model from the model menu to use it."
        control={
          phase === 'awaiting-browser' ? (
            <BusyText className="text-[13px] text-text-muted">Waiting for the browser…</BusyText>
          ) : phase === 'verifying' ? (
            <BusyText className="text-[13px] text-text-muted">Working…</BusyText>
          ) : (
            <Button variant="secondary" onClick={start}>{signedIn ? 'Re-authenticate' : 'Sign in'}</Button>
          )
        }
      />
      {inFlight && (
        <div className="space-y-2.5 px-4 pb-4">
          <p className="text-[12.5px] leading-snug text-text-muted">
            {phase === 'awaiting-browser' ? (
              <>
                A browser opened to sign in to ChatGPT. Approve there and this finishes on its own —
                nothing to paste back.{' '}
                <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  Reopen the page
                </a>
              </>
            ) : (
              'Starting sign-in… a browser will open shortly.'
            )}
          </p>
          <button
            onClick={() => window.koda.cancelCodexLogin().catch(console.error)}
            className="text-[12.5px] text-text-muted transition-colors hover:text-text"
          >
            Cancel
          </button>
        </div>
      )}
      {!inFlight && (
        <SettingsRow label="Status" control={<span className="text-[13px] text-text-muted">{status}</span>} />
      )}
      {phase === 'idle' && auth && !signedIn && (
        <div className="px-4 pb-3.5 pt-0.5 text-[12.5px] leading-snug text-text-muted">
          Sign in with your ChatGPT plan to use OpenAI models. Koda reads the login — it never stores your
          OpenAI credentials.
        </div>
      )}
      {phase === 'failed' && msg && <div className="px-4 pb-3 text-[12px] text-red-500">{msg}</div>}
    </SettingsSection>
  )
}

/** The Claude provider: sign in with a Pro/Max plan (reuses the onboarding `auth:*` flow — button →
 *  open the browser → paste the code back). The API-key path is the sibling panel below. */
function ClaudePanel({ billing, onChanged }: { billing: BillingState | null; onChanged: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'awaiting-code' | 'verifying' | 'failed'>('idle')
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    return window.koda.onAuthProgress((e) => {
      if (e.state === 'awaiting-code') {
        setPhase('awaiting-code')
        setUrl(e.url)
      } else if (e.state === 'verifying') setPhase('verifying')
      else if (e.state === 'completed') {
        setPhase('idle')
        setCode('')
        onChanged()
      } else if (e.state === 'failed') {
        setPhase('failed')
        setMsg(e.message)
      } else setPhase('idle') // cancelled / timeout
    })
  }, [onChanged])

  const start = (): void => {
    setMsg('')
    setPhase('verifying') // optimistic until the URL or a failure lands
    window.koda.startLogin().then((r) => {
      if (!r.ok) {
        setPhase('failed')
        setMsg(r.reason ?? 'Could not start sign-in.')
      }
    }).catch(() => setPhase('failed'))
  }

  const submit = (): void => {
    if (!code.trim()) return
    window.koda.submitAuthCode(code.trim()).catch(console.error)
  }

  const v = billing?.verdict
  const signedInSub = v?.mode === 'subscription'
  const status = !v
    ? '…'
    : signedInSub
      ? `Signed in${v.plan ? ` · ${v.plan}` : ''}${v.email ? ` · ${v.email}` : ''}`
      : billing?.mode === 'api'
        ? 'Using an API key (below)'
        : 'Not signed in'

  return (
    <SettingsSection title="Subscription">
      {v?.apiKeyTrap && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-text-muted">
          An API key in your environment is shadowing your subscription, so turns are billing at API rates.
          Remove it from your shell, or choose API billing below to make it deliberate.
        </div>
      )}
      <SettingsRow
        label="Claude subscription"
        description="Bills against your Pro or Max plan. This is the default, free at the point of use. Sign in once; the login is shared with the bundled engine."
        control={
          phase === 'awaiting-code' ? (
            <BusyText className="text-[13px] text-text-muted">Waiting for the code…</BusyText>
          ) : phase === 'verifying' ? (
            <BusyText className="text-[13px] text-text-muted">Working…</BusyText>
          ) : (
            <Button variant="secondary" onClick={start}>{signedInSub ? 'Re-authenticate' : 'Sign in'}</Button>
          )
        }
      />
      {phase === 'awaiting-code' && (
        <div className="space-y-2.5 px-4 pb-4">
          <p className="text-[12.5px] leading-snug text-text-muted">
            A browser opened for you to approve. Copy the code it shows and paste it here.{' '}
            <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Reopen the page
            </a>
          </p>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Paste the code"
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12.5px] text-text placeholder:font-sans placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
            />
            <Button variant="primary" onClick={submit} disabled={!code.trim()}>
              Continue
            </Button>
            <Button variant="ghost" onClick={() => window.koda.cancelLogin().catch(console.error)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {phase !== 'awaiting-code' && (
        <SettingsRow label="Status" control={<span className="text-[13px] text-text-muted">{status}</span>} />
      )}
      {phase === 'failed' && msg && <div className="px-4 pb-3 text-[12px] text-red-500">{msg}</div>}
    </SettingsSection>
  )
}

// The three ways the API key can be used, once one is stored. 'auto' is the safe default a fresh save
// lands on; 'api' (always) is the only one that spends on every turn — its blurb turns amber to warn.
const BILLING_MODE_OPTIONS: { value: BillingMode; label: string; title: string }[] = [
  { value: 'subscription', label: 'Subscription only', title: 'Stop at your plan limit. Never spend API money.' },
  { value: 'auto', label: 'After my limit', title: 'Run on your plan; switch to your key when you hit the limit (asks first).' },
  { value: 'api', label: 'Always', title: 'Bill every turn to your API key. Real per-token dollars.' },
]

const MODE_BLURB: Record<BillingMode, string> = {
  subscription:
    'Your key is stored but unused. Turns bill your plan and stop when you hit its limit.',
  auto: 'Turns bill your plan. When you hit the limit, Koda asks once, then continues on your API key until your plan resets.',
  api: 'Every turn bills your Anthropic API account: real per-token dollars, no plan window. Track it under Usage.',
}

/** Paste / replace / remove the BYO API key, and — once a key is stored — choose WHEN it's used
 *  (subscription only / after the limit / always). Picking a mode here is just a preference: nothing
 *  spends until the next turn, so it switches immediately and the per-mode blurb carries the warning.
 *  The actual consent-to-spend moment is the mid-session auto-fallback banner (Chassis), not this. */
function ApiKeyPanel({ billing, onChanged }: { billing: BillingState | null; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [replacing, setReplacing] = useState(false)
  const hasKey = billing?.hasKey ?? false
  const mode: BillingMode = billing?.mode ?? 'subscription'

  const save = async (): Promise<void> => {
    if (!key.trim() || saving) return
    setSaving(true)
    setErr('')
    try {
      const r = await window.koda.saveApiKey(key.trim())
      if (r.ok) {
        setKey('')
        setReplacing(false)
        onChanged() // re-fetch state so the selector + chip reflect the new mode
      } else setErr(r.error)
    } catch {
      setErr('Could not save the key.')
    } finally {
      setSaving(false)
    }
  }

  const remove = (): void => {
    window.koda.removeApiKey().then(() => onChanged()).catch(console.error)
  }

  const cancelReplace = (): void => {
    setReplacing(false)
    setKey('')
    setErr('')
  }

  // The paste field is only on when there's no key yet, or the user opted into replacing one —
  // replacing a saved key is rare, so it shouldn't sit there permanently butting the divider.
  const showInput = !hasKey || replacing

  const changeMode = (next: BillingMode): void => {
    if (next === mode) return
    window.koda.updateSettings({ billingMode: next }).then(() => onChanged()).catch(console.error)
  }

  return (
    <SettingsSection title="API key (advanced)">
      {hasKey ? (
        <>
          {/* Row + its warning live in one band so the card's divider sits below the pair, not crashing
              into the inset amber box. */}
          <div>
            <SettingsRow
              label="When to use your API key"
              description={MODE_BLURB[mode]}
              control={
                <SegmentedControl
                  ariaLabel="When to use your API key"
                  value={mode}
                  options={BILLING_MODE_OPTIONS}
                  onChange={(v) => changeMode(v as BillingMode)}
                />
              }
            />
            {mode === 'api' && (
              <div className="px-4 pb-4 text-[12px] text-text-muted">
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  “Always” spends real money on your Anthropic account on every turn, until you change it.
                </div>
              </div>
            )}
          </div>
          <SettingsRow
            label="Stored key"
            description="Saved encrypted on this Mac. Never leaves your machine except as the engine’s credential."
            control={
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setReplacing(true)}>Replace</Button>
                <Button variant="danger" onClick={remove}>Remove</Button>
              </div>
            }
          />
        </>
      ) : (
        <div className="px-4 pt-3 text-[12.5px] leading-snug text-text-muted">
          Spend your own Anthropic API credits instead of your subscription. Pay per token, with no 5-hour
          or weekly plan limit. Create a key at console.anthropic.com. After saving, choose whether to use it
          only past your plan limit or always.
        </div>
      )}
      <Collapse open={showInput}>
        <div className="space-y-2.5 px-4 pb-4 pt-3">
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus={replacing}
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                if (err) setErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape' && replacing) cancelReplace()
              }}
              placeholder={hasKey ? 'Paste the new key' : 'sk-ant-…'}
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12.5px] text-text placeholder:font-sans placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
            />
            <Button variant="primary" onClick={save} disabled={!key.trim() || saving}>
              {saving ? 'Checking…' : hasKey ? 'Save key' : 'Save'}
            </Button>
            {replacing && <Button variant="secondary" onClick={cancelReplace}>Cancel</Button>}
          </div>
          {err && <div className="text-[12px] text-red-500">{err}</div>}
        </div>
      </Collapse>
    </SettingsSection>
  )
}

// Codex's two billing credentials — a straight toggle (no 'auto' fallback in v1). 'api' spends real
// per-token dollars on every turn; its blurb turns amber to warn.
const CODEX_MODE_OPTIONS: { value: CodexBillingMode; label: string; title: string }[] = [
  { value: 'subscription', label: 'ChatGPT plan', title: 'Bill Codex to your ChatGPT plan.' },
  { value: 'api', label: 'API key', title: 'Bill every Codex turn to your OpenAI API key. Real per-token dollars.' },
]

/** Paste / replace / remove the BYO OpenAI key for Codex, and choose whether Codex bills the ChatGPT plan
 *  or the key. Mirrors the Anthropic ApiKeyPanel, minus the 'auto' fallback (Codex has no plan-limit
 *  hand-off in v1). The key is stored encrypted in main and written into Codex's isolated login on save;
 *  it never echoes back to the renderer. */
function OpenAiApiKeyPanel({ billing, onChanged }: { billing: BillingState | null; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [replacing, setReplacing] = useState(false)
  const hasKey = billing?.hasCodexKey ?? false
  const mode: CodexBillingMode = billing?.codexMode ?? 'subscription'

  const save = async (): Promise<void> => {
    if (!key.trim() || saving) return
    setSaving(true)
    setErr('')
    try {
      const r = await window.koda.saveCodexApiKey(key.trim())
      if (r.ok) {
        setKey('')
        setReplacing(false)
        onChanged()
      } else setErr(r.error)
    } catch {
      setErr('Could not save the key.')
    } finally {
      setSaving(false)
    }
  }

  const remove = (): void => {
    window.koda.removeCodexApiKey().then(() => onChanged()).catch(console.error)
  }

  const cancelReplace = (): void => {
    setReplacing(false)
    setKey('')
    setErr('')
  }

  const showInput = !hasKey || replacing

  const changeMode = (next: CodexBillingMode): void => {
    if (next === mode) return
    window.koda.updateSettings({ codexBillingMode: next }).then(() => onChanged()).catch(console.error)
  }

  return (
    <SettingsSection title="API key (advanced)">
      {hasKey ? (
        <>
          <div>
            <SettingsRow
              label="Bill Codex to"
              description={
                mode === 'api'
                  ? 'Every Codex turn bills your OpenAI API account: real per-token dollars, no plan window.'
                  : 'Your key is stored but unused. Codex bills your ChatGPT plan.'
              }
              control={
                <SegmentedControl
                  ariaLabel="Bill Codex to"
                  value={mode}
                  options={CODEX_MODE_OPTIONS}
                  onChange={(v) => changeMode(v as CodexBillingMode)}
                />
              }
            />
            {mode === 'api' && (
              <div className="px-4 pb-4 text-[12px] text-text-muted">
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  “API key” spends real money on your OpenAI account on every Codex turn, until you change it.
                </div>
              </div>
            )}
          </div>
          <SettingsRow
            label="Stored key"
            description="Saved encrypted on this Mac. Written into Codex’s login; never leaves your machine otherwise."
            control={
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setReplacing(true)}>Replace</Button>
                <Button variant="danger" onClick={remove}>Remove</Button>
              </div>
            }
          />
        </>
      ) : (
        <div className="px-4 pt-3 text-[12.5px] leading-snug text-text-muted">
          Spend your own OpenAI API credits instead of a ChatGPT plan. Pay per token, with no plan limit.
          Create a key at platform.openai.com. Saving switches Codex to bill your API key.
        </div>
      )}
      <Collapse open={showInput}>
        <div className="space-y-2.5 px-4 pb-4 pt-3">
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus={replacing}
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                if (err) setErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape' && replacing) cancelReplace()
              }}
              placeholder={hasKey ? 'Paste the new key' : 'sk-…'}
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12.5px] text-text placeholder:font-sans placeholder:text-text-muted/60 focus:border-accent focus:outline-none"
            />
            <Button variant="primary" onClick={save} disabled={!key.trim() || saving}>
              {saving ? 'Checking…' : hasKey ? 'Save key' : 'Save'}
            </Button>
            {replacing && <Button variant="secondary" onClick={cancelReplace}>Cancel</Button>}
          </div>
          {err && <div className="text-[12px] text-red-500">{err}</div>}
        </div>
      </Collapse>
    </SettingsSection>
  )
}

// ── Usage history (cross-engine daily rollup) ─────────────────────────────────────────
// The one usage card that spans both providers — daily estimated $ over the last two weeks, segmented
// by engine when more than one ran. Per-provider plan windows + spend live in each provider's own block
// above (EngineUsage). NO precise plan % anywhere — that needs the OAuth usage endpoint, which the ToS
// bars; Anthropic's plan limits / usage credits do the actual capping, this is a read-only mirror.
function HistorySection({
  history,
  multi,
  apiActive,
}: {
  history: UsageHistoryDay[]
  multi: boolean
  apiActive: boolean
}) {
  const recent = history.slice(0, 14)
  const max = Math.max(...recent.map((d) => d.costUsd), 0)
  return (
    <SettingsSection title="History">
      {recent.map((d) => (
        <HistoryRow key={d.date} day={d} max={max} multi={multi} />
      ))}
      <div className="px-4 pb-3 pt-1 text-[12px] leading-snug text-text-muted">
        Daily usage over the last two weeks{multi ? ', split by engine' : ''}.{' '}
        {apiActive ? 'Anthropic turns show real billed amounts.' : 'Estimated value — your plan covers it.'}
      </div>
    </SettingsSection>
  )
}

/** One engine's usage within its provider block: plan windows + estimated spend + per-model split. The
 *  `title` is the card heading (e.g. "Usage") — the provider brand is the group header above, so this
 *  doesn't repeat it. Each engine is its own account, so these never combine across providers. */
function EngineUsage({
  title,
  engineId,
  windows,
  spend,
  byModel,
  showPlanLimits,
  apiActive,
}: {
  title: string
  engineId: EngineId | string
  windows: Record<string, RateLimitInfo>
  spend: number
  byModel: Record<string, ModelSpend>
  showPlanLimits: boolean
  apiActive: boolean
}) {
  const five = windows['five_hour']
  const weekly = windows['weekly']
  const models = Object.entries(byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)
  // Anchor the 5-hour row for Anthropic (always-present empty state); for any other engine only show a
  // window once it actually reports one (never fabricate a gauge we can't see).
  const anchorFiveHour = engineId === 'claude'
  return (
    <SettingsSection title={title}>
      {showPlanLimits && (anchorFiveHour || five) && <PlanWindowRow label="5-hour limit" info={five} />}
      {showPlanLimits && weekly && <PlanWindowRow label="Weekly limit" info={weekly} />}
      {spend > 0 && (
        <SettingsRow
          label="Estimated spend"
          description={
            apiActive
              ? 'Billed to your API account, across open and restored sessions.'
              : 'What these turns would cost on the API — your plan covers it.'
          }
          control={<span className="font-mono text-[13px] text-text">{fmtUsd(spend)}</span>}
        />
      )}
      {models.map(([model, m]) => (
        <ModelUsageRow key={model} model={model} spend={m} />
      ))}
      <div className="px-4 pb-3 pt-1 text-[12px] leading-snug text-text-muted">
        {showPlanLimits
          ? 'Your subscription usage windows as the engine reports them — approximate; the exact limit is enforced on the provider’s side.'
          : 'Per-token spend from the engine. Your real invoice lives in the provider’s console.'}
      </div>
    </SettingsSection>
  )
}

/** One day in the usage history: date + turns + cost, with a bar sized against the busiest day in the
 *  window so the "where did my month go" shape reads at a glance. When more than one engine ran AND the
 *  day carries an engine split, the bar is segmented (Anthropic accent + OpenAI emerald) so two
 *  subscriptions' dollars don't read as one. */
function HistoryRow({ day, max, multi }: { day: UsageHistoryDay; max: number; multi: boolean }) {
  const pct = max > 0 ? Math.max(2, Math.round((day.costUsd / max) * 100)) : 0
  // Engine split for the colored portion: include even a single engine (so a Codex-only day reads in
  // OpenAI's color, not Anthropic's). Segment widths are relative to the split's OWN total, so they
  // always fill the bar — a legacy day whose byEngine sum is below costUsd (turns recorded before
  // engine-tagging) won't leave a gap.
  const split =
    multi && day.byEngine
      ? Object.entries(day.byEngine)
          .filter(([, c]) => c > 0)
          .sort((a, b) => engineOrder(a[0]) - engineOrder(b[0]))
      : null
  const splitTotal = split ? split.reduce((sum, [, c]) => sum + c, 0) : 0
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-6">
        <div className="text-[13.5px] font-medium text-text">{fmtDay(day.date)}</div>
        <div className="flex items-center gap-3 text-[12.5px] text-text-muted">
          <span>{day.turns === 1 ? '1 turn' : `${day.turns} turns`}</span>
          <span className="font-mono text-[13px] text-text">{fmtUsd(day.costUsd)}</span>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/60">
        <div className="flex h-full gap-px" style={{ width: `${pct}%` }}>
          {split && splitTotal > 0 ? (
            split.map(([eid, c]) => (
              <div
                key={eid}
                className={`h-full ${engineAccent(eid)}`}
                style={{ width: `${(c / splitTotal) * 100}%` }}
                title={`${engineLabel(eid)}: ${fmtUsd(c)}`}
              />
            ))
          ) : (
            <div className="h-full w-full bg-accent/70" />
          )}
        </div>
      </div>
    </div>
  )
}

/** Local `YYYY-MM-DD` → "Today" / "Yesterday" / "Mon, Jun 23". */
function fmtDay(date: string): string {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date()
  if (date === iso(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date === iso(yesterday)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** One model's accumulated cost + token split. The description calls out the cache share — the single
 *  most useful token fact (cache reads dominate counts and cost a fraction of fresh input). */
function ModelUsageRow({ model, spend }: { model: string; spend: ModelSpend }) {
  const promptTokens = spend.inputTokens + spend.cacheReadTokens + spend.cacheCreationTokens
  const cachedPct = promptTokens > 0 ? Math.round((spend.cacheReadTokens / promptTokens) * 100) : null
  const parts = [`${fmtTokens(spend.inputTokens)} in`, `${fmtTokens(spend.outputTokens)} out`]
  if (cachedPct !== null) parts.push(`${cachedPct}% cached`)
  return (
    <SettingsRow
      label={prettyModel(model)}
      description={parts.join(' · ')}
      control={<span className="font-mono text-[13px] text-text">{fmtUsd(spend.costUsd)}</span>}
    />
  )
}

/** Engine model id → a friendly label for non-engineers, derived generically (never a hardcoded
 *  lookup — the no-model-names rule). `claude-opus-4-8[1m]` → "Opus 4.8 · 1M context";
 *  `claude-haiku-4-5-20251001` → "Haiku 4.5". Falls back to the raw id if it doesn't parse. */
function prettyModel(id: string): string {
  const ctx = /\[(\d+)m\]$/i.exec(id)?.[1]
  const stripped = id
    .replace(/^claude-/, '')
    .replace(/\[\d+m\]$/i, '')
    .replace(/-\d{6,}$/, '') // trailing date stamp
  const [family, ...rest] = stripped.split('-')
  if (!family) return id
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const label = rest.length ? `${cap(family)} ${rest.join('.')}` : cap(family)
  return ctx ? `${label} · ${ctx}M context` : label
}

/** Compact token count: 1.2K / 3.4M. */
function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/** One subscription window. Claude gives only a coarse band (no precise %); Codex reports a real
 *  `usedPercent` — show the exact figure when present (a measured fill), else the band text. */
function PlanWindowRow({ label, info }: { label: string; info?: RateLimitInfo }) {
  if (!info)
    return (
      <SettingsRow
        label={label}
        control={<span className="text-[13px] text-text-muted">After your next turn</span>}
      />
    )
  const tone =
    info.status === 'rejected' || info.status === 'blocked'
      ? 'text-red-500'
      : info.status === 'warning'
        ? 'text-amber-500'
        : 'text-emerald-500'
  const pct = info.usedPercent != null ? Math.round(info.usedPercent) : null
  const text =
    pct != null
      ? `${pct}% used`
      : info.status === 'rejected' || info.status === 'blocked'
        ? 'Limit reached'
        : info.status === 'warning'
          ? 'Getting close (~75%+)'
          : 'Healthy'
  return (
    <SettingsRow
      label={label}
      description={`Resets ${fmtReset(info.resetsAt)}${info.isUsingOverage ? ' · using overage' : ''}`}
      control={<span className={`text-[13px] ${tone}`}>{text}</span>}
    />
  )
}

/** USD with cents — small amounts still read as a number, not "$0". */
function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

/** Absolute reset time; includes the weekday when it's not today. */
function fmtReset(resetsAt: number): string {
  const d = new Date(resetsAt * 1000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}
