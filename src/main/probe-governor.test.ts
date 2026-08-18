import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { governProbe, startProbeGovernor, type GovernedProbe } from './probe-governor'

/**
 * What must hold: a probe at the keyboard is untouched, a locked or sleeping Mac stops paying for it,
 * an away-from-the-window Mac pays less (and less again on battery), coming back runs an overdue probe
 * once rather than on the next scheduled tick, and an activity-driven run resets the stretch so
 * returning never polls twice in a row.
 *
 * Fake timers drive the probe's OWN interval — the adoption shape (`if (probe.due()) run()`) is what's
 * under test, not a scheduler this module doesn't have.
 */

const EVERY_MS = 60_000
const AWAY_AFTER_MS = 10 * 60_000

let power: EventEmitter
let windows: EventEmitter
let focused: boolean
let battery: boolean
let stop: (() => void) | null = null
let probe: GovernedProbe | null = null
let timer: ReturnType<typeof setInterval> | null = null
let runs: number

function start(): void {
  stop = startProbeGovernor({
    power: {
      on: (event, listener) => power.on(event, listener),
      off: (event, listener) => power.off(event, listener),
      isOnBatteryPower: () => battery,
    },
    windows: {
      on: (event, listener) => windows.on(event, listener),
      off: (event, listener) => windows.off(event, listener),
      anyFocused: () => focused,
    },
    now: () => Date.now(),
  })
}

/** Register a probe and drive it from its own interval, exactly as an adopted poller does. */
function arm(opts: { wake?: boolean; pauseOnLock?: boolean } = {}): void {
  probe = governProbe('test', EVERY_MS, {
    ...(opts.wake ? { wake: () => void runs++ } : {}),
    ...(opts.pauseOnLock === undefined ? {} : { pauseOnLock: opts.pauseOnLock }),
  })
  timer = setInterval(() => {
    if (probe?.due()) runs++
  }, EVERY_MS)
}

/** Advance by whole probe intervals. */
function ticks(n: number): void {
  vi.advanceTimersByTime(EVERY_MS * n)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  power = new EventEmitter()
  windows = new EventEmitter()
  focused = true
  battery = false
  runs = 0
})

afterEach(() => {
  if (timer) clearInterval(timer)
  timer = null
  probe?.release()
  probe = null
  stop?.()
  stop = null
  vi.useRealTimers()
})

