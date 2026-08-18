/**
 * Session naming — the title and the one-line overview the sessions map is read from.
 *
 * Koda used to name a thread once from its first prompt. That is fine for a chat archive and wrong for
 * a map: a thread that moves research → build → review → merge kept the name of whatever it opened
 * with, so the left side stopped describing the work. The selected cloud writer now runs a tiny
 * SCHEMA-CONSTRAINED generation in two flavours (T3's initial / regenerate split, research doc →
 * "Special flows"). Apple Intelligence and plain local text keep the dependable initial-title floor;
 * they do not regenerate a title from a framed digest.
 *
 *   initial     — name the thread from its opening request, separating the SUBJECT from incidental
 *                 instructions ("be careful", "run the tests" are not what the work is about).
 *   regenerate  — re-read the accumulated evidence under an explicit hierarchy: the user's messages
 *                 own the subject, what the agent did is supporting evidence, tool output is weakest.
 *                 Stage progression is NOT a subject change; only the user genuinely turning to other
 *                 work is.
 *
 * Two rules shape the mechanics:
 *
 * 1. THE ENGINE OWNS MODEL CALLS (CLAUDE.md). A cloud choice spawns that provider's CLI through
 *    `buildEngineEnv()` and shows up in that account's usage. The Settings picker is the explicit
 *    account choice; Koda never calls a provider API or silently chooses one itself.
 * 2. A MISS NEVER LEAVES A THREAD UNNAMED, AND NEVER RENAMES A NAMED ONE. The two flavours fail
 *    differently, because they start from different places:
 *
 *    - `initial` has no name to protect, so every miss — engine missing, not signed in, timeout,
 *      refusal, unparseable answer — falls through to the caller's floor (the on-device local-assist
 *      title, itself backed by a first-words string). The floor returns no sentence, so `overview`
 *      comes back empty and the row simply shows a title.
 *    - `regenerate` already HAS a name, and its evidence is the caller's framed digest ("What the user
 *      asked for, in order: …"), not a request anyone would want a title cut from. Feeding that to a
 *      first-words floor produces the literal framing as the session name, and feeding it to the
 *      on-device model puts a second, weaker namer in charge of a title the engine one already wrote.
 *      Either way an intermittent engine miss reads to the user as the name changing by itself. So a
 *      regenerate miss returns an EMPTY title and the caller keeps what the session carries.
 *
 *    When the local-assist model is good enough to hold the whole prompt split
 *    (local-assist-roadmap.md), it can take the regenerate path too; until then it never risks naming
 *    a thread after the digest framing.
 *
 * The naming turn is deliberately cheap and INERT: it runs outside the project, cannot mutate it,
 * leaves no conversation behind, uses a small model, ~1k input tokens, and defaults to no extended thinking (measured:
 * $0.004, ~5s on Claude — with thinking left on, the same turn is $0.017 and ~32s, which is a miss
 * against any budget worth setting).
 *
 * Inert is a security property here, not a cost one. The shared structured-generation seam owns the
 * containment once for every caller: a neutral cwd and no persistence for both engines, with tools
 * removed for Claude and an ephemeral read-only Codex exec. No naming caller owns provider flags.
 */
import type { EngineEnvOptions } from './env'
import {
  canGenerateText,
  firstJsonObject,
  generateStructuredText,
  looksLikeRefusal,
} from './generated-text'
import type { EngineId } from './profile'
import type { TextGenerationEffort } from '@shared/ipc'
import { disambiguate } from '../assist/engine'

// The inert spawn, the envelope unwrap, and the never-throw miss policy live in `generated-text.ts`,
// shared with the saved-version description (and, next, branch names). This file owns only what makes
// a NAME: the two prompt flavours, the schema, the cleaning, and the two-sided fallback rule above.

export type NamingKind = 'initial' | 'regenerate'

export interface GeneratedName {
  /** '' when a `regenerate` missed — the caller keeps the name the session already has. Never '' for
   *  an `initial`, which always has the floor beneath it. */
  title: string
  /** One plain sentence, or '' when only the floor could answer. */
  overview: string
}

