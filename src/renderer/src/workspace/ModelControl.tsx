import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EngineId, ProviderCatalogAvailability, ProviderModelCatalogs } from '@shared/ipc'
import { engineCapabilities } from '@shared/engine-capabilities'
import { providerModelCatalogs as initialProviderModelCatalogs } from '@shared/model-catalog'
import { Menu } from '../motion'
import { Caret } from '../Caret'
import { BusyText } from '../ui'
import { useWorkspace } from './store'
import { ProviderMark } from './EngineMark'
import {
  MODEL_PROVIDERS,
  engineDisplay,
  modelChoicesFor,
  prettyModel,
  providerAvailability,
} from './models'

// Provider catalogs are fetched async; the menu opens UPWARD (`bottom-full`), so keep the last-known
// result module-wide and render its fixed-height frame immediately on repeat opens.
let cachedProviderCatalogs: ProviderModelCatalogs = initialProviderModelCatalogs()
let providerCatalogsWarmed = false

type PickerView = EngineId | 'providers'

/**
 * Per-session model + engine picker. The compact trigger opens the CURRENT provider's curated model
 * list; provider switching is a deliberate drill-down rather than a permanent rail or one long mixed
 * catalog. That keeps the everyday choice small while MODEL_PROVIDERS remains the single extensible
 * presentation seam for future registered engines.
 *
 * Before the first turn either provider is selectable. Once real conversation content exists, the
 * other provider remains discoverable but its choices lock: context lives in the engine process and
 * cannot be handed across engines. Model changes within the current provider remain available while
 * idle and reattach the session on its next turn.
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
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)
  const session = useWorkspace((s) => s.sessions[sessionId])
  const hasPending = useWorkspace((s) => s.pending.some((r) => r.sessionId === sessionId))
  const engineId: EngineId = session?.engineId ?? 'claude'
  const conversationStarted =
    session?.items.some((item) => item.kind === 'user' || item.kind === 'canvas') ?? false
  const locked = !!busy || hasPending
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<PickerView>(engineId)
  const [recent, setRecent] = useState<string[]>([])
  const [providerCatalogs, setProviderCatalogs] = useState(cachedProviderCatalogs)
  const [showCustom, setShowCustom] = useState(false)
  const [custom, setCustom] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const catalogRequest = useRef(0)

  const refreshProviderCatalogs = useCallback((): void => {
    const request = ++catalogRequest.current
    window.koda
      .getProviderModelCatalogs()
      .then((catalogs) => {
        if (request !== catalogRequest.current) return
        cachedProviderCatalogs = catalogs
        setProviderCatalogs(catalogs)
      })
      .catch(() => {
        if (request !== catalogRequest.current) return
        const failed = initialProviderModelCatalogs({ codexProbeFailed: true })
        cachedProviderCatalogs = failed
        setProviderCatalogs(failed)
      })
  }, [])

  // Warm once so the first open already has a stable-height model list.
  useEffect(() => {
    if (providerCatalogsWarmed) return
    providerCatalogsWarmed = true
    refreshProviderCatalogs()
  }, [refreshProviderCatalogs])

  useEffect(() => {
    if (!open) return
    window.koda.getRecentModels().then(setRecent).catch(() => {})
    refreshProviderCatalogs()
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
        setShowCustom(false)
        setCustom('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, refreshProviderCatalogs])

  // Preference-first display: the explicit pick wins, then the model the engine reported resolving.
  const value = model ? prettyModel(model) : activeModel ? prettyModel(activeModel) : ''
  const label = value || 'Model'

  function close(): void {
    setOpen(false)
    setShowCustom(false)
    setCustom('')
  }

  function toggle(): void {
    if (locked) return
    setOpen((wasOpen) => {
      if (!wasOpen) {
        setView(engineId)
        setShowCustom(false)
      }
      return !wasOpen
    })
  }

  function showProvider(next: EngineId): void {
    setShowCustom(false)
    setCustom('')
    setView(next)
  }

  function choose(nextEngine: EngineId, nextModel: string | undefined): void {
    if (nextEngine === engineId) setSessionModel(sessionId, nextModel)
    else setSessionEngine(sessionId, nextEngine, nextModel)
    close()
  }

  const choicesFor = (provider: EngineId) =>
    modelChoicesFor(provider, {
      engineId,
      model,
      activeModel,
      recentModels: recent,
      providerCatalogs,
    })

  function providerSummary(provider: EngineId): string {
    const owner = engineDisplay(provider).owner
    if (provider !== engineId) return `${owner} · Choose a model`
    if (model) return `${owner} · ${prettyModel(model)}`
    if (activeModel) return `${owner} · ${prettyModel(activeModel)} · auto`
    return `${owner} · Engine default`
  }

  return (
    <div ref={ref} className="relative min-w-0 shrink">
      <button
        onClick={toggle}
        disabled={locked}
        title={locked ? 'Finish or stop what’s running to switch models' : `Model: ${value || 'Default'}`}
        aria-label={`Model: ${value || 'Default'}`}
        aria-expanded={open}
        className={`flex min-w-0 items-center gap-1.5 rounded-lg py-1 pl-1 pr-2 text-[11px] font-medium transition-colors hover:text-text disabled:opacity-40 ${
          open ? 'bg-bg text-text' : 'text-text-muted'
        }`}
      >
        <ProviderMark engineId={engineId} />
        <span className="max-w-36 truncate">{label}</span>
        <Caret className="text-text-muted" />
      </button>

      <Menu
        open={open}
        onClose={close}
        origin="origin-bottom-left"
        className="absolute bottom-full left-0 z-10 mb-1.5 flex h-[328px] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
      >
        {view === 'providers' ? (
          <>
            <div className="flex min-h-[59px] items-center border-b border-border px-3.5 py-2.5">
              <div>
                <h2 className="font-display text-[14px] font-semibold tracking-[-0.02em] text-text">
                  AI providers
                </h2>
                <p className="mt-0.5 text-[9px] text-text-muted">Choose where this chat runs</p>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {MODEL_PROVIDERS.map((provider) => {
                const display = engineDisplay(provider)
                const crossEngineLocked = conversationStarted && provider !== engineId
                return (
                  <button
                    key={provider}
                    onClick={() => showProvider(provider)}
                    className="grid min-h-[58px] w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-text transition-colors hover:bg-bg"
                  >
                    <ProviderMark engineId={provider} size="regular" />
                    <span className="min-w-0">
                      <span className="block truncate text-[11.5px] font-semibold">{display.short}</span>
                      <span className="mt-0.5 block truncate text-[9px] text-text-muted">
                        {crossEngineLocked
                          ? `${display.owner} · New chat required to switch`
                          : providerSummary(provider)}
                      </span>
                    </span>
                    <ArrowRight />
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <button
              onClick={() => setView('providers')}
              className="grid min-h-[59px] w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border px-3 py-2.5 text-left text-text transition-colors hover:bg-bg"
            >
              <ProviderMark engineId={view} size="regular" />
              <span className="min-w-0">
                <span className="block truncate text-[11.5px] font-semibold">
                  {engineDisplay(view).short}
                </span>
                <span className="mt-0.5 block truncate text-[9px] text-text-muted">
                  {engineDisplay(view).owner} · switch provider
                </span>
              </span>
              <ArrowRight />
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {unavailableFor(view, providerAvailability(view, providerCatalogs)) ? (
                <div className="px-2.5 py-3 text-[11px] leading-relaxed text-text-muted">
                  {unavailableFor(view, providerAvailability(view, providerCatalogs))}
                </div>
              ) : (
                choicesFor(view).map((choice) => (
                  <ModelRow
                    key={choice.id ?? 'engine-default'}
                    {...choice}
                    active={view === engineId && model === choice.id}
                    disabled={conversationStarted && view !== engineId}
                    onClick={() => choose(view, choice.id)}
                  />
                ))
              )}

              {engineCapabilities(view).customModelIds &&
                !(conversationStarted && view !== engineId) &&
                (showCustom ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (custom.trim()) choose(view, custom.trim())
                    }}
                    className="flex items-center gap-1.5 px-2 py-2"
                  >
                    <input
                      autoFocus
                      value={custom}
                      onChange={(event) => setCustom(event.target.value)}
                      placeholder="Full model ID"
                      className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-[10px] outline-none placeholder:text-text-muted/70 focus:border-accent/50"
                    />
                    <button
                      type="submit"
                      disabled={!custom.trim()}
                      className="shrink-0 rounded-md bg-accent px-2 py-1.5 text-[10px] font-medium text-white disabled:opacity-40"
                    >
                      Use
                    </button>
                  </form>
                ) : (
                  <button
                    onClick={() => setShowCustom(true)}
                    className="w-full rounded-[10px] px-2.5 py-2 text-left text-[10px] text-text-muted transition-colors hover:bg-bg hover:text-text"
                  >
                    Custom model ID…
                  </button>
                ))}

              {conversationStarted && view !== engineId && (
                <p className="px-2.5 py-2 text-[10px] leading-relaxed text-text-muted">
                  This conversation is already running on {engineDisplay(engineId).short}. Start a new
                  chat to switch providers.
                </p>
              )}
            </div>
          </>
        )}

        <button
          onClick={() => {
            close()
            openSettingsTo('providers')
          }}
          className="flex shrink-0 items-center gap-1.5 border-t border-border px-3.5 py-2.5 text-left text-[9.5px] text-text-muted transition-colors hover:text-text"
        >
          <SettingsIcon />
          AI providers in Settings
        </button>
      </Menu>
    </div>
  )
}

function unavailableFor(
  provider: EngineId,
  availability: ProviderCatalogAvailability,
): ReactNode | undefined {
  switch (availability) {
    case 'ready':
      return undefined
    case 'checking':
      return <BusyText size={11}>Checking…</BusyText>
    case 'signed-out':
      return `Sign in to ${engineDisplay(provider).owner} in Settings → AI providers.`
    case 'probe-failed':
      return `Couldn’t check ${engineDisplay(provider).owner} sign-in.`
    case 'empty':
      return 'No models available.'
  }
}

function ModelRow({
  label,
  description,
  badge,
  active,
  disabled,
  onClick,
}: {
  label: string
  description?: string
  badge?: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'This conversation is already running on the other provider' : description}
      className={`grid min-h-11 w-full grid-cols-[minmax(0,1fr)_18px] items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-accent/[0.06]' : 'hover:bg-bg'
      }`}
    >
      <span className="min-w-0">
        <span
          className={`flex min-w-0 items-center gap-1.5 truncate text-[11.5px] font-medium ${
            active ? 'text-accent' : 'text-text'
          }`}
        >
          <span className="truncate">{label}</span>
          {badge && (
            <span className="shrink-0 rounded-full bg-bg px-1.5 py-0.5 text-[8px] font-medium text-text-muted">
              {badge}
            </span>
          )}
        </span>
        {description && (
          <span className="mt-0.5 block truncate text-[9.5px] text-text-muted">{description}</span>
        )}
      </span>
      <span className={`text-center text-[11px] ${active ? 'text-accent' : 'text-transparent'}`}>
        ✓
      </span>
    </button>
  )
}

function ArrowRight(): React.JSX.Element {
  return (
    <svg
      className="size-3.5 text-text-muted"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  )
}
