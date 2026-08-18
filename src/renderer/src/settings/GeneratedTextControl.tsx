import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { isEngineId } from '@shared/engine-capabilities'
import type {
  EngineId,
  ProviderCatalogAvailability,
  ProviderModelCatalogs,
  TextGenerationEffort,
  TextGenerationModel,
} from '@shared/ipc'
import { providerModelCatalogs as initialProviderModelCatalogs } from '@shared/model-catalog'
import { Caret } from '../Caret'
import { Menu } from '../motion'
import { ProviderMark } from '../workspace/EngineMark'
import {
  MODEL_PROVIDERS,
  REASONING_EFFORTS,
  engineDisplay,
  modelChoicesFor,
  prettyModel,
  providerAvailability,
} from '../workspace/models'
import { useWorkspace } from '../workspace/store'
import { useAnchoredMenu } from './controls'

type Writer = TextGenerationModel['provider']
type ModelView = 'writers' | EngineId

interface Choice<T extends string> {
  value: T
  label: string
  description: string
  badge?: string
}

const WRITERS: readonly Choice<Writer>[] = [
  { value: 'apple', label: 'Apple Intelligence', description: 'On-device · no provider usage' },
  { value: 'plain', label: 'Plain local text', description: 'No AI · no provider usage' },
  ...MODEL_PROVIDERS.map((provider) => ({
    value: provider,
    label: engineDisplay(provider).short,
    description: `${engineDisplay(provider).owner} · choose a model`,
  })),
]

const EFFORTS: readonly Choice<TextGenerationEffort>[] = [
  { value: 'off', label: 'Off', description: 'No extended thinking', badge: 'Fastest' },
  ...REASONING_EFFORTS.filter((option) => option.id).map((option) => ({
    value: option.id as TextGenerationEffort,
    label: option.label,
    description: option.description,
    badge: option.badge,
  })),
]

function effortsFor(provider: EngineId | undefined): readonly Choice<TextGenerationEffort>[] {
  // Codex has no true thinking-off posture. Its compatibility default is medium; every offered row
  // maps to the same native reasoning terms used by the session picker.
  return provider === 'codex' ? EFFORTS.filter((option) => option.value !== 'off') : EFFORTS
}

/**
 * Settings counterpart to the session model + effort controls. Both surfaces consume the same
 * provider registry, model catalog, model-row builder, and effort vocabulary. Apple/plain remain
 * local writers in the top level; every engine drills into its own model list and uses the same
 * compact adjacent effort control.
 */
