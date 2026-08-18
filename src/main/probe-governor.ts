/**
 * Power-aware background probes — one place that decides whether a NON-ESSENTIAL standing poll is
 * worth waking the CPU for.
 *
 * Koda keeps a couple of probes running that nobody is waiting on: the account usage heartbeat (which
 * spawns a real `claude -p "/usage"` subprocess every five minutes) and the six-hourly update check.
 * With the lid shut, the screen locked, or Koda parked behind another app all afternoon, each of those
 * is a timer that wakes a sleeping CPU to produce something no one will read for hours — on a laptop,
 * out of the user's own charge.
 *
 * A probe keeps its OWN cadence: its own interval, its own activity triggers, its own skip rules. It
 * only asks this module, at the top of each tick, whether the tick is worth taking. Two answers:
 *   paused     the system is suspended, or the screen is locked and this probe pauses on lock.
 *   stretched  nobody is at a Koda window — take one tick in N, and a larger N on battery, where the
 *              wake costs the user charge rather than wall power.
 * Anything else runs at the probe's own cadence, untouched.
 *
 * "Nobody is at a Koda window" is a locked screen, or no focused Koda window for AWAY_AFTER_MS. The
 * difference between pausing and stretching on lock is who READS the probe's output: a locked Mac
 * still serves a phone, and still runs the overnight dream, so a probe those depend on takes the
 * stretch (`pauseOnLock: false`) rather than freezing its last value for as long as the lid is shut.
 *
 * Coming back is prompt, not incidental: a wake, an unlock, or the user returning to a Koda window
 * immediately runs every probe already past its own base interval, so sitting down never means staring
 * at a gauge that will refresh in four minutes.
 *
 * Deliberately NOT governed: anything the phone depends on. Remote transports, the relay ping, the
 * connect reconciler, the broker keepalive, and the suspension watchdog keep their own cadence
 * untouched — a Mac that saves power by dropping the phone has broken the thing Connect is sold on.
 * Also ungoverned: probes that only exist while real work is in flight (the workflow journal watcher,
 * the provider-outage recovery watch), because "idle" is exactly when their result matters most.
 *
 * There is no setting and no toggle here by design (curate, not configure). macOS Low Power Mode has
 * no Electron API, so running on battery is the available proxy for "the user is conserving".
 */
import { app, BrowserWindow, powerMonitor } from 'electron'
import { log } from './logger'

/** No focused Koda window for this long ⇒ nobody is watching what these probes feed. Long enough that
 *  reading a page in a browser, or watching an agent work from another app, never trips it. */
const AWAY_AFTER_MS = 10 * 60_000
/** Take one tick in N while away. Battery buys the longer stretch: same signal, costlier wake. */
const AWAY_STRETCH = 4
const BATTERY_STRETCH = 8
/** A run must be at least this much of the probe's own interval old. Guards the catch-up→scheduled-tick
 *  double-fire; see `due()` for why it isn't 1. */
const MIN_ELAPSED_FRACTION = 0.9

/** The Electron surfaces this module reads, named so a test can drive them without an Electron runtime. */
export interface ProbeEnvironment {
  power: {
    on(event: PowerEvent, listener: () => void): unknown
    off(event: PowerEvent, listener: () => void): unknown
    isOnBatteryPower(): boolean
  }
  windows: {
    on(event: WindowEvent, listener: () => void): unknown
    off(event: WindowEvent, listener: () => void): unknown
    /** True while any Koda window holds the foreground. */
    anyFocused(): boolean
  }
  now(): number
}

type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen' | 'on-ac' | 'on-battery'
type WindowEvent = 'browser-window-focus' | 'browser-window-blur'

export interface GovernedProbe {
  /** Ask at the top of the probe's own tick. False ⇒ skip this one. CONSUMES the tick: a stretched
   *  probe counts the skipped ticks, so this must be called once per tick and its answer obeyed. */
  due(): boolean
  /** A run happened outside the tick (an activity-driven refresh, a manual check). The stretch counts
   *  from here instead, so returning to the desk doesn't poll twice in a row. */
  ran(): void
  /** Stop offering this probe the catch-up run on wake. */
  release(): void
}

