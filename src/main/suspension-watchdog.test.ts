import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { startSuspensionWatchdog, stallContext } from './suspension-watchdog'

/**
 * The watchdog exists so a socket-drop log line can NAME its cause (gauntlet bar #7). What must hold:
 * a healthy process leaves no trace, a stalled one is measured by its own late tick, a real system
 * sleep is labelled as sleep (not throttle) even though both stall the timers, and stale stalls stop
 * being offered as context. Fake timers drive both the interval and Date.now, so a "stall" is a
 * system-time jump the interval never ticked through — exactly what suspension looks like from inside.
 */

let stop: (() => void) | null = null
let pm: EventEmitter

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  pm = new EventEmitter()
  stop = startSuspensionWatchdog(pm as never, Date.now)
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
})

const tick = (ms: number): void => void vi.advanceTimersByTime(ms)

describe('suspension watchdog', () => {
  it('a healthy process leaves no stall context', () => {
    tick(60_000)
    expect(stallContext(Date.now())).toEqual({})
  })

  it('a late tick is reported as a process throttle, measured by the gap', () => {
    tick(10_000) // healthy baseline
    vi.setSystemTime(Date.now() + 90_000) // the process was out for 90s: timers frozen, clock moving
    tick(5_000) // first tick after "waking"
    const ctx = stallContext(Date.now())
    expect(ctx.afterStall).toMatch(/^process throttle 9\ds/)
  })

  it('a suspend→resume outage is labelled system sleep, never double-reported as throttle', () => {
    tick(10_000)
    pm.emit('suspend')
    vi.setSystemTime(Date.now() + 300_000) // asleep 5 minutes
    pm.emit('resume')
    tick(5_000) // the interval fires late too — the resume claim must win the label
    const ctx = stallContext(Date.now())
    expect(ctx.afterStall).toMatch(/^system sleep 300s/)
  })

  it('a resume with no prior suspend event leaves the gap for the tick — outage still recorded', () => {
    tick(10_000)
    vi.setSystemTime(Date.now() + 90_000) // the process was out, but the OS never said "suspend"
    pm.emit('resume') // resume-first ordering — the destructive race the reviewer caught
    tick(5_000)
    expect(stallContext(Date.now()).afterStall).toMatch(/^process throttle/)
  })

  it('a stall goes stale: context is offered only near the event', () => {
    vi.setSystemTime(Date.now() + 90_000)
    tick(5_000)
    expect(stallContext(Date.now()).afterStall).toBeDefined()
    tick(150_000) // healthy ticks past RECENT_MS
    expect(stallContext(Date.now())).toEqual({})
  })

  it('normal 5s cadence never trips the 30s threshold', () => {
    for (let i = 0; i < 100; i++) tick(5_000)
    expect(stallContext(Date.now())).toEqual({})
  })
})
