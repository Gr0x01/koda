// Shared primitives used both by SourceControl.tsx and the sub-components it imports.
// Extracted here to break the import cycle: sub-components can't import from SourceControl.tsx
// because SourceControl.tsx imports them.
import { useState, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { GitStatusFile } from '@shared/ipc'
import { motion, cardVariants } from '../../motion'

// ── Section chrome ────────────────────────────────────────────────────────────────────
export function Section({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  return (
    <div className="border-t border-border pt-2 pb-1 first:border-t-0">
      <div className="flex items-baseline gap-1.5 px-3 pb-1">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </h3>
        {count !== undefined && count > 0 && (
          <span className="text-[11px] tabular-nums text-text-muted/50">{count}</span>
        )}
      </div>
      {children}
    </div>
  )
}

// ── File list row ─────────────────────────────────────────────────────────────────────
export function FileButton({
  file,
  active,
  onClick,
  title,
  trailing,
  onOpen,
  onReveal,
  onDiscard,
}: {
  file: GitStatusFile
  active: boolean
  onClick: () => void
  title: string
  /** Optional right-aligned cue (e.g. "shown above ↑" tying the row to the staged diff). */
  trailing?: ReactNode
  /** Open the actual file in the editor (read/edit) — surfaces a hover button + a menu item. */
  onOpen?: () => void
  /** Reveal the file in Finder — menu item only (a Mac table-stakes, not a hot action). */
  onReveal?: () => void
  /** When set, a hover-revealed discard control appears; returns error copy, or null on success. */
  onDiscard?: () => Promise<string | null>
}) {
  // A right-click menu carries the full action set (see / open / reveal / undo) so nothing is buried
  // behind hover-only affordances — the hover buttons are the fast path, the menu is the discoverable one.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const hasActions = !!(onOpen || onReveal || onDiscard)
  const name = basename(file.path)

  // Row is a container (not one big button) so each action can be its own click target next to the
  // name — a button can't nest inside a button. The name area keeps the whole diff-opening click.
  return (
    <div
      onContextMenu={
        hasActions
          ? (e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY })
            }
          : undefined
      }
      className={`group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors ${
        active ? 'bg-surface text-text' : 'text-text-muted hover:bg-surface'
      }`}
    >
      <button
        onClick={onClick}
        title={title}
        className={`flex min-w-0 flex-1 items-center gap-2 text-left transition-colors ${
          active ? 'text-text' : 'hover:text-text'
        }`}
      >
        <StatusGlyph status={file.status} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {trailing}
      {/* Hover-revealed fast path: an explicit "see what changed" eye (the row click, made legible),
          then "open the file", then discard. All share the right edge and fade in on row hover. */}
      {hasActions && !trailing && (
        <RowIconButton onClick={onClick} title={`See what changed in ${name}`} label="See what changed">
          <EyeIcon />
        </RowIconButton>
      )}
      {onOpen && (
        <RowIconButton onClick={onOpen} title={`Open ${name}`} label={`Open ${name}`}>
          <FileOpenIcon />
        </RowIconButton>
      )}
      {onDiscard && <DiscardControl label={name} onDiscard={onDiscard} />}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'See what changed', onClick },
            ...(onOpen ? [{ label: 'Open the file', onClick: onOpen }] : []),
            ...(onReveal ? [{ label: 'Reveal in Finder', onClick: onReveal }] : []),
            ...(onDiscard
              ? [{ label: 'Undo this change', danger: true, onClick: () => void onDiscard() }]
              : []),
          ]}
        />
      )}
    </div>
  )
}

// A quiet hover-revealed icon button on a file row — shares the ✕ discard's fade-in-on-row-hover feel
// so the whole action cluster reads as one thing. Focusable independently for keyboard reach.
function RowIconButton({
  onClick,
  title,
  label,
  children,
}: {
  onClick: () => void
  title: string
  label: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={label}
      className="shrink-0 rounded p-0.5 text-text-muted/60 opacity-0 transition-all hover:text-accent focus:opacity-100 group-hover:opacity-100"
    >
      {children}
    </button>
  )
}

