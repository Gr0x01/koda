import { useCallback } from 'react'
import { Button, cx } from '../ui'
import { useWorkspace } from './store'
import { doorFromLabels, followSession } from './session-href'

/**
 * "From Launch planning" — a document's provenance, rendered as a DOOR back into the conversation it
 * came out of. The id is read from the file's own `source:` frontmatter (written once at creation,
 * see doc-frontmatter.ts), so it survives the rename or move that would orphan a sidecar entry.
 *
 * Placement belongs to the caller (a Library row, a doc header, a citation list); this component owns
 * only what the affordance says and what following it does. It renders nothing at all when the
 * document has no recorded source, which is most documents in an existing project.
 *
 * All three states carry the shared button's `px-2.5` so they occupy the same box and a list can align
 * them as one column. A caller placing this UNDER body text wants `className="-ml-2.5"` to cancel that
 * padding, so the word "From" sits on the same left edge as the prose it annotates.
 *
 * The four states are the point. A door that no longer opens must SAY so before it is clicked, and
 * both inputs are already in the store, so it can:
 *   • **live** — the chat is open. Clicking selects it.
 *   • **archived** — the chat is closed but kept, and the cold index still holds its name. Clicking
 *     reopens it. Said out loud on the face of the affordance, because a chat the user deliberately
 *     put away should not slide back into the sidebar unannounced.
 *   • **gone** — deleted by hand or purged by the retention window, so the label is unrecoverable.
 *     Rendered as plain text, not a control: there is nowhere to go, and offering a click that can
 *     only fail is worse than saying the truth in the same space.
 *   • **unknown** — the archive index could not be read, so absence is not evidence of deletion.
 */
export function DocProvenance({
  source,
  className,
}: {
  /** `ProjectDoc['source']` — the originating session id, absent for a doc made before the
   *  convention or with no chat in front of the user. */
  source?: string
  className?: string
}): React.JSX.Element | null {
  const sessionLabel = useWorkspace((s) => (source ? s.sessions[source]?.label : undefined))
  const archivedLabel = useWorkspace((s) =>
    source ? s.archived.find((a) => a.id === source)?.label : undefined,
  )
  const archiveLoadFailed = useWorkspace((s) => s.archiveLoadFailed)

  const follow = useCallback(() => {
    if (source) void followSession(source, useWorkspace.getState)
  }, [source])

  if (!source) return null
  const door = doorFromLabels(sessionLabel, archivedLabel, archiveLoadFailed)

  if (door.status === 'gone')
    return (
      <span
        className={cx(
          'inline-block max-w-full truncate px-2.5 py-1 text-[12px] font-medium text-text-muted',
          className,
        )}
        title="That chat was deleted, so there is nothing left to open."
      >
        From a chat that is no longer here
      </span>
    )

  if (door.status === 'unknown')
    return (
      <span
        className={cx(
          'inline-block max-w-full truncate px-2.5 py-1 text-[12px] font-medium text-text-muted',
          className,
        )}
        title="Koda could not check archived chats."
      >
        From a chat Koda cannot check right now
      </span>
    )

  const archived = door.status === 'archived'
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={follow}
      title={archived ? 'Reopen this archived chat' : 'Open the chat this came from'}
      // The visible text leads the accessible name (voice control matches what it can see), then the
      // sentence says what following it does — "From Launch planning" alone doesn't read as an action.
      aria-label={`From ${door.label}.${archived ? ' Reopens this archived chat.' : ' Opens the chat this document came from.'}`}
      className={cx('inline-flex max-w-full items-center gap-1', className)}
    >
      <span className="flex-none">From</span>
      <span className="truncate">{door.label}</span>
      {archived && <span className="flex-none opacity-60">· archived</span>}
    </Button>
  )
}
