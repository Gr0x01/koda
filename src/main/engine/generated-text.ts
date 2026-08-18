/**
 * Generated text — the shared mechanics behind every small piece of prose Koda asks a model to write
 * ABOUT the user's work rather than for them: a session title, a saved version's description, and the
 * branch names the worktree work will want next.
 *
 * `structured-generation.ts` below this owns the security policy (neutral cwd, non-mutating native
 * containment, no persistence, credentials through `buildEngineEnv()`). This layer owns the part
 * every caller of that primitive was otherwise going to re-type, and get subtly different each time:
 *
 *   1. NEVER THROW, NEVER BLOCK. A generation is a nicety on top of something that already works
 *      (a session has a floor title, a save has a deterministic description). Every failure — no
 *      binary, not signed in, timeout, refusal, unparseable answer — resolves to `null` and lets the
 *      caller keep its floor. A miss is logged at info, never surfaced as an error.
 *   2. AN ENGINE THAT CANNOT SATISFY THE STRUCTURED-GENERATION CONTRACT NEVER SPAWNS. The evidence is
 *      untrusted text and the answer is persisted, so the child gets no project cwd, no persistence,
 *      and no mutation path. Claude removes tools; Codex is ephemeral and read-only. That native
 *      difference stays below this provider-neutral contract.
 *   3. ONE ANSWER SHAPE. The provider adapter removes its native envelope/event stream. The engine is
 *      still not trusted to have obeyed its schema: the normalized payload is handed to the caller's
 *      `read`, and rejected when that says it isn't the thing.
 *
 * Thinking is pinned off unless the user explicitly chose an effort for generated text in Settings.
 * Everything routed through here asks for two lines of JSON, and a one-shot that reasons costs about
 * ten times its answer in output tokens and six times its wall clock in the original naming assay —
 * which is why `off` remains the Claude compatibility default.
 */
import type { EngineEnvOptions } from './env'
import type { EngineId } from './profile'
import type { TextGenerationEffort } from '@shared/ipc'
import { canRunStructuredGeneration, runStructuredGeneration } from './structured-generation'
import { recordTurnUsage } from './usage-history'
import { log } from '../logger'

export interface GeneratedTextSpec<T> {
  /** Log tag for a miss: 'naming', 'version-message', 'branch-name'. */
  what: string
  /** The engine explicitly selected for this generated-text job. */
  engineId: EngineId
  prompt: string
  systemPrompt: string
  jsonSchema: object
  /** The field that proves an object is the payload rather than the CLI envelope wrapping it. */
  ownKey: string
  /** The engine's object → the caller's value, or null when the answer isn't one. */
  read: (obj: Record<string, unknown>) => T | null
  /** The selected engine model id or stable alias, passed through opaquely. */
  model: string
  /** User-selected reasoning budget. Missing means the pre-setting fast path (`off`). */
  effort?: TextGenerationEffort
  /** Wedged-engine backstop, not a budget to plan against: nothing waits on a generation. */
  timeoutMs: number
  /** argv belt against a pasted novel; callers trim their evidence first. */
  promptCap?: number
  /** The selected provider's billing mode: apiMode/apiKey only when that account uses API billing. */
  env?: EngineEnvOptions
  resourcesPath?: string
}

const DEFAULT_PROMPT_CAP = 8000

/**
 * Which engines may run a generation at all. The answer is the driver's own capability
 * (`structuredGeneration`), never an engine-name check here.
 */
export function canGenerateText(engineId: EngineId): boolean {
  return canRunStructuredGeneration(engineId)
}

/** Run one inert generation. Resolves to the caller's value, or `null` for every kind of miss. */
export async function generateStructuredText<T>(spec: GeneratedTextSpec<T>): Promise<T | null> {
  if (!canGenerateText(spec.engineId)) return null
  try {
    const effort = spec.effort ?? 'off'
    const result = await runStructuredGeneration({
      engineId: spec.engineId,
      prompt: spec.prompt.slice(0, spec.promptCap ?? DEFAULT_PROMPT_CAP),
      model: spec.model,
      effort: effort === 'off' ? undefined : effort,
      systemPrompt: spec.systemPrompt,
      jsonSchema: spec.jsonSchema,
      timeoutMs: spec.timeoutMs,
      thinking: effort === 'off' ? 'off' : 'engine-default',
      resourcesPath: spec.resourcesPath,
      env: spec.env,
    })
    // A successful spawn has already paid its provider. The adapter normalized every usage fact the
    // CLI exposed, so this layer neither knows provider field names nor fabricates missing numbers.
    recordTurnUsage(result.models, result.costUsd, spec.engineId)
    const obj = result.output ? firstJsonObject(result.output, spec.ownKey) : null
    const value = obj ? spec.read(obj) : null
    if (value !== null) return value
    log.info(spec.what, 'engine answer unusable', { engineId: spec.engineId })
  } catch (err) {
    // Not signed in, no binary, timeout, a wedged spawn: never worth surfacing an error for.
    log.info(spec.what, 'generation turn failed', {
      engineId: spec.engineId,
      message: (err as Error).message?.slice(0, 200),
    })
  }
  return null
}

/**
 * Phrases that never occur in a real generated line — a refusal, or an instruction the model echoed
 * back instead of following. Shared so a new caller inherits the backstop rather than discovering,
 * months later, that "I'm sorry, I can't help with that" is sitting in the user's git history.
 */
const UNUSABLE =
  /\b(i'?m sorry|i apologi[sz]e|i cannot|i can'?t|as an ai|as a language model|title case|imperative mood|no quotes|json only)\b/i

export function looksLikeRefusal(text: string): boolean {
  return UNUSABLE.test(text)
}

/**
 * Pull the first plausible `{...}` out of a normalized engine answer, unwrapping a JSON-string or
 * fence around it. `ownKey` proves the object is this caller's payload; a syntactically valid but
 * differently shaped object still reads as a miss.
 *
 * Exported because every schema-constrained job validates its normalized payload the same way.
 * `library-ask.ts` is the other direct caller; the parameter keeps it from being naming-shaped.
 */
export function firstJsonObject(raw: string, ownKey: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const direct = JSON.parse(text) as unknown
    if (typeof direct === 'string') return firstJsonObject(direct, ownKey)
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const record = direct as Record<string, unknown>
      return ownKey in record ? record : null
    }
  } catch {
    // A fenced or prefixed answer gets one bounded object extraction below.
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return firstJsonObject(text.slice(start, end + 1), ownKey)
}
