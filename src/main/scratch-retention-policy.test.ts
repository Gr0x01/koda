import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  days: 1,
  events: [] as string[],
  releaseFirst: null as (() => void) | null,
  holdFirst: true,
}))

vi.mock('./settings', () => ({ loadScratchRetentionDays: () => state.days }))
vi.mock('./window-registry', () => ({
  openProjectPaths: () => ['/project'],
  windowForProject: () => undefined,
}))
vi.mock('./probe-governor', () => ({
  governProbe: () => ({ due: () => true, ran: () => {}, release: () => {} }),
}))
vi.mock('./scratch', () => ({
  pruneScratch: async (_root: string, days: number) => {
    state.events.push(`prune-${days}-start`)
    if (state.holdFirst) {
      state.holdFirst = false
      await new Promise<void>((resolve) => {
        state.releaseFirst = resolve
      })
    }
    state.events.push(`prune-${days}-end`)
    return 0
  },
  saveScratchImage: vi.fn(),
}))

import {
  applyScratchRetentionSetting,
  sweepOpenScratchRetention,
} from './scratch-retention'

describe('scratch retention policy lane', () => {
  beforeEach(() => {
    state.days = 1
    state.events = []
    state.releaseFirst = null
    state.holdFirst = true
  })

  it('finishes an old prune before persisting a longer retention policy', async () => {
    const oldSweep = sweepOpenScratchRetention()
    await vi.waitFor(() => expect(state.releaseFirst).not.toBeNull())

    const keepForever = applyScratchRetentionSetting(() => {
      state.events.push('persist-forever')
      state.days = 0
      return { scratchRetentionDays: 0 }
    })
    await Promise.resolve()
    expect(state.events).not.toContain('persist-forever')

    state.releaseFirst?.()
    await Promise.all([oldSweep, keepForever])

    expect(state.events).toEqual([
      'prune-1-start',
      'prune-1-end',
      'persist-forever',
      'prune-0-start',
      'prune-0-end',
    ])
  })
})
