import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, cardVariants, duration, motion, useReducedMotion } from '../motion'
import { windowHasOpenMenu } from '../window-modal'
import { cx } from './cx'

// Third shared primitive (see DESIGN.md §6: PixelGlyph, Caret). Replaces the native `title=`
// attribute everywhere it was standing in for a real tooltip or a small popover — 102 uses across 40
// files, none of which can hold an icon, a second line, a Restore button, or show on touch.
//
// Two shapes, one component, because both are "float a card off a trigger, clamped on-screen":
//   - tooltip (default): pointer-events: none, role="tooltip", plain text or a fact list.
//   - interactive: real focusable controls inside, stays open while the card itself is hovered/
//     focused, closes on a grace-period timer instead of instantly so the pointer can cross the gap
//     from trigger to card without the card vanishing under it.
//
// `trigger` is CLONED in place (React.cloneElement), not wrapped in an extra DOM node — a `<li>`
// trigger inside a `<ul>` of session rows has to stay a direct child, or the list breaks. That means
// `trigger` must be a host element (button, li, div, span, …) or a component that forwards its ref
// and spreads unknown props onto one — the same contract Radix's `asChild` makes callers meet.

const TOOLTIP_OPEN_DELAY_MS = duration.slow * 1000 // 260ms — long enough that sweeping a pointer down a row list doesn't light up every row it passes
const CLOSE_GRACE_MS = 140 // time to cross the gap from trigger to card before a leave is treated as real (RB-approved mock)
const VIEWPORT_PAD = 12
const TRIGGER_GAP = 10

// The card is portaled to <body>, so Tab from the trigger lands on the trigger's DOM-next sibling and
// the blur tears the card down before it can ever be reached. An interactive card therefore has to
// hand focus across the gap by hand, which needs to know what inside it can take focus.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface HoverCardFact {
  icon: ReactNode
  value: ReactNode
  /**
   * What the icon would say if it could ("Branch", "Model"). Read out before the value and hidden on
   * screen — a bare glyph has no accessible name, so without this a screen reader hears "main" with
   * nothing telling it what `main` is.
   */
  label?: string
  /** Amber — a warning fact (e.g. "No restore point for this turn"), never the accent. */
  warn?: boolean
}

export interface HoverCardProps {
  /** The element that opens the card on hover/focus. Cloned in place — see file header. */
  trigger: ReactElement<Record<string, unknown>>
  /** Card body. Ignored when `facts` is given. */
  children?: ReactNode
  /** Shorthand for the icon+value fact-row shape (branch, model, context used, a warning, …). */
  facts?: HoverCardFact[]
  /** Optional heading line, styled like `Card`'s caption so it reads as the same kind of object.
   *  Named `heading`, not `title`: `title=` is the exact anti-pattern this primitive replaces and the
   *  DESIGN.md §7 tripwire greps for that string, so a prop called `title` would make adoption read as
   *  regression on the one measurement tracking it. */
  heading?: ReactNode
  /**
   * Interactive cards hold real controls (e.g. an archived chat's Restore button): pointer-events
   * auto, open with no hover delay, no `role="tooltip"` (WAI-ARIA: a tooltip must never contain
   * interactive content). The default is the non-interactive shape: pointer-events none, delayed
   * open, `role="tooltip"`.
   */
  interactive?: boolean
  /** Accessible name for the interactive shape's panel (skip for tooltip — its own content is
   *  already exposed to assistive tech via `aria-describedby`). */
  ariaLabel?: string
  className?: string
  /** Card width in px. Facts/short text read best narrow; a list of interactive rows wants more room. */
  width?: number
  /** Temporarily suppress this disclosure while a stronger surface (for example an item menu) owns
   *  the same row. The trigger stays in place and keeps its focus; any open card closes immediately. */
  disabled?: boolean
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(node)
      else (ref as { current: T | null }).current = node
    }
  }
}

// Best-effort passthrough for a ref the caller already put on `trigger` — most triggers won't carry
// one, but a caller that does (e.g. also measuring the row for something else) shouldn't lose it.
function existingRef(el: ReactElement<Record<string, unknown>>): Ref<HTMLElement> | undefined {
  const fromProps = (el.props as { ref?: Ref<HTMLElement> }).ref
  if (fromProps) return fromProps
  return (el as unknown as { ref?: Ref<HTMLElement> }).ref
}

