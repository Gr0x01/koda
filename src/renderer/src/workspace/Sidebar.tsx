import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { SIDEBAR_MIN_WIDTH } from '@shared/ipc'
import { AnimatePresence, motion, spring, duration } from '../motion'
import { HoverCard } from '../ui'
import { computeSessionChanges, statusOf, useWorkspace, type SessionState } from './store'
import { ageLabel, groupSessions } from './session-map'
import { SessionRow } from './SessionRow'
import { DocumentsShelf } from './KeptDocs'
import { openLibrary } from './library/LibraryHost'
import { PanelHeader } from './PanelHeader'
import { ArchivedFoot } from './RailFoot'
import { RecentImages } from './RecentImages'
import { ResizeHandle } from './ResizeHandle'

/**
 * The left rail. Sessions remain its primary map of *who is working*. A deliberately small Documents
 * section follows that map for project objects the person chose to keep close; the full set of what
 * exists is still summoned, used, and left.
 *
 * That rule is what removed the Files tree from here. An unfiltered directory listing (`build`, `out`,
 * `release`, `.DS_Store`) is an IDE explorer in a product whose users will not read code —
 * files are reached through Find (⌘P) and documents through the Library (⌘K), both overlays. What
 * follows the map is the project's document shelf. Two quiet foot lines stay pinned below the
 * scrolling navigation and disclose their contents on hover: **Archived**, the way back from a
 * one-click archive, and **Recent images**.
 */
export function Sidebar() {
  const width = useWorkspace((s) => s.sidebarWidth)
  const setWidth = useWorkspace((s) => s.setSidebarWidth)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  const asideRef = useRef<HTMLElement>(null)

  return (
    <aside
      ref={asideRef}
      style={{ width, minWidth: SIDEBAR_MIN_WIDTH }}
      className="relative flex shrink-0 flex-col border-r border-border bg-bg"
    >
      <RailHeader />
      {/* One scrolling navigation flow: Needs you → Active → Documents. The shelf belongs immediately
          after the sessions it helps, while the two utility rows remain pinned at the foot. */}
      <SessionMap />
      <div className="mt-auto">
        <ArchivedFoot />
        <RecentImages />
      </div>
      {/* Drag the sidebar ⇆ main split (over the right border). */}
      <ResizeHandle
        orientation="vertical"
        onResize={(x) => {
          const left = asideRef.current?.getBoundingClientRect().left ?? 0
          setWidth(x - left)
        }}
        onResizeEnd={persistLayout}
      />
    </aside>
  )
}

/**
 * The rail's head: this window's project, and the one action that starts work in it.
 *
 * Deliberately **no chevron and no picker** — Koda is one project per window, so a caret would promise
 * switching that does not exist. The Library button is the only visible door to the document surface
 * (⌘K is otherwise a keystroke you have to already know), which is why it sits beside the `+` rather
 * than leaving with the Files section it used to head.
 */
function RailHeader() {
  const projectPath = useWorkspace((s) => s.projectPath)
  const startSession = useWorkspace((s) => s.startSession)
  const name = projectPath ? basename(projectPath) : 'No project'

  return (
    <PanelHeader
      title={
        <div className="flex min-w-0 items-center gap-2 text-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted" aria-hidden>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          <h2 className="min-w-0 truncate text-[12px] font-medium">{name}</h2>
        </div>
      }
    >
      <div className="-mr-1 flex items-center gap-0.5">
        <HoverCard
          trigger={
            <HeaderIconButton onClick={openLibrary} aria-label="Browse documents">
              <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5Z" />
              <path d="M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H9" />
              <path d="m17.4 6.6 2.2 12.1" />
            </HeaderIconButton>
          }
        >
          Your documents, by title (⌘K).
        </HoverCard>
        <HoverCard
          trigger={
            <HeaderIconButton onClick={() => startSession()} aria-label="New chat">
              <path d="M12 5v14M5 12h14" />
            </HeaderIconButton>
          }
        >
          Start another chat in this project (⌘T).
        </HoverCard>
      </div>
    </PanelHeader>
  )
}

/** An icon-only header action. `forwardRef` + `...rest` because `HoverCard` clones its trigger in
 *  place and needs the underlying element (see HoverCard's header for the contract). Not `IconButton`:
 *  that primitive carries a native `title=`, which is exactly what `HoverCard` replaces. */
const HeaderIconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function HeaderIconButton({ children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted outline-none transition-colors hover:bg-surface hover:text-text focus-visible:bg-surface focus-visible:text-text"
        {...rest}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {children}
        </svg>
      </button>
    )
  },
)

