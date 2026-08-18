import { describe, expect, it, vi } from 'vitest'
import { windowHasOpenModal } from './window-modal'

describe('window modal ownership', () => {
  it('blocks workspace shortcuts exactly while an aria modal owns the window', () => {
    const querySelector = vi.fn().mockReturnValueOnce({}).mockReturnValueOnce(null)
    const doc = { querySelector }

    expect(windowHasOpenModal(doc)).toBe(true)
    expect(windowHasOpenModal(doc)).toBe(false)
    expect(querySelector).toHaveBeenCalledWith('[aria-modal="true"]')
  })
})
