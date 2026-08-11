/**
 * Ping the user the moment a MAXED-OUT plan window resets — and only then.
 *
 * Account-level limits reset every window whether or not you touched the cap; a ping on every reset
 * would be noise. The signal worth surfacing is the narrow one: you hit 100% (`status === 'rejected'`),
 * got blocked, and now the window has rolled over so you can resume. We watch the per-engine
 * `RateLimitUpdate` stream in the main process, latch "this window maxed", and fire exactly one ping
 * when its `resetsAt` passes. Every non-overage window type is tracked — originally 5-hour only, but
 * with doubled 5-hour caps the weekly (`seven_day`) window is now the wall people actually hit, and
 * since ~2026-07 it may be the only window the Claude stream reports at all.
 *
 * Two fire paths, both guarded by `fired` so the ping lands once:
 *  - a timer armed at `resetsAt` (the prompt path while the Mac is awake), and
 *  - a transition check when a fresh window (a later `resetsAt`) is first observed — the backstop for a Mac
 *    that was asleep at the reset instant (the timer runs late; the next turn's update catches it first).
 *
 * State is per engine+window and in-memory only: it starts empty on boot (no spurious ping from a
 * restored "maxed"), and a single account-level ping per window reset — never per session.
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

const windows = new Map<string, TrackedWindow>() // key = `${engine}:${rateLimitType}`

// The /usage poll reports the SAME window's resetsAt with up to ±60s wobble (server-side minute
// rounding). A real rollover jumps by the window length (5h / 7d), so anything under this slack is
// jitter for the tracked window, not a fresh one — treating it as a rollover fired a spurious
// "limit reset" ping on every wobble while maxed (3 pings in 80min, 2026-08-03).
const ROLLOVER_SLACK_S = 15 * 60

/** Feed every `RateLimitUpdate` here; overage variants are the same window re-reported. */
export function noteRateLimit(engine: string, info: RateLimitInfo): void {
  if (typeof info.resetsAt !== 'number' || info.rateLimitType.includes('overage')) return
  const key = `${engine}:${info.rateLimitType}`
  const maxed = info.status === 'rejected' // both engines: the cap is hit
  const prev = windows.get(key)

  // A substantially later reset time means the tracked window rolled over. If it maxed and we never got
  // to ping (Mac was asleep when the timer should have run), this fresh-window update is our backstop —
  // ping now.
  if (prev && info.resetsAt > prev.resetsAt + ROLLOVER_SLACK_S) {
    if (prev.maxed && !prev.fired) fire(key, engine, info.rateLimitType)
    clearTimer(prev)
    windows.delete(key)
  }

  const cur = windows.get(key) ?? { resetsAt: info.resetsAt, maxed: false, fired: false }
  if (info.resetsAt > cur.resetsAt) {
    cur.resetsAt = info.resetsAt // jitter moved the instant later — track the latest, never regress
    if (cur.maxed && !cur.fired) arm(key, engine, info.rateLimitType, cur)
  }
  if (maxed && !cur.maxed) {
    cur.maxed = true
    arm(key, engine, info.rateLimitType, cur) // latch + schedule the reset ping
  }
  windows.set(key, cur)
}

function arm(key: string, engine: string, type: string, cur: TrackedWindow): void {
  clearTimer(cur)
  // Fire just after the reset instant so the window is genuinely clear by the time the banner lands.
  const delay = Math.max(0, cur.resetsAt * 1000 - Date.now()) + 2000
  cur.timer = setTimeout(() => {
    if (!cur.fired) fire(key, engine, type)
  }, delay)
}

function fire(key: string, engine: string, type: string): void {
  const cur = windows.get(key)
  if (cur) {
    cur.fired = true // mark this reset handled even when silenced, so it can't re-fire later
    clearTimer(cur)
  }
  if (!loadUsageResetNotify()) return // toggled off in Settings — read live at fire time
  const label = engine === 'codex' ? 'OpenAI' : 'Claude'
  const windowWord = type === 'five_hour' ? '5-hour' : 'weekly'
  const title = 'Usage limit reset'
  const body = `Your ${label} ${windowWord} limit has reset. You're good to go.`
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (err) {
    log.warn('usage', 'reset notification failed', err instanceof Error ? err.message : err)
  }
  phonePush?.(title, body)
  log.info('usage', 'limit-reset ping sent', { engine, type })
}

function clearTimer(cur: TrackedWindow): void {
  if (cur.timer) {
    clearTimeout(cur.timer)
    cur.timer = undefined
  }
}