interface ProbeRecord {
  name: string
  everyMs: number
  /** Ticks taken toward the current stretch; reset by every run, governed or not. */
  ticks: number
  lastRunAt: number
  /** False ⇒ a locked screen only stretches this probe. See `governProbe`. */
  pauseOnLock: boolean
  wake?: () => void
}

const probes = new Set<ProbeRecord>()

let env: ProbeEnvironment | null = null
let suspended = false
let locked = false
let onBattery = false
/** When Koda last lost the foreground; null while a Koda window holds it. */
let unfocusedSince: number | null = null

function now(): number {
  return env?.now() ?? Date.now()
}

/** How many of this probe's own ticks one run costs right now; null ⇒ paused entirely. */
function stretch(at: number, pauseOnLock = true): number | null {
  if (suspended) return null // the machine is off; its timers aren't firing anyway
  // A locked screen is the strongest "nobody is here" signal there is, so it's the default pause. A
  // probe whose output another surface still reads while the Mac is locked opts out and takes the
  // away stretch instead (see `pauseOnLock`).
  if (locked) return pauseOnLock ? null : awayStretch()
  if (unfocusedSince === null) return 1
  if (at - unfocusedSince < AWAY_AFTER_MS) return 1
  return awayStretch()
}

function awayStretch(): number {
  return onBattery ? BATTERY_STRETCH : AWAY_STRETCH
}

/**
 * Register a non-essential probe. Registration is inert until `startProbeGovernor` runs (and stays
 * inert if it never does), so a probe can be created at any point in boot and simply runs at its own
 * cadence until the governor is listening.
 */
export function governProbe(
  name: string,
  everyMs: number,
  opts: {
    /** Run this probe NOW when the machine comes back and it is already past `everyMs`. Omit for a
     *  probe whose own next tick is soon enough that a catch-up would just be a duplicate. */
    wake?: () => void
    /** Pass `false` when something OTHER than a person at this Mac reads what this probe writes — the
     *  phone, or an unattended scheduler. A locked screen then stretches it (still 1-in-8 on battery)
     *  instead of freezing its last value for as long as the lid stays shut. Defaults to pausing. */
    pauseOnLock?: boolean
  } = {},
): GovernedProbe {
  const record: ProbeRecord = {
    name,
    everyMs,
    ticks: 0,
    lastRunAt: now(),
    pauseOnLock: opts.pauseOnLock ?? true,
    wake: opts.wake,
  }
  probes.add(record)
  return {
    due(): boolean {
      const at = now()
      const factor = stretch(at, record.pauseOnLock)
      if (factor === null) return false
      // Counting ticks rather than measuring elapsed time keeps this immune to timer drift: a probe
      // stretched 4× runs on its 4th tick, whatever the interval actually did.
      if (++record.ticks < factor) return false
      // …but a catch-up run doesn't reset the probe's own interval, so its next scheduled tick can
      // land seconds later and start a second concurrent run. The elapsed floor is what stops that.
      // Deliberately 0.9 rather than a full interval: a probe that calls `ran()` from inside the run
      // `due()` just authorized stamps `lastRunAt` a moment late, and an exact comparison would then
      // suppress every tick after it.
      if (at - record.lastRunAt < record.everyMs * MIN_ELAPSED_FRACTION) return false
      record.ticks = 0
      record.lastRunAt = at
      return true
    },
    ran(): void {
      record.ticks = 0
      record.lastRunAt = now()
    },
    release(): void {
      probes.delete(record)
    },
  }
}

