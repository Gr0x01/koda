import { STAGE_MAX_WIDTH, STAGE_MIN_WIDTH } from '@shared/ipc'

/**
 * How the Stage shares the main area with the conversation (Documents/design/document-workspace.md,
 * "Responsive behavior"). Kept pure and out of SurfaceHost so the rule that keeps the conversation on
 * screen can be proved without a window: the host measures, this decides.
 */

/**
 * The design's narrow-desktop breakpoint. The prototype measured the whole window because its sidebar
 * was a fixed 220px; Koda's sidebar is user-resizable between 180 and 600, so the window number says
 * nothing about how much room the conversation and the Stage actually have. Applied instead to the row
 * they share — the design's number minus the sidebar it was counting at that width — which reproduces
 * the prototype exactly at a 220px sidebar and stays honest at every other one.
 */
export const STAGE_OVERLAY_BREAKPOINT = 980
const PROTOTYPE_SIDEBAR_WIDTH = 220
export const STAGE_SIDE_BY_SIDE_MIN = STAGE_OVERLAY_BREAKPOINT - PROTOTYPE_SIDEBAR_WIDTH

/**
 * The narrowest the conversation may be squeezed to while the Stage sits beside it. Below roughly this
 * the composer's control row (approval mode, model, effort, send) wraps into rubble and the transcript
 * stops being a reading column.
 *
 * This is the floor that makes the trap impossible: the Stage's persisted px width is absolute and
 * window-independent, so a Stage restored at 900 in a 960 window used to leave the conversation zero
 * wide and push the Stage's own right-hand controls past the edge where `main` clips them — no
 * divider, no hide control, nothing on screen to get back with, and the width survived a relaunch.
 */
export const CONVERSATION_MIN_WIDTH = 420

export type StageFit = {
  /** Lay the Stage OVER the whole conversation instead of splitting the row between the two. */
  overlay: boolean
  /** The width to draw the Stage at, side by side. Never written back to the stored preference. */
  width: number
  /** The widest the divider may drag the Stage in the row as it is right now. */
  maxWidth: number
}

/**
 * Hold the user's stored Stage width inside the room the row actually has.
 *
 * The stored preference is never rewritten here. A narrower window clamps what is DRAWN, so widening
 * it again restores the width the user chose; only their own drag changes what is persisted.
 *
 * `rowWidth <= 0` means "not measured yet" (the first paint, before the observer runs) — fall back to
 * the absolute persisted range rather than inventing a clamp from a width nobody has measured.
 */
export function fitStage(rowWidth: number, storedWidth: number): StageFit {
  const measured = Number.isFinite(rowWidth) && rowWidth > 0
  const room = measured ? rowWidth - CONVERSATION_MIN_WIDTH : STAGE_MAX_WIDTH
  const maxWidth = Math.min(STAGE_MAX_WIDTH, Math.max(STAGE_MIN_WIDTH, room))
  return {
    overlay: measured && rowWidth < STAGE_SIDE_BY_SIDE_MIN,
    width: Math.min(Math.max(storedWidth, STAGE_MIN_WIDTH), maxWidth),
    maxWidth,
  }
}