export function GeneratedTextControl({
  value,
  onChange,
}: {
  value: TextGenerationModel
  onChange: (next: TextGenerationModel) => void
}) {
  const openSettingsTo = useWorkspace((state) => state.openSettingsTo)
  const modelMenu = useAnchoredMenu()
  const effortMenu = useAnchoredMenu()
  const setEffortOpen = effortMenu.setOpen
  const [providerCatalogs, setProviderCatalogs] = useState<ProviderModelCatalogs>(
    initialProviderModelCatalogs(),
  )
  const [view, setView] = useState<ModelView>(isEngineId(value.provider) ? value.provider : 'writers')
  const [modelIndex, setModelIndex] = useState(0)
  const [effortIndex, setEffortIndex] = useState(0)
  const modelOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const effortOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const catalogRequest = useRef(0)
  const provider = isEngineId(value.provider) ? value.provider : undefined
  const cloudValue = provider ? value as Extract<TextGenerationModel, { provider: EngineId }> : undefined
  const effortOptions = effortsFor(provider)

  const refreshProviderCatalogs = useCallback((): void => {
    const request = ++catalogRequest.current
    window.koda
      .getProviderModelCatalogs()
      .then((catalogs) => {
        if (request === catalogRequest.current) setProviderCatalogs(catalogs)
      })
      .catch(() => {
        if (request === catalogRequest.current)
          setProviderCatalogs(initialProviderModelCatalogs({ codexProbeFailed: true }))
      })
  }, [])

  useEffect(refreshProviderCatalogs, [refreshProviderCatalogs])

  useEffect(() => {
    if (!provider) setEffortOpen(false)
  }, [provider, setEffortOpen])

  useEffect(() => {
    if (!modelMenu.open || !modelMenu.pos) return
    const frame = window.requestAnimationFrame(() => modelOptionRefs.current[modelIndex]?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [modelIndex, modelMenu.open, modelMenu.pos, view])

  useEffect(() => {
    if (!effortMenu.open || !effortMenu.pos) return
    const frame = window.requestAnimationFrame(() => effortOptionRefs.current[effortIndex]?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [effortIndex, effortMenu.open, effortMenu.pos])

  function modelOptions(nextProvider: EngineId): Choice<string>[] {
    return modelChoicesFor(nextProvider, {
      engineId: nextProvider,
      model: provider === nextProvider ? cloudValue?.model : undefined,
      recentModels: [],
      providerCatalogs,
    })
      .filter((choice): choice is typeof choice & { id: string } => !!choice.id)
      .map((choice) => ({
        value: choice.id,
        label: choice.label,
        description: choice.description ?? choice.id,
        badge: choice.badge,
      }))
  }

  function currentWriterIndex(): number {
    return Math.max(0, WRITERS.findIndex((option) => option.value === value.provider))
  }

  function currentModelIndex(nextProvider: EngineId): number {
    const options = modelOptions(nextProvider)
    const current = provider === nextProvider ? cloudValue?.model : undefined
    return Math.max(0, options.findIndex((option) => option.value === current))
  }

  function currentEffortIndex(): number {
    return Math.max(0, effortOptions.findIndex((option) => option.value === cloudValue?.effort))
  }

  function showModelMenu(nextView: ModelView): void {
    effortMenu.setOpen(false)
    if (nextView !== 'writers') refreshProviderCatalogs()
    setView(nextView)
    setModelIndex(nextView === 'writers' ? currentWriterIndex() : currentModelIndex(nextView))
    modelMenu.setOpen(true)
  }

  function toggleModelMenu(): void {
    if (modelMenu.open) modelMenu.setOpen(false)
    else showModelMenu(provider ?? 'writers')
  }

  function showEffortMenu(): void {
    modelMenu.setOpen(false)
    setEffortIndex(currentEffortIndex())
    effortMenu.setOpen(true)
  }

  function closeModelMenu(): void {
    modelMenu.setOpen(false)
    window.requestAnimationFrame(() => modelMenu.triggerRef.current?.focus())
  }

  function closeEffortMenu(): void {
    effortMenu.setOpen(false)
    window.requestAnimationFrame(() => effortMenu.triggerRef.current?.focus())
  }

  function chooseWriter(writer: Writer): void {
    if (isEngineId(writer)) {
      showModelMenu(writer)
      return
    }
    onChange(writer === 'apple' ? { provider: 'apple' } : { provider: 'plain' })
    closeModelMenu()
  }

  function chooseModel(nextProvider: EngineId, model: string): void {
    if (nextProvider === 'claude') {
      onChange({
        provider: 'claude',
        model: model as Extract<TextGenerationModel, { provider: 'claude' }>['model'],
        effort: provider === 'claude' ? cloudValue?.effort ?? 'off' : 'off',
      })
    } else {
      onChange({
        provider: 'codex',
        model,
        effort: provider === 'codex' ? cloudValue?.effort ?? 'medium' : 'medium',
      })
    }
    closeModelMenu()
  }

  function chooseEffort(effort: TextGenerationEffort): void {
    if (!cloudValue) return
    if (cloudValue.provider === 'claude') onChange({ ...cloudValue, effort })
    else onChange({ ...cloudValue, effort })
    closeEffortMenu()
  }

  const currentModel = provider
    ? modelOptions(provider).find((option) => option.value === cloudValue?.model)
    : undefined
  const currentEffort = effortOptions.find((option) => option.value === cloudValue?.effort)
  const currentLabel =
    value.provider === 'apple'
      ? 'Apple Intelligence'
      : value.provider === 'plain'
        ? 'Plain local text'
        : `${engineDisplay(value.provider).short} ${currentModel?.label ?? prettyModel(value.model)}`

  return (
    <div className="flex items-center gap-1.5">
      <button
        ref={modelMenu.triggerRef}
        aria-label="Text generation model"
        aria-haspopup="listbox"
        aria-expanded={modelMenu.open}
        onClick={toggleModelMenu}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          showModelMenu(provider ?? 'writers')
        }}
        className="flex w-52 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-surface"
      >
        <WriterMark writer={value.provider} />
        <span className="truncate">{currentLabel}</span>
        <Caret className="ml-auto text-text-muted" />
      </button>

      {provider && (
        <button
          ref={effortMenu.triggerRef}
          aria-label="Generated text effort"
          aria-haspopup="listbox"
          aria-expanded={effortMenu.open}
          onClick={() => effortMenu.open ? effortMenu.setOpen(false) : showEffortMenu()}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            showEffortMenu()
          }}
          className="flex w-28 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-surface"
        >
          <ReasoningMark />
          <span className="truncate">{currentEffort?.label ?? 'Medium'}</span>
          <Caret className="ml-auto text-text-muted" />
        </button>
      )}

      {modelMenu.pos &&
        createPortal(
          <Menu
            open={modelMenu.open}
            onClose={() => modelMenu.setOpen(false)}
            origin="origin-top-right"
            className="fixed z-50 w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-pop"
            style={{ top: modelMenu.pos.top, right: modelMenu.pos.right }}
          >
            <div ref={modelMenu.menuRef}>
              {view === 'writers' ? (
                <WriterMenu
                  value={value.provider}
                  activeIndex={modelIndex}
                  optionRefs={modelOptionRefs}
                  onActiveIndex={setModelIndex}
                  onChoose={chooseWriter}
                  onClose={closeModelMenu}
                />
              ) : (
                <EngineModelMenu
                  provider={view}
                  value={provider === view ? cloudValue?.model : undefined}
                  options={modelOptions(view)}
                  availability={providerAvailability(view, providerCatalogs)}
                  activeIndex={modelIndex}
                  optionRefs={modelOptionRefs}
                  onActiveIndex={setModelIndex}
                  onShowWriters={() => showModelMenu('writers')}
                  onChoose={(model) => chooseModel(view, model)}
                  onClose={closeModelMenu}
                  onOpenProviders={() => {
                    modelMenu.setOpen(false)
                    openSettingsTo('providers')
                  }}
                />
              )}
            </div>
          </Menu>,
          document.body,
        )}

      {effortMenu.pos &&
        createPortal(
          <Menu
            open={effortMenu.open}
            onClose={() => effortMenu.setOpen(false)}
            origin="origin-top-right"
            className="fixed z-50 w-72 overflow-hidden rounded-xl border border-border bg-surface p-2.5 shadow-pop"
            style={{ top: effortMenu.pos.top, right: effortMenu.pos.right }}
          >
            <div ref={effortMenu.menuRef} role="listbox" aria-label="Generated text effort">
              <div className="px-1.5 pb-2 pt-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-text-muted/75">
                Reasoning effort
              </div>
              {effortOptions.map((option, index) => (
                <button
                  key={option.value}
                  ref={(node) => { effortOptionRefs.current[index] = node }}
                  role="option"
                  aria-selected={cloudValue?.effort === option.value}
                  tabIndex={index === effortIndex ? 0 : -1}
                  onFocus={() => setEffortIndex(index)}
                  onKeyDown={(event) => handleChoiceKey(
                    event,
                    index,
                    effortOptions.length,
                    effortOptionRefs,
                    setEffortIndex,
                    () => chooseEffort(option.value),
                    closeEffortMenu,
                  )}
                  onClick={() => chooseEffort(option.value)}
                  className={`grid min-h-[47px] w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${cloudValue?.effort === option.value ? 'bg-accent/10' : 'hover:bg-bg'}`}
                >
                  <span className={`size-3.5 rounded-full border ${cloudValue?.effort === option.value ? 'border-[4px] border-accent' : 'border-border'}`} />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium text-text">{option.label}</span>
                    <span className="mt-0.5 block truncate text-[9px] text-text-muted">{option.description}</span>
                  </span>
                  {option.badge && <span className="text-[8.5px] text-text-muted/75">{option.badge}</span>}
                </button>
              ))}
            </div>
          </Menu>,
          document.body,
        )}
    </div>
  )
}

