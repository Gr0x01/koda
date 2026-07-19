/**
 * Provider outage watch — know when Claude/Codex is DOWN, and ping once when it's BACK.
 *
 * Deliberately not a status monitor: nothing runs while the user isn't working. The only entry point
 * is a turn failing with a provider-shaped error (`looksLikeProviderDown` on the drivers' EngineError).
 *
 * ONE failed turn is enough — no retrying from the user. The provider's status page lags real experience
 * by many minutes (a human has to flip it), so gating on it would miss the outage you're already feeling.
 * Instead the first error starts a SILENT background watch and checks the feed once: if the page is
 * already red we surface the incident immediately; if not, the watch keeps polling so a confirmation that
 * lands minutes later still arms the recovery ping. Because a provisional watch shows NOTHING until the
 * feed corroborates — no pill, no server-side push, and a green feed is never read as recovery (the page
 * was green all along) — a lone blip costs nothing and can never raise a false alarm. It resolves when a
 * successful turn clears it, when the feed confirms then later recovers, or by quietly forgetting itself
 * after PROVISIONAL_GRACE_MS if the page never corroborates.
 *
 * While watching: the renderer shows a quiet pill (broadcast hook) once confirmed, the Mac polls the feed every
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
import type { ProviderKind, ProviderStatusEvent } from '@shared/ipc'
import { loadProviderStatusNotify } from '../settings'
import { log } from '../logger'

export type { ProviderStatusEvent }

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
  /** Reported severity from the feed — drives the chip word. Set once feed-confirmed. */
  kind?: ProviderKind
  timer: ReturnType<typeof setInterval>
  remoteRegistered: boolean
  /** Has the public feed corroborated this incident? Provisional (error-armed) watches start false. */
  feedConfirmed: boolean
  /** When the watch was armed — bounds how far ahead of the feed a provisional watch is trusted. */
  armedAt: number
}

const watching = new Map<string, WatchState>() // key = engine

const POLL_MS = 60_000
// How long a SILENT provisional watch keeps polling for the page to catch up. Nothing is user-visible in
// this window; if the feed never corroborates, the single stray error was a blip and we forget it.
const PROVISIONAL_GRACE_MS = 20 * 60_000

/** Current down-state, for seeding a window that opens mid-outage. Only feed-confirmed (user-visible)
 *  incidents count — a silent provisional watch has nothing to show yet. */
export function currentProviderStatus(): ProviderStatusEvent[] {
  return Array.from(watching.entries())
    .filter(([, s]) => s.feedConfirmed)
    .map(([engine, s]) => ({ engine, down: true, note: s.note, kind: s.kind }))
}

/** A turn failed with a provider-shaped error. On the FIRST failure we start a SILENT background watch and
 *  check the feed once: if the page is already red we surface it immediately; otherwise the watch keeps
 *  polling so a confirmation that lands minutes later (the page lags) still arms the recovery ping — with
 *  no retrying from the user. A lone blip the page never corroborates is forgotten silently. */
export function noteProviderError(engine: string): void {
  if (!FEEDS[engine] || watching.has(engine)) return
  enterOutage(engine, undefined, false) // silent until the feed corroborates
  void checkFeed(engine)
    .then((status) => {
      if (status?.down) confirmOutage(engine, status.note, status.kind)
    })
    .catch(() => {})
}

/** On-arrival check (window focus / app launch): for each engine the UI shows, look at the feed once so
 *  the chip is truthful the moment you sit down — without any background monitor. It reconciles BOTH ways:
 *  a red feed surfaces a confirmed incident you haven't personally hit; a green feed clears a surfaced one
 *  that resolved while we couldn't poll (the classic case: the Mac slept through the recovery, so the local
 *  poll never fired). The clear is silent — the server already handled any "back up" push, and a late local
 *  ping on wake would be stale. A green feed never arms a bare watch, and provisional watches are left to
 *  their own poll/grace. */
export async function refreshProviderStatus(engines: string[]): Promise<void> {
  await Promise.all(
    engines
      .filter((e) => FEEDS[e])
      .map((e) =>
        checkFeed(e)
          .then((status) => {
            if (!status) return
            const s = watching.get(e)
            if (status.down) confirmOutage(e, status.note, status.kind)
            else if (s?.feedConfirmed) clearSurfaced(e, s)
          })
          .catch(() => {}),
      ),
  )
}

/** A successful turn while watching = the user is back at work; clear silently. Only announce the clear if
 *  the incident had gone visible (a silent provisional watch never showed anything to take back). */
export function noteTurnOk(engine: string): void {
  const s = watching.get(engine)
  if (!s) return
  if (s.feedConfirmed) clearSurfaced(engine, s)
  else clearWatch(engine, s) // silent provisional watch — nothing was shown, nothing to take back
  log.info('status', 'outage watch cleared by a successful turn', { engine })
}

/** Clear a SURFACED incident without a recovery ping: drop the pill, cancel the server row. For clears
 *  that aren't a fresh "it's back" moment — a successful turn, or arrival-time reconciliation where the
 *  incident resolved while we couldn't poll (the server already pushed, or the recovery is now stale). */
function clearSurfaced(engine: string, s: WatchState): void {
  clearWatch(engine, s)
  void hooks?.cancelRemoteWatch(engine).catch(() => {})
  hooks?.broadcast({ engine, down: false })
}

