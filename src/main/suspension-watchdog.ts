/**
 * Names the silent killer behind "the socket just died": was the MAIN PROCESS actually stopped?
 *
 * The 08-06/08-07 relay-drop forensics (gauntlet, bar #7) ended at an unanswerable question — when
 * both ends of a healthy socket go quiet for 60s, was that a network path cut, a system sleep, or
 * macOS App Nap throttling the idle/backgrounded process until its timers (and pongs) stop? The log
 * couldn't say, because a stalled process logs nothing. This watchdog makes the stall itself leave a
 * trace: a 5s heartbeat timer whose LATE firing measures how long the process was out, plus
 * powerMonitor suspend/resume to tell real system sleep apart from process throttling.
 *
 * Diagnosis only — it fixes nothing. Drop sites (relay.ts) append `stallContext()` to their log
 * lines so one line names the cause: throttled process vs slept Mac vs (neither ⇒) network path.
 */
import { powerMonitor } from 'electron'
import { log } from './logger'

const TICK_MS = 5_000
/** A tick this much beyond its schedule means the process genuinely stopped, not GC jitter. */
const STALL_MS = 30_000
/** How far back a stall stays relevant to a socket-drop diagnosis (covers both liveness windows). */
const RECENT_MS = 120_000

type Stall = { kind: 'system sleep' | 'process throttle'; endedAt: number; gapMs: number }

let lastStall: Stall | null = null

/** One-line cause context for a drop log: what stopped the process, how long, how recently. */
export function stallContext(now = Date.now()): { afterStall?: string } {
  if (!lastStall || now - lastStall.endedAt > RECENT_MS) return {}
  const { kind, gapMs, endedAt } = lastStall
  return { afterStall: `${kind} ${Math.round(gapMs / 1000)}s, ended ${Math.round((now - endedAt) / 1000)}s before this` }
}

type PowerEvents = {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  off(event: 'suspend' | 'resume', listener: () => void): unknown
}

export function startSuspensionWatchdog(
  pm: PowerEvents = powerMonitor,
  now: () => number = Date.now
): () => void {
  lastStall = null // one watchdog per process; a (re)start owns the record from scratch
  let lastTick = now()
  let suspendedAt: number | null = null

  const onSuspend = (): void => {
    suspendedAt = now()
    log.info('main', 'system suspending')
  }
  const onResume = (): void => {
    const t = now()
    // suspendedAt can be null when the OS resumes without having told us it suspended (rare) — leave
    // lastTick alone then, so the tick gap still catches the outage, labelled as a throttle.
    if (suspendedAt != null) {
      lastStall = { kind: 'system sleep', endedAt: t, gapMs: t - suspendedAt }
      log.info('main', 'system resumed', { sleptSeconds: Math.round((t - suspendedAt) / 1000) })
      suspendedAt = null
      lastTick = t // this gap is accounted for — don't double-report it as a throttle
    }
  }
  pm.on('suspend', onSuspend)
  pm.on('resume', onResume)

  const timer = setInterval(() => {
    const t = now()
    const gap = t - lastTick
    lastTick = t
    if (gap <= TICK_MS + STALL_MS) return
    // A resume handler that already claimed this same outage window wins the label (sleep, with the
    // truer duration); only an unclaimed gap is the interesting case — the process was throttled.
    if (lastStall && t - lastStall.endedAt < gap) return
    lastStall = { kind: 'process throttle', endedAt: t, gapMs: gap - TICK_MS }
    log.warn('main', 'main process was suspended or throttled — timers stalled', {
      seconds: Math.round((gap - TICK_MS) / 1000),
    })
  }, TICK_MS)

  return () => {
    clearInterval(timer)
    pm.off('suspend', onSuspend)
    pm.off('resume', onResume)
  }
}
