/**
 * The session door: the href vocabulary that turns a recorded session id into somewhere the user can
 * GO, plus the resolution that decides whether that door still opens.
 *
 * Why this exists at all: a document's `source:` frontmatter records which conversation it came out of
 * (doc-frontmatter.ts), and a caption reading "From Launch planning" is worth little compared with
 * landing the user back in the conversation where the decision was made. That is the one thing no
 * other document tool can offer, because no other tool was in the room.
 *
 * Two rules this module exists to keep:
 *
 *   • **Provenance outlives its session.** Frontmatter is permanent; chats archive, get deleted, and
 *     get purged by the retention window. So every read of a session id resolves through
 *     `resolveSessionDoor` FIRST, and the four answers are all real: live, archived (still nameable,
 *     still restorable), unknown while the archive index is unreadable, and gone. A surface that assumes `sessions[id]` exists renders a caption
 *     that lies or a button that dead-ends.
 *   • **The state is knowable before the click.** Both inputs (`sessions`, `archived`) are already in
 *     the renderer's store, so an affordance can say "that chat is no longer here" instead of
 *     accepting a click and swallowing it. Only the markdown-link path (StageLinks.tsx) learns at
 *     click time, and it owns saying so.
 *
 * Pure on purpose: no React, no store import, no IPC. The store is passed in as a getter so this is
 * testable with plain objects, and so `followSession` can re-read state after an await.
 *
 * **The rule.** Anything in the renderer that turns a stored session id into a place to go routes
 * through here: `sessionHref`/`parseSessionHref` for the href, `resolveSessionDoor`/`doorFromLabels`
 * for the state, `followSession` for the navigation, `followRefusalCopy` for what to say when it
 * can't. A surface that reads `sessions[id]` directly has quietly decided that archived and deleted
 * are the same thing, which is the bug this module exists to prevent. Two tripwires, both empty today:
 *
 *     rg -n "status: 'gone'" src/renderer/src --glob '!**\/session-href*'
 *     rg -n "koda:\/\/session" src shared --glob '!**\/session-href*' --glob '!**\/StageLinks.tsx'
 *
 * The first catches a second copy of the ladder; the second catches an href assembled by hand.
 */

/** The portable href vocabulary is shared with the phone. This module remains the owner of desktop
 * door resolution and re-exports the shared builders so existing callers keep one route. */
import { parseSessionHref, sessionHref, SESSION_HREF_PREFIX } from '@shared/stage-links'
export { parseSessionHref, sessionHref, SESSION_HREF_PREFIX }

/**
 * What a recorded session id points at NOW.
 *
 * `archived` is deliberately its own answer rather than being folded into `gone`: the cold archive
 * index keeps each chat's `label` on its light metadata (session-store.ts splits the transcript body
 * off, not the name), so an archived chat is still nameable AND still restorable. Most pointers that
 * look dead are only asleep, and collapsing the two would throw that away.
 */
export type SessionDoor =
  | { status: 'live'; label: string }
  | { status: 'archived'; label: string }
  | { status: 'unknown' }
  | { status: 'gone' }

/** The slice of workspace state a door needs. Structural so callers pass `useWorkspace.getState` and
 *  tests pass a literal. */
export interface SessionDoorState {
  sessions: Record<string, { label: string }>
  archived: { id: string; label: string }[]
  /** The archive index was present but unreadable. Absence from `archived` is not proof of deletion. */
  archiveLoadFailed?: boolean
}

export function resolveSessionDoor(sessionId: string, state: SessionDoorState): SessionDoor {
  return doorFromLabels(
    state.sessions[sessionId]?.label,
    state.archived.find((a) => a.id === sessionId)?.label,
    state.archiveLoadFailed,
  )
}

/**
 * The ladder itself, for a caller that already holds the two labels. A list of documents subscribes
 * per row and must select PRIMITIVES out of the store (a selector returning a fresh object re-renders
 * on every unrelated store write, and the session store is rewritten on a ~500ms debounce while a turn
 * streams), so it can't hand `resolveSessionDoor` the whole state. Same ordering, one implementation.
 */
export function doorFromLabels(live?: string, archived?: string, archiveUnavailable = false): SessionDoor {
  if (live !== undefined) return { status: 'live', label: live }
  if (archived !== undefined) return { status: 'archived', label: archived }
  if (archiveUnavailable) return { status: 'unknown' }
  // Deleted from the archive, purged by the retention window, or written by a different project's
  // window and carried here by a moved file. All three are the same fact to a reader: the label is
  // unrecoverable, because deleting an archive unlinks its body and drops its only index row.
  return { status: 'gone' }
}

/** What happened when a door was followed. Every branch is reportable — the caller decides where to
 *  say it, and `gone`/`unavailable` must never render as silence. */
export type FollowOutcome = 'opened' | 'reopened' | 'gone' | 'unreadable' | 'unavailable'

/** The actions a door needs, on top of the state it reads. */
export interface SessionDoorStore extends SessionDoorState {
  selectSession: (id: string) => void
  restoreArchived: (id: string) => Promise<void>
}

/**
 * Walk through the door. Takes a GETTER because reopening an archived chat is async and the state has
 * to be re-read afterwards: `restoreArchived` resolves either way, and its one failure mode (the
 * saved transcript can't be read) deliberately leaves the chat archived rather than half-reopening
 * it. Re-checking is how that failure becomes `unreadable` instead of a click that appeared to work.
 */
export async function followSession(
  sessionId: string,
  getState: () => SessionDoorStore,
): Promise<FollowOutcome> {
  const store = getState()
  const door = resolveSessionDoor(sessionId, store)
  if (door.status === 'gone') return 'gone'
  if (door.status === 'unknown') return 'unavailable'
  if (door.status === 'live') {
    store.selectSession(sessionId)
    return 'opened'
  }
  await store.restoreArchived(sessionId)
  // restoreArchived already fronts the reopened chat; selecting again would fight it.
  return getState().sessions[sessionId] ? 'reopened' : 'unreadable'
}

/**
 * What a followed door says when it can't deliver, or null when saying it is somebody else's job.
 * Lives here rather than in the surface so an outcome and its wording stay one thing: a new outcome
 * that nobody writes copy for shows up as a missing case, not as a click that goes quiet.
 *
 * Only `gone` has copy, and only because nothing else in the app owns that sentence. It names what
 * happened rather than blaming the click, because a chat the user (or the retention window) deleted is
 * not a mistake they made.
 */
export function followRefusalCopy(outcome: FollowOutcome): string | null {
  switch (outcome) {
    case 'gone':
      return 'That chat is no longer here. It was deleted, so Koda has nothing left to open.'
    case 'unreadable':
      // Already spoken for, and more loudly: a failed restore raises `archiveRestoreFailed`, which the
      // data-integrity banner renders across the top of the window ("Koda couldn't reopen an archived
      // chat. Nothing moved and nothing was lost."). A second sentence about one failure is noise.
      return null
    case 'unavailable':
      return "Koda can't check archived chats right now, so it can't tell whether that chat is still there."
    case 'opened':
    case 'reopened':
      return null
  }
}
