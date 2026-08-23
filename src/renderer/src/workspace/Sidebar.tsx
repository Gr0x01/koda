import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SIDEBAR_MIN_WIDTH } from '@shared/ipc'
import { AnimatePresence, motion, spring, duration } from '../motion'
import { HoverCard } from '../ui'
import { computeSessionChanges, statusOf, useWorkspace, type SessionState } from './store'
import { ageLabel, groupSessions } from './session-map'
import { SessionRow } from './SessionRow'
import { StarredDocumentsShelf } from './KeptDocs'
import { PanelHeader, PanelHeaderIconButton } from './PanelHeader'
import { ArchivedFoot } from './RailFoot'
import { RecentImages } from './RecentImages'
import { ResizeHandle } from './ResizeHandle'

/**
 * The left rail. Sessions remain its primary map of *who is working*. A deliberately small Starred documents
 * section follows that map for project objects the person chose to keep close; the full set of what
 * exists is still summoned, used, and left.
 *
 * That rule is what removed the Files tree from here. An unfiltered directory listing (`build`, `out`,
 * `release`, `.DS_Store`) is an IDE explorer in a product whose users will not read code —
 * files are reached through Find (⌘P) and documents through the Library (⌘K), both overlays. What
 * follows the map is the project's starred-document shelf. History stays pinned below the scrolling
 * navigation as its own named section; Archived chats and Recent images disclose their contents in
 * the existing anchored cards without being pressed against the global footer.
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
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionsHeader />
        {/* One scrolling navigation flow: sessions → starred documents. History stays outside this
            scroll owner so the way back remains reachable without colliding with global controls. */}
        <SessionMap />
      </div>
      <HistorySection />
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
 * Sessions owns the rail head. The project name already lives in the window title and cannot change
 * within this window, so repeating it here spends the strongest navigation position on inert context.
 */
function SessionsHeader() {
  const startSession = useWorkspace((s) => s.startSession)

  return (
    <PanelHeader
      title={
        <h2
          id="sessions-heading"
          className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Sessions
        </h2>
      }
    >
      <div className="-mr-1">
        <HoverCard
          trigger={
            <PanelHeaderIconButton onClick={() => startSession()} aria-label="New chat">
              <path d="M12 5v14M5 12h14" />
            </PanelHeaderIconButton>
          }
        >
          Start another chat in this project (⌘T).
        </HoverCard>
      </div>
    </PanelHeader>
  )
}

function HistorySection() {
  return (
    <section aria-labelledby="history-heading" className="mt-auto shrink-0 px-1.5 pb-3 pt-2">
      <h2
        id="history-heading"
        className="px-2 pb-1 pt-2 font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted"
      >
        History
      </h2>
      <ArchivedFoot />
      <RecentImages />
    </section>
  )
}

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
  // clears its attention, so it rejoins the ordinary session rows a frame later), and the map has to move
  // a row between parts without the row leaving the DOM. See the render for why that matters.
  const items = useMemo(() => {
    const out: MapItem[] = []
    const part = (label: string, group: SessionState[]): void => {
      if (group.length === 0) return
      out.push({ kind: 'heading', key: `heading:${label}`, label })
      for (const session of group) out.push({ kind: 'row', key: session.id, session })
    }
    part('Needs you', grouped.waiting)
    for (const session of grouped.active) out.push({ kind: 'row', key: session.id, session })
    return out
  }, [grouped])

  return (
    // `layoutScroll` so a row's slide is measured against the scrolled list, not the viewport —
    // without it a reorder while the map is scrolled animates from the wrong place.
    <motion.div layoutScroll className="min-h-0 flex-1 overflow-y-auto pb-2">
      <section aria-labelledby="sessions-heading" className="px-1.5">
        {list.length === 0 ? (
          <p className="px-2 py-1.5 text-xs leading-relaxed text-text-muted">
            No chats yet. Start one to begin.
          </p>
        ) : (
        /*
         * Needs-you first: an approval or a stopped turn is the only thing here the user has to act
         * on, and burying it under this morning's threads is what made the flat list read as an
         * archive. Needs you keeps one subordinate caption only when it exists; Sessions names the
         * ordinary list once at the top. Everything else is one recency list, and
         * a dormant thread is marked by nothing but its own age text — it sinks to the bottom and
         * stays reachable, rather than being filed away for the user.
         *
         * ONE list and ONE AnimatePresence for both parts, not a list per part. Clicking a row under
         * Needs you clears its attention, which is exactly what moves it into the ordinary rows — so the map
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
                    <h3 className="px-2 pb-1 pt-2 font-display text-[10px] font-semibold uppercase tracking-wider text-text-muted/70">
                      {item.label}
                    </h3>
                  </MapHeading>
                ),
              )}
            </AnimatePresence>
          </ul>
        )}
      </section>
      {/* Project-wide document shortcuts are a sibling section immediately after the sessions, never
          a bottom utility. Its heading remains so the Library action is reachable with no stars. */}
      <StarredDocumentsShelf />
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
