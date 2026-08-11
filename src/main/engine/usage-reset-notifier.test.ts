/**
 * Regression guard for the maxed-window reset ping (usage-reset-notifier.ts). The /usage poll wobbles
 * the SAME window's resetsAt by ±60s (server minute-rounding); on 2026-08-03 the notifier read each
 * wobble as a rollover and pinged "limit reset" three times in 80 minutes while the cap was still hit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../settings', () => ({ loadUsageResetNotify: () => true }))
vi.mock('../logger', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return false // skip the desktop banner in tests; the phone-push spy observes fires
    }
  },
}))

const NOW = new Date(2026, 7, 3, 18, 0, 0).getTime()
const nowS = Math.round(NOW / 1000)

let noteRateLimit: typeof import('./usage-reset-notifier').noteRateLimit
let push: ReturnType<typeof vi.fn<(title: string, body: string) => void>>

const report = (resetsAt: number, status: 'allowed' | 'warning' | 'rejected') =>
  noteRateLimit('claude', { rateLimitType: 'five_hour', resetsAt, status, usedPercent: status === 'rejected' ? 100 : 90 })

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.resetModules()
  const mod = await import('./usage-reset-notifier')
  noteRateLimit = mod.noteRateLimit
  push = vi.fn()
  mod.setUsageResetPush(push)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usage reset notifier', () => {
  it('ignores ±60s resetsAt wobble on a maxed window (the 2026-08-03 spam)', () => {
    const reset = nowS + 3600
    report(reset - 60, 'rejected')
    // The poll alternates between the two roundings of the same instant for over an hour.
    for (let i = 0; i < 20; i++) report(i % 2 ? reset - 60 : reset, 'rejected')
    expect(push).not.toHaveBeenCalled()

    // The armed timer still delivers exactly one ping once the window genuinely clears.
    vi.advanceTimersByTime(3700 * 1000)
    expect(push).toHaveBeenCalledTimes(1)
    report(reset, 'rejected')
    report(reset - 60, 'rejected')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('backstop still pings once when a real rollover is first observed (Mac slept through the timer)', () => {
    const reset = nowS + 3600
    report(reset, 'rejected')
    // Jump past the reset without running the timer (asleep), then the next poll shows a fresh window.
    vi.setSystemTime(NOW + 4000 * 1000)
    report(reset + 5 * 3600, 'allowed')
    expect(push).toHaveBeenCalledTimes(1)
    report(reset + 5 * 3600, 'allowed')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('never pings for a window that was not maxed', () => {
    report(nowS + 3600, 'warning')
    vi.advanceTimersByTime(4000 * 1000)
    report(nowS + 6 * 3600, 'warning')
    expect(push).not.toHaveBeenCalled()
  })
})
