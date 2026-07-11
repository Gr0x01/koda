/**
 * Koda motion presets — wrap-and-it-animates-correctly components built on `motion`.
 *
 * The hard part of "animate transitions" is the EXIT: React wants to unmount a node the
 * instant its condition goes false, so it pops. `AnimatePresence` (re-exported below) keeps
 * the node mounted until its exit finishes. The rule of use:
 *
 *   <AnimatePresence>{open && <Overlay onDismiss={close}>…</Overlay>}</AnimatePresence>
 *
 * AnimatePresence MUST live in the parent that owns the open/closed condition — not inside
 * the surface — because it's what defers the unmount. The presets handle the rest (enter,
 * exit, interruptible spring, backdrop click-out). Reduced-motion is honored globally via
 * <MotionConfig reducedMotion="user"> at the app root (see main.tsx).
 */
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { backdropVariants, cardVariants, drawerRightVariants, menuVariants } from './tokens'

export { AnimatePresence, MotionConfig, motion, useReducedMotion }
export * from './tokens'

/**
 * A summoned overlay: a fading scrim + a soft scale/lift card, dismissed by clicking outside
 * the card. Covers Spotlight-style palettes (align="start") and centered modals/lightboxes
 * (align="center"). The card wrapper stops click propagation so only the scrim dismisses.
 *
 * Pass the card's own look (size, padding, rounding, bg) via `className` — the preset owns
 * only positioning + motion, never the surface's appearance.
 */
export function Overlay({
  onDismiss,
  children,
  align = 'center',
  className = '',
  scrimClassName = 'bg-black/30',
}: {
  onDismiss: () => void
  children: ReactNode
  align?: 'start' | 'center'
  /** Applied to the card wrapper — the surface's own box styles. */
  className?: string
  /** Override the scrim tint if a surface needs a darker/lighter backdrop. */
  scrimClassName?: string
}) {
  return (
    <motion.div
      variants={backdropVariants}
      initial="hidden"
      animate="visible"
      exit="hidden"
      onMouseDown={onDismiss}
      className={`fixed inset-0 z-50 flex justify-center ${
        align === 'start' ? 'items-start pt-[12vh]' : 'items-center'
      } ${scrimClassName}`}
    >
      <motion.div
        variants={cardVariants}
        onMouseDown={(e) => e.stopPropagation()}
        className={className}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

/**
 * A right-edge drawer (recovery timeline, side panels): a fading scrim + a panel that slides
 * in from the right. Same parent-AnimatePresence rule as Overlay.
 */
export function Drawer({
  onDismiss,
  children,
  className = '',
}: {
  onDismiss: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div
      variants={backdropVariants}
      initial="hidden"
      animate="visible"
      exit="hidden"
      onMouseDown={onDismiss}
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
    >
      <motion.div
        variants={drawerRightVariants}
        onMouseDown={(e) => e.stopPropagation()}
        className={className}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

/**
 * Collapsible region with a real height transition (the thing CSS can't do from `auto`).
 * Animates open/closed height + fade. Keep contents cheap — height animation reflows.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Dropdown / popover menu — scale-fades out of the trigger corner and animates closed instead of
 * vanishing. Owns its own AnimatePresence (pass the `open` flag), so a caller just swaps its
 * `{open && <div …>}` for `<Menu open={open} …>`. Positioning (absolute/z/width) + the box look stay
 * in `className`; set the grow-from corner with a Tailwind `origin-*` class (e.g. `origin-bottom-left`
 * for an upward menu).
 */
export function Menu({
  open,
  children,
  className = '',
  origin = 'origin-top',
  style,
  onClose,
}: {
  open: boolean
  children: ReactNode
  className?: string
  origin?: string
  /** Inline positioning — e.g. `fixed` coords when the menu is portaled to escape a clipping parent. */
  style?: CSSProperties
  /** When provided, Escape closes the menu — matches the click-out most callers already wire. */
  onClose?: () => void
}) {
  useEffect(() => {
    if (!open || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          variants={menuVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          className={`${origin} ${className}`}
          style={style}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
