/**
 * Model-picker helpers. Koda can't enumerate the models available to the user (no engine/API surface
 * for it) and must never ship a hardcoded version list, so the picker offers the engine's stable
 * ALIASES plus whatever full ids the user types — and these helpers only PRESENT a model string, they
 * never branch app logic on it (honors the no-model-names rule). Aliases are engine selectors, not
 * version assertions — the same vocabulary `claude --model` and the TUI's `/model` already expose.
 */

/** Per-engine display metadata (brand label, sort order, chart accent) — ONE source so the Usage view,
 *  status bar, and any future engine surface read the same names/colors. These are ENGINE brands, not
 *  model ids, so they're a fixed map (not the no-model-names rule, which is about version assertions). */
interface EngineDisplay {
  label: string
  /** Bare brand name for tight surfaces (footer gauge) where the full "Anthropic · Claude" won't fit. */
  short: string
  order: number
  /** Tailwind bg class for this engine's segment in charts (history bar). */
  accent: string
}
const ENGINE_DISPLAY: Record<string, EngineDisplay> = {
  claude: { label: 'Anthropic · Claude', short: 'Claude', order: 0, accent: 'bg-accent/70' },
  codex: { label: 'OpenAI · Codex', short: 'Codex', order: 1, accent: 'bg-emerald-500/70' },
}
export function engineLabel(id: string): string {
  return ENGINE_DISPLAY[id]?.label ?? id
}
export function engineShort(id: string): string {
  return ENGINE_DISPLAY[id]?.short ?? id
}
export function engineOrder(id: string): number {
  return ENGINE_DISPLAY[id]?.order ?? 99
}
export function engineAccent(id: string): string {
  return ENGINE_DISPLAY[id]?.accent ?? ENGINE_DISPLAY.claude.accent
}

/** Aliases surfaced as quick-picks. Stable engine selectors (always resolve to the current model of
 *  that family); the user types a full id for anything else, including an older fallback. */
export const QUICK_ALIASES: { id: string; label: string }[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]

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