function enterOutage(
  engine: string,
  note: string | undefined,
  feedConfirmed: boolean,
  kind?: ProviderKind,
): void {
  if (watching.has(engine)) return
  const state: WatchState = {
    note,
    kind,
    remoteRegistered: false,
    feedConfirmed,
    armedAt: Date.now(),
    timer: setInterval(() => void poll(engine), POLL_MS),
  }
  watching.set(engine, state)
  // A provisional watch stays invisible: no pill, no server push, until the feed corroborates.
  if (feedConfirmed) {
    hooks?.broadcast({ engine, down: true, note, kind })
    registerRemote(engine, state)
  }
  log.info(
    'status',
    feedConfirmed
      ? 'provider outage confirmed — watching for recovery'
      : 'provider error — watching the feed silently (page not yet confirming)',
    { engine, note },
  )
}

/** The feed corroborates the incident: surface a silent provisional watch (or open a confirmed one),
 *  refresh the pill note, and register the server-side push. */
function confirmOutage(engine: string, note: string | undefined, kind?: ProviderKind): void {
  const s = watching.get(engine)
  if (!s) {
    enterOutage(engine, note, true, kind)
    return
  }
  const changed = (!!note && note !== s.note) || (!!kind && kind !== s.kind)
  if (note) s.note = note
  if (kind) s.kind = kind
  if (!s.feedConfirmed) {
    s.feedConfirmed = true
    registerRemote(engine, s)
    hooks?.broadcast({ engine, down: true, note: s.note, kind: s.kind }) // chip surfaces now
    log.info('status', 'silent watch now feed-confirmed — surfacing', { engine, note, kind })
  } else if (changed) {
    hooks?.broadcast({ engine, down: true, note: s.note, kind: s.kind })
  }
}

/** Register the server-side watch so the recovery push survives the Mac sleeping. Only ever called for a
 *  feed-confirmed incident: the edge function decides recovery off the feed, so a provisional (page-still-
 *  green) row would make it fire "back up" on its very next tick. Gated on the Settings toggle HERE (not
 *  just at fire time) — the server never sees the toggle, so an off user must never get a row. */
function registerRemote(engine: string, state: WatchState): void {
  if (!loadProviderStatusNotify()) return
  void hooks
    ?.registerRemoteWatch(engine)
    .then((ok) => {
      state.remoteRegistered = ok
    })
    .catch(() => {})
}

async function poll(engine: string): Promise<void> {
  const s = watching.get(engine)
  if (!s) return
  const status = await checkFeed(engine).catch(() => null)
  if (!status) {
    expireIfStaleProvisional(engine, s) // feed unreachable — keep watching, but don't linger forever
    return
  }
  if (status.down) {
    confirmOutage(engine, status.note, status.kind) // upgrades a provisional watch + refreshes note/kind
    return
  }
  // Feed says green. Only a watch the feed had CONFIRMED down can recover off it going green again — for a
  // provisional watch the page was green all along, so this proves nothing. Wait for a successful turn
  // (noteTurnOk) or let the grace window lapse.
  if (s.feedConfirmed) recovered(engine, s)
  else expireIfStaleProvisional(engine, s)
}

/** A silent provisional watch the feed never corroborated is dropped after the grace window. Nothing was
 *  ever shown, so there's nothing to take back — just stop polling. */
function expireIfStaleProvisional(engine: string, s: WatchState): void {
  if (s.feedConfirmed || Date.now() - s.armedAt < PROVISIONAL_GRACE_MS) return
  clearWatch(engine, s)
  log.info('status', 'silent watch expired — feed never corroborated, forgetting', { engine })
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
// Statuspage component states → our coarse kind, ranked worst-first so the chip word matches reality (a
// slowdown is never called an "outage"). Anything not here is treated as healthy.
const KIND_BY_STATUS: Record<string, ProviderKind> = {
  major_outage: 'outage',
  partial_outage: 'partial',
  degraded_performance: 'degraded',
  under_maintenance: 'maintenance',
}
const KIND_RANK: Record<ProviderKind, number> = { outage: 4, partial: 3, degraded: 2, maintenance: 1 }

type FeedStatus = { down: boolean; note?: string; kind?: ProviderKind }

async function checkFeed(engine: string): Promise<FeedStatus | null> {
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
    const broken = relevant
      .map((c) => ({ c, kind: KIND_BY_STATUS[c.status ?? ''] }))
      .filter((x): x is { c: { name?: string; status?: string }; kind: ProviderKind } => !!x.kind)
      .sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind]) // worst-first
    if (broken.length === 0) return { down: false }
    const worst = broken[0]
    const note =
      data.incidents?.[0]?.name ??
      `${worst.c.name}: ${(worst.c.status ?? '').replace(/_/g, ' ')}`
    return { down: true, note, kind: worst.kind }
  }
  // Component names drifted (page redesign) — fall back to the page-level indicator, majors only, so a
  // provider-wide meltdown still registers without a web-only blip flagging the engine.
  const ind = data.status?.indicator
  if (ind === 'major' || ind === 'critical')
    return { down: true, kind: 'outage', note: data.incidents?.[0]?.name ?? data.status?.description }
  return { down: false }
}
