import type { Entry } from './types'

/**
 * How a plumbing step describes itself, in one line. Pure, and shared by the two places that need it:
 * the row inside an open work object, and the strip that stands in for the whole run while it's shut.
 * Both must say the same thing about the same step — a strip that summarized differently from the row
 * it hides is a strip you can't trust to know what it's hiding.
 */

export type StepLabel = {
  /** The doer — a tool's name, or the thinking line's state. */
  name: string
  /** What it was about: the command, the path, the pattern. Empty when there's nothing to add. */
  detail: string
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** A one-line, human-leaning summary of the tool's input for a collapsed header. */
export function summarize(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  // `path` last: Grep/Glob carry both, and the pattern is what the step was actually about.
  const first =
    str(obj, 'file_path') ?? str(obj, 'command') ?? str(obj, 'pattern') ?? str(obj, 'query') ?? str(obj, 'path')
  if (first) return first
  const json = JSON.stringify(input ?? {})
  return json.length > 80 ? json.slice(0, 80) + '…' : json
}

/**
 * What the step was asked to do, in full — the header truncates to one line, and a long command or
 * prompt is exactly what you opened the row to read. Null when the header already said all of it.
 */
const NAMED = ['file_path', 'command', 'pattern', 'query', 'path'] as const

export function detailOf(input: unknown, summary: string): string | null {
  const obj = (input ?? {}) as Record<string, unknown>
  const body =
    str(obj, 'command') ?? str(obj, 'prompt') ?? str(obj, 'description') ?? str(obj, 'pattern') ?? str(obj, 'query')
  const where = str(obj, 'path')
  const full = [body, body && where ? `in ${where}` : where].filter(Boolean).join('\n')
  // The header truncates to one line, so repeating a long command here is the point; repeating a short
  // one is noise.
  if (full) return full === summary && full.length <= 60 ? null : full
  // Nothing Koda has a name for — an MCP tool's arguments, say. The shape itself is the only detail
  // there is, so show it rather than an empty drawer.
  const keys = input && typeof input === 'object' ? Object.keys(obj) : []
  if (!keys.length || keys.some((k) => (NAMED as readonly string[]).includes(k))) return null
  return JSON.stringify(input, null, 2)
}

/** One step, named. Non-plumbing entries have no step label — they carry their own container. */
export function stepLabel(entry: Entry): StepLabel {
  if (entry.kind === 'thinking')
    return {
      name: entry.active ? 'Thinking' : 'Thought',
      detail: entry.estimatedTokens != null ? `~${entry.estimatedTokens.toLocaleString()} tokens` : '',
    }
  if (entry.kind === 'tool') return { name: entry.name, detail: summarize(entry.input) }
  return { name: '', detail: '' }
}

/**
 * What the shut work object says it is holding: the newest step, because that's the one you'd look for.
 * The count rides beside it, so the strip answers both "what is it doing" and "how much did it do".
 */
export function runSummary(entries: readonly Entry[]): StepLabel {
  const last = entries[entries.length - 1]
  return last ? stepLabel(last) : { name: '', detail: '' }
}
