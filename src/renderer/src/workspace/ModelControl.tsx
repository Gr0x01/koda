import { useEffect, useRef, useState } from 'react'
import type { CodexModel, EngineId } from '@shared/ipc'
import { Menu } from '../motion'
import { Caret } from '../Caret'
import { BusyText } from '../ui'
import { useWorkspace } from './store'
import { QUICK_ALIASES, isModelAlias, prettyModel } from './models'

// Codex model list + auth are fetched async; the menu opens UPWARD (`bottom-full`), so if they resolve
// after open the menu grows taller and the Claude rows shift up under the cursor. Cache the last-known
// values module-wide so repeat opens render at full height immediately — the open still refreshes them,
// but from a stable starting point instead of an empty one.
let cachedCodexModels: CodexModel[] = []
let cachedCodexSignedIn: boolean | null = null

/**
 * Per-session model + engine picker — a compact pill (active model + chevron) beside the approval-mode
 * pill. The dropdown groups models by ENGINE (Claude / OpenAI); picking a model under an engine sets
 * the session's engine to it (`[[codex-engine-selection-ux]]`). Rules:
 *   • Before the first turn: either engine is selectable (switching engine respawns a fresh session).
 *   • After the first turn: the OTHER engine grays out — you can change model WITHIN the same engine,
 *     but not cross engines (the conversation lives in the engine process, so it can't be handed over).
 * Selecting reattaches the session with `--model` (or a fresh spawn for an engine switch) on its next
 * turn — blocked mid-turn, same as crossing plan mode.
 */
