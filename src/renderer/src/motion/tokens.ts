/**
 * Koda's motion system — the ONE place durations, easings, springs, and the common
 * enter/exit variants are defined. Every animated surface pulls from here so motion
 * is a system (consistent, interruptible, reduced-motion-aware) rather than per-component
 * decoration. The felt target is the floating/calm visual language: short, soft, never showy.
 *
 * Two consumers share these numbers:
 *   - JS surfaces (drawers, overlays, modals) via `motion` + the presets in ./index.tsx
 *   - CSS-class surfaces (hovers, fades) via the `--duration-*` / `--ease-*` Tailwind tokens
 *     in styles/index.css, which mirror the values below.
 * Keep the two in sync — these are the source of truth; the CSS vars are the mirror.
 */

/** Seconds (motion's unit). Short enough to never feel sluggish, long enough to read. */
export const duration = {
  fast: 0.12, // micro: hovers, small fades, backdrops
  base: 0.18, // the default: overlays, cards, most enter/exit
  slow: 0.26, // larger travel: drawers, full panels
} as const

/** Cubic-bezier easings. `out` is the workhorse — a soft decelerate that matches the calm feel. */
export const ease = {
  out: [0.22, 1, 0.36, 1], // soft ease-out (decelerate into place)
  inOut: [0.4, 0, 0.2, 1], // symmetric, for things that move both ways
} as const

/**
 * Springs for anything a user can interrupt (click-again-mid-animation reverses smoothly
 * instead of snapping/queuing). Preferred over tween for summoned surfaces.
 */
export const spring = {
  // Overlays/cards: quick to settle, minimal overshoot.
  snappy: { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 },
  // Drawers/panels: a touch softer for the longer travel.
  gentle: { type: 'spring', stiffness: 300, damping: 32, mass: 1 },
} as const

// ── Shared variants ──────────────────────────────────────────────────────────
// `hidden` is both the initial (enter-from) and the exit (leave-to) state, so a surface
// animates out the same way it came in. AnimatePresence in the parent drives the exit.

/** Backdrop scrim — pure fade, fast (it shouldn't draw attention to itself). */
export const backdropVariants = {
  hidden: { opacity: 0, transition: { duration: duration.fast, ease: ease.out } },
  visible: { opacity: 1, transition: { duration: duration.fast, ease: ease.out } },
}

/** Summoned card/modal/popover — soft scale + lift + fade, spring in, quick fade-scale out. */
export const cardVariants = {
  hidden: {
    opacity: 0,
    scale: 0.97,
    y: 8,
    transition: { duration: duration.fast, ease: ease.out },
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: spring.snappy,
  },
}

/** Plain fade — list items, content swaps, anything that shouldn't move, just appear. */
export const fadeVariants = {
  hidden: { opacity: 0, transition: { duration: duration.fast, ease: ease.out } },
  visible: { opacity: 1, transition: { duration: duration.base, ease: ease.out } },
}

/** Right-edge drawer (recovery, side panels). Slides on the X axis; spring for interruptibility. */
export const drawerRightVariants = {
  hidden: { x: '100%', transition: { duration: duration.base, ease: ease.out } },
  visible: { x: 0, transition: spring.gentle },
}

/**
 * Dropdown / popover menus (model picker, approval-mode, context breakdown). A quick scale + fade
 * from the trigger corner — set the corner with a Tailwind `origin-*` class on the menu so it grows
 * out of the button, not the center. Fast both ways; menus should feel instant, not theatrical.
 */
export const menuVariants = {
  hidden: { opacity: 0, scale: 0.96, transition: { duration: duration.fast, ease: ease.out } },
  visible: { opacity: 1, scale: 1, transition: { duration: duration.fast, ease: ease.out } },
}