function EngineModelMenu({
  provider,
  value,
  options,
  availability,
  activeIndex,
  optionRefs,
  onActiveIndex,
  onShowWriters,
  onChoose,
  onClose,
  onOpenProviders,
}: {
  provider: EngineId
  value?: string
  options: readonly Choice<string>[]
  availability: ProviderCatalogAvailability
  activeIndex: number
  optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>
  onActiveIndex: (index: number) => void
  onShowWriters: () => void
  onChoose: (value: string) => void
  onClose: () => void
  onOpenProviders: () => void
}) {
  const unavailable = unavailableCopy(provider, availability)
  return (
    <>
      <button
        onClick={onShowWriters}
        className="grid min-h-[59px] w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border px-3 py-2.5 text-left text-text transition-colors hover:bg-bg"
      >
        <ProviderMark engineId={provider} size="regular" />
        <span className="min-w-0">
          <span className="block truncate text-[11.5px] font-semibold">{engineDisplay(provider).short}</span>
          <span className="mt-0.5 block truncate text-[9px] text-text-muted">{engineDisplay(provider).owner} · switch writer</span>
        </span>
        <ArrowRight />
      </button>
      <div role="listbox" aria-label={`${engineDisplay(provider).short} text generation models`} className="p-2">
        {unavailable ? (
          <p className="px-2.5 py-3 text-[11px] leading-relaxed text-text-muted">{unavailable}</p>
        ) : options.map((option, index) => (
          <ModelChoiceRow
            key={option.value}
            ref={(node) => { optionRefs.current[index] = node }}
            {...option}
            active={value === option.value}
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => onActiveIndex(index)}
            onKeyDown={(event) => handleChoiceKey(
              event,
              index,
              options.length,
              optionRefs,
              onActiveIndex,
              () => onChoose(option.value),
              onClose,
            )}
            onClick={() => onChoose(option.value)}
          />
        ))}
      </div>
      <button
        onClick={onOpenProviders}
        className="flex w-full items-center gap-1.5 border-t border-border px-3.5 py-2.5 text-left text-[9.5px] text-text-muted transition-colors hover:text-text"
      >
        <SettingsIcon />
        AI providers in Settings
      </button>
    </>
  )
}

