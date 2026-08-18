/**
 * Where the transcript should sit. Pure, so the rule can be tested without a layout engine — the
 * component measures, this decides.
 *
 * Three modes, because "pinned or not" can't express the one that matters most: a turn you just sent
 * belongs at the TOP of the viewport with its answer filling downward, not at the bottom under the
 * turn before it.
 */
export type ScrollMode = 'follow' | 'anchor' | 'free'

export type AnchorMeasurements = {
  /** Visible height of the scroll container. */
  viewport: number
  /** Full scrollable height, excluding the pad this plan asks for. */
  contentHeight: number
  /** Distance from the top of the scrollable content to the top of the newest turn. */
  turnTop: number
  /** Height of the newest turn, from its own top to the end of the content. */
  turnHeight: number
  /** Breathing room kept under an anchored turn. */
  gap: number
}

export type AnchorPlan = {
  mode: ScrollMode
  /** Extra room to render below the content so the anchored turn can reach the top. */
  pad: number
  /** Where to put scrollTop. */
  top: number
}

export function anchorPlan(mode: ScrollMode, m: AnchorMeasurements): AnchorPlan | null {
  if (mode === 'free') return null
  if (mode === 'follow') return { mode: 'follow', pad: 0, top: m.contentHeight }
  // Once the turn outgrows the viewport there is nothing left to anchor: it already fills the screen,
  // and what the reader wants from there on is the tail.
  if (m.turnHeight >= m.viewport - m.gap) return { mode: 'follow', pad: 0, top: m.contentHeight }
  return {
    mode: 'anchor',
    pad: Math.round(m.viewport - m.turnHeight - m.gap),
    top: Math.max(0, Math.round(m.turnTop)),
  }
}