export interface NamingRequest {
  kind: NamingKind
  /** The engine explicitly chosen for generated text. */
  engineId: EngineId
  /** Stable alias chosen in Settings for generated text. */
  model: string
  /** Reasoning budget chosen beside the model in Settings. */
  effort?: TextGenerationEffort
  /** User messages first, then what the agent did. Assembled by the caller (the renderer owns the
   *  transcript shape); this module only frames it. */
  evidence: string
  /** The name the session carries now; a regenerate keeps it when the subject hasn't moved. */
  currentTitle?: string
  /** Sibling names an answer must not exactly collide with. */
  avoid?: string[]
  /** Provider billing parity: apiMode/apiKey only when the selected provider uses API billing. */
  env?: EngineEnvOptions
  resourcesPath?: string
}

/** The answer shape the naming turn is constrained to (Claude's `--json-schema`). The engine is not
 *  trusted to have obeyed it: the reply is parsed, cleaned, and rejected if it isn't a name. */
export const NAME_JSON_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, overview: { type: 'string' } },
  required: ['title', 'overview'],
  additionalProperties: false,
} as const

/** Shape rules, kept out of the evidence so both flavours share one voice. Length caps are stated in
 *  words because that is what the model can count; the parse below enforces them anyway. */
export const NAME_SYSTEM_PROMPT = [
  'You name a piece of work so a person scanning a list of threads knows what each one is.',
  'Reply with JSON only: {"title": "...", "overview": "..."}.',
  'The title is 2 to 6 words in Title Case. No quotes, no trailing punctuation, no subtitle after a colon.',
  'The overview is ONE plain sentence of at most 18 words, present tense, describing the work itself.',
  'Never mention the assistant, the agent, the model, or this naming task. Never use an em dash.',
].join(' ')

const INITIAL_PROMPT = `This thread has just started. Name it from the opening request below.

The SUBJECT is the thing being worked on. Incidental instructions are not the subject and must not reach the title: how to work, what tone to take, which tools to prefer, "be careful", "run the tests first", "ask me before you change anything". Strip those and name what is actually being made, fixed, or figured out.

If the request is too vague to name anything specific, name the vague thing plainly rather than inventing detail.`

const REGENERATE_PROMPT = `This thread has been running for a while. Re-name it from the evidence below, weighed in this order:

1. The user's own messages own the subject. What the user asked for is what this thread is about.
2. What the agent did is supporting evidence. It sharpens the wording; it never replaces the subject.
3. File names, commands, and tool output are the weakest evidence. They never become the title.

A thread that moves through research, planning, building, review, CI, and merge on the same work HAS NOT CHANGED SUBJECTS. Name the umbrella subject that covers all of it.

Worked examples:
- The user asks why the checkout page loses people, then asks for the fix, then asks for a review and a pull request. The subject is the checkout drop-off from start to finish. "Open A Pull Request" is wrong: the pull request is the last stage of the same subject.
- The user asks to speed up the photo importer, and the agent spends most of the thread reading the database layer. The subject is still the photo importer. "Database Layer Review" is wrong: the reading served the importer.
- The user works on the photo importer, then says "different thing now, my invoices are not sending". The subject genuinely moved. The invoices are the subject now.

Keep the current title when it still covers the work. Change it only when the subject genuinely moved, or when the title was never accurate.`

/** The full user-side prompt for a naming turn. Pure, so the split is testable without an engine. */
export function buildNamingPrompt(req: Pick<NamingRequest, 'kind' | 'evidence' | 'currentTitle'>): string {
  const head = req.kind === 'initial' ? INITIAL_PROMPT : REGENERATE_PROMPT
  const current =
    req.kind === 'regenerate' && req.currentTitle?.trim()
      ? `\n\nCurrent title: ${req.currentTitle.trim()}`
      : ''
  return `${head}${current}\n\n<evidence>\n${req.evidence.trim()}\n</evidence>`
}

/**
 * A schema-constrained answer → a usable name, or null when the engine answered with something that
 * isn't one. Accepts a bare JSON object, a fenced one, or a JSON string wrapping the object (Claude's
 * `--output-format json` carries the answer as a string in `result`); anything else is a miss.
 */
export function parseNamingReply(raw: string): GeneratedName | null {
  const obj = firstJsonObject(raw, 'title')
  return obj ? readName(obj) : null
}

