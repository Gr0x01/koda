/**
 * Model-picker helpers. Koda can't enumerate the models available to the user (no engine/API surface
 * for it) and must never ship a hardcoded version list, so the picker offers the engine's stable
 * ALIASES plus whatever full ids the user types — and these helpers only PRESENT a model string, they
 * never branch app logic on it (honors the no-model-names rule). Aliases are engine selectors, not
 * version assertions — the same vocabulary `claude --model` and the TUI's `/model` already expose.
 */

import type {
  EngineId,
  ProviderCatalogAvailability,
  ProviderModelCatalogs,
} from '@shared/ipc'

/** Per-engine display metadata (brand label, sort order, chart accent) — ONE source so the Usage view,
 *  status bar, and every model picker read the same names/colors. These are ENGINE brands, not model
 *  ids, so they're a fixed map (not the no-model-names rule, which is about version assertions).
 *
 *  Adding an engine still requires a real driver + capability registration. Once those exist, this
 *  exhaustive record and MODEL_PROVIDERS are the presentation seam: the pickers map the catalog rather
 *  than growing another hard-coded rail/tab layout for every provider. */
export interface EngineDisplay {
  label: string
  /** Bare brand name for tight surfaces (footer gauge) where the full "Anthropic · Claude" won't fit. */
  short: string
  /** Company/account name shown beneath the engine brand in provider choosers. */
  owner: string
  order: number
  /** Tailwind bg class for this engine's segment in charts (history bar). */
  accent: string
}
const ENGINE_DISPLAY: Record<EngineId, EngineDisplay> = {
  claude: {
    label: 'Anthropic · Claude',
    short: 'Claude',
    owner: 'Anthropic',
    order: 0,
    accent: 'bg-accent/70',
  },
  codex: {
    label: 'OpenAI · Codex',
    short: 'Codex',
    owner: 'OpenAI',
    order: 1,
    accent: 'bg-emerald-500/70',
  },
}

/** Provider order in every picker, derived from the exhaustive display record so a newly registered
 *  driver cannot silently exist in one client but disappear from another. */
export const MODEL_PROVIDERS: readonly EngineId[] = (Object.keys(ENGINE_DISPLAY) as EngineId[]).sort(
  (a, b) => ENGINE_DISPLAY[a].order - ENGINE_DISPLAY[b].order,
)

function displayFor(id: string): EngineDisplay | undefined {
  return ENGINE_DISPLAY[id as EngineId]
}

export function engineDisplay(id: EngineId): EngineDisplay {
  return ENGINE_DISPLAY[id]
}
export function engineLabel(id: string): string {
  return displayFor(id)?.label ?? id
}
export function engineShort(id: string): string {
  return displayFor(id)?.short ?? id
}
export function engineOrder(id: string): number {
  return displayFor(id)?.order ?? 99
}
export function engineAccent(id: string): string {
  return displayFor(id)?.accent ?? ENGINE_DISPLAY.claude.accent
}

/** Aliases surfaced as quick-picks. Stable engine selectors (always resolve to the current model of
 *  that family); the user types a full id for anything else, including an older fallback. */
