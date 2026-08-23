/**
 * Whole-subscription usage scan — reads the engine CLIs' own on-disk session transcripts (every
 * `.jsonl` under `~/.claude/projects` and `~/.codex/sessions`, plus Koda's isolated Codex home)
 * so usage stays complete even for turns that never ran through Koda. Terminal sessions and
 * other tools on this Mac show up; nothing leaves the machine. This is the accounting source for
 * the Usage page; the per-turn tracker in usage-history.ts keeps owning the live value view and
 * rate windows.
 *
 * Origin attribution: Codex is exact by home (Koda drives its own CODEX_HOME; `~/.codex` is other
 * tools). Claude shares one `~/.claude` between Koda and everything else, so Koda session ids are
 * recorded into a registry as sessions run; scanned records with an unregistered session id read
 * as `outside`. Sessions that predate the registry misattribute to `outside` until their next
 * turn — the totals are unaffected, only the through-Koda split line. Asides and structured
 * one-shots spawn with CLI-chosen ids and read as `outside` too, matching the turn tracker's
 * existing choice to leave their small cost uncounted.
 *
 * The per-file cache keys on mtime+size so a rescan only re-parses files that changed. Cached
 * entries store compact per-record rows (not aggregates) because Claude forks replay history into
 * new files: de-duplication by `messageId:requestId` has to happen across files, at merge time.
 */
