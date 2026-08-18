import { useEffect, useRef, useState } from 'react'
import { Clock, Cpu, Fuel, Smartphone, TriangleAlert } from 'lucide-react'
import { Menu, motion, spring, duration } from '../motion'
import { HoverCard, type HoverCardFact } from '../ui'
import { busyActivity } from './activity'
import type { SessionState, SessionStatus } from './store'
import { StatusIcon } from './SessionStatusIcon'
import { prettyModel } from './models'
import { EngineMark } from './EngineMark'
import type { TaskCompletionState } from '@shared/ipc'

/**
 * One row in the sidebar's Sessions list. Disclosure over density: the title line carries only the
 * status glyph and the label, the meta line under it carries live activity (or age) plus which engine
 * this thread runs on, and everything else that used to crowd the title — loose files, needs-check,
 * unversioned, the context meter, the model name, the phone glyph — moved into a `HoverCard` that
 * opens on the row itself. The row's only hover-revealed VERB is Archive; Rename stays right-click
 * only, mirroring the conversation header's kebab.
 */
export function SessionRow({
  session,
  status,
  active,
  attention,
  dirtyCount,
  completion,
  age,
  onSelect,
  onOpenChanges: _onOpenChanges,
  onRename,
  onArchive,
}: {
  session: SessionState
  status: SessionStatus
  active: boolean
  attention: boolean
  dirtyCount: number
  completion?: TaskCompletionState
  /** "20 minutes ago" — how long this thread has been quiet, shown in place of live activity. Empty
   *  only for a session Koda has never observed activity in. */
  age?: string
  onSelect: () => void
  /** Unused since the loose-files chip moved into the hover card (facts are read-only there); kept so
   *  the prop shape matches Sidebar.tsx's call site. */
  onOpenChanges: () => void
  onRename: (name: string) => void
  onArchive: () => void
}) {
  const fresh = session.items.length === 0 && !session.context
  const activity = activityOf(session, status)
  // Ground-truth model (what the engine reported running) falling back to the user's pick before the
  // first turn reports. Undefined only when the Mac hasn't named a model yet.
  const model = session.activeModel ?? session.model
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Retain the last cursor coords through the close animation — `menu` goes null the frame the exit
  // starts, but AnimatePresence keeps the menu mounted, so it still needs a position to shrink from.
  const menuPos = useRef({ x: 0, y: 0 })
  if (menu) menuPos.current = menu
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(session.label)

  function startRename(): void {
    setDraft(session.label)
    setRenaming(true)
  }
  function commitRename(): void {
    const name = draft.trim()
    if (name && name !== session.label) onRename(name)
    setRenaming(false)
  }

  const pctContext = session.context?.contextWindow
    ? Math.round((session.context.contextTokens / session.context.contextWindow) * 100)
    : undefined
  const completionWarning = completionWarningText(completion)

  // Everything that used to crowd the title line, read out on hover instead — "hover means what was
  // true all along". Order matches the approved mock: model, context fill, loose files, the completion
  // warning, phone origin, age. Branch/worktree are dropped — SessionState carries neither yet.
  const facts: HoverCardFact[] = []
  if (model) facts.push({ icon: <Cpu size={13} />, value: prettyModel(model), label: 'Model' })
  if (pctContext !== undefined) facts.push({ icon: <Fuel size={13} />, value: `${pctContext}% of context used` })
  if (dirtyCount > 0) {
    facts.push({
      icon: <TriangleAlert size={13} />,
      value: `${dirtyCount} ${dirtyCount === 1 ? 'file' : 'files'} not yet saved`,
      warn: true,
    })
  }
  if (completionWarning) facts.push({ icon: <TriangleAlert size={13} />, value: completionWarning, warn: true })
  if (session.fromRemote) facts.push({ icon: <Smartphone size={13} />, value: 'Started from your phone' })
  if (age) facts.push({ icon: <Clock size={13} />, value: age, label: 'Last activity' })

  return (
    <HoverCard
      trigger={
        <motion.li
          // `layout="position"` slides a row to its new slot when the list reorders (sending a turn
          // bumps its session to the top) — position-only so it doesn't fight the height enter/exit
          // below.
          layout="position"
          // Enter/exit: fade + height-collapse so adding/removing a session reflows the list smoothly
          // instead of popping. `height: auto` settles via spring; opacity is a quick fade.
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ ...spring.snappy, opacity: { duration: duration.fast } }}
          onClick={onSelect}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          className={`group relative cursor-pointer overflow-hidden rounded-md px-2 py-1 transition-colors ${
            active
              ? 'bg-surface text-text'
              : attention
                ? 'text-accent hover:bg-surface/60'
                : 'text-text-muted hover:bg-surface/60 hover:text-text'
          }`}
        >
          <div className="flex items-center gap-2">
            <StatusIcon status={status} fresh={fresh} attention={attention} />
            {renaming ? (
              <input
                autoFocus
                value={draft}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') setRenaming(false)
                }}
                onBlur={commitRename}
                className="min-w-0 flex-1 rounded border border-accent/50 bg-bg px-1 py-0 text-[13px] outline-none transition-[padding-right] group-hover:pr-[78px]"
              />
            ) : (
              // Right padding grows on row hover so the label truncates BEFORE the Archive button
              // instead of running underneath it (RB-approved mock: ~78px, transitioned).
              <span
                onDoubleClick={startRename}
                className="min-w-0 flex-1 truncate text-[13px] transition-[padding-right] group-hover:pr-[78px]"
              >
                {session.label}
              </span>
            )}
          </div>
          {/* Meta line: live activity (or age, once quiet) on the left, truncating; which engine this
              thread runs on pinned right. Everything else that lived here — the model name included —
              moved into the hover card. */}
          {(activity || age) && (
            <p className="ml-[23px] -mt-px flex items-center gap-1.5 text-[11px] text-text-muted/80">
              <span className="min-w-0 truncate">{activity ?? age}</span>
              <EngineMark
                engineId={session.engineId}
                className={active ? 'opacity-100' : 'opacity-70 group-hover:opacity-100'}
              />
            </p>
          )}
          {/* The overview: one generated sentence saying what this thread is ABOUT, which is what turns
              a list of names into a map. Hidden while the agent is working — a live activity line is
              more useful than a summary of the thread in that moment — and while renaming. */}
          {session.overview && !activity && !renaming && (
            <p className="ml-[23px] mt-px line-clamp-2 text-[11px] leading-snug text-text-muted/70">
              {session.overview}
            </p>
          )}
          {/* The row's one hover-revealed verb. Archive is non-destructive (restorable from Settings),
              so it's a plain single click — no confirm. Rename stays right-click only (below). */}
          <div className="pointer-events-none absolute right-1.5 top-1 flex items-center opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onArchive()
              }}
              // Ghost at rest: this sits on top of the row's own title, so a filled chip competes with
              // the name it is covering. The fill arrives only when the pointer is on the verb itself.
              className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-text/[0.08] hover:text-text"
            >
              Archive
            </button>
          </div>
          <RowContextMenu
            open={!!menu}
            x={menuPos.current.x}
            y={menuPos.current.y}
            onClose={() => setMenu(null)}
            onRename={startRename}
            onArchive={onArchive}
          />
        </motion.li>
      }
      heading={session.label}
      facts={facts}
    />
  )
}