export const QUICK_ALIASES: {
  id: string
  label: string
  description: string
  recommended?: boolean
}[] = [
  { id: 'fable', label: 'Fable', description: 'For your toughest challenges', recommended: true },
  { id: 'opus', label: 'Opus', description: 'For complex work' },
  { id: 'sonnet', label: 'Sonnet', description: 'Efficient for everyday tasks' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest for quick answers' },
]

/** UI-neutral model rows. Both control heads render this same catalog; platform components own only
 *  layout and platform-specific unavailable copy. */
export interface ModelChoice {
  id: string | undefined
  label: string
  description?: string
  badge?: string
}

export interface ModelChoiceContext {
  engineId: EngineId
  model?: string
  activeModel?: string
  recentModels: readonly string[]
  providerCatalogs: ProviderModelCatalogs
}

function defaultChoice(provider: EngineId, context: ModelChoiceContext): ModelChoice {
  return {
    id: undefined,
    label: 'Engine default',
    description:
      provider === context.engineId && !context.model && context.activeModel
        ? `Currently ${prettyModel(context.activeModel)}`
        : `Let ${engineDisplay(provider).short} choose`,
    badge: 'Auto',
  }
}

const MODEL_CHOICE_BUILDERS: Record<
  EngineId,
  (context: ModelChoiceContext) => ModelChoice[]
> = {
  claude: (context) => [
    ...QUICK_ALIASES.map((alias) => ({
      id: alias.id,
      label: alias.label,
      description: alias.description,
      badge: alias.recommended ? 'Recommended' : undefined,
    })),
    ...context.recentModels
      .filter((id) => id !== context.model && !isModelAlias(id))
      .map((id) => ({ id, label: prettyModel(id), description: id })),
    defaultChoice('claude', context),
  ],
  codex: (context) => [
    ...context.providerCatalogs.codex.models.map((item) => ({
      id: item.id,
      label: item.label,
      badge: item.isDefault ? 'Recommended' : undefined,
    })),
    defaultChoice('codex', context),
  ],
}

export function modelChoicesFor(
  provider: EngineId,
  context: ModelChoiceContext,
): ModelChoice[] {
  return MODEL_CHOICE_BUILDERS[provider](context)
}

export function providerAvailability(
  provider: EngineId,
  catalogs: ProviderModelCatalogs,
): ProviderCatalogAvailability {
  return catalogs[provider]?.availability ?? 'checking'
}

/** One shared presentation contract for the desktop and phone reasoning pickers. Values stay verbatim
 *  engine terms; the copy explains the tradeoff without pretending Koda owns their semantics. */
export interface ReasoningEffortOption {
  id: string
  label: string
  description: string
  badge?: string
}

export const REASONING_EFFORTS: readonly ReasoningEffortOption[] = [
  { id: '', label: 'Default', description: 'Let the selected engine decide', badge: 'Engine pick' },
  { id: 'low', label: 'Low', description: 'Quick answers with lighter reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balanced speed and depth' },
  { id: 'high', label: 'High', description: 'More time for complex work' },
  { id: 'xhigh', label: 'X-high', description: 'Very deep reasoning' },
  { id: 'max', label: 'Max', description: 'The most reasoning the engine offers' },
]

export function prettyEffort(effort: string | undefined): string {
  if (!effort) return 'Default'
  return REASONING_EFFORTS.find((option) => option.id === effort)?.label ?? effort
}

/** Every alias the engine accepts — used only to keep aliases OUT of the "recently used" list (they're
 *  always offered, so remembering them is noise). Not exhaustive engine truth, just a dedup heuristic. */
const ALL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'default', 'best', 'opusplan'])

const ALIAS_LABELS: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  default: 'Default',
  best: 'Best',
  opusplan: 'Opus Plan',
}

/** True for a bare engine alias (so the picker doesn't store it as a custom "recently used" id).
 *  Exact match — a variant like `opus[1m]` is NOT a bare alias, so it's still worth remembering. */
export function isModelAlias(id: string): boolean {
  return ALL_ALIASES.has(id.toLowerCase())
}

/**
 * Display-only label for a model id. Aliases get a friendly name; a full id like `claude-opus-4-8`
 * becomes `Opus 4.8` by a GENERIC transform (strip the vendor prefix, title-case the family word,
 * dot-join the trailing numeric version) — it asserts no specific model exists, just formats whatever
 * the engine reported. Anything it can't parse falls through verbatim.
 */
export function prettyModel(id: string): string {
  if (ALIAS_LABELS[id]) return ALIAS_LABELS[id]
  const body = id.replace(/^claude-/, '')
  const m = /^([a-z]+)-(\d+(?:[-.]\d+)*)/.exec(body)
  if (m) {
    // 'gpt' is an initialism (GPT-5.5), not a title-cased word (Opus 4.8).
    const family = m[1] === 'gpt' ? 'GPT' : `${m[1][0].toUpperCase()}${m[1].slice(1)}`
    return `${family} ${m[2].replace(/-/g, '.')}`
  }
  return id
}