import { app } from 'electron'
import { readFileSync, copyFileSync } from 'node:fs'
import { readdir, stat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import { codexHome } from './codex-home'
import { log } from '../logger'
import type { EngineId, PricedScanBucket, ScanOrigin, ScanSource } from '@shared/ipc'

/** The scanner's bucket is the shared wire shape minus the pricing fields usage-pricing.ts adds. */
export type ScanBucket = Omit<PricedScanBucket, 'costUsd' | 'cacheSavingsUsd' | 'costSource'>

export interface ScanSummary {
  buckets: ScanBucket[]
  sources: ScanSource[]
  scannedAt: number
  scanMs: number
}

/** [hourStartMs, model, origin, uncachedInput, cachedInput, cacheCreation, output, reasoning, dedupeKey] */
type Row = [number, string, ScanOrigin, number, number, number, number, number, string | null]

type FileCache = { mtimeMs: number; size: number; malformed: number; rows: Row[] }

type Stored = {
  version: 2
  /** Claude engine-session ids Koda has driven → last-seen local day (pruned by age). */
  knownClaudeSessions: Record<string, string>
  files: Record<string, FileCache>
}

const REGISTRY_RETAIN_DAYS = 180

function filePath(): string {
  return join(app.getPath('userData'), 'koda-usage-scan.json')
}

function emptyStore(): Stored {
  return { version: 2, knownClaudeSessions: {}, files: {} }
}

// Same fail-soft posture as usage-history.ts: an unreadable file is preserved for later diagnosis
// and never authorizes a write that would overwrite it.
function read(): { store: Stored; writable: boolean } {
  try {
    const p = JSON.parse(readFileSync(filePath(), 'utf8'))
    if (p && typeof p === 'object' && p.version === 2 && p.files && typeof p.files === 'object' && p.knownClaudeSessions)
      return { store: p as Stored, writable: true }
    // Valid JSON carrying an older cache format is STALE, not corrupt: discard and rebuild, so the
    // first scan after an upgrade overwrites it. Treating it as corrupt would flip writable off and
    // permanently disable the cache — a full cold re-scan on every Usage open, forever.
    if (p && typeof p === 'object' && typeof p.version === 'number')
      return { store: emptyStore(), writable: true }
    throw new Error('usage scan cache has an invalid shape')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { store: emptyStore(), writable: true }
    log.warn('usage', 'usage scan cache unreadable; preserving it', err instanceof Error ? err.message : err)
    try {
      copyFileSync(filePath(), `${filePath()}.corrupt.bak`, 1)
    } catch {
      // Original stays in place; the guard that matters is writable=false below.
    }
  }
  return { store: emptyStore(), writable: false }
}

function write(s: Stored): void {
  try {
    writeFileAtomic(filePath(), JSON.stringify(s))
  } catch (err) {
    log.warn('usage', 'usage scan cache write failed', err instanceof Error ? err.message : err)
  }
}

/** UTC-hour start of a timestamp — the bucket key for the rolling hourly view. Whole-hour local
 *  offsets keep day boundaries on hour boundaries, and the day is derived per record anyway. */
function hourStartOf(ms: number): number {
  return ms - (ms % 3_600_000)
}

/** Local calendar day of a timestamp (wall-clock day, matching usage-history's keying). */
function localDayOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── Koda-session registry (Claude origin attribution) ────────────────────────────

let chain: Promise<unknown> = Promise.resolve()
function serialize<T>(job: () => Promise<T> | T): Promise<T> {
  const next = chain.then(job)
  chain = next.catch(() => undefined)
  return next
}

const pendingClaudeIds = new Set<string>()

/** Record a Claude engine session as Koda-driven. Called from the driver constructor at spawn.
 *  Memory-only: the next scan folds pending ids into the persisted registry while it already holds
 *  the store, so session start never pays a read or write of the (large) cache file. An id lost to
 *  a quit before any scan re-registers on the session's next spawn; until then its records read as
 *  `outside`, which only shades the split line, never the totals. */
export function recordKodaClaudeSession(engineSessionId: string): void {
  if (engineSessionId) pendingClaudeIds.add(engineSessionId)
}

// ── Transcript parsing ───────────────────────────────────────────────────────────

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** One Claude `type:"assistant"` record → a row, or null for records that carry no usage (user
 *  rows, meta rows, synthetic-model placeholders). */
function claudeRow(rec: Record<string, unknown>, known: Record<string, string>): Row | null {
  if (rec['type'] !== 'assistant') return null
  const message = rec['message'] as Record<string, unknown> | undefined
  const usage = message?.['usage'] as Record<string, unknown> | undefined
  if (!usage) return null
  const model = typeof message?.['model'] === 'string' ? (message['model'] as string) : ''
  if (!model || model === '<synthetic>') return null
  const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp'] as string) : NaN
  if (!Number.isFinite(ts)) return null
  const sessionId = typeof rec['sessionId'] === 'string' ? (rec['sessionId'] as string) : ''
  const messageId = typeof message?.['id'] === 'string' ? (message['id'] as string) : ''
  const requestId = typeof rec['requestId'] === 'string' ? (rec['requestId'] as string) : ''
  // Forked/replayed history repeats records verbatim in new files; the id pair survives the copy.
  // Records with neither id cannot be matched across files and count once, unkeyed.
  const dedupeKey = messageId || requestId ? `${messageId}:${requestId}` : null
  const origin: ScanOrigin = sessionId && known[sessionId] !== undefined ? 'koda' : 'outside'
  return [
    hourStartOf(ts),
    model,
    origin,
    num(usage['input_tokens']),
    num(usage['cache_read_input_tokens']),
    num(usage['cache_creation_input_tokens']),
    num(usage['output_tokens']),
    0,
    dedupeKey,
  ]
}

/** Codex rollouts interleave `turn_context` (which names the model) with `token_count` events.
 *  `last_token_usage` is the per-response delta — the cumulative sibling would double-count — and
 *  some CLI versions emit the same delta at more than one lifecycle point, so consecutive
 *  identical deltas collapse to one. Proven against real rollouts both ways: collapsed-sum equals
 *  the file's final `total_token_usage` exactly on paired (2026-02) and unpaired (2026-07) files.
 *  Codex `input_tokens` INCLUDES the cached share; the row stores uncached = input − cached so
 *  both engines mean the same thing by each column. Beyond that, token counts are unique within a
 *  rollout and resume appends rather than replays, so rows carry no cross-file dedupe key. */
function codexRows(lines: string[], origin: ScanOrigin, counters: { malformed: number }): Row[] {
  const rows: Row[] = []
  let model = ''
  let previousDelta = ''
  for (const line of lines) {
    if (!line) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      counters.malformed += 1
      continue
    }
    const payload = rec['payload'] as Record<string, unknown> | undefined
    if (rec['type'] === 'turn_context') {
      const m = payload?.['model']
      if (typeof m === 'string' && m) model = m
      continue
    }
    if (rec['type'] !== 'event_msg' || payload?.['type'] !== 'token_count') continue
    const info = payload?.['info'] as Record<string, unknown> | undefined
    const last = info?.['last_token_usage'] as Record<string, unknown> | undefined
    if (!last) continue
    const delta = JSON.stringify(last)
    if (delta === previousDelta) continue
    previousDelta = delta
    const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp'] as string) : NaN
    if (!Number.isFinite(ts)) {
      counters.malformed += 1
      continue
    }
    const input = num(last['input_tokens'])
    const cached = Math.min(num(last['cached_input_tokens']), input)
    // A resumed rollout can replay token counts before this run's first turn_context names a model.
    // Those tokens are real; 'unknown' keeps them counted (it prices as unpriced → tokens-only).
    rows.push([
      hourStartOf(ts),
      model || 'unknown',
      origin,
      input - cached,
      cached,
      0,
      num(last['output_tokens']),
      num(last['reasoning_output_tokens']),
      null,
    ])
  }
  return rows
}

