import { describe, expect, it } from 'vitest'
import type { RateLimitInfo } from './ipc'
import { liveRateLimitWindows, rateLimitBand, reconcileRateLimitWindows } from './rate-limits'

function window(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    rateLimitType: 'five_hour',
    resetsAt: 2_000,
    status: 'allowed',
    usedPercent: 20,
    observedAt: 100,
    source: 'stream',
    ...overrides,
  }
}

describe('rate-limit reconciler', () => {
  it('keeps a complete snapshot over a later sparse event in the same reset window', () => {
    const snapshot = window({ usedPercent: 52, observedAt: 200, source: 'snapshot' })
    const sparse = window({ usedPercent: 40, observedAt: 300, source: 'stream' })

    const result = reconcileRateLimitWindows({ five_hour: snapshot }, sparse)

    expect(result.accepted).toBe(false)
    expect(result.windows.five_hour.usedPercent).toBe(52)
  })

  it('refreshes a readable row from a partial poll without granting sibling prune authority', () => {
    const current = {
      five_hour: window({ usedPercent: 52, observedAt: 200, source: 'snapshot' }),
      seven_day: window({ rateLimitType: 'seven_day', usedPercent: 31, observedAt: 200, source: 'snapshot' }),
    }
    const partial = window({ usedPercent: 57, observedAt: 300, source: 'poll' })

    const result = reconcileRateLimitWindows(current, partial)

    expect(result.accepted).toBe(true)
    expect(result.windows.five_hour.usedPercent).toBe(57)
    expect(result.windows.seven_day.usedPercent).toBe(31)
  })

  it('accepts a weaker source when it describes a new reset window', () => {
    const snapshot = window({ observedAt: 200, source: 'snapshot' })
    const nextWindow = window({ resetsAt: 3_000, observedAt: 300, source: 'stream' })

    expect(reconcileRateLimitWindows({ five_hour: snapshot }, nextWindow).windows.five_hour.resetsAt).toBe(3_000)
  })

  it('does not let a newer Codex snapshot move backwards inside the same reset window', () => {
    const current = window({ usedPercent: 13, observedAt: 200, source: 'snapshot' })
    const raced = window({ usedPercent: 12, observedAt: 300, source: 'snapshot' })

    expect(reconcileRateLimitWindows({ five_hour: current }, raced).windows.five_hour.usedPercent).toBe(13)
  })

  it('rejects an older observation and applies authoritative pruning only with an accepted update', () => {
    const current = {
      five_hour: window({ observedAt: 300, source: 'snapshot' }),
      weekly: window({ rateLimitType: 'weekly', observedAt: 300, source: 'snapshot' }),
    }
    const older = window({ observedAt: 200, source: 'snapshot' })

    expect(reconcileRateLimitWindows(current, older, ['five_hour']).windows).toEqual(current)
  })

  it('uses one warning threshold and drops only measured-expired windows', () => {
    expect(rateLimitBand(74.9)).toBe('allowed')
    expect(rateLimitBand(75)).toBe('warning')
    expect(rateLimitBand(100)).toBe('rejected')
    expect(
      liveRateLimitWindows(
        {
          live: window({ rateLimitType: 'live', resetsAt: 101 }),
          expired: window({ rateLimitType: 'expired', resetsAt: 100 }),
        },
        100,
      ),
    ).toHaveProperty('live')
    expect(liveRateLimitWindows({ expired: window({ resetsAt: 100 }) }, 100)).toEqual({})
  })
})