/** The machine is back. Every probe already past its own base interval gets one catch-up run. */
function catchUp(reason: string): void {
  if (suspended) return // nothing has come back yet
  const at = now()
  const caught: string[] = []
  for (const probe of probes) {
    probe.ticks = 0
    // A lid opened at the login screen is a resume, not an arrival. For a probe that pauses on lock
    // that means waiting: catching up there would start an update download for an absent user, on
    // whatever network the Mac woke onto, and `unlock-screen` catches up too, so nothing is lost. A
    // probe that opted OUT of the lock pause is exactly the one still being read while the screen is
    // locked, so denying it here would leave the phone's snapshot stale for a whole stretched window.
    if (locked && probe.pauseOnLock) continue
    if (!probe.wake || at - probe.lastRunAt < probe.everyMs) continue
    probe.lastRunAt = at
    caught.push(probe.name)
    try {
      probe.wake()
    } catch (err) {
      log.warn('power', 'probe catch-up failed', {
        probe: probe.name,
        reason,
        err: err instanceof Error ? err.message : err,
      })
    }
  }
  // One line so "why did the gauge refresh just now" is answerable from the run log.
  if (caught.length) log.info('power', 'probes caught up', { reason, probes: caught })
}

function electronEnvironment(): ProbeEnvironment {
  return {
    power: {
      on: (event, listener) => powerMonitor.on(event as 'suspend', listener),
      off: (event, listener) => powerMonitor.off(event as 'suspend', listener),
      isOnBatteryPower: () => {
        try {
          return powerMonitor.isOnBatteryPower()
        } catch {
          return false // desktop, or an OS that won't say — never guess "conserving"
        }
      },
    },
    windows: {
      on: (event, listener) => app.on(event as 'browser-window-focus', listener),
      off: (event, listener) => app.off(event as 'browser-window-focus', listener),
      anyFocused: () => BrowserWindow.getFocusedWindow() != null,
    },
    now: Date.now,
  }
}

/**
 * Start listening. Electron-side: call once, after `app.whenReady()` — powerMonitor is unusable
 * before it. Returns a stop function; a (re)start owns the state from scratch, and registered probes
 * survive it.
 */
export function startProbeGovernor(environment: ProbeEnvironment = electronEnvironment()): () => void {
  env = environment
  suspended = false
  locked = false
  onBattery = environment.power.isOnBatteryPower()
  // No window has focus at boot (none exists yet). That is honest — the away clock starts now and is
  // cancelled the moment the first window takes the foreground.
  unfocusedSince = environment.windows.anyFocused() ? null : environment.now()

  const onSuspend = (): void => {
    suspended = true
  }
  const onResume = (): void => {
    suspended = false
    catchUp('resume')
  }
  const onLock = (): void => {
    locked = true
  }
  const onUnlock = (): void => {
    locked = false
    catchUp('unlock')
  }
  const onAc = (): void => {
    onBattery = false
  }
  const onBatteryPower = (): void => {
    onBattery = true
  }
  const onFocus = (): void => {
    // A focused window proves the screen is unlocked. `unlock-screen` rides a best-effort
    // distributed notification; if one is dropped, this is the heal that keeps a lock pause
    // from outliving the lock.
    locked = false
    if (unfocusedSince === null) return
    unfocusedSince = null
    catchUp('focus')
  }
  const onBlur = (): void => {
    // A blur can arrive AFTER the focus of the window that took over (two Koda windows, or a window
    // swap). Ask who holds the foreground now rather than trusting the event order.
    if (unfocusedSince !== null || environment.windows.anyFocused()) return
    unfocusedSince = environment.now()
  }

  const powerWiring: Array<[PowerEvent, () => void]> = [
    ['suspend', onSuspend],
    ['resume', onResume],
    ['lock-screen', onLock],
    ['unlock-screen', onUnlock],
    ['on-ac', onAc],
    ['on-battery', onBatteryPower],
  ]
  const windowWiring: Array<[WindowEvent, () => void]> = [
    ['browser-window-focus', onFocus],
    ['browser-window-blur', onBlur],
  ]
  for (const [event, listener] of powerWiring) environment.power.on(event, listener)
  for (const [event, listener] of windowWiring) environment.windows.on(event, listener)

  log.info('power', 'background probe governor watching', { onBattery })

  return () => {
    for (const [event, listener] of powerWiring) environment.power.off(event, listener)
    for (const [event, listener] of windowWiring) environment.windows.off(event, listener)
    if (env === environment) env = null
    suspended = false
    locked = false
    unfocusedSince = null
  }
}