// A right-click menu for a file row, positioned at the cursor and clamped inside the viewport. A
// full-screen transparent layer behind it closes on any outside click. Mirrors FileTree's ContextMenu
// styling so the two menus read as the same object.
function RowMenu({
  x,
  y,
  onClose,
  items,
}: {
  x: number
  y: number
  onClose: () => void
  items: { label: string; danger?: boolean; onClick: () => void }[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const pad = 8
    setPos({
      x: Math.max(pad, Math.min(x, window.innerWidth - el.offsetWidth - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - el.offsetHeight - pad)),
    })
  }, [x, y])
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <motion.div
        ref={ref}
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        style={{ top: pos.y, left: pos.x, transformOrigin: 'top left' }}
        onClick={(e) => e.stopPropagation()}
        className="absolute min-w-[160px] overflow-hidden rounded-lg border border-border bg-bg py-1 text-xs shadow-pop"
      >
        {items.map((it) => (
          <button
            key={it.label}
            onClick={() => {
              onClose()
              it.onClick()
            }}
            className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface ${
              it.danger ? 'text-red-400' : 'text-text'
            }`}
          >
            {it.label}
          </button>
        ))}
      </motion.div>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

function FileOpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
    </svg>
  )
}

// A quiet per-row discard: an ✕ that surfaces on row hover (or focus), a light inline "Discard? Yes /
// Keep" confirm (no modal — it's recoverable from the timeline), then a brief busy state. On failure it
// shows a retryable label rather than a toast. Success just lets the row vanish on the next git refresh.
function DiscardControl({
  label,
  onDiscard,
}: {
  label: string
  onDiscard: () => Promise<string | null>
}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const [err, setErr] = useState<string | null>(null)

  async function run(): Promise<void> {
    setPhase('busy')
    setErr(null)
    const msg = await onDiscard()
    if (msg) {
      setErr(msg)
      setPhase('idle')
    }
    // success → the file leaves the changes list on refresh; this row unmounts, no reset needed.
  }

  if (phase === 'busy') {
    return <span className="shrink-0 text-[10px] text-text-muted">Removing…</span>
  }
  if (phase === 'confirm') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[10px]">
        <span className="text-text-muted">Discard?</span>
        <button onClick={run} className="font-medium text-red-400 transition-colors hover:text-red-300">
          Yes
        </button>
        <button
          onClick={() => setPhase('idle')}
          className="text-text-muted transition-colors hover:text-text"
        >
          Keep
        </button>
      </span>
    )
  }
  if (err) {
    return (
      <button
        onClick={() => {
          setErr(null)
          setPhase('confirm')
        }}
        title={err}
        className="shrink-0 text-[10px] text-red-400 transition-colors hover:text-red-300"
      >
        Couldn't — retry
      </button>
    )
  }
  return (
    <button
      onClick={() => setPhase('confirm')}
      title={`Discard changes to ${label}`}
      aria-label={`Discard changes to ${label}`}
      className="shrink-0 rounded p-0.5 text-text-muted/60 opacity-0 transition-all hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  )
}

// ── Status glyph ──────────────────────────────────────────────────────────────────────
const GLYPH: Record<GitStatusFile['status'], { ch: string; cls: string; title: string }> = {
  modified: { ch: 'M', cls: 'text-amber-500', title: 'Modified' },
  added: { ch: 'A', cls: 'text-emerald-500', title: 'Added' },
  deleted: { ch: 'D', cls: 'text-red-500', title: 'Deleted' },
  renamed: { ch: 'R', cls: 'text-accent', title: 'Renamed' },
  untracked: { ch: 'U', cls: 'text-emerald-500', title: 'New (untracked)' },
  other: { ch: '•', cls: 'text-text-muted', title: 'Changed' },
}

export function StatusGlyph({ status }: { status: GitStatusFile['status'] }) {
  const g = GLYPH[status]
  return (
    <span
      className={`w-3 shrink-0 text-center font-mono text-[11px] font-semibold ${g.cls}`}
      title={g.title}
    >
      {g.ch}
    </span>
  )
}

// ── Path helpers ──────────────────────────────────────────────────────────────────────
export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

export function shortRoot(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}
