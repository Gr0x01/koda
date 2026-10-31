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
 * as `outside`. Origin resolves at merge time, not parse time, so a session registered after its
 * records were cached still flips to `koda` on the next scan. Sessions that predate the registry
 * read as `outside` until their next turn — the totals are unaffected, only the through-Koda
 * split line. Asides and structured
 * one-shots spawn with CLI-chosen ids and read as `outside` too, matching the turn tracker's
 * existing choice to leave their small cost uncounted.
 *
 * The per-file cache keys on mtime+size so a rescan only touches files that changed, and both CLIs
 * only append to a transcript, so a file that grew resumes at the byte offset the last scan
 * stopped at. A live session hundreds of megabytes long then costs a rescan its new lines, not the
 * whole file. A file that shrank re-reads from the top. Cached entries store compact per-record
 * rows (not aggregates) because Claude forks replay history into new files: de-duplication by
 * `messageId:requestId` has to happen across files, at merge time.
 */
import { app } from 'electron'
import { readFileSync, copyFileSync, createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import { codexHome } from './codex-home'
import { log } from '../logger'
import { LONG_PROMPT_TOKENS } from '@shared/model-pricing'
import type { EngineId, PricedScanBucket, ScanOrigin, ScanSource } from '@shared/ipc'

/** The scanner's bucket is the shared wire shape minus the pricing fields usage-pricing.ts adds. */
export type ScanBucket = Omit<PricedScanBucket, 'costUsd' | 'cacheSavingsUsd' | 'costSource'> & {
  /** Every record in the bucket carried a prompt over LONG_PROMPT_TOKENS. Tiers are decided per
   *  request, and only the scanner still sees one, so it splits the cell for usage-pricing.ts. */
  longPrompt?: boolean
}

export interface ScanSummary {
  buckets: ScanBucket[]
  sources: ScanSource[]
  scannedAt: number
  scanMs: number
}

/** [hourStartMs, model, claudeSessionId, uncachedInput, cachedInput, cacheCreation, output, reasoning, dedupeKey]
 *  Claude rows carry their session id ('' for Codex, whose origin is fixed by root). */
type Row = [number, string, string, number, number, number, number, number, string | null]

/** The Codex parser's carry-over between lines, persisted so an appended tail parses in context. */
type CodexState = { model: string; previousDelta: string }

type FileCache = {
  mtimeMs: number
  size: number
  malformed: number
  rows: Row[]
  /** Byte offset just past the last line parsed; the next scan of a grown file resumes here. */
  offset: number
  codex?: CodexState
}

type Stored = {
  // v3: rows carry the Claude session id instead of a parse-time origin, and files carry offsets.
  version: 3
  /** Claude engine-session ids Koda has driven → last-seen local day (pruned by age). */
  knownClaudeSessions: Record<string, string>
  files: Record<string, FileCache>
}

const REGISTRY_RETAIN_DAYS = 180

function filePath(): string {
  return join(app.getPath('userData'), 'koda-usage-scan.json')
}

function emptyStore(): Stored {
  return { version: 3, knownClaudeSessions: {}, files: {} }
}

// Same fail-soft posture as usage-history.ts: an unreadable file is preserved for later diagnosis
// and never authorizes a write that would overwrite it.
function read(): { store: Stored; writable: boolean } {
  try {
    const p = JSON.parse(readFileSync(filePath(), 'utf8'))
    if (p && typeof p === 'object' && p.version === 3 && p.files && typeof p.files === 'object' && p.knownClaudeSessions)
      return { store: p as Stored, writable: true }
    // Valid JSON carrying an older cache format is STALE, not corrupt: discard and rebuild, so the
    // first scan after an upgrade overwrites it. Treating it as corrupt would flip writable off and
    // permanently disable the cache — a full cold re-scan on every Usage open, forever.
    // The session registry outlives a row-format change: it can't be rebuilt from transcripts, so
    // dropping it would flip every past Koda session to `outside`.
    if (p && typeof p === 'object' && typeof p.version === 'number')
      return {
        store: {
          ...emptyStore(),
          ...(p.knownClaudeSessions && typeof p.knownClaudeSessions === 'object'
            ? { knownClaudeSessions: p.knownClaudeSessions as Record<string, string> }
            : {}),
        },
        writable: true,
      }
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
function claudeRow(rec: Record<string, unknown>): Row | null {
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
  return [
    hourStartOf(ts),
    model,
    sessionId,
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
async function codexRows(
  lines: AsyncIterable<string>,
  state: CodexState,
  counters: { malformed: number },
): Promise<Row[]> {
  const rows: Row[] = []
  for await (const line of lines) {
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
      if (typeof m === 'string' && m) state.model = m
      continue
    }
    if (rec['type'] !== 'event_msg' || payload?.['type'] !== 'token_count') continue
    const info = payload?.['info'] as Record<string, unknown> | undefined
    const last = info?.['last_token_usage'] as Record<string, unknown> | undefined
    if (!last) continue
    const delta = JSON.stringify(last)
    if (delta === state.previousDelta) continue
    state.previousDelta = delta
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
      state.model || 'unknown',
      '',
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

async function claudeRowsOf(lines: AsyncIterable<string>, counters: { malformed: number }): Promise<Row[]> {
  const rows: Row[] = []
  for await (const line of lines) {
    if (!line) continue
    try {
      const row = claudeRow(JSON.parse(line) as Record<string, unknown>)
      if (row) rows.push(row)
    } catch {
      counters.malformed += 1
    }
  }
  return rows
}

/**
 * Lines of `file` from byte `cursor.offset`, advancing the cursor past each line it yields. Split
 * on raw bytes, never one whole-file string: a long session passes V8's ~512 MB string cap. An
 * unterminated tail is yielded only once it parses, so a record caught mid-write is read whole on
 * the next scan instead of being counted malformed and skipped past.
 */
async function* linesFrom(file: string, cursor: { offset: number }): AsyncGenerator<string> {
  let pending: Buffer[] = []
  for await (const chunk of createReadStream(file, { start: cursor.offset, highWaterMark: 1 << 20 })) {
    const buf = chunk as Buffer
    let from = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, from)) {
      const line = Buffer.concat([...pending, buf.subarray(from, nl)])
      pending = []
      cursor.offset += line.length + 1
      from = nl + 1
      yield line.toString('utf8')
    }
    if (from < buf.length) pending.push(buf.subarray(from))
  }
  if (pending.length === 0) return
  const tail = Buffer.concat(pending)
  const text = tail.toString('utf8')
  try {
    JSON.parse(text)
  } catch {
    return
  }
  cursor.offset += tail.length
  yield text
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

  // Fold spawn-time registrations in; both halves of the store are pruned after the walk.
  const today = localDayOf(started)
  for (const id of pendingClaudeIds) store.knownClaudeSessions[id] = today
  pendingClaudeIds.clear()
  // Registry ids some cached row still resolves through. Origin is looked up at merge time, so
  // pruning one of these would relabel that session's history `outside`.
  const referenced = new Set<string>()

  const sources: ScanSource[] = []
  const liveFiles = new Set<string>()
  const seen = new Set<string>()
  const buckets = new Map<string, ScanBucket>()

  const fold = (engine: EngineId, rootOrigin: ScanOrigin | undefined, row: Row): void => {
    const key = row[8]
    if (key !== null) {
      if (seen.has(key)) return
      seen.add(key)
    }
    const [hourStartMs, model, sessionId, uncached, cached, cacheCreation, output, reasoning] = row
    const isKoda = !rootOrigin && sessionId !== '' && store.knownClaudeSessions[sessionId] !== undefined
    if (isKoda) referenced.add(sessionId)
    const origin: ScanOrigin = rootOrigin ?? (isKoda ? 'koda' : 'outside')
    const day = localDayOf(hourStartMs)
    const longPrompt = uncached + cached + cacheCreation > LONG_PROMPT_TOKENS
    const bKey = `${hourStartMs}|${day}|${engine}|${model}|${origin}|${longPrompt}`
    const b =
      buckets.get(bKey) ??
      ({ hourStartMs, day, engine, model, origin, longPrompt, uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, records: 0 } as ScanBucket)
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
          const resume = cached && cached.size <= st.size ? cached : null
          const counters = { malformed: 0 }
          const cursor = { offset: resume?.offset ?? 0 }
          const codex: CodexState = { ...(resume?.codex ?? { model: '', previousDelta: '' }) }
          const lines = linesFrom(file, cursor)
          const rows =
            kind === 'claude' ? await claudeRowsOf(lines, counters) : await codexRows(lines, codex, counters)
          entry = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            malformed: (resume?.malformed ?? 0) + counters.malformed,
            rows: resume ? resume.rows.concat(rows) : rows,
            offset: cursor.offset,
            ...(kind === 'codex' ? { codex } : {}),
          }
          store.files[file] = entry
        }
        source.malformedRecords += entry.malformed
        for (const row of entry.rows) fold(engine, origin, row)
      } catch (err) {
        source.skippedFiles += 1
        source.status = 'partial'
        log.warn('usage', `usage scan skipped ${file}`, err instanceof Error ? err.message : err)
      }
    }
    sources.push(source)
  }

  for (const file of Object.keys(store.files)) if (!liveFiles.has(file)) delete store.files[file]
  const horizon = localDayOf(started - REGISTRY_RETAIN_DAYS * 24 * 60 * 60 * 1000)
  for (const [id, day] of Object.entries(store.knownClaudeSessions))
    if (day < horizon && !referenced.has(id)) delete store.knownClaudeSessions[id]
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
