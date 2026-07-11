/**
 * Ping the user the moment a MAXED-OUT 5-hour window resets — and only then.
 *
 * The account-level 5-hour limit resets every window whether or not you touched the cap; a ping on every
 * reset would be noise. The signal worth surfacing is the narrow one: you hit 100% (`status === 'rejected'`),
 * got blocked, and now the window has rolled over so you can resume. We watch the per-engine `RateLimitUpdate`
 * stream in the main process, latch "this window maxed", and fire exactly one ping when its `resetsAt` passes.
 *
 * Two fire paths, both guarded by `fired` so the ping lands once:
 *  - a timer armed at `resetsAt` (the prompt path while the Mac is awake), and
 *  - a transition check when a fresh window (a later `resetsAt`) is first observed — the backstop for a Mac
 *    that was asleep at the reset instant (the timer runs late; the next turn's update catches it first).
 *
 * State is per-engine and in-memory only: it starts empty on boot (no spurious ping from a restored "maxed"),
 * and a single account-level ping per engine — never per session or per window.
 */
import { Notification } from 'electron'
import type { RateLimitInfo } from '@shared/ipc'
import { loadUsageResetNotify } from '../settings'
import { log } from '../logger'

/** Best-effort phone push (via the cloud relay when a phone is paired). Injected by the IPC layer. */
type PushFn = (title: string, body: string) => void
let phonePush: PushFn | null = null
export function setUsageResetPush(fn: PushFn | null): void {
  phonePush = fn
}

interface TrackedWindow {
  resetsAt: number
  maxed: boolean
  fired: boolean
  timer?: ReturnType<typeof setTimeout>
}

const windows = new Map<string, TrackedWindow>() // key = engine ('claude' | 'codex')

/** Feed every 5-hour `RateLimitUpdate` here (weekly windows are ignored — the ask is the 5-hour cap). */
export function noteRateLimit(engine: string, info: RateLimitInfo): void {
  if (info.rateLimitType !== 'five_hour' || typeof info.resetsAt !== 'number') return
  const maxed = info.status === 'rejected' // both engines: the cap is hit
  const prev = windows.get(engine)

  // A later reset time means the tracked window rolled over. If it maxed and we never got to ping (Mac was
  // asleep when the timer should have run), this fresh-window update is our backstop — ping now.
  if (prev && info.resetsAt > prev.resetsAt) {
    if (prev.maxed && !prev.fired) fire(engine)
    clearTimer(prev)
    windows.delete(engine)
  }

  const cur = windows.get(engine) ?? { resetsAt: info.resetsAt, maxed: false, fired: false }
  cur.resetsAt = info.resetsAt
  if (maxed && !cur.maxed) {
    cur.maxed = true
    arm(engine, cur) // latch + schedule the reset ping
  }
  windows.set(engine, cur)
}

function arm(engine: string, cur: TrackedWindow): void {
  clearTimer(cur)
  // Fire just after the reset instant so the window is genuinely clear by the time the banner lands.
  const delay = Math.max(0, cur.resetsAt * 1000 - Date.now()) + 2000
  cur.timer = setTimeout(() => {
    if (!cur.fired) fire(engine)
  }, delay)
}

function fire(engine: string): void {
  const cur = windows.get(engine)
  if (cur) {
    cur.fired = true // mark this reset handled even when silenced, so it can't re-fire later
    clearTimer(cur)
  }
  if (!loadUsageResetNotify()) return // toggled off in Settings — read live at fire time
  const label = engine === 'codex' ? 'OpenAI' : 'Claude'
  const title = 'Usage limit reset'
  const body = `Your ${label} 5-hour limit has reset. You're good to go.`
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (err) {
    log.warn('usage', 'reset notification failed', err instanceof Error ? err.message : err)
  }
  phonePush?.(title, body)
  log.info('usage', 'five-hour reset ping sent', { engine })
}

function clearTimer(cur: TrackedWindow): void {
  if (cur.timer) {
    clearTimeout(cur.timer)
    cur.timer = undefined
  }
}
