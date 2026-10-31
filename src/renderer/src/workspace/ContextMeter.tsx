import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ContextUsage } from '@shared/ipc'
import { MessageSquarePlus, Shrink } from 'lucide-react'
import { Menu } from '../motion'

/**
 * The context-window meter (ui-workspace.md §7a) — the careful-engineer signal a non-engineer
 * lacks: how full is the conversation, and when to stop / start fresh. `ContextReadout` shows the
 * focused session's percentage and expandable token breakdown; `SegmentBar` supplies the shared
 * pixel gauge used by the desktop and phone.
 * The category split (`/context` system-prompt/tools/memory) isn't in the headless stream, so the
 * breakdown shows what the engine DOES report: fresh vs cached input, output, cost.
 */

const GREEN = 0.6
const AMBER = 0.85

function ratioOf(c: ContextUsage): number | null {
  if (!c.contextWindow) return null
  return Math.min(1, c.contextTokens / c.contextWindow)
}

/** The conversation is nearly full (red zone) — the point where continuing in the same session starts
 *  to cost speed and quality, so the "keep going in a fresh chat" handoff is worth offering. */
export function contextFull(c?: ContextUsage): boolean {
  if (!c) return false
  const r = ratioOf(c)
  return r !== null && r >= AMBER
}

/** The compact handoff action, shown beside the context meter only once context is nearly full. Asks
 *  the agent for a summary and carries it into a fresh session (see store.continueInFreshChat). */
export function ContinueFreshButton({
  context,
  busy,
  onClick,
}: {
  context?: ContextUsage
  busy?: boolean
  onClick: () => void
}) {
  if (!contextFull(context)) return null
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title="This chat is getting long. Carry a summary into a fresh chat to keep going fast."
      aria-label="Continue in a fresh chat"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40"
    >
      <MessageSquarePlus size={14} aria-hidden />
    </button>
  )
}

/** Closes an open popover on an outside press or Escape. The trigger lives inside `ref`, so its own
 *  toggle press is not "outside". Listens only while open. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, close])
}

/** A compaction locks the composer until the engine finishes, so a stray press must not start one.
 *  Cancel takes focus: Enter right after a misclick backs out instead of committing. */
function CompactConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="whitespace-normal font-sans">
      <p className="text-[12px] font-medium text-text">Compact this chat?</p>
      <p className="mt-0.5 text-[11px] leading-snug text-text-muted">
        The earlier conversation becomes a summary. You can send again when it finishes.
      </p>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          autoFocus
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 text-[12px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] text-white transition-opacity hover:opacity-90"
        >
          Compact
        </button>
      </div>
    </div>
  )
}

/** Compact in place, always beside the meter once there is a conversation to summarize. Quieter than
 *  the handoff button because it is the routine choice: the chat keeps going where it is. */