function chain<E>(existing: unknown, ours: (e: E) => void): (e: E) => void {
  return (e: E) => {
    if (typeof existing === 'function') (existing as (e: E) => void)(e)
    ours(e)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

// A fade-only, un-timed pair for reduced motion — no travel, and no baked-in duration so the
// component-level `transition={{ duration: 0 }}` (set only when reduced) actually applies. Mirrors
// the `transition={reduce ? { duration: 0 } : …}` idiom already used at UsageChart.tsx / Dock.tsx.
const REDUCED_VARIANTS = { hidden: { opacity: 0 }, visible: { opacity: 1 } }

export function HoverCard({
  trigger,
  children,
  facts,
  heading,
  interactive = false,
  ariaLabel,
  className,
  width = 260,
  disabled = false,
}: HoverCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()
  const reduce = useReducedMotion()

  const clearTimers = (): void => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
  }
  const openNow = (): void => {
    clearTimers()
    if (windowHasOpenMenu()) return
    setOpen(true)
  }
  const scheduleOpen = (): void => {
    clearTimers()
    // A menu the user summoned outranks a card the pointer merely drifted over — including a menu
    // opened from a DIFFERENT row, which is why this is a window query and not component state.
    // Re-checked on the timer too: the pointer can settle on a row before the menu is dismissed.
    if (windowHasOpenMenu()) return
    // Interactive triggers are deliberate single targets (an "Archived" footer row), not a list the
    // pointer sweeps across on its way somewhere else — no reason to make them wait.
    if (interactive) {
      setOpen(true)
      return
    }
    openTimer.current = setTimeout(() => {
      if (windowHasOpenMenu()) return
      setOpen(true)
    }, TOOLTIP_OPEN_DELAY_MS)
  }
  const scheduleClose = (): void => {
    clearTimers()
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
  }
  const closeNow = (): void => {
    clearTimers()
    setOpen(false)
  }

  useEffect(() => clearTimers, [])

  useEffect(() => {
    if (!disabled) return
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    setOpen(false)
  }, [disabled])

  // Measure and clamp on open (in a layout effect so the corrected position lands before the first
  // paint, not after). Re-measured on scroll/resize while open — the RemoteMenu popover pattern.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (!anchor) return
      const h = cardRef.current?.offsetHeight ?? 0
      const left = clamp(anchor.right + TRIGGER_GAP, VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD)
      const top = clamp(anchor.top, VIEWPORT_PAD, window.innerHeight - h - VIEWPORT_PAD)
      setPos({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, width])

  // Escape has to dismiss a card the POINTER opened, and that card has no focus anywhere near it — the
  // trigger's own keydown never fires. WAI-ARIA requires Escape to work regardless of how it opened.
  useEffect(() => {
    if (!open) return
    // Closes inline rather than through `closeNow`, which is a fresh function every render and would
    // resubscribe the listener on each one.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const onTriggerKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      closeNow()
      return
    }
    // Forward-Tab off the trigger jumps into the portaled card instead of past it, so an interactive
    // card's controls are reachable at all. Without this the card is mouse-only.
    if (!interactive || e.key !== 'Tab' || e.shiftKey) return
    const first = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    if (!first) return
    e.preventDefault()
    clearTimers()
    first.focus()
  }

  const onCardKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      closeNow()
      anchorRef.current?.focus()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (items.length === 0) return
    const leaving = e.shiftKey ? e.target === items[0] : e.target === items[items.length - 1]
    if (!leaving) return
    // Tabbing off either end returns to the trigger and closes, so the surrounding tab order behaves
    // as though the card were inline rather than parked at the end of <body>.
    e.preventDefault()
    closeNow()
    anchorRef.current?.focus()
  }

  const clonedTrigger = cloneElement(trigger, {
    ref: mergeRefs(existingRef(trigger), anchorRef),
    onMouseEnter: chain<MouseEvent>(trigger.props.onMouseEnter, scheduleOpen),
    onMouseLeave: chain<MouseEvent>(trigger.props.onMouseLeave, scheduleClose),
    // A context menu is a different disclosure taking over the same element, so the card yields to it
    // rather than sitting under it. The pointer is still inside the trigger afterwards and
    // `mouseenter` will not fire again, so it stays down until the pointer actually leaves and returns.
    onContextMenu: chain<MouseEvent>(trigger.props.onContextMenu, closeNow),
    onFocus: chain<FocusEvent>(trigger.props.onFocus, openNow),
    onBlur: chain<FocusEvent>(trigger.props.onBlur, scheduleClose),
    onKeyDown: chain<KeyboardEvent>(trigger.props.onKeyDown, onTriggerKeyDown),
    'aria-describedby': disabled || interactive
      ? (trigger.props['aria-describedby'] as string | undefined)
      : id,
  })

  return (
    <>
      {clonedTrigger}
      {createPortal(
        <AnimatePresence>
          {open && !disabled && (
            <motion.div
              ref={cardRef}
              id={id}
              role={interactive ? undefined : 'tooltip'}
              aria-label={interactive ? ariaLabel : undefined}
              variants={reduce ? REDUCED_VARIANTS : cardVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={reduce ? { duration: 0 } : undefined}
              onMouseEnter={interactive ? clearTimers : undefined}
              onMouseLeave={interactive ? scheduleClose : undefined}
              onFocus={interactive ? clearTimers : undefined}
              onBlur={interactive ? scheduleClose : undefined}
              onKeyDown={interactive ? onCardKeyDown : undefined}
              style={{
                position: 'fixed',
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
                width,
                pointerEvents: interactive ? 'auto' : 'none',
              }}
              // Type lives on the CARD, not on its contents. Plain-text children used to render raw
              // and inherit the ambient body size, so a text tooltip came out at reading scale beside
              // fact rows that set their own 12px — the same primitive rendering two different type
              // sizes depending on which prop you passed. 12px is the app's chrome scale (status bar,
              // meta lines, settings rows); the transcript's 13.5px reading rhythm is not for chrome.
              className={cx(
                'z-50 rounded-xl border border-border bg-surface p-3 text-[12px] leading-snug text-text-muted shadow-pop',
                className,
              )}
            >
              {heading && (
                // Sentence case, not a caption: the commonest heading here is a chat's own title, and
                // an uppercase tracking-wide treatment shouts a name the user wrote in normal words.
                <div className="mb-2 text-[13px] font-medium leading-snug text-text">{heading}</div>
              )}
              {facts ? (
                // Plain rows, not a <dl>: a definition list's children must be <dt>/<dd>, and an icon
                // is not a term. The accessible name rides `label` instead.
                <div className="grid gap-1.5">
                  {facts.map((f, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span aria-hidden className="mt-0.5 shrink-0 opacity-75">
                        {f.icon}
                      </span>
                      <span className={f.warn ? 'text-amber-500' : 'text-text'}>
                        {f.label && <span className="sr-only">{f.label}: </span>}
                        {f.value}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                children
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