function SessionMap() {
  const order = useWorkspace((s) => s.order)
  const sessions = useWorkspace((s) => s.sessions)
  const activeId = useWorkspace((s) => s.activeId)
  const pending = useWorkspace((s) => s.pending)
  const selectSession = useWorkspace((s) => s.selectSession)
  const openChanges = useWorkspace((s) => s.openChanges)
  const renameSession = useWorkspace((s) => s.renameSession)
  const archiveSession = useWorkspace((s) => s.archiveSession)
  const gitFiles = useWorkspace((s) => s.gitFiles)
  const completionBySession = useWorkspace((s) => s.completionBySession)

  const list = useMemo(() => order.map((id) => sessions[id]).filter(Boolean), [order, sessions])
  // Per-session dirty count for the row chip — the passive "this session still has loose work" glance,
  // attributed from the aggregate working tree (one git tree, sliced by who edited each file).
  const dirtyBySession = useMemo(
    () => computeSessionChanges(sessions, order, gitFiles, completionBySession).countBySession,
    [sessions, order, gitFiles, completionBySession],
  )
  // The clock behind every row's age label, re-read on a timer rather than every render. One clock per
  // render keeps the whole list's reading consistent with itself.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(tick)
  }, [])
  const grouped = useMemo(
    () => groupSessions(list, (s) => statusOf(s, pending)),
    [list, pending],
  )

  // Flatten both parts into ONE ordered item list — headings included — so the whole map renders as a
  // single presence tree. Grouping is a derived, moment-to-moment fact (selecting a Needs-you row
  // clears its attention, so it belongs under Active a frame later), and the map has to be able to move
  // a row between parts without the row leaving the DOM. See the render for why that matters.
  const items = useMemo(() => {
    const out: MapItem[] = []
    const part = (label: string, group: SessionState[]): void => {
      if (group.length === 0) return
      out.push({ kind: 'heading', key: `heading:${label}`, label })
      for (const session of group) out.push({ kind: 'row', key: session.id, session })
    }
    part('Needs you', grouped.waiting)
    part('Active', grouped.active)
    return out
  }, [grouped])

  return (
    // `layoutScroll` so a row's slide is measured against the scrolled list, not the viewport —
    // without it a reorder while the map is scrolled animates from the wrong place.
    <motion.div layoutScroll className="min-h-0 flex-1 overflow-y-auto pb-2">
      <div className="px-1.5">
        {list.length === 0 ? (
          <p className="px-2 py-1.5 text-xs leading-relaxed text-text-muted">
            No chats yet. Start one to begin.
          </p>
        ) : (
        /*
         * Needs-you first: an approval or a stopped turn is the only thing here the user has to act
         * on, and burying it under this morning's threads is what made the flat list read as an
         * archive. Every nonempty part keeps its heading, so Active remains as legible as Needs you
         * and Documents even when no chat needs attention. Everything else is one recency list, and
         * a dormant thread is marked by nothing but its own age text — it sinks to the bottom and
         * stays reachable, rather than being filed away for the user.
         *
         * ONE list and ONE AnimatePresence for both parts, not a list per part. Clicking a row under
         * Needs you clears its attention, which is exactly what moves it to Active — so the map
         * re-groups on the click that selects. Rendered as sibling presence trees, that move was an
         * unmount here and a mount there: the row collapsed to zero height in one part while a copy
         * of itself grew back in another, and every other row's layout animation ran against the
         * two-phase result. Keyed by session id in one tree it is a plain reorder, which `layout` on
         * the row slides. Headings animate the same way so a part appearing or emptying pushes its
         * neighbours instead of teleporting them.
         */
          <ul className="flex flex-col">
            <AnimatePresence initial={false}>
              {items.map((item) =>
                item.kind === 'row' ? (
                  <SessionRow
                    key={item.key}
                    session={item.session}
                    status={statusOf(item.session, pending)}
                    active={item.session.id === activeId}
                    attention={item.session.attention && item.session.id !== activeId}
                    dirtyCount={dirtyBySession[item.session.id] ?? 0}
                    completion={completionBySession[item.session.id]}
                    age={ageLabel(item.session.lastActivityAt, now)}
                    onSelect={() => selectSession(item.session.id)}
                    onOpenChanges={() => openChanges(item.session.id)}
                    onRename={(name) => renameSession(item.session.id, name)}
                    onArchive={() => void archiveSession(item.session.id)}
                  />
                ) : (
                  <MapHeading key={item.key}>
                    <h3 className="px-2 pb-1 pt-2 font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                      {item.label}
                    </h3>
                  </MapHeading>
                ),
              )}
            </AnimatePresence>
          </ul>
        )}
      </div>
      {/* Project-wide document shortcuts are a sibling section immediately after Active, never a
          bottom utility. Renders nothing until something is starred. */}
      <DocumentsShelf />
    </motion.div>
  )
}

/** How often the map re-reads the clock (see `now` above). A minute, because the age labels have
 *  minute granularity — a slower tick prints "3 minutes ago" on a row that went quiet eight ago. */
const AGE_TICK_MS = 60 * 1000

/**
 * One entry in the flattened map: a caps heading or a session row. Grouping is done with space and
 * type — no boxes, no rules between the parts (a border here would claim a section boundary the eye
 * already gets from the gap).
 */
type MapItem =
  | { kind: 'heading'; key: string; label: string }
  | { kind: 'row'; key: string; session: SessionState }

/** A heading in the map's one list: same fade + height-collapse as a row, so a part that appears or
 *  empties pushes its neighbours instead of popping in and out of the flow under them. */
function MapHeading({ children }: { children: ReactNode }) {
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ ...spring.snappy, opacity: { duration: duration.fast } }}
      className="overflow-hidden"
    >
      {children}
    </motion.li>
  )
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}
