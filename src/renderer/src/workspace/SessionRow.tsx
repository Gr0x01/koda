import { useEffect, useRef, useState } from 'react'
import { Menu, motion, spring, duration } from '../motion'
import { busyActivity } from './activity'
import type { SessionState, SessionStatus } from './store'
import { StatusIcon } from './SessionStatusIcon'
import { ContextMeter } from './ContextMeter'
import { prettyModel } from './models'

/**
 * One row in the sidebar's Sessions list — a flat Cursor-style entry (status glyph + label + optional
 * dirty chip + fuel gauge), not a bubbly card. No inline close: the sidebar is persistent history, not
 * something to garbage-collect. Rename + Archive live on the right-click menu (mirroring the
 * conversation header's kebab).
 */
export function SessionRow({
  session,
  status,
  active,
  attention,
  dirtyCount,
  onSelect,
  onOpenChanges,
  onRename,
  onArchive,
}: {
  session: SessionState
  status: SessionStatus
  active: boolean
  attention: boolean
  dirtyCount: number
  onSelect: () => void
  onOpenChanges: () => void
  onRename: (name: string) => void
  onArchive: () => void
}) {
  const fresh = session.items.length === 0 && !session.context
  const activity = activityOf(session, status)
  // Ground-truth model (what the engine reported running) falling back to the user's pick before the
  // first turn reports. Undefined only when the Mac hasn't named a model yet — then the meta line just
  // omits it rather than showing a stub.
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

  return (
    <motion.li
      // `layout="position"` slides a row to its new slot when the list reorders (sending a turn bumps
      // its session to the top) — position-only so it doesn't fight the height enter/exit below.
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
      className={`cursor-pointer overflow-hidden rounded-md px-2 py-1 transition-colors ${
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
            className="min-w-0 flex-1 rounded border border-accent/50 bg-bg px-1 py-0 text-[13px] outline-none"
          />
        ) : (
          <span onDoubleClick={startRename} className="min-w-0 flex-1 truncate text-[13px]">
            {session.label}
          </span>
        )}
        {/* This session was started from the phone and adopted into this window — a quiet phone glyph
            so the user knows where it came from. Cleared on next boot (restores as an ordinary tab). */}
        {session.fromRemote && (
          <svg
            viewBox="0 0 24 24"
            aria-label="Started from your phone"
            className="size-3 shrink-0 text-text-muted/70"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>Started from your phone</title>
            <rect x="7" y="2" width="10" height="20" rx="2" />
            <path d="M11 18h2" />
          </svg>
        )}
        {/* Unsaved-changes chip — this session's dirty file count. Click jumps to the Changes tab
            focused on this session's group (not the row's select). Hidden when nothing's unsaved.
            Names the unit ("edits") in the chip itself — a bare number badge on a chat-shaped row
            reads as an unread-message count, and hover text fires only after the misread. */}
        {dirtyCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpenChanges()
            }}
            title={`${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'} — review & save`}
            className="shrink-0 whitespace-nowrap rounded-full bg-accent/12 px-1.5 text-[10.5px] font-semibold tabular-nums text-accent transition-colors hover:bg-accent/20"
          >
            {dirtyCount} {dirtyCount === 1 ? 'edit' : 'edits'}
          </button>
        )}
        {/* The fuel gauge — how the user sees context filling and knows when to start fresh. On the
            title line (Cursor-style), but only once there's fill: an all-empty gauge on every fresh
            row reads as decorative signal bars, not data. */}
        {(session.context?.contextTokens ?? 0) > 0 && (
          <ContextMeter context={session.context} className="shrink-0" />
        )}
      </div>
      {/* Meta line below the title: the live activity (Cursor's "Reading docs") and the model, always
          shown so every row names what it's running. Activity truncates; the model is pinned and dim
          (mono, matching the counters) so it reads as metadata, not the headline. */}
      {(activity || model) && (
        <p className="ml-[23px] -mt-px flex items-center gap-1.5 text-[11px] text-text-muted/80">
          {activity && <span className="min-w-0 truncate">{activity}</span>}
          {activity && model && <span className="shrink-0 opacity-40">·</span>}
          {model && (
            <span className="shrink-0 font-mono text-[10.5px] text-text-muted/70">{prettyModel(model)}</span>
          )}
        </p>
      )}
      <RowContextMenu
        open={!!menu}
        x={menuPos.current.x}
        y={menuPos.current.y}
        onClose={() => setMenu(null)}
        onRename={startRename}
        onArchive={onArchive}
      />
    </motion.li>
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
          title="End this session and put it away. Restore it any time from Settings"
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
