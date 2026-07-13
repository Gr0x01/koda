import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SIDEBAR_MIN_WIDTH } from '@shared/ipc'
import { AnimatePresence, motion, spring } from '../motion'
import { computeSessionChanges, statusOf, useWorkspace } from './store'
import { SessionRow } from './SessionRow'
import { FilesBrowser } from './FilesBrowser'
import { DocsBrowser } from './DocsBrowser'
import { PanelHeader } from './PanelHeader'
import { RecentImages } from './RecentImages'
import { ResizeHandle } from './ResizeHandle'

/**
 * The left sidebar (ui-workspace.md §2/§7/§9) — two stacked, always-visible sections, no tabs:
 * **Sessions** on top (this project's agents as a flat Cursor-style list — status glyph + label +
 * fuel gauge; no bubbly cards, no inline close) and **Files** beneath (the project file tree, so
 * Koda stands alone). Sessions is capped so a long list never crowds the tree off-screen; Files
 * takes the rest. Disposing a session lives in the focused conversation; session history is
 * reference-only. Recovery stays the summoned History drawer (the rail), not here.
 */
export function Sidebar() {
  const width = useWorkspace((s) => s.sidebarWidth)
  const setWidth = useWorkspace((s) => s.setSidebarWidth)
  const frac = useWorkspace((s) => s.sessionsFrac)
  const setFrac = useWorkspace((s) => s.setSessionsFrac)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  const asideRef = useRef<HTMLElement>(null)

  return (
    <aside
      ref={asideRef}
      style={{ width, minWidth: SIDEBAR_MIN_WIDTH }}
      className="relative flex shrink-0 flex-col border-r border-border bg-bg"
    >
      {/* Sessions hugs its rows (a single session no longer reserves a fixed slab); the divider rides
          its live bottom and drags the cap. */}
      <SessionsSection
        maxFrac={frac}
        onResize={(y) => {
          const r = asideRef.current?.getBoundingClientRect()
          if (r) setFrac((y - r.top) / r.height)
        }}
        onResizeEnd={persistLayout}
      />
      <FilesSection />
      {/* Recent screenshots you've handed Claude — a thin strip at the foot of the sidebar; hidden when
          the project has none. Click to view, `+` to re-attach. */}
      <RecentImages />
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

function SessionsSection({
  maxFrac,
  onResize,
  onResizeEnd,
}: {
  maxFrac: number
  onResize: (clientY: number) => void
  onResizeEnd: () => void
}) {
  const order = useWorkspace((s) => s.order)
  const sessions = useWorkspace((s) => s.sessions)
  const activeId = useWorkspace((s) => s.activeId)
  const pending = useWorkspace((s) => s.pending)
  const startSession = useWorkspace((s) => s.startSession)
  const selectSession = useWorkspace((s) => s.selectSession)
  const openChanges = useWorkspace((s) => s.openChanges)
  const renameSession = useWorkspace((s) => s.renameSession)
  const archiveSession = useWorkspace((s) => s.archiveSession)
  const gitFiles = useWorkspace((s) => s.gitFiles)

  const list = order.map((id) => sessions[id]).filter(Boolean)
  // Per-session dirty count for the row chip — the passive "this session has unsaved work" glance,
  // attributed from the aggregate working tree (one git tree, sliced by who edited each file).
  const dirtyBySession = useMemo(
    () => computeSessionChanges(sessions, order, gitFiles).countBySession,
    [sessions, order, gitFiles],
  )

  // The handle is meaningful only when the list overflows its cap — otherwise Sessions hugs its rows
  // and there's no boundary to drag (a free affordance that does nothing reads as broken). We keep it
  // mounted while a drag is in flight so a drag that resolves the overflow doesn't yank pointer capture.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setOverflowing(el.scrollHeight - el.clientHeight > 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [list.length, maxFrac])

  // Size to the rows, but never past `maxFrac` of the sidebar (then the list scrolls) — so a few
  // sessions take only the room they need and Documents gets the rest, while a long list stays capped.
  return (
    <div style={{ maxHeight: `${maxFrac * 100}%` }} className="relative flex min-h-0 shrink-0 flex-col">
      <PanelHeader label="Sessions">
        <button
          onClick={startSession}
          title="Run another agent on this project"
          aria-label="New session"
          className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </PanelHeader>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {list.length === 0 ? (
          <p className="px-2 py-1.5 text-xs leading-relaxed text-text-muted">
            No sessions yet. Start one to begin.
          </p>
        ) : (
          <ul className="flex flex-col">
            {/* initial={false} so existing sessions don't all animate on app load — only genuine
                adds/removes reflow. Rows collapse their height on exit so neighbours slide up. */}
            <AnimatePresence initial={false}>
              {list.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  status={statusOf(s, pending)}
                  active={s.id === activeId}
                  attention={s.attention && s.id !== activeId}
                  dirtyCount={dirtyBySession[s.id] ?? 0}
                  onSelect={() => selectSession(s.id)}
                  onOpenChanges={() => openChanges(s.id)}
                  onRename={(name) => renameSession(s.id, name)}
                  onArchive={() => void archiveSession(s.id)}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      {/* Divider at the section's live bottom edge (the Sessions ⇆ Files boundary). Only shown when the
          list overflows its cap — that's the only time there's a boundary to drag. Drag raises/lowers
          the cap; invisible until hover. */}
      {(overflowing || dragging) && (
        <ResizeHandle
          orientation="horizontal"
          style={{ top: '100%' }}
          onResize={(_, y) => {
            setDragging(true)
            onResize(y)
          }}
          onResizeEnd={() => {
            setDragging(false)
            onResizeEnd()
          }}
        />
      )}
    </div>
  )
}

/**
 * The lower sidebar section. Doc-first by default — a flat **Documents** list (find your writing by
 * glancing) — with a segmented **Docs ⇄ Files** switch to the full file tree (the organize/code view).
 * The switch lives on the header *title* (a mode-switch, the surface's Doc/Markdown/Diff pattern), so
 * the right slot stays pure actions (Find, New document, New folder) — all live in both views; New
 * folder just lands in Documents/ from the doc view and at the project root from the tree.
 */
function FilesSection() {
  const filesView = useWorkspace((s) => s.filesView)
  const setFilesView = useWorkspace((s) => s.setFilesView)
  const newDocument = useWorkspace((s) => s.newDocument)
  const newFolder = useWorkspace((s) => s.newFolder)
  const openSearch = useWorkspace((s) => s.setSearchOpen)
  const docs = filesView === 'docs'
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <PanelHeader title={<DocsFilesToggle docs={docs} onChange={setFilesView} />}>
        <div className="-mr-0.5 flex items-center gap-1.5">
          {/* Find lives with the file actions — it searches files (names + contents + replace), not app settings. */}
          <HeaderIconButton onClick={() => openSearch(true)} title="Find in project (⌘P)" aria-label="Find in project">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </HeaderIconButton>
          <HeaderIconButton onClick={() => void newDocument()} title="New document" aria-label="New document">
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4M9 15h6M12 18v-6" />
          </HeaderIconButton>
          {/* New folder lands at the project root in the tree, and in the user's Documents/ from the
              doc-first view (where their writing lives, so it appears where they expect). */}
          <HeaderIconButton
            onClick={() => void newFolder(undefined, docs)}
            title="New folder"
            aria-label="New folder"
          >
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            <path d="M12 10v6M9 13h6" />
          </HeaderIconButton>
        </div>
      </PanelHeader>
      {docs ? <DocsBrowser /> : <FilesBrowser />}
    </div>
  )
}

/**
 * The Documents ⇄ Files view switch — a segmented control: a `bg-text/5` trough with a ring-edged
 * surface chip that SLIDES to the active cell, active label in full-strength ink. A mode-switch *looks*
 * like a mode-switch — distinct from the action icons (Find, New) beside it, which open/create.
 *
 * The chip slides via a single indicator measured from each button's offset WITHIN the trough (x/size),
 * NOT a shared `layoutId`. A layout-animated chip re-measures against the whole tree and springs
 * vertically every frame the Files section is resized (the Sessions⇆Files drag shifts this header's
 * position) — the jitter bug. Button offsets inside the trough don't change on that resize, so the
 * indicator stays put; it only animates when the active cell actually changes.
 */
function DocsFilesToggle({ docs, onChange }: { docs: boolean; onChange: (v: 'docs' | 'tree') => void }) {
  const opts = [
    { v: 'docs', label: 'Docs', on: docs },
    { v: 'tree', label: 'Files', on: !docs },
  ] as const
  const activeV = docs ? 'docs' : 'tree'
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const troughRef = useRef<HTMLDivElement>(null)
  const [chip, setChip] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // Re-measure only when the active cell changes or the trough's own box does (font swap, not the
  // sidebar's vertical resize — the trough is content-sized inside a fixed-height header).
  useLayoutEffect(() => {
    const measure = () => {
      const btn = btnRefs.current[activeV]
      if (btn) setChip({ x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight })
    }
    measure()
    const el = troughRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [activeV])

  return (
    <div ref={troughRef} className="-ml-0.5 relative flex items-center gap-px rounded-lg bg-text/5 p-0.5">
      {/* Ring edge (lighter than both trough and fill) so the active half reads as a filled segment on
          dark too — plain bg-surface sits darker than the light-overlay trough there and recedes (the
          old "button mashup" look). The ring alone does it; no drop shadow needed. */}
      {chip && (
        <motion.span
          aria-hidden
          initial={false}
          animate={{ x: chip.x, y: chip.y, width: chip.w, height: chip.h }}
          transition={spring.snappy}
          className="pointer-events-none absolute left-0 top-0 rounded-md bg-surface ring-1 ring-border"
        />
      )}
      {opts.map(({ v, label, on }) => (
        <button
          key={v}
          ref={(el) => {
            btnRefs.current[v] = el
          }}
          onClick={() => onChange(v)}
          aria-pressed={on}
          className={`relative z-10 rounded-md px-2.5 py-0.5 font-display text-[11px] font-medium transition-colors ${
            on ? 'text-text' : 'text-text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function HeaderIconButton({
  onClick,
  title,
  'aria-label': ariaLabel,
  children,
}: {
  onClick: () => void
  title: string
  'aria-label': string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}

