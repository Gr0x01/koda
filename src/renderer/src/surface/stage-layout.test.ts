import { describe, expect, it } from 'vitest'
import { STAGE_MAX_WIDTH, STAGE_MIN_WIDTH, clampLayout } from '@shared/ipc'
import {
  CONVERSATION_MIN_WIDTH,
  STAGE_SIDE_BY_SIDE_MIN,
  fitStage,
} from './stage-layout'

/**
 * The trap this closes: the Stage's width is a persisted PIXEL preference with an absolute,
 * window-independent clamp, and nothing re-clamped it against the window. A Stage dragged or restored
 * to ~900 in a 960-wide window left the conversation zero wide and pushed the Stage's own right-hand
 * controls past the edge, where `main` clips them — the user had nothing on screen to get back with,
 * and the width survived a relaunch.
 *
 * So the two things worth pinning are that the conversation can never be squeezed to nothing, and that
 * the fix costs the user nothing: a narrow window clamps what is DRAWN, never what is STORED.
 */

describe('the conversation always keeps a usable minimum', () => {
  it('leaves it at least its floor at every row width the stage sits beside it in', () => {
    for (let rowWidth = STAGE_SIDE_BY_SIDE_MIN; rowWidth <= 2400; rowWidth += 7) {
      for (const stored of [STAGE_MIN_WIDTH, 440, 700, 900, STAGE_MAX_WIDTH]) {
        const fit = fitStage(rowWidth, stored)
        expect(fit.overlay).toBe(false)
        expect(rowWidth - fit.width).toBeGreaterThanOrEqual(CONVERSATION_MIN_WIDTH)
        expect(rowWidth - fit.maxWidth).toBeGreaterThanOrEqual(CONVERSATION_MIN_WIDTH)
      }
    }
  })

  it('cannot be squeezed out by a stage width no drag could reach either', () => {
    // A hand-edited settings file is clamped to the absolute range first; that value still has to fit.
    const stored = clampLayout({ conversationWidth: 99_999 }).conversationWidth
    expect(stored).toBe(STAGE_MAX_WIDTH)
    const fit = fitStage(1200, stored)
    expect(fit.width).toBe(1200 - CONVERSATION_MIN_WIDTH)
  })

  it('overlays instead of splitting once no split can satisfy both minimums', () => {
    // The narrow rule and the floor cannot disagree: below the breakpoint there is no honest split.
    expect(CONVERSATION_MIN_WIDTH + STAGE_MIN_WIDTH).toBeLessThanOrEqual(STAGE_SIDE_BY_SIDE_MIN)
    expect(fitStage(STAGE_SIDE_BY_SIDE_MIN, 900).overlay).toBe(false)
    expect(fitStage(STAGE_SIDE_BY_SIDE_MIN - 1, 900).overlay).toBe(true)
    // The reported trap: a 960 window (the app's own minimum) with the sidebar at its 320 default.
    expect(fitStage(960 - 320, 900).overlay).toBe(true)
  })
})

describe('the stored preference survives a narrow window', () => {
  it('clamps what is drawn without touching what was stored', () => {
    const stored = 900
    expect(fitStage(800, stored).width).toBe(800 - CONVERSATION_MIN_WIDTH)
    // Same stored value, wider row: the user gets back the width they chose, to the pixel.
    expect(fitStage(1600, stored).width).toBe(stored)
    expect(fitStage(1600, stored).width).toBe(fitStage(0, stored).width)
  })

  it('caps the drag at the room, so what is persisted is what the user saw', () => {
    expect(fitStage(1000, 440).maxWidth).toBe(1000 - CONVERSATION_MIN_WIDTH)
    // Beyond the absolute ceiling the room stops being the limit.
    expect(fitStage(4000, 440).maxWidth).toBe(STAGE_MAX_WIDTH)
  })

  it('applies no clamp before the row has been measured', () => {
    expect(fitStage(0, STAGE_MAX_WIDTH)).toEqual({
      overlay: false,
      width: STAGE_MAX_WIDTH,
      maxWidth: STAGE_MAX_WIDTH,
    })
    expect(fitStage(Number.NaN, 900).width).toBe(900)
  })
})