describe('probe governor', () => {
  it('leaves a probe alone while the user is at a Koda window', () => {
    start()
    arm()
    ticks(5)
    expect(runs).toBe(5)
  })

  it('runs at full cadence when no governor was ever started', () => {
    arm()
    ticks(4)
    expect(runs).toBe(4)
  })

  it('pauses while the screen is locked, and resumes on the very next tick after unlock', () => {
    start()
    arm()
    ticks(2)
    power.emit('lock-screen')
    ticks(5)
    expect(runs).toBe(2) // nobody is there — five ticks bought nothing

    power.emit('unlock-screen')
    ticks(1)
    expect(runs).toBe(3)
  })

  it('pauses across a system suspend', () => {
    start()
    arm()
    power.emit('suspend')
    ticks(4)
    expect(runs).toBe(0)
    power.emit('resume')
    ticks(1)
    expect(runs).toBe(1)
  })

  it('stretches only after the window has been unfocused a sustained stretch', () => {
    start()
    arm()
    focused = false
    windows.emit('browser-window-blur')
    // Still inside the away grace: a quick glance at another app changes nothing.
    ticks(AWAY_AFTER_MS / EVERY_MS - 1)
    expect(runs).toBe(AWAY_AFTER_MS / EVERY_MS - 1)

    // Past it: one run per four ticks.
    runs = 0
    ticks(8)
    expect(runs).toBe(2)
  })

  it('stretches further on battery than on wall power', () => {
    battery = true
    start()
    arm()
    focused = false
    windows.emit('browser-window-blur')
    ticks(AWAY_AFTER_MS / EVERY_MS - 1)
    runs = 0
    ticks(16)
    expect(runs).toBe(2) // one run per eight ticks
  })

  it('keeps running while a Koda window still holds focus after a sibling blurs', () => {
    start()
    arm()
    windows.emit('browser-window-blur') // another Koda window took over; focused stays true
    ticks(20)
    expect(runs).toBe(20)
  })

  it('runs an overdue probe the moment the user comes back, not on its next tick', () => {
    start()
    arm({ wake: true })
    power.emit('lock-screen')
    ticks(5) // paused: nothing ran, and the probe is now well past its interval
    expect(runs).toBe(0)

    power.emit('unlock-screen') // catch-up fires here, before any tick
    expect(runs).toBe(1)
  })

  it('does not re-run a probe that just ran when focus flickers', () => {
    start()
    arm({ wake: true })
    focused = false
    windows.emit('browser-window-blur')
    focused = true
    windows.emit('browser-window-focus') // probe ran ~0ms ago — not overdue, no catch-up
    expect(runs).toBe(0)
  })

  it('counts an activity-driven run, so coming back does not poll twice', () => {
    start()
    arm({ wake: true })
    power.emit('lock-screen')
    ticks(5)
    probe?.ran() // a turn ended and refreshed this probe's data on its own
    power.emit('unlock-screen')
    expect(runs).toBe(0)
  })

  it('releases the catch-up registration', () => {
    start()
    arm({ wake: true })
    power.emit('lock-screen')
    ticks(5)
    probe?.release()
    power.emit('unlock-screen')
    expect(runs).toBe(0)
  })

  // A probe something else still reads while the Mac is locked (the phone's usage readout, the
  // overnight dream's headroom gate) must not have its last value frozen for as long as the lid is shut.
  it('stretches rather than pauses a probe that opted out of the lock pause', () => {
    start()
    arm({ pauseOnLock: false })
    power.emit('lock-screen')
    ticks(8)
    expect(runs).toBe(2) // one run per four ticks, not zero
  })

  it('stretches that probe further when the locked Mac is on battery', () => {
    battery = true
    start()
    arm({ pauseOnLock: false })
    power.emit('lock-screen')
    ticks(16)
    expect(runs).toBe(2)
  })

  // The catch-up doesn't reset the probe's own interval, so its next scheduled tick lands a full
  // interval after registration but only moments after the catch-up ran. Without an elapsed floor
  // that tick starts a second concurrent run of the same subprocess.
  it('does not run again on the scheduled tick that follows a catch-up', () => {
    start()
    arm({ wake: true })
    power.emit('lock-screen')
    vi.advanceTimersByTime(EVERY_MS * 4 + EVERY_MS * 0.9) // paused; next tick is 0.1 of an interval away
    expect(runs).toBe(0)

    power.emit('unlock-screen')
    expect(runs).toBe(1) // the catch-up

    ticks(1) // the probe's own tick lands right behind it
    expect(runs).toBe(1)
  })

  it('goes straight back to its own cadence after a catch-up', () => {
    start()
    arm({ wake: true })
    power.emit('lock-screen')
    ticks(5) // the unlock below lands on a tick boundary, so every later tick is a full interval old
    power.emit('unlock-screen')
    expect(runs).toBe(1)

    ticks(2)
    expect(runs).toBe(3) // the elapsed floor delays nothing that was genuinely due
  })

  // A lid opened at the login screen is a resume, not an arrival: nobody has proved they're here and
  // the Mac woke onto an unknown network.
  it('does not catch up on a resume that wakes to a locked screen', () => {
    start()
    arm({ wake: true })
    power.emit('lock-screen')
    ticks(5)
    power.emit('suspend')
    vi.setSystemTime(Date.now() + 8 * 60 * 60_000) // asleep overnight
    power.emit('resume')
    expect(runs).toBe(0)

    power.emit('unlock-screen') // someone actually arrives
    expect(runs).toBe(1)
  })

  // …but the probe that opted out of the lock pause is the one still being read while the screen is
  // locked, so waiting for an arrival would leave its consumer stale for a whole stretched window.
  it('does catch up on that resume for a probe that opted out of the lock pause', () => {
    start()
    arm({ wake: true, pauseOnLock: false })
    power.emit('lock-screen')
    power.emit('suspend')
    vi.setSystemTime(Date.now() + 8 * 60 * 60_000) // asleep overnight, still locked on waking
    power.emit('resume')
    expect(runs).toBe(1)
  })

  // `unlock-screen` rides a best-effort distributed notification. If macOS drops it, the first
  // click into a Koda window is proof the screen is unlocked — the pause must not outlive the lock.
  it('focus heals a missed unlock notification', () => {
    start()
    arm({ wake: true }) // pauses on lock, like the update check
    focused = false
    windows.emit('browser-window-blur')
    power.emit('lock-screen')
    ticks(5)
    expect(runs).toBe(0) // paused; the unlock notification never arrives

    focused = true
    windows.emit('browser-window-focus')
    expect(runs).toBe(1) // focus healed the stale lock and caught the probe up
  })
})
