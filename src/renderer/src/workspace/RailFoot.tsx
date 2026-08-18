import { forwardRef, useMemo, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { HoverCard, IconButton, cx } from '../ui'
import { useWorkspace } from './store'

/**
 * The rail's foot — the quiet lines under the session map, one per thing that answers *what exists*
 * rather than *who is working*. Each is a single icon + label + count that discloses its contents in
 * an interactive `HoverCard`: summoned, used, and left, instead of holding permanent rail height.
 *
 * `RailFootLine` is the shared shape (this file's Archived line and `RecentImages` both wear it), and
 * it is a real `<button>` so it satisfies `HoverCard`'s trigger contract — cloned in place, host
 * element, focusable, so the card opens on keyboard focus as well as hover.
 */

export interface RailFootLineProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode
  label: string
  count: number
}

export const RailFootLine = forwardRef<HTMLButtonElement, RailFootLineProps>(function RailFootLine(
  { icon, label, count, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'flex w-full shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left text-[11.5px]',
        'text-text-muted outline-none transition-colors hover:bg-surface hover:text-text',
        'focus-visible:bg-surface focus-visible:text-text',
        className,
      )}
      {...rest}
    >
      <span aria-hidden className="shrink-0 opacity-80">
        {icon}
      </span>
      {label}
      <span className="ml-auto text-[10.5px] tabular-nums opacity-60">{count}</span>
    </button>
  )
})

/** How many archived chats the card lists before handing off to Settings. Enough to cover "I just
 *  archived the wrong thing" and the day around it; past that the full screen is the right surface. */
const CARD_CAP = 6

/**
 * **Archived** — the way back. Archiving is a one-click verb on a session row, so the return trip
 * cannot stay four clicks deep in Settings; this line is that loop closed. Renders nothing at all
 * until something is archived, so an ordinary project never sees it.
 *
 * Every row carries its own visible **Restore** (the shipped word — see `settings/ArchivedSection`).
 * A card whose only verb hides behind a second hover would rebuild the problem the card exists to
 * solve. Permanent delete and retention stay in Settings: this is retrieval, not management.
 */
export function ArchivedFoot() {
  const archived = useWorkspace((s) => s.archived)
  const restoreArchived = useWorkspace((s) => s.restoreArchived)
  const openSettingsTo = useWorkspace((s) => s.openSettingsTo)

  // Sorted here rather than trusted from the store: archiving prepends, but a boot hydrate merges a
  // cold-store index whose order is the file's, and "most recent first" is the card's whole premise.
  const recent = useMemo(
    () => [...archived].sort((a, b) => b.archivedAt - a.archivedAt).slice(0, CARD_CAP),
    [archived],
  )
  if (archived.length === 0) return null
  const hidden = archived.length - recent.length

  return (
    <HoverCard
      interactive
      heading="Archived"
      ariaLabel="Archived chats"
      width={296}
      trigger={
        <RailFootLine
          icon={<IconArchive />}
          label="Archived"
          count={archived.length}
          aria-label={`Archived chats (${archived.length})`}
          onClick={() => openSettingsTo('archived')}
        />
      }
    >
      <ul className="flex flex-col">
        {recent.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-bg">
            <span className="min-w-0 flex-1 truncate text-[12px] text-text">{a.label}</span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-text-muted">
              {shortAge(a.archivedAt)}
            </span>
            {/* Icon, not the word: six rows of "Restore" read as a wall of buttons rather than a list
                of chats, and restoring is cheap and reversible, so it does not need to announce
                itself. Always visible, never behind a further hover: the card exists to restore
                things, so hiding its only verb would rebuild the problem it solves. The label names
                WHICH chat, so it stays unambiguous to a screen reader. */}
            <IconButton
              size="sm"
              label={`Restore ${a.label}`}
              className="shrink-0"
              onClick={() => void restoreArchived(a.id)}
            >
              <RotateCcw className="size-3.5" aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => openSettingsTo('archived')}
        className="mt-2 w-full border-t border-border pt-2 text-left text-[11px] text-text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
      >
        {hidden > 0 ? `${hidden} more in Settings` : 'Manage archived chats in Settings'}
      </button>
    </HoverCard>
  )
}

/** A compact age for a narrow card row — "2d", "3w", "1mo". Settings has room for the "x ago" phrase;
 *  this sits beside a title and a button in 296px, so it trades the words for the digits. */
function shortAge(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.round(days / 30)
  return months < 12 ? `${months}mo` : `${Math.round(days / 365)}y`
}

function IconArchive() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="4" width="19" height="4.5" rx="1" />
      <path d="M4.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4" />
    </svg>
  )
}
