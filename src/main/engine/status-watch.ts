/**
 * Provider outage watch — know when Claude/Codex is DOWN, and ping once when it's BACK.
 *
 * Deliberately not a status monitor: nothing runs while the user isn't working. The only entry point
 * is a turn failing with a provider-shaped error (`looksLikeProviderDown` on the drivers' EngineError).
 * That triggers ONE check of the provider's public status feed; only a feed-confirmed incident enters
 * the watching state (a lone 500 with a green feed stays an ordinary error — no false alarms).
 *
 * While watching: the renderer shows a quiet pill (broadcast hook), the Mac polls the feed every
 * minute, and — when a phone is paired on the cloud-relay tier — a server-side watch is registered so
 * the "back up" push arrives even if the Mac lid closes (the Mac can't poll while asleep; see
 * supabase/functions/status-watch). Recovery fires exactly one macOS notification (+ phone push only
 * when no server watch took the job), then the whole thing forgets itself. A successful turn while
 * watching also clears it silently — the user is plainly back at work.
 *
 * Feeds are the providers' public Statuspage-format JSON; we filter to the components that can break
 * the ENGINE (Claude API / Claude Code, Codex API) so a claude.ai-web or FedRAMP incident never flags.
 */
import { Notification } from 'electron'
import { loadProviderStatusNotify } from '../settings'
import { log } from '../logger'

export interface ProviderStatusEvent {
  engine: string
  down: boolean
  /** Human-readable incident/component line for the pill tooltip. */
  note?: string
}

interface FeedSpec {
  url: string
  /** Components that can break the engine; anything else on the page is noise for us. */
  components: RegExp
  /** Provider name for user-facing copy. */
  provider: string
  label: string
}

const FEEDS: Record<string, FeedSpec> = {
  claude: {
    url: 'https://status.claude.com/api/v2/summary.json',
    components: /claude api|claude code/i,
    provider: 'Anthropic',
    label: 'Claude',
  },
  codex: {
    url: 'https://status.openai.com/api/v2/summary.json',
    components: /codex api/i,
    provider: 'OpenAI',
    label: 'Codex',
  },
}

/** Provider-side failure shapes, shared by both drivers' EngineError classification. */
export function looksLikeProviderDown(message: string): boolean {
  return /\b(500|502|503|504|529)\b|overloaded|temporarily unavailable|service unavailable|upstream unavailable|bad gateway|gateway timeout|internal server error/i.test(
    message,
  )
}

// ── Hooks (injected by the IPC layer, like setUsageResetPush) ────────────────────
interface StatusWatchHooks {
  /** Push the pill state to every window. */
  broadcast: (e: ProviderStatusEvent) => void
  /** Register a server-side watch (phone push survives Mac sleep). Resolves true when registered. */
  registerRemoteWatch: (engine: string) => Promise<boolean>
  /** Drop the server-side watch (idempotent; the server may already have fired + cleaned up). */
  cancelRemoteWatch: (engine: string) => Promise<void>
  /** Direct phone push — the fallback when no server watch got registered (Mac stayed awake). */
  phonePush: (title: string, body: string) => void
}
let hooks: StatusWatchHooks | null = null
export function setStatusWatchHooks(h: StatusWatchHooks | null): void {
  hooks = h
}

interface WatchState {
  note?: string
  timer: ReturnType<typeof setInterval>
  remoteRegistered: boolean
}

const watching = new Map<string, WatchState>() // key = engine
const lastCheckAt = new Map<string, number>() // debounce for the error-triggered one-shot check

const CHECK_DEBOUNCE_MS = 30_000
const POLL_MS = 60_000

/** Current down-state, for seeding a window that opens mid-outage. */
export function currentProviderStatus(): ProviderStatusEvent[] {
  return Array.from(watching.entries()).map(([engine, s]) => ({ engine, down: true, note: s.note }))
}

/** A turn failed with a provider-shaped error → one feed check; a confirmed incident starts the watch. */
export function noteProviderError(engine: string): void {
  if (watching.has(engine) || !FEEDS[engine]) return
  const now = Date.now()
  if (now - (lastCheckAt.get(engine) ?? 0) < CHECK_DEBOUNCE_MS) return
  lastCheckAt.set(engine, now)
  void checkFeed(engine)
    .then((status) => {
      if (status?.down && !watching.has(engine)) enterOutage(engine, status.note)
    })
    .catch(() => {})
}

