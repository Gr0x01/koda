/**
 * Local-assist engine — the backend-swappable seam for Koda's QoL micro-tasks (session titles,
 * humanized safety-git recovery labels). Tier-1 backend = Apple Foundation Models via a tiny signed
 * Swift helper (spawn-per-call; the OS keeps the on-device model warm across processes, ~300ms).
 *
 * Electron-free on purpose (testable in isolation, like adapter.ts). The Electron wiring (settings
 * toggle, helper-path resolution, IPC) lives in the thin layer that constructs this.
 *
 * Contract: `assist()` NEVER throws and ALWAYS returns a usable string. Anything that isn't a clean
 * model answer — toggle off, model unavailable, helper missing, timeout, bad JSON — falls through to
 * the deterministic floor. "Apple FM if available, else first-words / raw label" (local-assist-roadmap).
 *
 * Roadmap note: this is where the `local-gguf` backend slots in later (another branch behind the same
 * `generate()` boundary) and where non-Mac inherits it. Don't widen the public surface for that yet.
 */
import { execFile } from 'node:child_process'

export type AssistTask = 'title' | 'label'

export interface AssistEngineOpts {
  /** Absolute path to the compiled Swift helper, or null when there's no backend (non-mac / not built). */
  helperPath: string | null
  /** The user's toggle (Apple-style: default-on when available, one switch to disable). */
  enabled: () => boolean
  /** Per-call ceiling. Generous: tasks are background, but a wedged helper must never hang a caller. */
  timeoutMs?: number
}

type Availability = 'unknown' | 'available' | 'unavailable'

interface HelperOk {
  ok: true
  output: string
}
interface HelperErr {
  ok: false
  reason: string
}

export class AssistEngine {
  private availability: Availability = 'unknown'
  private readonly timeoutMs: number

  constructor(private readonly opts: AssistEngineOpts) {
    this.timeoutMs = opts.timeoutMs ?? 8000
    // No backend → permanently deterministic; never attempt a spawn.
    if (!opts.helperPath) this.availability = 'unavailable'
  }

  /** True only when the model has answered at least once. The renderer can show the toggle either way. */
  isAvailable(): boolean {
    return this.availability === 'available'
  }

  /**
   * Produce a clean string for `task` from `input`. Always resolves to something usable.
   * The smart path is attempted only when enabled AND not already known-unavailable.
   * `avoid` (titles only): sibling-session names — an answer that exactly collides gets a date
   * suffix so two same-topic sessions never share a name. The list is deliberately NOT shown to the
   * model: measured on-device, the ~3B model ignores "don't use these names" on identical inputs, so
   * divergence comes from the substance-digest input plus this deterministic floor.
   */
  async assist(task: AssistTask, input: string, avoid: string[] = []): Promise<string> {
    const out = await this.generate(task, input)
    return task === 'title' ? disambiguate(out, avoid) : out
  }

  private async generate(task: AssistTask, input: string): Promise<string> {
    const fallback = deterministic(task, input)
    if (!this.opts.enabled() || this.availability === 'unavailable') return fallback

    const result = await this.runHelper(task, input)
    if (result?.ok) {
      this.availability = 'available'
      const out = tidy(task, result.output)
      // The model answered, but "answered" isn't "usable": the on-device model sometimes refuses or
      // echoes its own instructions on bug-report-shaped input. Rejecting → the floor keeps that
      // apology text from being stored verbatim as the session name.
      return out.length > 0 && !looksUnusable(out) ? out : fallback
    }
    // A hard "unavailable:*" signal latches off (no AI on this machine / this run); transient
    // "error:*" or a spawn miss does NOT latch — it might be a one-off, so stay 'unknown' and retry next time.
    if (result && result.reason.startsWith('unavailable:')) this.availability = 'unavailable'
    return fallback
  }