export function CompactButton({
  context,
  busy,
  active,
  onClick,
}: {
  context?: ContextUsage
  busy?: boolean
  /** A compaction is running. The button stays put and pulses, so the press visibly did something. */
  active?: boolean
  onClick: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setConfirming(false), [])
  useDismiss(confirming, ref, close)
  if (!context && !active) return null
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setConfirming((v) => !v)}
        disabled={busy}
        title={
          active
            ? 'Compacting this chat…'
            : 'Compact this chat. The earlier conversation is replaced with a summary to free up room.'
        }
        aria-label={active ? 'Compacting this chat' : 'Compact this chat'}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-hover hover:text-text ${
          active ? 'text-accent' : 'text-text-muted disabled:opacity-40'
        }`}
      >
        <Shrink size={13} aria-hidden className={active ? 'animate-pulse' : undefined} />
      </button>
      <Menu
        open={confirming && !busy}
        origin="origin-bottom-right"
        className="absolute bottom-full right-0 z-10 mb-1.5 w-60 rounded-xl border border-border bg-surface p-3 shadow-pop"
      >
        <CompactConfirm
          onCancel={close}
          onConfirm={() => {
            setConfirming(false)
            onClick()
          }}
        />
      </Menu>
    </div>
  )
}

function fillClass(ratio: number): string {
  if (ratio < GREEN) return 'bg-emerald-500'
  if (ratio < AMBER) return 'bg-amber-500'
  return 'bg-red-500'
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

// The focused composer readout flattens the bar, so it uses more sections to keep resolution.
const COMPOSER_SEGMENTS = 10

/** Lit-segment count for a fill ratio (null before a window is known → empty gauge). Any non-zero
 *  usage lights at least the first block, so "barely used" reads distinctly from "empty" instead of
 *  looking like nothing was used until it crosses the first rounding threshold (~10% at 5 segments). */
function filledOf(ratio: number | null, segments: number): number {
  if (ratio === null || ratio <= 0) return 0
  return Math.max(1, Math.round(ratio * segments))
}

// Pixel ramp: columns rise in height left→right, so "fuller" reads from the rising silhouette, not
// color alone. Heights interpolate between these so any `segments` count (5 context, 3 rate-limit)
// keeps the same envelope.
const RAMP_MIN_PX = 3
const RAMP_MAX_PX = 10
// Flat-mode column height — for tight strips (the composer) where the rising ramp has no vertical
// room. Resolution comes from more, equal-height columns instead of the height envelope.
const FLAT_PX = 8

/**
 * The shared headroom gauge — one pixel visual language for every "how much is left" indicator (the
 * sidebar context meter here; the footer's subscription rate-limit windows). A row of pixel columns
 * that light green→amber→red by position, so it reads as "filling toward the limit" from both shape
 * and color. Matches the pixel status glyphs. Empty columns stay grayed (a 0% gauge is present, not
 * missing). Columns rise in height by default; `flat` keeps them equal-height for short strips.
 */
export function SegmentBar({
  filled,
  segments,
  flat = false,
  className = '',
  title,
}: {
  filled: number
  segments: number
  flat?: boolean
  className?: string
  title?: string
}) {
  return (
    <div className={`flex items-end gap-[1.5px] ${className}`} title={title}>
      {Array.from({ length: segments }, (_, i) => {
        const height = flat
          ? FLAT_PX
          : segments <= 1
            ? RAMP_MAX_PX
            : Math.round(RAMP_MIN_PX + (RAMP_MAX_PX - RAMP_MIN_PX) * (i / (segments - 1)))
        return (
          <span
            key={i}
            // Color each lit column by its own position so the ramp reads green→amber→red as it fills.
            className={`w-[3px] rounded-[1px] ${i < filled ? fillClass((i + 1) / segments) : 'bg-border'}`}
            style={{ height }}
          />
        )
      })}
    </div>
  )
}

/** Focused readout — headline number + bar, click to expand the token breakdown.
 *  `openUpward` floats the breakdown above the trigger (for the composer, which sits at the
 *  screen bottom) instead of pushing it down. */
export function ContextReadout({
  context,
  openUpward = false,
  segments = COMPOSER_SEGMENTS,
  onCompact,
}: {
  context?: ContextUsage
  openUpward?: boolean
  /** Adds a compact action under the breakdown, for a surface with no room for CompactButton (the
   *  phone composer). The breakdown is a narrow mono readout with no room for a decision, so this only
   *  closes it and hands off: the caller owns the confirmation. Omit while a turn is running. */
  onCompact?: () => void
  /** Tick count in the flat gauge. Defaults to the desktop's 10; the pocket-width mobile composer
   *  passes fewer so the bar reads calmer next to the other controls. */
  segments?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, ref, close)
  if (!context) return null
  const ratio = ratioOf(context)
  const pct = ratio === null ? null : Math.round(ratio * 100)

  return (
    <div ref={ref} className="relative flex flex-col items-end gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[11px] font-mono text-text-muted transition-colors hover:text-text"
        title="Context window usage, click for the breakdown"
        aria-label="Context window usage"
      >
        {/* Percentage + the same pixel-column gauge as the sidebar / rate-limit meters — but flat
            (no vertical room in the composer strip), trading the height ramp for more sections. The
            byte figures (used / window) live in the breakdown on click. */}
        {pct !== null && <span>{pct}%</span>}
        <SegmentBar filled={filledOf(ratio, segments)} segments={segments} flat />
      </button>

      <Menu
        open={open}
        origin={openUpward ? 'origin-bottom-right' : 'origin-top-right'}
        className={`${openUpward ? 'absolute bottom-full right-0 z-10 mb-1.5' : ''} w-max whitespace-nowrap rounded-xl border border-border bg-surface px-3 py-2 text-[11px] font-mono text-text-muted shadow-pop`}
      >
        <Row
          label="in context"
          value={
            `${fmt(context.contextTokens)}` +
            (context.contextWindow ? ` / ${fmt(context.contextWindow)}` : '') +
            (pct !== null ? ` · ${pct}%` : '')
          }
        />
        <Row label="· fresh input" value={fmt(context.inputTokens)} />
        <Row label="· cached" value={fmt(context.cacheReadTokens + context.cacheCreationTokens)} />
        <Row label="last output" value={fmt(context.outputTokens)} />
        {onCompact && (
          <button
            onClick={() => {
              close()
              onCompact()
            }}
            className="mt-1.5 flex w-full items-center gap-1.5 border-t border-border/60 pt-1.5 font-sans text-[12px] text-text active:opacity-70"
          >
            <Shrink size={13} aria-hidden />
            Compact this chat
          </button>
        )}
      </Menu>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6">
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </div>
  )
}