/** The parsed object → a usable name, or null. Split out because the shared generation seam hands the
 *  caller the unwrapped object, while `parseNamingReply` still takes raw text (its tests, and any
 *  future caller holding an answer string). */
function readName(obj: Record<string, unknown>): GeneratedName | null {
  const title = cleanTitle(typeof obj.title === 'string' ? obj.title : '')
  if (!title) return null
  return { title, overview: cleanOverview(typeof obj.overview === 'string' ? obj.overview : '') }
}

/**
 * Generate this session's title + overview (never throws, never rejects). A miss resolves per the
 * header's rule 2: an `initial` falls to `floor`, a `regenerate` returns an empty title so the caller
 * keeps the name the session already carries.
 */
export async function generateSessionName(
  req: NamingRequest,
  floor: (text: string, avoid: string[]) => Promise<string>,
): Promise<GeneratedName> {
  const avoid = req.avoid ?? []
  const engineId = req.engineId
  const missed = async (): Promise<GeneratedName> =>
    req.kind === 'initial'
      ? { title: await floor(req.evidence, avoid), overview: '' }
      : { title: '', overview: '' }
  // Engines that cannot satisfy the shared non-mutating generation contract keep the deterministic
  // floor. Provider-specific containment belongs below this layer.
  if (!canNameOnEngine(engineId)) return missed()
  const named = await runNamingTurn(req, engineId)
  if (!named) return missed()
  return { title: disambiguate(named.title, avoid), overview: named.overview }
}

/** Which engines can run a naming turn under the shared ephemeral, non-mutating contract. The answer
 *  is the driver's capability, not an engine-name check here. */
export function canNameOnEngine(engineId: EngineId): boolean {
  return canGenerateText(engineId)
}

/** A naming turn is one small message (~5s measured), so this is a wedged-engine backstop, not a
 *  budget to plan against. It used to be 45s, which a thinking-enabled turn cleared on a good day and
 *  missed on a normal one; every miss renamed the thread from the floor. `thinking: 'off'` is what
 *  makes the turn fast — this only decides how long a genuinely stuck one may hold the name open, and
 *  nothing waits on it (the caller is fire-and-forget behind a per-session naming epoch). */
const NAMING_TIMEOUT_MS = 90_000
/** argv cap — the evidence is already trimmed by the caller; this is the belt against a pasted novel. */
const PROMPT_CAP = 8000

/** One inert naming turn on the selected engine, through the shared generation seam (which owns
 *  containment, the envelope unwrap, and the never-throw miss). This function owns only
 *  naming's model, prompt, schema and timeout. The model is a stable engine alias selected in
 *  Settings, never a pinned version id. */
function runNamingTurn(req: NamingRequest, engineId: EngineId): Promise<GeneratedName | null> {
  return generateStructuredText<GeneratedName>({
    what: 'naming',
    engineId,
    prompt: buildNamingPrompt(req),
    model: req.model,
    effort: req.effort,
    systemPrompt: NAME_SYSTEM_PROMPT,
    jsonSchema: NAME_JSON_SCHEMA,
    ownKey: 'title',
    read: readName,
    timeoutMs: NAMING_TIMEOUT_MS,
    promptCap: PROMPT_CAP,
    resourcesPath: req.resourcesPath,
    env: req.env,
  })
}

/** A title is a short phrase. Strip the decorations small models add, and reject anything that is
 *  plainly not a name (a refusal, a paragraph, a leaked instruction) so the floor answers instead. */
function cleanTitle(raw: string): string {
  const text = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[.,;:]+$/, '')
    .trim()
  if (!text || looksLikeRefusal(text)) return ''
  return text.split(' ').length > 9 ? '' : text
}

/** One sentence. Over-long or refusal-shaped overviews are dropped rather than shown — a row with a
 *  title and no second line reads fine; a row with a paragraph does not. Em dashes become commas
 *  (Koda's prose rule), which is cheaper than re-asking for one line of copy. */
function cleanOverview(raw: string): string {
  const text = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s*—\s*/g, ', ')
    .trim()
  if (!text || looksLikeRefusal(text)) return ''
  return text.split(' ').length > 30 ? '' : text
}
