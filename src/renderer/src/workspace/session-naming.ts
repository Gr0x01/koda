/**
 * What a naming turn gets to see, and when it runs again.
 *
 * The engine side owns the prompt split (main/engine/naming.ts); this side owns the evidence and the
 * cadence, because only the renderer holds the transcript. Two rules matter here:
 *
 * - The EVIDENCE HIERARCHY is built into the material, not just asserted in the prompt: the user's own
 *   messages go first and whole, what the agent did follows as a short tail. A naming turn that reads
 *   mostly tool output writes titles about tool output.
 * - REGENERATION IS RARE ON PURPOSE. A thread is re-named at a few crossings, not every turn: the name
 *   should stop moving once the work has a shape, and each turn spends a (small) piece of the user's
 *   plan. A user rename ends regeneration for good — `userNamed` is checked by every caller.
 *
 * Pure, so both rules are testable without a store or an engine.
 */
import type { Entry } from '../transcript/Transcript'

/** How many of the user's own messages the naming turn reads (the newest ones, oldest first). */
const MAX_USER_MESSAGES = 8
const USER_MESSAGE_CAP = 400
/** The tail of what the agent actually did — supporting evidence, deliberately smaller than the above. */
const AGENT_TAIL_CAP = 900

/**
 * Turn counts at which a thread is re-named: after its first turn has an answer, then at the crossings
 * where a thread has plausibly grown past its opening subject. Sparse and fixed, so a long thread costs
 * a handful of tiny turns over its life rather than one per turn.
 */
export function shouldRegenerateName(userTurns: number): boolean {
  if (userTurns <= 1) return false
  return userTurns === 2 || userTurns === 5 || (userTurns > 5 && userTurns % 10 === 0)
}

/** The user's own messages in this thread — the evidence that owns the subject. */
export function userMessages(items: Entry[]): string[] {
  return items
    .filter((item): item is Extract<Entry, { kind: 'user' }> => item.kind === 'user')
    .map((item) => item.text.trim())
    .filter((text) => text && text !== '(image)')
}

/**
 * The naming turn's material. `user messages` first (newest `MAX_USER_MESSAGES`, in the order they were
 * sent, so a thread reads as a story), then one short tail of what the agent last did.
 */
export function namingEvidence(items: Entry[]): string {
  const asked = userMessages(items)
    .slice(-MAX_USER_MESSAGES)
    .map((text) => `- ${clip(text, USER_MESSAGE_CAP)}`)
  const lastReply = [...items]
    .reverse()
    .find((item): item is Extract<Entry, { kind: 'assistant' }> => item.kind === 'assistant')
  const parts: string[] = []
  if (asked.length) parts.push(`What the user asked for, in order:\n${asked.join('\n')}`)
  if (lastReply?.markdown.trim())
    parts.push(`What the agent did most recently:\n${clip(lastReply.markdown.trim(), AGENT_TAIL_CAP)}`)
  return parts.join('\n\n')
}

function clip(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`
}
