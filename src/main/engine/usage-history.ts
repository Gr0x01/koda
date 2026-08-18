/**
 * Daily usage history — a tiny fail-soft JSON rollup in userData (same pattern as settings.ts /
 * assist/labels.ts; not a DB). Each completed turn folds into the current local day's bucket, keyed
 * by model. This is the "where did my month go" record that outlives the in-memory open/restored
 * sessions (which only cover what's currently loaded). Cost mirrors the turn's `total_cost_usd`; on a subscription it's the API-
 * equivalent estimate the plan covers, in API mode the real billed amount — same as `spendUsd`.
 */
import { app } from 'electron'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import type { ModelSpend, ModelTurnUsage, RateLimitInfo, UsageHistoryDay } from '@shared/ipc'
import { log } from '../logger'
import type { EngineId } from '@shared/ipc'

type StoredDay = Omit<UsageHistoryDay, 'date'>
type Stored = { version: 1; days: Record<string, StoredDay> }

/** Keep roughly a quarter of history; older days are pruned on write so the file stays small. */
const RETAIN_DAYS = 90

function filePath(): string {
  return join(app.getPath('userData'), 'koda-usage-history.json')
}

type ReadResult = { store: Stored; writable: boolean }

function read(): ReadResult {
  try {
    const p = JSON.parse(readFileSync(filePath(), 'utf8'))
    if (p && typeof p === 'object' && p.days && typeof p.days === 'object')
      return { store: p as Stored, writable: true }
    throw new Error('usage history has an invalid shape')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { store: { version: 1, days: {} }, writable: true }
    log.warn('usage', 'usage history is present but unreadable; preserving it', err instanceof Error ? err.message : err)
    try {
      copyFileSync(filePath(), `${filePath()}.corrupt.bak`, 1)
    } catch {
      // The original stays in place; the important guard is that this read can never authorize a write.
    }
  }
  return { store: { version: 1, days: {} }, writable: false }
}

function write(s: Stored): void {
  try {
    writeFileAtomic(filePath(), JSON.stringify(s, null, 2))
  } catch (err) {
    log.warn('usage', 'failed to persist usage history', err instanceof Error ? err.message : err)
  }
}

/** Local calendar day (the user's wall-clock day is what they reason about), `YYYY-MM-DD`. */
function localDay(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyDay(): StoredDay {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
    byModel: {},
    byEngine: {},
  }
}

function sumCost(models: ModelTurnUsage[]): number {
  return models.reduce((sum, m) => sum + m.costUsd, 0)
}

/** Drop all but the most recent RETAIN_DAYS days. `YYYY-MM-DD` sorts lexically by date. */
function prune(s: Stored): void {
  const dates = Object.keys(s.days).sort()
  for (let i = 0; i < dates.length - RETAIN_DAYS; i++) delete s.days[dates[i]]
}

// Serialize read/modify/write so concurrent turns (multi-session) don't clobber each other's day bucket.
let chain: Promise<void> = Promise.resolve()

/**
 * Fold one completed turn into today's rollup. Fire-and-forget — callers never await. `costEstimate`
 * is the provider's authoritative total when it reports one; `models` carries normalized per-model
 * token facts and may carry zero cost on tokens-only engines. A turn with neither is skipped.
 */
