import { describe, expect, it } from 'vitest'
import { anchorPlan } from './transcript-scroll'

const m = (over: Partial<Parameters<typeof anchorPlan>[1]> = {}) => ({
  viewport: 800,
  contentHeight: 4000,
  turnTop: 3600,
  turnHeight: 200,
  gap: 24,
  ...over,
})

describe('anchorPlan', () => {
  it('leaves a reading position alone', () => {
    expect(anchorPlan('free', m())).toBeNull()
  })

  it('follows the tail', () => {
    expect(anchorPlan('follow', m())).toEqual({ mode: 'follow', pad: 0, top: 4000 })
  })

  it('puts a fresh turn at the top, with room below it to get there', () => {
    expect(anchorPlan('anchor', m())).toEqual({ mode: 'anchor', pad: 576, top: 3600 })
  })

  it('gives up the anchor once the turn fills the screen, and follows instead', () => {
    expect(anchorPlan('anchor', m({ turnHeight: 900 }))).toEqual({ mode: 'follow', pad: 0, top: 4000 })
  })

  it('drops the pad the moment the anchor is given up, so no dead space is left behind', () => {
    const grown = anchorPlan('anchor', m({ turnHeight: 776 }))
    expect(grown).toMatchObject({ mode: 'follow', pad: 0 })
  })

  it('never asks for a negative scroll position', () => {
    expect(anchorPlan('anchor', m({ turnTop: -40 }))?.top).toBe(0)
  })
})