function unavailableCopy(provider: EngineId, availability: ProviderCatalogAvailability): string | undefined {
  switch (availability) {
    case 'ready': return undefined
    case 'checking': return 'Checking available models…'
    case 'signed-out': return `Sign in to ${engineDisplay(provider).owner} in Settings → AI providers.`
    case 'probe-failed': return `Couldn’t check ${engineDisplay(provider).owner} sign-in.`
    case 'empty': return 'No models available.'
  }
}

function WriterMenu({
  value,
  activeIndex,
  optionRefs,
  onActiveIndex,
  onChoose,
  onClose,
}: {
  value: Writer
  activeIndex: number
  optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>
  onActiveIndex: (index: number) => void
  onChoose: (value: Writer) => void
  onClose: () => void
}) {
  return (
    <>
      <div className="flex min-h-[59px] items-center border-b border-border px-3.5 py-2.5">
        <div>
          <h2 className="font-display text-[14px] font-semibold tracking-[-0.02em] text-text">Text generators</h2>
          <p className="mt-0.5 text-[9px] text-text-muted">Choose what writes in the background</p>
        </div>
      </div>
      <div role="listbox" aria-label="Text generation writers" className="p-2">
        {WRITERS.map((option, index) => (
          <button
            key={option.value}
            ref={(node) => { optionRefs.current[index] = node }}
            role="option"
            aria-selected={value === option.value}
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => onActiveIndex(index)}
            onKeyDown={(event) => handleChoiceKey(
              event,
              index,
              WRITERS.length,
              optionRefs,
              onActiveIndex,
              () => onChoose(option.value),
              onClose,
            )}
            onClick={() => onChoose(option.value)}
            className={`grid min-h-[58px] w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-text transition-colors ${value === option.value ? 'bg-accent/[0.06]' : 'hover:bg-bg'}`}
          >
            <WriterMark writer={option.value} size="regular" />
            <span className="min-w-0">
              <span className={`block truncate text-[11.5px] font-semibold ${value === option.value ? 'text-accent' : ''}`}>{option.label}</span>
              <span className="mt-0.5 block truncate text-[9px] text-text-muted">{option.description}</span>
            </span>
            {isEngineId(option.value) ? <ArrowRight /> : (
              <span className={`text-center text-[11px] ${value === option.value ? 'text-accent' : 'text-transparent'}`}>✓</span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}

const ModelChoiceRow = forwardRef<
  HTMLButtonElement,
  Choice<string> & {
    active: boolean
    tabIndex: number
    onFocus: () => void
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
    onClick: () => void
  }
>(function ModelChoiceRow(
  { label, description, badge, active, tabIndex, onFocus, onKeyDown, onClick },
  ref,
) {
  return (
    <button
      ref={ref}
      role="option"
      aria-selected={active}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={onClick}
      className={`grid min-h-11 w-full grid-cols-[minmax(0,1fr)_18px] items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left transition-colors ${active ? 'bg-accent/[0.06]' : 'hover:bg-bg'}`}
    >
      <span className="min-w-0">
        <span className={`flex min-w-0 items-center gap-1.5 truncate text-[11.5px] font-medium ${active ? 'text-accent' : 'text-text'}`}>
          <span className="truncate">{label}</span>
          {badge && <span className="shrink-0 rounded-full bg-bg px-1.5 py-0.5 text-[8px] font-medium text-text-muted">{badge}</span>}
        </span>
        <span className="mt-0.5 block truncate text-[9.5px] text-text-muted">{description}</span>
      </span>
      <span className={`text-center text-[11px] ${active ? 'text-accent' : 'text-transparent'}`}>✓</span>
    </button>
  )
})

function handleChoiceKey(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  refs: MutableRefObject<Array<HTMLButtonElement | null>>,
  setActiveIndex: (index: number) => void,
  choose: () => void,
  close: () => void,
): void {
  let next: number | undefined
  if (event.key === 'ArrowDown') next = (index + 1) % count
  else if (event.key === 'ArrowUp') next = (index - 1 + count) % count
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
    close()
    return
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    choose()
    return
  } else return

  event.preventDefault()
  setActiveIndex(next)
  refs.current[next]?.focus()
}

function WriterMark({ writer, size = 'compact' }: { writer: Writer; size?: 'compact' | 'regular' }) {
  if (isEngineId(writer)) return <ProviderMark engineId={writer} size={size} />
  const frame = size === 'regular' ? 'size-[30px] rounded-[9px]' : 'size-5 rounded-md'
  const glyphSize = size === 'regular' ? 16 : 12
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center bg-current/10 ${frame} ${writer === 'apple' ? 'text-text-muted' : 'text-text-muted/80'}`}>
      {writer === 'apple' ? <AppleMark size={glyphSize} /> : <PlainMark size={glyphSize} />}
    </span>
  )
}

function AppleMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m5.7 5.7 2.8 2.8M15.5 15.5l2.8 2.8M18.3 5.7l-2.8 2.8M8.5 15.5l-2.8 2.8" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

function PlainMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  )
}

function ReasoningMark() {
  return (
    <svg className="size-3.5 shrink-0 text-accent/90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m5.7 5.7 2.8 2.8M15.5 15.5l2.8 2.8M18.3 5.7l-2.8 2.8M8.5 15.5l-2.8 2.8" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

function ArrowRight() {
  return (
    <svg className="size-3.5 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  )
}