export function ModelControl({
  sessionId,
  model,
  activeModel,
  busy,
}: {
  sessionId: string
  model?: string
  activeModel?: string
  busy?: boolean
}) {
  const setSessionModel = useWorkspace((s) => s.setSessionModel)
  const setSessionEngine = useWorkspace((s) => s.setSessionEngine)
  const session = useWorkspace((s) => s.sessions[sessionId])
  const hasPending = useWorkspace((s) => s.pending.some((r) => r.sessionId === sessionId))
  const engineId: EngineId = session?.engineId ?? 'claude'
  // The conversation binds to its engine once a real user turn exists — past then the other engine locks.
  // A fresh session already carries the engine's auto "session started" notice, so item count alone would
  // lock prematurely; gate on an actual user/canvas turn (same signal as send()'s `firstTurn`).
  const conversationStarted = session?.items.some((it) => it.kind === 'user' || it.kind === 'canvas') ?? false
  const locked = !!busy || hasPending
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [codexModels, setCodexModels] = useState<CodexModel[]>(cachedCodexModels)
  const [codexSignedIn, setCodexSignedIn] = useState<boolean | null>(cachedCodexSignedIn)
  const [showCustom, setShowCustom] = useState(false)
  const [custom, setCustom] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Warm the Codex cache once so the first open already renders at full height (no upward shift).
  useEffect(() => {
    if (cachedCodexSignedIn !== null) return
    window.koda.getCodexModels().then((m) => { cachedCodexModels = m; setCodexModels(m) }).catch(() => {})
    window.koda.getCodexAuthStatus().then((s) => { cachedCodexSignedIn = s.signedIn; setCodexSignedIn(s.signedIn) }).catch(() => { cachedCodexSignedIn = false; setCodexSignedIn(false) })
  }, [])

  useEffect(() => {
    if (!open) return
    window.koda.getRecentModels().then(setRecent).catch(() => {})
    window.koda.getCodexModels().then((m) => { cachedCodexModels = m; setCodexModels(m) }).catch(() => {})
    window.koda.getCodexAuthStatus().then((s) => { cachedCodexSignedIn = s.signedIn; setCodexSignedIn(s.signedIn) }).catch(() => { cachedCodexSignedIn = false; setCodexSignedIn(false) })
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Preference-first display (matches the dropdown checkmark): show the user's chosen model immediately
  // (it's what the next turn reattaches with), else the model the engine actually reported defaulting to.
  const value = model ? prettyModel(model) : activeModel ? prettyModel(activeModel) : ''
  const label = value ? `Model: ${value}` : 'Model'

  // A Claude group row was picked (next = a model id, or undefined for "Default" = engine picks).
  function chooseClaude(next: string | undefined): void {
    if (engineId === 'codex') setSessionEngine(sessionId, 'claude', next)
    else setSessionModel(sessionId, next)
    close()
  }
  // A Codex (OpenAI) group row was picked.
  function chooseCodex(next: string | undefined): void {
    if (engineId === 'claude') setSessionEngine(sessionId, 'codex', next)
    else setSessionModel(sessionId, next)
    close()
  }
  function close(): void {
    setOpen(false)
    setShowCustom(false)
    setCustom('')
  }

  // Recently-typed full ids, freshest first, minus the current pick (it shows in the alias/default rows).
  const recents = recent.filter((id) => id !== model)
  // An engine other than the session's locks once the conversation has started.
  const claudeLocked = conversationStarted && engineId !== 'claude'
  const codexLocked = conversationStarted && engineId !== 'codex'

  return (
    <div ref={ref} className="relative min-w-0 shrink">
      <button
        onClick={() => !locked && setOpen((v) => !v)}
        disabled={locked}
        title={locked ? 'Finish or stop what’s running to switch models' : `Model: ${value || 'Default'}`}
        className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:text-text disabled:opacity-40"
      >
        <span className="truncate">{label}</span>
        <Caret className="text-text-muted" />
      </button>

      <Menu
        open={open}
        onClose={close}
        origin="origin-bottom-left"
        className="absolute bottom-full left-0 z-10 mb-1.5 max-h-[60vh] w-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-pop"
      >
        {/* ── Claude ── */}
        <Divider label="Claude" />
        <Row label="Default" hint="engine picks" active={engineId === 'claude' && !model} disabled={claudeLocked} onClick={() => chooseClaude(undefined)} />
        {QUICK_ALIASES.map((a) => (
          <Row key={a.id} label={a.label} active={engineId === 'claude' && model === a.id} disabled={claudeLocked} onClick={() => chooseClaude(a.id)} />
        ))}
        {recents.length > 0 && (
          <>
            {recents.map((id) => (
              <Row key={id} label={prettyModel(id)} hint={isModelAlias(id) ? undefined : id} active={false} disabled={claudeLocked} onClick={() => chooseClaude(id)} />
            ))}
          </>
        )}
        {showCustom ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (custom.trim()) chooseClaude(custom.trim())
            }}
            className="flex items-center gap-1.5 px-2.5 py-2"
          >
            <input
              autoFocus
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="e.g. claude-opus-4-6"
              className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-1 text-[11px] outline-none placeholder:text-text-muted focus:border-accent/50"
            />
            <button type="submit" disabled={!custom.trim()} className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40">
              Use
            </button>
          </form>
        ) : (
          !claudeLocked && (
            <button onClick={() => setShowCustom(true)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-text-muted transition-colors hover:bg-bg hover:text-text">
              <span className="w-3 shrink-0" />
              Custom…
            </button>
          )
        )}

        {/* ── OpenAI (Codex) ── */}
        <Divider label="OpenAI" />
        {codexSignedIn === false ? (
          <div className="px-2.5 py-1.5 text-[11px] text-text-muted">Sign in to OpenAI in Settings → AI providers.</div>
        ) : codexModels.length === 0 ? (
          <div className="px-2.5 py-1.5 text-[11px] text-text-muted">
            {codexSignedIn === null ? <BusyText size={11}>Checking…</BusyText> : 'No models available.'}
          </div>
        ) : (
          <>
            <Row label="Default" hint="engine picks" active={engineId === 'codex' && !model} disabled={codexLocked} onClick={() => chooseCodex(undefined)} />
            {codexModels.map((m) => (
              <Row key={m.id} label={m.label} active={engineId === 'codex' && model === m.id} disabled={codexLocked} onClick={() => chooseCodex(m.id)} />
            ))}
          </>
        )}
      </Menu>
    </div>
  )
}

function Row({
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string
  hint?: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? 'This conversation is already running on the other engine' : hint}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-accent/10 text-accent' : 'text-text hover:bg-bg'
      }`}
    >
      <span className="w-3 shrink-0 text-accent">{active ? '✓' : ''}</span>
      <span className="truncate font-medium">{label}</span>
      {hint && <span className="ml-auto truncate text-[10px] text-text-muted">{hint}</span>}
    </button>
  )
}

function Divider({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="border-t border-border px-2.5 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-wide text-text-muted first:border-t-0">
      {label}
    </div>
  )
}