function claudeRowsOf(lines: string[], known: Record<string, string>, counters: { malformed: number }): Row[] {
  const rows: Row[] = []
  for (const line of lines) {
    if (!line) continue
    try {
      const row = claudeRow(JSON.parse(line) as Record<string, unknown>, known)
      if (row) rows.push(row)
    } catch {
      counters.malformed += 1
    }
  }
  return rows
}

// ── Walking and aggregation ──────────────────────────────────────────────────────

async function jsonlFilesUnder(root: string, depthLeft = 6): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory() && depthLeft > 0) out.push(...(await jsonlFilesUnder(p, depthLeft - 1)))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

interface ScanRoot {
  engine: EngineId
  root: string
  kind: 'claude' | 'codex'
  /** Fixed origin for the whole root; Claude resolves per record instead. */
  origin?: ScanOrigin
}

function defaultRoots(): ScanRoot[] {
  return [
    { engine: 'claude', root: join(homedir(), '.claude', 'projects'), kind: 'claude' },
    { engine: 'codex', root: join(homedir(), '.codex', 'sessions'), kind: 'codex', origin: 'outside' },
    { engine: 'codex', root: join(codexHome(), 'sessions'), kind: 'codex', origin: 'koda' },
  ]
}

async function scanOnce(roots: ScanRoot[]): Promise<ScanSummary> {
  const started = Date.now()
  const { store, writable } = read()

  // Fold spawn-time registrations in and prune both halves while we hold the store: cache entries
  // for deleted files, registry ids past the retention horizon.
  const today = localDayOf(started)
  for (const id of pendingClaudeIds) store.knownClaudeSessions[id] = today
  pendingClaudeIds.clear()
  const horizon = localDayOf(started - REGISTRY_RETAIN_DAYS * 24 * 60 * 60 * 1000)
  for (const [id, day] of Object.entries(store.knownClaudeSessions))
    if (day < horizon) delete store.knownClaudeSessions[id]

  const sources: ScanSource[] = []
  const liveFiles = new Set<string>()
  const seen = new Set<string>()
  const buckets = new Map<string, ScanBucket>()

  const fold = (engine: EngineId, row: Row): void => {
    const key = row[8]
    if (key !== null) {
      if (seen.has(key)) return
      seen.add(key)
    }
    const [hourStartMs, model, origin, uncached, cached, cacheCreation, output, reasoning] = row
    const day = localDayOf(hourStartMs)
    const bKey = `${hourStartMs}|${day}|${engine}|${model}|${origin}`
    const b =
      buckets.get(bKey) ??
      ({ hourStartMs, day, engine, model, origin, uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, records: 0 } as ScanBucket)
    b.uncachedInput += uncached
    b.cachedInput += cached
    b.cacheCreation += cacheCreation
    b.output += output
    b.reasoning += reasoning
    b.records += 1
    buckets.set(bKey, b)
  }

  for (const { engine, root, kind, origin } of roots) {
    const files = await jsonlFilesUnder(root)
    const source: ScanSource = {
      engine,
      root,
      status: files.length === 0 ? 'missing' : 'ok',
      files: files.length,
      skippedFiles: 0,
      malformedRecords: 0,
    }
    for (const file of files) {
      liveFiles.add(file)
      try {
        const st = await stat(file)
        const cached = store.files[file]
        let entry: FileCache
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          entry = cached
        } else {
          const counters = { malformed: 0 }
          const lines = (await readFile(file, 'utf8')).split('\n')
          const rows =
            kind === 'claude'
              ? claudeRowsOf(lines, store.knownClaudeSessions, counters)
              : codexRows(lines, origin ?? 'outside', counters)
          entry = { mtimeMs: st.mtimeMs, size: st.size, malformed: counters.malformed, rows }
          store.files[file] = entry
        }
        source.malformedRecords += entry.malformed
        for (const row of entry.rows) fold(engine, row)
      } catch (err) {
        source.skippedFiles += 1
        source.status = 'partial'
        log.warn('usage', `usage scan skipped ${file}`, err instanceof Error ? err.message : err)
      }
    }
    sources.push(source)
  }

  for (const file of Object.keys(store.files)) if (!liveFiles.has(file)) delete store.files[file]
  if (writable) write(store)

  return {
    buckets: [...buckets.values()].sort((a, b) => a.hourStartMs - b.hourStartMs),
    sources,
    scannedAt: started,
    scanMs: Date.now() - started,
  }
}

/** Scan every transcript root and return day×engine×model×origin buckets. Serialized: concurrent
 *  callers queue behind the running scan rather than racing the cache file. `rootsOverride` is the
 *  test seam. */
export function scanUsageTranscripts(rootsOverride?: ScanRoot[]): Promise<ScanSummary> {
  return serialize(() => scanOnce(rootsOverride ?? defaultRoots()))
}

export type { ScanRoot }