  private runHelper(task: AssistTask, input: string): Promise<HelperOk | HelperErr | null> {
    const { helperPath } = this.opts
    if (!helperPath) return Promise.resolve(null)
    return new Promise((resolve) => {
      execFile(
        helperPath,
        // Cap the argv arg: a huge pasted prompt would blow ARG_MAX (E2BIG → spawn fail → fallback).
        // A title/label only needs the opening anyway. The deterministic floor still sees full input.
        [task, input.slice(0, 4000)],
        { timeout: this.timeoutMs, maxBuffer: 1 << 16 },
        (err, stdout) => {
          if (err) return resolve(null) // spawn miss / timeout / nonzero — treat as transient
          try {
            const parsed = JSON.parse(stdout.trim()) as HelperOk | HelperErr
            resolve(parsed && typeof parsed.ok === 'boolean' ? parsed : null)
          } catch {
            resolve(null)
          }
        },
      )
    })
  }
}

/**
 * Defensive cleanup of a model answer: strip wrapping quotes and a stray trailing terminator that
 * small models sometimes add despite instructions. Does NOT truncate — the model's title is kept
 * whole (length is already bounded by the helper's token budget); the UI ellipsizes visually when
 * it doesn't fit, so we never chop real words out of the stored name.
 */
function tidy(_task: AssistTask, raw: string): string {
  return recase(
    raw
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/[.,;:]+$/, '')
      .trim(),
  )
}

/**
 * The on-device model is asked for Title Case but small models sometimes SHOUT the whole answer
 * ("GUARDIANSHIP OF CLAUDE"), which then gets stored verbatim as the session name. Fix only the
 * unambiguous shout: a multi-word phrase with zero lowercase letters. That leaves genuine mixed-case
 * titles ("iPhone Cloud Launch") and a lone acronym ("API") alone — those aren't the bug.
 */
const MINOR_WORD = /^(a|an|and|as|at|but|by|for|in|of|on|or|the|to|vs|via|with)$/i
function recase(text: string): string {
  if (!/\s/.test(text) || /[a-z]/.test(text)) return text
  const words = text.split(/(\s+)/) // keep separators so spacing survives
  let word = 0
  return words
    .map((seg) => {
      if (/^\s+$/.test(seg)) return seg
      const first = word++ === 0
      const lower = seg.toLowerCase()
      if (!first && MINOR_WORD.test(seg)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/**
 * Backstop against a model answer that came back clean-shaped but isn't a real title/label: an Apple
 * FM refusal ("I'm sorry, but as an AI…"), a leaked instruction fragment ("Title Case, no quotes…"),
 * or a run-on sentence. Titles and labels are single-line short phrases, so anything multi-line, long,
 * or carrying a refusal/meta phrase is rejected — the caller falls through to the deterministic floor.
 * Phrases here are chosen to never occur in a genuine 2–8 word name, so real titles aren't caught.
 */
function looksUnusable(text: string): boolean {
  if (/[\n\r]/.test(text)) return true
  if (text.split(/\s+/).filter(Boolean).length > 9) return true
  return /\b(i'?m sorry|i apologi[sz]e|i cannot|i can'?t|i can not|as an ai|as a (chat)?bot|as a language model|cannot (comply|assist|fulfil|help)|no quotes|title case|trailing punctuation)\b/i.test(
    text,
  )
}

/**
 * Collision floor for titles: when the answer (model or deterministic) exactly matches a sibling
 * session's name, a date suffix tells them apart. This is the only hard guarantee of distinct names —
 * it also covers assist-off machines, where the deterministic first-words title would otherwise
 * repeat identically forever.
 */
function disambiguate(title: string, avoid: string[]): string {
  const norm = (t: string): string => t.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!avoid.some((a) => norm(a) === norm(title))) return title
  return `${title} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/**
 * The always-available floor. Title = first few words of the request (ellipsized); label = the
 * request itself, whitespace-collapsed (already the user's own words — what safety-git stores today).
 */
export function deterministic(task: AssistTask, input: string): string {
  const clean = input.replace(/\s+/g, ' ').trim()
  if (task === 'label') return clean || 'checkpoint'

  // First few words of the prompt as a plain short name (the agreed no-AI floor). Unlike a real
  // model title this is a raw sentence fragment, so when we clip it we append an ellipsis — otherwise
  // a mid-sentence cut ("…edits pill in") reads as a broken or half-saved title, not a short one.
  const words = clean.split(' ').filter(Boolean)
  if (words.length === 0) return 'Untitled'
  return words.length <= 8 ? clean : `${words.slice(0, 8).join(' ')}…`
}
