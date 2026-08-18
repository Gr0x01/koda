/**
 * Which of this project's threads need the user, and how long ago each one was last worked in. The
 * rule lives out here rather than in the sidebar so it stays testable without a store, a window, or an
 * engine — keep it pure.
 *
 * Nothing here is filed by hand: both the grouping and the age read `lastActivityAt`, which the store
 * stamps only at turn boundaries. A thread cannot be marked done, and the map cannot claim a state the
 * user is not actually in.
 */
import type { SessionState, SessionStatus } from './store'
import { sessionNeedsYou } from '@shared/session-attention'

export type SessionGroup = 'active' | 'waiting'

/**
 * Which part of the map a session belongs in.
 *
 * - `waiting` — it needs the user: an approval is pending, the turn stopped on an error, or it reached
 *   a notable state in the background the user hasn't looked at yet.
 * - `active` — everything else.
 *
 * Live work outranks terminal attention, and the order of these arms is the whole rule. `attention` is
 * raised when a BACKGROUNDED thread reaches a notable state and is cleared only by the user opening it,
 * so a thread that reached one and went straight back to work carried it while running — most visibly
 * when a delegated agent outlives the turn that spawned it, which ends the turn (raising the mark) and
 * leaves the thread working. Ranked above the live arm, that thread sat under "Needs you" reporting
 * "Agent still working…", asking for a user who has nothing to do yet, and nothing but a click could
 * move it. A pending approval stays above everything because it needs the user during the work; terminal
 * error and unseen-completion signals wait for work to stop, then re-raise without a click.
 */
export function sessionGroup(session: SessionState, status: SessionStatus): SessionGroup {
  return sessionNeedsYou({
    gate: status === 'waiting',
    working: status === 'thinking' || session.busy,
    terminalError: status === 'error',
    unseenAttention: session.attention,
  })
    ? 'waiting'
    : 'active'
}

export interface GroupedSessions {
  active: SessionState[]
  waiting: SessionState[]
}

/** Split a session list into the map's two parts, preserving the caller's order within each. */
export function groupSessions(
  sessions: SessionState[],
  statusOf: (session: SessionState) => SessionStatus,
): GroupedSessions {
  const grouped: GroupedSessions = { active: [], waiting: [] }
  for (const session of sessions) grouped[sessionGroup(session, statusOf(session))].push(session)
  return grouped
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "just now" / "20 minutes ago" / "3 days ago" — carried by every row that has no live activity, so a
 * thread's age is legible at a glance without a timestamp column and an old thread needs no marking
 * beyond sitting at the bottom of the list saying how old it is.
 *
 * Buckets run from minutes up because an idle row is far more often minutes old than days old; a
 * days-only reading would print "0 days ago" on a thread touched over lunch.
 */
export function ageLabel(lastActivityAt: number | undefined, now: number): string {
  if (lastActivityAt === undefined) return ''
  const elapsed = Math.max(0, now - lastActivityAt)
  if (elapsed < MINUTE) return 'just now'
  const minutes = Math.floor(elapsed / MINUTE)
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(elapsed / HOUR)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.floor(elapsed / DAY)
  if (days < 14) return days === 1 ? 'a day ago' : `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 9) return `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  return months <= 1 ? 'a month ago' : `${months} months ago`
}