export function recordTurnUsage(
  models: ModelTurnUsage[] | undefined,
  costEstimate: number | undefined,
  engineId: EngineId = 'claude',
): void {
  if (!models?.length && !costEstimate) return
  chain = chain
    .then(() => {
      const { store, writable } = read()
      if (!writable) return
      const date = localDay()
      const day = store.days[date] ?? emptyDay()
      const turnCost = costEstimate ?? sumCost(models ?? [])
      day.turns += 1
      day.costUsd += turnCost
      day.byEngine = day.byEngine ?? {}
      day.byEngine[engineId] = (day.byEngine[engineId] ?? 0) + turnCost
      for (const m of models ?? []) {
        day.inputTokens += m.inputTokens
        day.outputTokens += m.outputTokens
        day.cacheReadTokens += m.cacheReadTokens
        day.cacheCreationTokens += m.cacheCreationTokens
        const acc: ModelSpend | undefined = day.byModel[m.model]
        day.byModel[m.model] = {
          costUsd: (acc?.costUsd ?? 0) + m.costUsd,
          inputTokens: (acc?.inputTokens ?? 0) + m.inputTokens,
          outputTokens: (acc?.outputTokens ?? 0) + m.outputTokens,
          cacheReadTokens: (acc?.cacheReadTokens ?? 0) + m.cacheReadTokens,
          cacheCreationTokens: (acc?.cacheCreationTokens ?? 0) + m.cacheCreationTokens,
        }
      }
      store.days[date] = day
      prune(store)
      write(store)
    })
    .catch(() => {})
}

/** Recent daily rollups, newest first (default last 30 days) — for the Usage view's History section. */
export function loadUsageHistory(maxDays = 30): UsageHistoryDay[] {
  const { store } = read()
  return Object.entries(store.days)
    .map(([date, d]) => ({ date, ...d }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxDays)
}

// ── Last-seen account windows (rate limits) ───────────────────────────────────
// Persisted so a fresh boot still knows the unexpired windows — a weekly window is valid for days,
// and the stream only re-reports windows as turns run. Same fail-soft JSON pattern as the rollup
// above, in its own file (different lifecycle: overwritten per window, not accumulated).

type StoredWindows = { version: 1; byEngine: Partial<Record<EngineId, Record<string, RateLimitInfo>>> }

function windowsPath(): string {
  return join(app.getPath('userData'), 'koda-rate-limits.json')
}

// In-memory mirror of the file so per-turn updates don't re-read, and unchanged updates skip the write
// (within a window the band/reset usually repeat turn after turn).
let windowsCache: StoredWindows | null = null

function readWindows(): StoredWindows {
  if (windowsCache) return windowsCache
  try {
    const p = JSON.parse(readFileSync(windowsPath(), 'utf8'))
    if (p && typeof p === 'object' && p.byEngine && typeof p.byEngine === 'object')
      return (windowsCache = p as StoredWindows)
  } catch {
    /* missing/corrupt → empty */
  }
  return (windowsCache = { version: 1, byEngine: {} })
}

/** Persist the reconciler's complete engine map. Main owns merge/precedence; disk mirrors that answer
 *  instead of independently replaying the update and risking a different result. */
export function replaceRateLimits(engineId: EngineId, windows: Record<string, RateLimitInfo>): void {
  const store = readWindows()
  if (JSON.stringify(store.byEngine[engineId] ?? {}) === JSON.stringify(windows)) return
  store.byEngine[engineId] = windows
  try {
    writeFileAtomic(windowsPath(), JSON.stringify(store, null, 2))
  } catch (err) {
    log.warn('usage', 'failed to persist rate-limit windows', err instanceof Error ? err.message : err)
  }
}

/** Last-seen windows per engine that haven't reset yet — the boot-time seed. An expired window is
 *  dropped, not carried over: past its reset the real band is unknown, and showing the old one would
 *  be a fabrication. */
export function loadRateLimits(): Partial<Record<EngineId, Record<string, RateLimitInfo>>> {
  const nowSec = Date.now() / 1000
  const out: Partial<Record<EngineId, Record<string, RateLimitInfo>>> = {}
  for (const [engine, windows] of Object.entries(readWindows().byEngine)) {
    const live = Object.fromEntries(
      Object.entries(windows ?? {}).filter(
        ([, w]) => typeof w?.rateLimitType === 'string' && typeof w.resetsAt === 'number' && w.resetsAt > nowSec,
      ),
    )
    if (Object.keys(live).length)
      out[engine as EngineId] = Object.fromEntries(
        Object.entries(live).map(([type, info]) => [type, { ...info, source: info.source ?? 'disk' }]),
      )
  }
  return out
}