/** A successful turn while watching = the user is back at work; clear silently (no ping). */
export function noteTurnOk(engine: string): void {
  const s = watching.get(engine)
  if (!s) return
  clearWatch(engine, s)
  void hooks?.cancelRemoteWatch(engine).catch(() => {}) // no phone ping either — they're plainly back
  hooks?.broadcast({ engine, down: false })
  log.info('status', 'outage watch cleared by a successful turn', { engine })
}

function enterOutage(engine: string, note: string | undefined): void {
  const state: WatchState = {
    note,
    remoteRegistered: false,
    timer: setInterval(() => void poll(engine), POLL_MS),
  }
  watching.set(engine, state)
  hooks?.broadcast({ engine, down: true, note })
  // Server-side watch so the recovery push survives the Mac sleeping. Best-effort: no phone paired or
  // relay off → the Mac-side poll still covers the lid-open case. Gated on the Settings toggle HERE
  // (not just at fire time) — the server never sees the toggle, so an off user must never get a row.
  if (loadProviderStatusNotify()) {
    void hooks
      ?.registerRemoteWatch(engine)
      .then((ok) => {
        state.remoteRegistered = ok
      })
      .catch(() => {})
  }
  log.info('status', 'provider outage confirmed — watching for recovery', { engine, note })
}

async function poll(engine: string): Promise<void> {
  const s = watching.get(engine)
  if (!s) return
  const status = await checkFeed(engine).catch(() => null)
  if (!status) return // feed unreachable — keep watching
  if (status.down) {
    if (status.note && status.note !== s.note) {
      s.note = status.note
      hooks?.broadcast({ engine, down: true, note: status.note })
    }
    return
  }
  recovered(engine, s)
}

function recovered(engine: string, s: WatchState): void {
  clearWatch(engine, s)
  hooks?.broadcast({ engine, down: false })
  log.info('status', 'provider recovered', { engine })
  if (!loadProviderStatusNotify()) {
    // Toggled off mid-outage — no ping anywhere, including a server watch registered while it was on.
    void hooks?.cancelRemoteWatch(engine).catch(() => {})
    return
  }
  const feed = FEEDS[engine]
  const title = `${feed.label} is back up`
  const body = `${feed.provider}'s outage is over. Pick up where you left off.`
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (err) {
    log.warn('status', 'recovery notification failed', err instanceof Error ? err.message : err)
  }
  // The phone ping: when a server watch is registered, LEAVE its row — the edge function pushes and
  // deletes on its next tick (cancelling here would race it: whoever polls the feed first would eat
  // the other's push, and the Mac seeing green first would mean no phone ping at all). Only push
  // directly when the server watch never registered.
  if (!s.remoteRegistered) hooks?.phonePush(title, body)
}

/** Stop polling + drop the pill state. Server-watch cancellation is deliberately NOT here — recovery
 *  leaves the row for the edge function to consume, while noteTurnOk cancels it explicitly. */
function clearWatch(engine: string, s: WatchState): void {
  clearInterval(s.timer)
  watching.delete(engine)
}

// ── Feed check ───────────────────────────────────────────────────────────────────
const BAD = new Set(['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance'])

async function checkFeed(engine: string): Promise<{ down: boolean; note?: string } | null> {
  const feed = FEEDS[engine]
  if (!feed) return null
  const res = await fetch(feed.url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
  if (!res.ok) return null
  const data = (await res.json()) as {
    status?: { indicator?: string; description?: string }
    components?: Array<{ name?: string; status?: string }>
    incidents?: Array<{ name?: string }>
  }
  const relevant = (data.components ?? []).filter((c) => feed.components.test(c.name ?? ''))
  if (relevant.length > 0) {
    const broken = relevant.filter((c) => BAD.has(c.status ?? ''))
    if (broken.length === 0) return { down: false }
    const note =
      data.incidents?.[0]?.name ?? `${broken[0].name}: ${(broken[0].status ?? '').replace(/_/g, ' ')}`
    return { down: true, note }
  }
  // Component names drifted (page redesign) — fall back to the page-level indicator, majors only, so a
  // provider-wide meltdown still registers without a web-only blip flagging the engine.
  const ind = data.status?.indicator
  if (ind === 'major' || ind === 'critical')
    return { down: true, note: data.incidents?.[0]?.name ?? data.status?.description }
  return { down: false }
}