/**
 * The session row's right-click menu — Rename + Archive, mirroring the conversation header's kebab.
 * Cursor-anchored (fixed coords, so it escapes the sessions list's scroll clip), scale-fades via the
 * shared `Menu` motion preset (grows from the cursor corner, animates closed), and self-dismisses on
 * outside pointerdown, Escape, or scroll/resize. Archive is non-destructive (the conversation is kept,
 * restorable from Settings), so it's a plain single click — no confirm.
 */
function RowContextMenu({
  open,
  x,
  y,
  onClose,
  onRename,
  onArchive,
}: {
  open: boolean
  x: number
  y: number
  onClose: () => void
  onRename: () => void
  onArchive: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    // Outside pointerdown / scroll / resize / Escape dismiss. Clicks INSIDE are left alone so a menu
    // button's own onClick lands (it closes the menu itself) — mirrors the header kebab's containment.
    const onDown = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onShift = (): void => onClose()
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onShift, true)
    window.addEventListener('resize', onShift)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onShift, true)
      window.removeEventListener('resize', onShift)
    }
  }, [open, onClose])

  // Keep the menu on-screen: nudge up/left when it would overflow the viewport (est. 160×92 box).
  const left = Math.min(x, window.innerWidth - 160)
  const top = Math.min(y, window.innerHeight - 92)

  return (
    <Menu
      open={open}
      origin="origin-top-left"
      style={{ position: 'fixed', left, top }}
      className="z-30 w-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-pop"
    >
      <div ref={ref}>
        <button
          onClick={() => {
            onClose()
            onRename()
          }}
          className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-bg"
        >
          Rename
        </button>
        <div className="my-1 border-t border-border" />
        <button
          onClick={() => {
            onClose()
            onArchive()
          }}
          className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-bg"
        >
          Archive session
        </button>
      </div>
    </Menu>
  )
}

/** A human one-liner for what the session is doing now — drives the row's second line. Null when
 *  idle (the row stays compact). Derived from the live turn state + the in-flight tool. */
function activityOf(s: SessionState, status: SessionStatus): string | null {
  if (status === 'waiting') return 'Needs your approval'
  if (status === 'error') return 'Stopped'
  if (status !== 'thinking') return null
  return busyActivity(s)
}

/** The completion badges' sentences, unchanged — just relocated from a title attribute into a hover
 *  fact. Gated on `paths.length` like the badges they replace: a needs-check state over zero
 *  attributed paths asks the user to check nothing. */
function completionWarningText(completion?: TaskCompletionState): string | null {
  if (!completion || completion.paths.length === 0) return null
  if (completion.state === 'needs-check') {
    return completion.reason === 'checkpoint-failed'
      ? "Koda couldn't take a recovery point for this turn, so these files have no restore point"
      : "Koda couldn't read this project's Git status, so these files may be attributed wrong"
  }
  if (completion.state === 'unversioned') {
    return 'This session changed files, but this project has no permanent version history'
  }
  return null
}
