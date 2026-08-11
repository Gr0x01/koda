/**
 * Per-project session persistence — open sessions survive an app restart, scoped to their project
 * (one project per window). Each project gets its own JSON file in userData, keyed by a hash of its
 * realpath'd root. On the next turn the engine reattaches each conversation via `claude --resume`
 * (spike/resume). The renderer owns the transcript shape (stored opaquely); main reads back only
 * `{ id, cwd }` to repopulate recovery + resume dirs, and stamps `projectPath` so the file is
 * self-describing.
 *
 * Plus a single `koda-app-state.json` (which projects were open + a recents list) so boot can
 * reopen one window per remembered project.
 *
 * Deliberately NOT a library (small files, same call style as settings.ts). Writes are fail-soft (a
 * failed write never breaks the caller), but reads are NOT uniformly so: an ABSENT store restores
 * nothing, while a store that EXISTS and can't be read throws. That distinction is load-bearing — an
 * unreadable store reported as "empty" hydrates the renderer, which un-gates its debounced save and
 * writes the emptiness back over the user's real file ~500ms later, unattended. `koda-app-state.json`
 * has no renderer to gate on, so it enforces the same refusal main-side instead: every AUTOMATIC
 * mutator (noteProjectClosed/Deleted, saveWindowBounds, backfillKnownProjects) loads through
 * `loadAppStateForWrite`, which returns nothing rather than `EMPTY_STATE` on a corrupt file, and the
 * mutator skips its save entirely. `noteProjectOpened` is the one exception and the way back out —
 * see its `'user-open'` consent below.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  ArchivedSessionMetaSchema,
  ArchivedSessionSchema,
  PersistedSessionSchema,
  PersistedSessionsSchema,
  type ArchivedPreviewTurn,
  type ArchivedSession,
  type BackupKept,
  type ArchivedSessionMeta,
  type PersistedSession,
  type PersistedSessions,
  type ReplayEntry,
} from '@shared/ipc'
import { writeFileAtomic } from './atomic-write'
import { loadArchiveRetentionDays } from './settings'
import { log } from './logger'
import {
  mergeReplayIntoTranscript,
  normalizeReplaySequence,
  settleRestoredDelegationReplay,
  transcriptFromReplay,
} from '@shared/delegation'
import { deleteRemoteReplay, loadRemoteReplay, purgeRemoteReplayProject } from './remote-replay-store'

/** A store that exists but could not be read, carrying whether the copy `keepCorrupt` tried to make
 *  actually landed. Every failure path below reports that real answer instead of discarding it: the
 *  user-facing banner says "Koda kept a copy beside it", and two failures make that a lie if it isn't
 *  checked — an EACCES/EIO store (the re-read inside `keepCorrupt` fails for the same reason the
 *  original read did) and a `copyFileSync` that itself fails (ENOSPC, a read-only userData). */
export class StoreReadError extends Error {
  constructor(
    message: string,
    readonly backupKept: boolean,
  ) {
    super(message)
    this.name = 'StoreReadError'
  }
}

/** Out-param for a load that SUCCEEDS but had to set rows aside. The drop is invisible in the return
 *  value (a shorter list looks exactly like a shorter list), and the user has to be told — a silently
 *  short list is the one case where the file IS then overwritten, because saving stays on. Callers that
 *  show it (the IPC boundary) pass one in; everyone else ignores it. */
export interface StoreReadReport {
  dropped: number
}

/** The on-disk per-project shape = the renderer's blob + the project it belongs to (main-stamped). */
const StoredProjectSchema = PersistedSessionsSchema.extend({ projectPath: z.string() })
type StoredProject = z.infer<typeof StoredProjectSchema>

/** The READ-time shape of a stored project file — same as `StoredProjectSchema` except `sessions` is
 *  `unknown[]`, validated row-by-row below (keepValidRows/W5) instead of all-or-nothing. The WRITE path
 *  (ipc.ts's save boundary) still validates incoming renderer data against the strict
 *  `PersistedSessionsSchema` — that data was just computed by the live renderer, so schema drift can't
 *  have happened yet; only DISK data ages across builds. */
const StoredProjectReadSchema = StoredProjectSchema.extend({ sessions: z.array(z.unknown()) })

/** Stable per-project filename: hash the project path so no path chars / length leak into the name. */
function projectStorePath(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), `koda-sessions-${hash}.json`)
}

// ── Archived sessions: the COLD store (metadata index + per-session body files) ───────────────────
// Archives used to ride inside the hot store above — rewritten every ~500ms while streaming — so a
// dogfood project's 169 transcripts (~50MB) froze both processes for ~1s per save. First fix moved them
// to a cold file. But that file was still ONE blob holding every transcript inline, so it re-hit the same
// O(n) wall as it grew (26MB read+parsed on boot just to draw a list; a whole rewrite to delete one).
//
// Second fix (this): SPLIT metadata from body. The index file holds only the light metadata + a baked
// preview per archive — KB-sized, so boot and the list stay cheap no matter how many archives pile up.
// Each transcript body lives in its own file, fetched only when that archive is restored. Deleting one
// unlinks one small file + rewrites the (small) index, never a multi-MB blob.

/** v2 = the light metadata index (bodies split out). v1 = the old single blob with transcripts inline.
 *  The v2 rows are `unknown` here and validated ONE BY ONE (keepValidRows) — as `z.array(Meta)` a
 *  single malformed row failed the whole parse and took every valid archive with it. */
const ArchiveIndexSchema = z.object({ version: z.literal(2), archived: z.array(z.unknown()) })
const ArchiveFileV1Schema = z.object({ version: z.literal(1), archived: z.array(ArchivedSessionSchema) })
const ArchivedBodySchema = z.object({ items: z.array(z.unknown()) })

/** The metadata index — same filename the old blob used (v1 is detected by its `version` field and
 *  migrated in place). */
function archiveIndexPath(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), `koda-archive-${hash}.json`)
}

/** The directory of per-session transcript bodies (sibling to the index; `.bodies` so it can't collide
 *  with the index file's name). */
function archiveBodiesDir(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), `koda-archive-${hash}.bodies`)
}

/** One body file, named by a hash of the session id — traversal-safe (the id comes from the renderer)
 *  and collision-free regardless of the id's characters. */
function archiveBodyPath(projectPath: string, sessionId: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  return join(archiveBodiesDir(projectPath), `${name}.json`)
}

/** The last few readable turns, baked into the metadata so the list can preview without the body. Items
 *  are opaque here (the renderer's Entry model), so this reads the shape structurally. */
function buildArchivePreview(items: unknown[]): ArchivedPreviewTurn[] {
  const turns: ArchivedPreviewTurn[] = []
  for (const raw of items) {
    const it = raw as { kind?: string; text?: string; markdown?: string }
    if (it?.kind === 'user' && it.text?.trim()) turns.push({ kind: 'user', text: clipPreview(it.text.trim()) })
    else if (it?.kind === 'assistant' && it.markdown?.trim())
      turns.push({ kind: 'assistant', text: clipPreview(it.markdown.trim()) })
  }
  return turns.slice(-6) // just the tail, enough to recognize the chat
}
const clipPreview = (s: string): string => (s.length > 500 ? s.slice(0, 500) : s)

/** Highest entry (and subagent-child) id in a transcript — baked into the metadata so boot can advance
 *  the id counter past a not-yet-restored archive without loading its body. */
function maxArchivedItemId(items: unknown[]): number {
  let max = 0
  for (const raw of items) {
    const it = raw as { id?: number; kind?: string; children?: { id?: number }[] }
    if (typeof it?.id === 'number' && it.id > max) max = it.id
    if (it?.kind === 'subagent' && Array.isArray(it.children))
      for (const c of it.children) if (typeof c?.id === 'number' && c.id > max) max = c.id
  }
  return max
}

/** Split one full archived session into its metadata (with baked preview + maxItemId) after writing its
 *  body out. Used by both v1 migration and hot-blob ingest. */
function splitArchive(projectPath: string, full: ArchivedSession): ArchivedSessionMeta {
  writeArchivedBody(projectPath, full.id, full.items)
  const { items, ...rest } = full
  return { ...rest, preview: buildArchivePreview(items), maxItemId: maxArchivedItemId(items) }
}

/** A project's archived-session metadata, newest first. Migrates a v1 blob in place on first read, and
 *  applies the opt-in retention purge.
 *
 *  NO index file = nothing archived yet: returns [] (benign — there's nothing to save over). A
 *  zero-length/whitespace-only file is treated the same way (see loadProjectSessions). An index that
 *  EXISTS, is non-empty, and can't be read or parsed THROWS instead of reading as none: the boot path
 *  installs whatever this returns and then persists it, so "[] because it failed" is how a whole archive
 *  list gets rewritten to empty. Individual malformed ROWS are dropped, not fatal (keepValidRows), and
 *  counted into `report` so the caller can tell the user how many. */
export function loadArchivedMeta(projectPath: string, report?: StoreReadReport): ArchivedSessionMeta[] {
  const path = archiveIndexPath(projectPath)
  if (!existsSync(path)) return []
  let metas: ArchivedSessionMeta[] = []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    // No `content`: keepCorrupt re-reads the file, which fails for the same reason this read did, so
    // this is exactly the case where no copy gets kept. Report that rather than promising one.
    const backupKept = keepCorrupt(path)
    log.warn('session-store', 'archive index unreadable — refusing to report it as empty', {
      project: projectPath,
      error: err instanceof Error ? err.message : String(err),
      backupKept,
    })
    throw new StoreReadError(err instanceof Error ? err.message : String(err), backupKept)
  }
  // A zero-length (or whitespace-only) file holds no data at all — e.g. `writeFileAtomic`'s rename lands
  // but a power cut hits before the bytes are flushed to disk. That is indistinguishable from "nothing
  // archived yet" and has nothing to protect; treating it as corrupt would brick the project forever
  // (every boot reads it, fails to parse, refuses to save over it, on a file worth nothing).
  if (!text.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const backupKept = keepCorrupt(path, text)
    log.warn('session-store', 'archive index unreadable — refusing to report it as empty', {
      project: projectPath,
      error: err instanceof Error ? err.message : String(err),
      backupKept,
    })
    throw new StoreReadError(err instanceof Error ? err.message : String(err), backupKept)
  }
  const v2 = ArchiveIndexSchema.safeParse(raw)
  if (v2.success) {
    metas = keepValidRows(ArchivedSessionMetaSchema, path, v2.data.archived, projectPath, 'archive', text, report)
  } else {
    const v1 = ArchiveFileV1Schema.safeParse(raw)
    if (!v1.success) {
      const backupKept = keepCorrupt(path, text)
      log.warn('session-store', 'archive index matches neither v2 nor v1 — refusing to report it as empty', {
        project: projectPath,
        backupKept,
      })
      throw new StoreReadError('archive index is present but unreadable', backupKept)
    }
    if (v1.data.archived.length) {
      // One-shot: write each transcript to its own body file, build the light index, and keep the
      // original blob as `.v1.bak` (a real user's archives are irreplaceable — don't destroy on migrate).
      // COPY (not move) the backup so the original v1 stays at the index path until the new v2 index
      // atomically overwrites it — a crash mid-migration then re-reads valid v1 and re-migrates, rather
      // than finding no index and reading empty.
      try {
        copyFileSync(path, `${path}.v1.bak`)
      } catch {
        /* couldn't back up — proceed; the new index overwrites the old blob below */
      }
      metas = v1.data.archived.map((f) => splitArchive(projectPath, f))
      saveArchivedMeta(projectPath, metas)
      log.info('session-store', 'split archived transcripts into per-session bodies', {
        project: projectPath,
        count: metas.length,
      })
    }
  }
  return applyArchiveRetention(projectPath, metas)
}

/** Validate an array's rows INDIVIDUALLY against `schema`, dropping the ones that fail rather than
 *  failing the whole array. The realistic trigger is schema drift (a user reinstalls an older build, or
 *  a new build tightens a field — e.g. a new `approvalMode` enum value an older session-store reader
 *  doesn't know), and one drifted row must not cost the user every other row — the same reason
 *  `rateLimits` carries `.catch` in shared/ipc.ts. Shared by the archive index (W5's original case) and
 *  the session list (W5's extension — the named trigger for this whole branch hits sessions, not
 *  archives).
 *
 *  Dropping rows means the next save writes a SHORTER array, so back the original up first
 *  (`keepCorrupt`) — the dropped rows stay recoverable from it. If that backup can't be made (e.g.
 *  ENOSPC), refuse to drop anything and throw instead: an unrecoverable drop is a failed read, not a
 *  partial one, and this module's whole contract is that a failed read never reports as empty/shorter. */
function keepValidRows<T>(
  schema: z.ZodType<T>,
  path: string,
  rows: unknown[],
  projectPath: string,
  kind: string,
  content?: string,
  report?: StoreReadReport,
): T[] {
  const kept: T[] = []
  for (const row of rows) {
    const parsed = schema.safeParse(row)
    if (parsed.success) kept.push(parsed.data)
  }
  if (kept.length !== rows.length) {
    if (!keepCorrupt(path, content)) {
      throw new StoreReadError(
        `could not back up ${basename(path)} before dropping ${rows.length - kept.length} ${kind} row(s) — refusing to drop them`,
        false,
      )
    }
    // The load SUCCEEDS from here, so saving stays on and the shorter list will be written back. That
    // makes the count the user's only warning that a chat left the list, which is why it travels out
    // (StoreReadReport → the IPC boundary → the data-integrity banner) instead of only being logged.
    if (report) report.dropped = rows.length - kept.length
    log.warn('session-store', `dropped ${rows.length - kept.length} unreadable ${kind} row(s)`, {
      project: projectPath,
      kept: kept.length,
    })
  }
  return kept
}

/** How many distinct-content backups `keepCorrupt` keeps per store, oldest pruned first — bounds the
 *  pile so months of boots each hitting a different drifted row don't leave an ever-growing stack of
 *  `.bak` files. */
export const MAX_CORRUPT_BACKUPS = 5

/** Copy a store that failed to load (or is about to lose rows) aside as `<name>.corrupt-<hash>.bak`
 *  BEFORE anything can overwrite it. A store we can't parse — or a row we're about to drop — is still
 *  the user's only copy of that data; losing it to our own next write is the failure this whole module
 *  guards against (same instinct as the v1 migration's `.v1.bak`).
 *
 *  Keyed by a hash of the CONTENT, not mere existence: the old "one copy per file, ever" rule meant a
 *  single benign drop on boot A permanently consumed the only backup slot, so boot B's *different* drop
 *  months later got no copy at all — the backup voided the very mechanism it exists for. Content-keying
 *  means a later boot hitting different bad bytes gets its own backup; a boot re-hitting the exact same
 *  bad bytes is a no-op (already covered). Bounded by `MAX_CORRUPT_BACKUPS` (oldest pruned by mtime).
 *
 *  Returns whether a copy of `content` now verifiably exists on disk — callers that are about to DROP
 *  data conditional on it (`keepValidRows`) must not proceed when this is false. Best-effort otherwise:
 *  a failed copy must never mask the read failure that prompted it. */
function keepCorrupt(path: string, content?: string): boolean {
  try {
    const text = content ?? readFileSync(path, 'utf8')
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
    const dir = dirname(path)
    const prefix = `${basename(path)}.corrupt-`
    const backup = join(dir, `${prefix}${hash}.bak`)
    if (!existsSync(backup)) {
      copyFileSync(path, backup)
      log.warn('session-store', 'kept a copy of an unreadable store', { backup })
      pruneOldCorruptBackups(dir, prefix)
    }
    return true
  } catch (err) {
    log.warn('session-store', 'could not back up an unreadable store', err instanceof Error ? err.message : err)
    return false
  }
}

/** Keep only the `MAX_CORRUPT_BACKUPS` most-recently-written backups for one store, oldest first
 *  deleted. Best-effort: a failed prune just leaves an extra file around, never blocks the backup that
 *  triggered it. */
function pruneOldCorruptBackups(dir: string, prefix: string): void {
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
      .map((n) => ({ name: n, mtime: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(MAX_CORRUPT_BACKUPS)) unlinkSync(join(dir, f.name))
  } catch {
    /* best-effort */
  }
}

/** Persist the metadata index (light — no transcript bodies). Returns whether the write landed, so a
 *  caller that's about to DELETE the source data (the hot-blob migration) can gate on it. */
export function saveArchivedMeta(projectPath: string, archived: ArchivedSessionMeta[]): boolean {
  try {
    writeFileAtomic(archiveIndexPath(projectPath), JSON.stringify({ version: 2, archived }))
    return true
  } catch (err) {
    log.warn('session-store', 'failed to persist archived index', err instanceof Error ? err.message : err)
    return false
  }
}

/** Fetch one archived session's transcript body. Returns the items on a clean read (which may legitimately
 *  be `[]` for a minimal/headless archive), or `null` when the read/parse FAILED — so a caller that's about
 *  to consume-and-delete the body (restore) can tell "genuinely empty" from "couldn't read it" and never
 *  destroy a transcript it merely failed to load. */
export function loadArchivedBody(projectPath: string, sessionId: string): unknown[] | null {
  try {
    const parsed = ArchivedBodySchema.safeParse(JSON.parse(readFileSync(archiveBodyPath(projectPath, sessionId), 'utf8')))
    if (!parsed.success) return null
    const replay = normalizeReplaySequence(
      settleRestoredDelegationReplay(loadRemoteReplay(projectPath, sessionId, sessionId)),
    )
    if (!replay.length) return parsed.data.items
    return parsed.data.items.length
      ? mergeReplayIntoTranscript(parsed.data.items, replay)
      : transcriptFromReplay(replay)
  } catch {
    return null
  }
}

/** Persist one archived session's transcript body to its own file. */
export function writeArchivedBody(projectPath: string, sessionId: string, items: unknown[]): void {
  try {
    mkdirSync(archiveBodiesDir(projectPath), { recursive: true })
    writeFileAtomic(archiveBodyPath(projectPath, sessionId), JSON.stringify({ items }))
  } catch (err) {
    log.warn('session-store', 'failed to persist archived body', err instanceof Error ? err.message : err)
  }
}

/** Delete one archived session's body file (on restore — consumed — or on permanent delete). No-op if
 *  it's already gone. */
export function deleteArchivedBody(projectPath: string, sessionId: string): void {
  try {
    unlinkSync(archiveBodyPath(projectPath, sessionId))
  } catch {
    /* already gone / never written */
  }
  deleteRemoteReplay(projectPath, sessionId)
}

/** Ingest full archives found still inline in a pre-split hot blob (loadProjectSessions migration) —
 *  split each to a body + metadata and merge into the index, newest-first. Returns whether the index
 *  write landed: the migration MUST NOT strip these archives from the hot file unless this is true, or a
 *  failed cold write would lose them from both places. Can also THROW (via `loadArchivedMeta`, e.g. a
 *  present-but-unreadable index) — callers that are about to remove the same session from the hot store
 *  (`archiveSession` below) must call this FIRST and let a throw propagate before touching the hot
 *  store, or a throwing ingest deletes the session from both places at once (C2). */
export function ingestFullArchives(projectPath: string, full: ArchivedSession[]): boolean {
  const existing = loadArchivedMeta(projectPath)
  const metas = full.map((f) => splitArchive(projectPath, f))
  return saveArchivedMeta(projectPath, [...metas, ...existing])
}

/** The opt-in retention purge: when `archiveRetentionDays > 0`, drop (and unlink the bodies of) archives
 *  older than the window. Default 0 = keep forever (archives live outside safety-git, so a purge is
 *  permanent — the safe default never deletes; the user opts in from the Archived settings section). */
function applyArchiveRetention(projectPath: string, metas: ArchivedSessionMeta[]): ArchivedSessionMeta[] {
  const days = loadArchiveRetentionDays()
  if (days <= 0) return metas
  const cutoff = Date.now() - days * 86_400_000
  const kept = metas.filter((m) => m.archivedAt >= cutoff)
  if (kept.length === metas.length) return metas
  // Index first and only carry on if it took the write — the same order `deleteArchived` follows, and
  // for the same reason. Unlinking the bodies first leaves rows on disk whose transcripts are gone, and
  // nothing says so while retention is on because this filter hides those rows on every load. Setting
  // retention back to Forever then hands the user back a list of chats that all open to nothing.
  if (!saveArchivedMeta(projectPath, kept)) {
    log.warn('session-store', 'retention purge skipped — the archived index refused the write', {
      project: projectPath,
      days,
    })
    return metas
  }
  for (const m of metas) if (m.archivedAt < cutoff) deleteArchivedBody(projectPath, m.id)
  log.info('session-store', `auto-deleted ${metas.length - kept.length} archived session(s) past retention`, {
    project: projectPath,
    days,
  })
  return kept
}

/** The persisted sessions for a project, or `null` when the project has NO store file yet (nothing was
 *  ever saved here — safe to start empty and save over). A zero-length/whitespace-only file reads the
 *  same way (see the comment inline below).
 *
 *  A non-empty store that can't be read/parsed/validated THROWS. It used to return the same `null`,
 *  which the renderer flattens to "no sessions", hydrates, and — 500ms later, unattended — saves back
 *  over the file it just failed to read. The renderer's boot-load `.catch` deliberately does not
 *  hydrate, so the throw is what keeps persistence read-only for the run and leaves the file intact. */
export function loadProjectSessions(projectPath: string, report?: StoreReadReport): PersistedSessions | null {
  const path = projectStorePath(projectPath)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    // Same as the archive index above: with no `content` to hand, keepCorrupt re-reads a file that has
    // just proved unreadable, so this is the path where no copy exists. Say so honestly.
    const backupKept = keepCorrupt(path)
    log.warn('session-store', 'session store unreadable — refusing to report it as empty', {
      project: projectPath,
      error: err instanceof Error ? err.message : String(err),
      backupKept,
    })
    throw new StoreReadError(err instanceof Error ? err.message : String(err), backupKept)
  }
  // A zero-length (or whitespace-only) file holds no data — `writeFileAtomic` doesn't fsync, so a power
  // cut right after its rename can land exactly this. It's indistinguishable from "nothing saved yet"
  // and has nothing to protect; treating it as corrupt bricks the project (every boot fails to parse it
  // and refuses to save over it — forever — for a file worth nothing).
  if (!text.trim()) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const backupKept = keepCorrupt(path, text)
    log.warn('session-store', 'session store unreadable — refusing to report it as empty', {
      project: projectPath,
      error: err instanceof Error ? err.message : String(err),
      backupKept,
    })
    throw new StoreReadError(err instanceof Error ? err.message : String(err), backupKept)
  }
  const stored = StoredProjectReadSchema.safeParse(raw)
  if (!stored.success) {
    const backupKept = keepCorrupt(path, text)
    log.warn('session-store', 'session store present but invalid — refusing to report it as empty', {
      project: projectPath,
      issue: stored.error.issues[0]?.message,
      backupKept,
    })
    throw new StoreReadError('session store is present but unreadable', backupKept)
  }
  // Sessions are validated row-by-row (keepValidRows/W5) rather than all-or-nothing — one drifted field
  // on one session (e.g. a new `approvalMode` enum value an older build doesn't know, the named trigger
  // for this whole branch) must not cost the user every other chat in the project.
  const sessions = keepValidRows(
    PersistedSessionSchema,
    path,
    stored.data.sessions,
    projectPath,
    'session',
    text,
    report,
  )
  const data = { ...stored.data, sessions }
  // One-shot migration to the cold archive store: a pre-split store carries `archived` inline — move
  // them out (split to body + metadata) and rewrite the hot file without (shrinking it by whatever the
  // archive had grown to). After this runs once the branch never triggers again for that project.
  if (data.archived?.length) {
    // Only strip the archives from the hot file once the cold write is CONFIRMED — otherwise a failed
    // cold write would delete them from both places (they're irreplaceable). On failure, leave the hot
    // file untouched so the archives survive inline and the migration retries next boot.
    if (ingestFullArchives(projectPath, data.archived)) {
      const { archived: _archived, ...hot } = data
      writeFileAtomic(path, JSON.stringify(hot, null, 2))
      log.info('session-store', 'migrated archived sessions to the cold store', {
        project: projectPath,
        count: data.archived.length,
      })
      return PersistedSessionsSchema.parse(hot)
    }
    log.warn('session-store', 'archive cold-store migration write failed — kept inline for retry', {
      project: projectPath,
    })
  }
  // The renderer doesn't need projectPath back — PersistedSessionsSchema strips it.
  return PersistedSessionsSchema.parse(data)
}

/** Lean read of ONE session's persisted record, for the remote transcript path. `loadProjectSessions`
 *  double-Zod-validates the ENTIRE project store — and a heavy dogfood project's store runs tens of MB
 *  (all sessions × all transcript items), so that validation was ~2.6s on every phone session-open. The
 *  phone transcript is display-only and reads our OWN file, so parse once and pluck the session; skip the
 *  whole-store validation. Fail-soft (null on any miss) exactly like loadProjectSessions. */
export function readPersistedSession(
  projectPath: string,
  sessionId: string,
): PersistedSessions['sessions'][number] | null {
  try {
    const file = projectStorePath(projectPath)
    // mtime-keyed parse cache: a heavy store is tens of MB (~200-300ms to parse) and repeat phone opens
    // re-read it. The file is rewritten atomically (temp + rename), so mtime is a sound freshness key.
    // One entry per project; the parsed object is shared, so callers must not mutate it.
    const mtimeMs = statSync(file).mtimeMs
    const hit = parsedStoreCache.get(file)
    const raw =
      hit && hit.mtimeMs === mtimeMs
        ? hit.raw
        : (JSON.parse(readFileSync(file, 'utf8')) as { sessions?: PersistedSessions['sessions'] })
    if (!hit || hit.mtimeMs !== mtimeMs) parsedStoreCache.set(file, { mtimeMs, raw })
    return raw.sessions?.find((s) => s.id === sessionId) ?? null
  } catch {
    return null
  }
}
const parsedStoreCache = new Map<string, { mtimeMs: number; raw: { sessions?: PersistedSessions['sessions'] } }>()

/** Persist a project's sessions. `projectPath` is main-supplied (the window's root), never trusted
 *  from the renderer — that's why it's a separate arg, not part of the renderer's blob. */
export function saveProjectSessions(projectPath: string, data: PersistedSessions): void {
  try {
    // `archived` never rides the hot file anymore (cold store above) — strip it even if a caller
    // still passes it, so nothing can quietly re-fatten this constantly-rewritten file.
    const stored: StoredProject = { ...data, archived: undefined, projectPath }
    // Atomic (temp + rename): this file is rewritten every few hundred ms while a session streams,
    // and a torn write here = the project's entire transcript history gone (fail-soft read → null).
    writeFileAtomic(projectStorePath(projectPath), JSON.stringify(stored, null, 2))
  } catch (err) {
    log.warn('session-store', 'failed to persist sessions', err instanceof Error ? err.message : err)
  }
}

/** Archive one session: write it to the cold archive store FIRST, and only remove it from the hot
 *  store once that write is durably confirmed (C2). `ingestFullArchives` can THROW (a present-but-
 *  unreadable archive index) or return `false` (a failed write) — either way the session must survive in
 *  the hot store rather than vanish from both places. A throw here propagates to the caller untouched;
 *  the hot store is never rewritten unless this returns `true`.
 *
 *  Shared by both of the engine's archive paths (a live session ended from the phone, and a past/history
 *  one) so the ordering lives in exactly one place instead of being duplicated (and re-broken) per
 *  caller. Returns whether the archive — and the hot-store removal — actually happened. */
export function archiveSession(
  projectPath: string,
  store: PersistedSessions,
  session: PersistedSession,
  storedId: string,
): boolean {
  if (!ingestFullArchives(projectPath, [{ ...session, archivedAt: Date.now() }])) return false
  saveProjectSessions(projectPath, {
    ...store,
    activeId: store.activeId === storedId ? null : store.activeId,
    sessions: store.sessions.filter((s) => s.id !== storedId),
  })
  return true
}

// ── Ghost-session hygiene ──────────────────────────────────────────────────────
//
// Koda mints a session id and records the session the moment it starts, but the engine only writes its
// own conversation (~/.claude/projects/<slugged-cwd>/<id>.jsonl) once a first exchange completes. A
// session whose start failed — or that was closed before anything was said — therefore exists in Koda's
// store but nowhere the engine can `--resume` (which exits "No conversation found"). These ghosts
// accumulate forever and surface as dead entries. Prune the safe subset at boot: nothing was ever said
// (zero transcript items) AND the engine holds no conversation. Anything with content is kept — its
// transcript still renders even if resume would fail.

/** Does the Claude engine still hold this conversation? Its per-cwd dir slugs every non-alphanumeric
 *  to '-'; the cwd it was spawned with may be the realpath, so accept either form. (We deliberately
 *  share the user's ~/.claude home — profile.ts strips CLAUDE_CONFIG_DIR.) */
export function claudeConversationExists(cwd: string, sessionId: string): boolean {
  return claudeConversationPaths(cwd, sessionId).some((p) => existsSync(p))
}

/** The mtime (epoch ms) of a session's engine conversation, or 0 when there's none — a real "last
 *  active" signal for past sessions with no persisted timestamp, so the launcher can order history
 *  most-recent-first instead of by stored order. */
export function claudeConversationMtime(cwd: string, sessionId: string): number {
  for (const p of claudeConversationPaths(cwd, sessionId)) {
    try {
      return statSync(p).mtimeMs
    } catch {
      /* try the other slug form, else fall through to 0 */
    }
  }
  return 0
}

/** Candidate jsonl paths for a conversation — the cwd it was spawned with may be the realpath, so
 *  accept either slug form. */
function claudeConversationPaths(cwd: string, sessionId: string): string[] {
  return [cwd, realpathOr(cwd)].map((dir) =>
    join(homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`),
  )
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// ── Transcript rebuild from the engine's own conversation file ────────────────
//
// A headless (phone-driven) session's transcript never passes through a renderer, so Koda's store holds
// zero items and the in-memory replay buffer dies with the process — after a Mac relaunch the phone
// opened a months-long conversation to a blank "Ready" screen. The engine's per-session jsonl IS the
// durable record, and its `user`/`assistant` lines carry the same `message.content` block arrays the
// live stream does, so we can synthesize the same ReplayEntry events the phone already reduces.

/** Refuse to slurp a pathological file whole; the biggest real conversations are single-digit MB. */
const MAX_CONVERSATION_BYTES = 32 * 1024 * 1024

/** Rebuild a headless session's displayable history from the engine's on-disk conversation. Returns
 *  events in conversation order (user turns, assistant prose, tool cards), or [] when there's nothing
 *  readable — callers treat that exactly like an empty replay buffer. Thinking blocks and subagent
 *  sidechains are skipped: this is history for a human to reread, not a byte-perfect replay. `liveId`
 *  stamps each event so the phone's reducer keys them to the session it actually has open (a resumed
 *  session's live id differs from the stored id the file is named by). */
export function readClaudeConversationReplay(cwd: string, sessionId: string, liveId: string): ReplayEntry[] {
  const path = claudeConversationPaths(cwd, sessionId).find((p) => existsSync(p))
  if (!path) return []
  let raw: string
  try {
    if (statSync(path).size > MAX_CONVERSATION_BYTES) return []
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: ReplayEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a torn tail line (engine mid-write) is expected, not an error
    }
    if (entry?.isSidechain === true || entry?.isMeta === true) continue
    const content = entry?.message?.content
    if (entry?.type === 'user') {
      // A human turn's content is a string or text blocks; tool results also arrive as `user` lines.
      if (typeof content === 'string') {
        if (content.trim()) out.push({ type: 'RemoteUserTurn', sessionId: liveId, text: content })
        continue
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          out.push({ type: 'RemoteUserTurn', sessionId: liveId, text: block.text })
        } else if (block?.type === 'tool_result') {
          out.push({
            type: 'ToolResult',
            sessionId: liveId,
            id: String(block.tool_use_id ?? ''),
            output: toolResultTextOf(block.content),
            isError: block.is_error === true,
          })
        }
      }
    } else if (entry?.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          out.push({ type: 'AssistantBlock', sessionId: liveId, markdown: block.text })
        } else if (block?.type === 'tool_use') {
          out.push({
            type: 'ToolRequested',
            sessionId: liveId,
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            input: block.input,
          })
        }
      }
    }
  }
  return out
}

/** A tool_result's displayable text — the block's content is a bare string or an array of text parts. */
function toolResultTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Run once at boot. Fail-soft per project file; a write failure just leaves the ghosts for next time. */
export function pruneGhostSessions(): void {
  for (const projectPath of loadAppState().recentProjects) {
    try {
      const path = projectStorePath(projectPath)
      if (!existsSync(path)) continue
      const stored = StoredProjectSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      if (!stored.success) continue
      const kept = stored.data.sessions.filter(
        (s) =>
          (s.engineId ?? 'claude') !== 'claude' || // Codex resumes by its own thread id — don't judge it here
          s.items.length > 0 ||
          claudeConversationExists(s.cwd || projectPath, s.id),
      )
      if (kept.length === stored.data.sessions.length) continue
      const activeId = kept.some((s) => s.id === stored.data.activeId) ? stored.data.activeId : null
      writeFileAtomic(path, JSON.stringify({ ...stored.data, sessions: kept, activeId }, null, 2))
      log.info('session-store', `pruned ${stored.data.sessions.length - kept.length} ghost session(s)`, { projectPath })
    } catch (err) {
      log.warn('session-store', 'ghost prune failed for a project (skipped)', err instanceof Error ? err.message : err)
    }
  }
}

// ── v1 → v2 migration ─────────────────────────────────────────────────────────
//
// v1 was ONE global blob (koda-sessions.json) holding all sessions across all projects with a single
// activeId. v2 splits it per-project. Migration buckets v1 sessions by their `cwd`, writes one v2
// file per project, then renames the v1 file to `.v1.bak`. Idempotent: the rename happens only after
// every write succeeds, so a crash mid-migration just re-runs next boot (re-deriving the same buckets).

const V1Schema = z.object({
  version: z.literal(1),
  activeId: z.string().nullable(),
  sessions: z.array(z.object({ cwd: z.string() }).passthrough()),
})

function legacyStorePath(): string {
  return join(app.getPath('userData'), 'koda-sessions.json')
}

/** Hash the realpath so a migrated bucket lands on the same filename a window later loads. */
function rootKeyForCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd // dir gone — no window will ever root here, but keep the data rather than drop it
  }
}

/** Run once at boot, before any window opens. Fail-soft: a migration error logs and leaves v1 intact. */
export function migrateV1IfPresent(): void {
  const legacy = legacyStorePath()
  if (!existsSync(legacy)) return
  try {
    const parsed = V1Schema.safeParse(JSON.parse(readFileSync(legacy, 'utf8')))
    if (!parsed.success) {
      log.warn('session-store', 'v1 store present but unparseable; leaving it untouched')
      return
    }
    const { activeId, sessions } = parsed.data
    // Bucket sessions by their realpath'd project root.
    const buckets = new Map<string, typeof sessions>()
    for (const s of sessions) {
      const root = rootKeyForCwd(s.cwd)
      const list = buckets.get(root) ?? []
      list.push(s)
      buckets.set(root, list)
    }
    // Write one v2 file per project; activeId carries over only into the bucket that owns it.
    for (const [root, list] of buckets) {
      const ownsActive = list.some((s) => (s as { id?: string }).id === activeId)
      const stored: StoredProject = {
        version: 2,
        projectPath: root,
        activeId: ownsActive ? activeId : null,
        // Re-validate each session against the real schema (drops anything malformed).
        sessions: PersistedSessionsSchema.shape.sessions.parse(list),
      }
      writeFileAtomic(projectStorePath(root), JSON.stringify(stored, null, 2))
    }
    renameSync(legacy, `${legacy}.v1.bak`) // only after every bucket wrote — keeps retry-on-crash safe
    log.info('session-store', `migrated v1 store → ${buckets.size} project file(s)`)
  } catch (err) {
    log.warn('session-store', 'v1→v2 migration failed (left v1 intact)', err instanceof Error ? err.message : err)
  }
}

// ── App state (which projects are open + recents) ──────────────────────────────

/** Last window size + position, so a relaunch reopens at the size the user left it (not the 1280×800
 *  default). One shared value — the last window to move/resize wins; good enough for one-window use. */
const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})
export type WindowBounds = z.infer<typeof WindowBoundsSchema>

const AppStateSchema = z.object({
  version: z.literal(1),
  /** Projects open at last quit — boot reopens one window each. */
  openProjects: z.array(z.string()),
  /** Most-recent-first, capped — shown in ProjectHome. */
  recentProjects: z.array(z.string()),
  /** Every project ever opened on this Mac, most-recent-first, UNCAPPED — the full set the phone Home
   *  lists (recents is only the desktop's short list). Seeded once from the on-disk session stores
   *  (backfillKnownProjects) so it's complete for projects that predate this field. `.default` so older
   *  state files parse. */
  knownProjects: z.array(z.string()).default([]),
  /** Optional so older state files (pre-bounds) still parse — absent ⇒ default size. */
  windowBounds: WindowBoundsSchema.optional(),
})
export type AppState = z.infer<typeof AppStateSchema>

/** READ-time shape of the same file — the three project-path arrays are `unknown[]`, validated row by
 *  row below (keepValidRows) instead of all-or-nothing, same reasoning as `StoredProjectReadSchema`: one
 *  drifted entry must not cost every other one. `windowBounds` is left as `unknown` and re-validated
 *  separately (an invalid rect is one field, not a reason to fail the whole file). `version` stays a
 *  strict literal — a MISMATCHED version (the realistic trigger: a downgrade reading a newer build's
 *  file) is a shape change, not a bad row, and fails the whole file rather than being tolerated.
 *  DERIVED from the strict schema rather than restated, so the read and write shapes cannot drift
 *  apart — a second hand-kept copy is the defect this whole branch exists to stop. */
const AppStateLooseSchema = AppStateSchema.extend({
  openProjects: z.array(z.unknown()).default([]),
  recentProjects: z.array(z.unknown()).default([]),
  knownProjects: z.array(z.unknown()).default([]),
  windowBounds: z.unknown().optional(),
})

const RECENTS_CAP = 20
const EMPTY_STATE: AppState = { version: 1, openProjects: [], recentProjects: [], knownProjects: [] }

function appStatePath(): string {
  return join(app.getPath('userData'), 'koda-app-state.json')
}

/** Strict load: absent (or blank/whitespace-only — the same power-cut case `loadProjectSessions` treats
 *  as benign) returns `EMPTY_STATE`, nothing to protect. Present-but-unreadable (bad bytes, bad JSON, or
 *  a version mismatch) THROWS after backing the file up via `keepCorrupt` — same contract as
 *  `loadProjectSessions`/`loadArchivedMeta`. Not exported: the public `loadAppState` below never lets
 *  this throw escape (see its doc for why), so every WRITE path in this file that would otherwise save
 *  right back over an unreadable file goes through `loadAppStateForWrite` instead, which does. */
function loadAppStateStrict(): AppState {
  const path = appStatePath()
  if (!existsSync(path)) return EMPTY_STATE
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const backupKept = keepCorrupt(path)
    log.warn('session-store', 'app state unreadable — refusing to report it as empty', {
      error: err instanceof Error ? err.message : String(err),
      backupKept,
    })
    throw new StoreReadError(err instanceof Error ? err.message : String(err), backupKept)
  }
  if (!text.trim()) return EMPTY_STATE
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const backupKept = keepCorrupt(path, text)
    log.warn('session-store', 'app state unreadable — refusing to report it as empty', {
      error: err instanceof Error ? err.message : String(err),
      backupKept,
    })
    throw new StoreReadError(err instanceof Error ? err.message : String(err), backupKept)
  }
  const loose = AppStateLooseSchema.safeParse(raw)
  if (!loose.success) {
    const backupKept = keepCorrupt(path, text)
    log.warn('session-store', 'app state present but invalid — refusing to report it as empty', {
      issue: loose.error.issues[0]?.message,
      backupKept,
    })
    throw new StoreReadError('app state is present but unreadable', backupKept)
  }
  const openProjects = keepValidRows(z.string(), path, loose.data.openProjects, path, 'open-project', text)
  const recentProjects = keepValidRows(z.string(), path, loose.data.recentProjects, path, 'recent-project', text)
  const knownProjects = keepValidRows(z.string(), path, loose.data.knownProjects, path, 'known-project', text)
  const bounds = WindowBoundsSchema.safeParse(loose.data.windowBounds)
  return {
    version: 1,
    openProjects,
    recentProjects,
    knownProjects,
    windowBounds: bounds.success ? bounds.data : undefined,
  }
}

/** Lenient wrapper for the many READ-ONLY call sites across main (default window bounds, the app menu's
 *  recents, boot's reopen loop, the phone's project list via `knownProjectPaths`) — none of them save
 *  appState back, so there's nothing for them to clobber, and they already tolerate an empty list the
 *  same way a `null` from `loadProjectSessions` flattens to "no sessions" for the renderer. The corrupt
 *  file is still backed up inside `loadAppStateStrict` even though this wrapper swallows the throw, so
 *  the data isn't silently gone — `loadAppStateForWrite` below is what actually refuses to save. */
export function loadAppState(): AppState {
  try {
    const state = loadAppStateStrict()
    appStateFailure = null
    return state
  } catch (err) {
    appStateFailure = { backupKept: err instanceof StoreReadError ? err.backupKept : null }
    return EMPTY_STATE
  }
}

/** What the last strict load found, for the renderer (`app:dataIntegrity` → ProjectHome). `null` once a
 *  load succeeds again, which is what a user-open recovery below produces — so the notice takes itself
 *  down rather than outliving the problem. Without this the failure is INVISIBLE: every reader here
 *  falls back to an empty list, and an empty ProjectHome is pixel-identical to a fresh install. */
let appStateFailure: { backupKept: BackupKept } | null = null

export function appStateHealth(): { unreadable: boolean; backupKept: BackupKept } {
  return { unreadable: !!appStateFailure, backupKept: appStateFailure?.backupKept ?? null }
}

/** Why a write path is loading. `'automatic'` is everything that happens on its own — a window moving,
 *  boot's backfill, a window closing — and none of it may write over a file we could not read.
 *  `'user-open'` is the single path a person drives on purpose (see `noteProjectOpened`), and it is the
 *  way out of an otherwise permanent dead end: refusing every write means the project they just picked
 *  is forgotten again at the next launch, forever, with the app looking freshly installed each time. */
type WriteConsent = 'automatic' | 'user-open'

/** For WRITE paths only: every one of this file's appState mutators does load-then-save with no gate in
 *  between, and (unlike the per-project session store) nothing downstream — there is no renderer here —
 *  can refuse to persist on its behalf. So the refusal has to live at the load itself: a corrupt file
 *  returns `undefined` instead of `EMPTY_STATE`, and every automatic caller below skips its save
 *  entirely rather than write emptiness over the file it just failed to read.
 *
 *  A `'user-open'` load starts over from `EMPTY_STATE` instead, but ONLY once `keepCorrupt` has
 *  confirmed the copy landed: replacing a file we still hold beside the original costs nothing that
 *  can't be brought back, while replacing the only copy there is would be the exact loss this whole
 *  refusal exists to prevent. */
function loadAppStateForWrite(consent: WriteConsent = 'automatic'): AppState | undefined {
  try {
    const state = loadAppStateStrict()
    appStateFailure = null
    return state
  } catch (err) {
    const backupKept = err instanceof StoreReadError ? err.backupKept : null
    appStateFailure = { backupKept }
    if (consent === 'user-open' && backupKept === true) {
      log.warn('session-store', 'app state unreadable — starting a fresh one from a project the user just opened (the original is kept beside it)')
      return EMPTY_STATE
    }
    log.warn('session-store', 'app state unreadable — refusing to let a write clobber it', err instanceof Error ? err.message : err)
    return undefined
  }
}

function saveAppState(state: AppState): void {
  try {
    writeFileAtomic(appStatePath(), JSON.stringify(state, null, 2))
  } catch (err) {
    log.warn('session-store', 'failed to persist app state', err instanceof Error ? err.message : err)
  }
}

/** Where the open-a-project dialogs should start: ~/Koda (where new projects are created), falling
 *  back to home before the first project ever exists. Not used by projectCreate, which mkdirs ~/Koda
 *  unconditionally. */
export function projectsHomeDir(): string {
  const dir = join(homedir(), 'Koda')
  return existsSync(dir) ? dir : homedir()
}

/** Record a project as open + bump it to the front of recents (deduped, capped) and of the uncapped
 *  known-projects registry (so it never falls off the phone's full list the way recents does).
 *
 *  The ONE `'user-open'` write path. Every call site is a person choosing a project — the folder picker
 *  (ProjectHome and ⌘O), a recents/Open-Recent entry, a worktree opened from Versions, a project just
 *  created — so reaching here means someone asked for this list to change. Nothing automatic may be
 *  routed through this function; add it to `noteProjectClosed`'s side of the file instead. */
export function noteProjectOpened(projectPath: string): void {
  const s = loadAppStateForWrite('user-open')
  if (!s) return
  const openProjects = s.openProjects.includes(projectPath) ? s.openProjects : [...s.openProjects, projectPath]
  const recentProjects = [projectPath, ...s.recentProjects.filter((p) => p !== projectPath)].slice(0, RECENTS_CAP)
  const knownProjects = [projectPath, ...s.knownProjects.filter((p) => p !== projectPath)]
  saveAppState({ ...s, openProjects, recentProjects, knownProjects })
}

/** Record a project window as closed (drops it from openProjects; stays in recents). */
export function noteProjectClosed(projectPath: string): void {
  const s = loadAppStateForWrite()
  if (!s) return
  saveAppState({ ...s, openProjects: s.openProjects.filter((p) => p !== projectPath) })
}

/** Project deleted (moved to the Trash): drop it from both lists — a dead recents entry would
 *  otherwise linger until the cap pushes it out. */
export function noteProjectDeleted(projectPath: string): void {
  const s = loadAppStateForWrite()
  if (!s) return
  saveAppState({
    ...s,
    openProjects: s.openProjects.filter((p) => p !== projectPath),
    recentProjects: s.recentProjects.filter((p) => p !== projectPath),
    knownProjects: s.knownProjects.filter((p) => p !== projectPath),
  })
}

/** Run once at boot. Seed knownProjects from the on-disk session stores so a Mac that predates the
 *  field (or that opened projects on an older build) still lists ALL of them on the phone, not just the
 *  20 in recents. Each `koda-sessions-<hash>.json` stamps its own `projectPath`, so the store set IS the
 *  registry of projects ever worked in here. Idempotent (a union) and fail-soft: a corrupt store is
 *  skipped, a read/write failure just leaves the seed for next boot. */
export function backfillKnownProjects(): void {
  try {
    const dir = app.getPath('userData')
    const fromStores: string[] = []
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('koda-sessions-') || !name.endsWith('.json')) continue
      try {
        const p = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { projectPath?: unknown }).projectPath
        if (typeof p === 'string' && p) fromStores.push(p)
      } catch {
        /* corrupt/partial store — skip it */
      }
    }
    const s = loadAppStateForWrite()
    if (!s) return
    // recents on top (freshest), then the already-known set, then anything new the stores turned up.
    const merged: string[] = []
    const seen = new Set<string>()
    for (const p of [...s.recentProjects, ...s.knownProjects, ...fromStores]) {
      if (seen.has(p)) continue
      seen.add(p)
      merged.push(p)
    }
    if (merged.length !== s.knownProjects.length || merged.some((p, i) => p !== s.knownProjects[i])) {
      saveAppState({ ...s, knownProjects: merged })
    }
  } catch (err) {
    log.warn('session-store', 'known-projects backfill failed (skipped)', err instanceof Error ? err.message : err)
  }
}

/** The phone's full project list: every project ever worked in on this Mac that still exists on disk,
 *  most-recent-first. Recents float on top (the freshness the phone Home relies on), then the rest of the
 *  known set. This is the phone's start/resume/browse whitelist too — the phone can act in any project
 *  the user has here, never an arbitrary directory. */
export function knownProjectPaths(): string[] {
  const s = loadAppState()
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of [...s.recentProjects, ...s.knownProjects]) {
    if (seen.has(p)) continue
    seen.add(p)
    if (existsSync(p)) out.push(p)
  }
  return out
}

/** Delete every per-project session artifact when a project is deleted. All of these are keyed by the
 *  project PATH (a hash for Koda's own stores, a slug for the engine's), so a folder deleted and then
 *  recreated at the same path would otherwise re-adopt the old sessions. Call this BEFORE the folder is
 *  trashed — the engine's store slug depends on the path's realpath, which stops resolving once it's gone.
 *  Best-effort: a missing file is fine, a failed unlink is logged, never thrown (delete must still finish). */
export function purgeProjectSessions(projectPath: string): void {
  const kodaStores = [
    projectStorePath(projectPath),
    archiveIndexPath(projectPath),
    `${archiveIndexPath(projectPath)}.v1.bak`, // one-time migration backup, same hash
  ]
  for (const f of kodaStores) rmQuiet(f)
  rmQuiet(archiveBodiesDir(projectPath), true)
  purgeRemoteReplayProject(projectPath)
  // …plus any `.corrupt-<ts>.bak` kept aside for those two stores — they hold the same project's data.
  for (const f of [projectStorePath(projectPath), archiveIndexPath(projectPath)]) {
    try {
      const prefix = `${basename(f)}.corrupt-`
      for (const n of readdirSync(dirname(f))) if (n.startsWith(prefix) && n.endsWith('.bak')) rmQuiet(join(dirname(f), n))
    } catch {
      /* userData unreadable — the delete must still finish */
    }
  }
  // The engine keyed its jsonl store by the cwd it was spawned with — either the path as given or its
  // realpath — so purge both slug forms.
  const engineDirs = new Set(
    [projectPath, realpathOr(projectPath)].map((dir) =>
      join(homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')),
    ),
  )
  for (const d of engineDirs) rmQuiet(d, true)
}

function rmQuiet(path: string, recursive = false): void {
  try {
    rmSync(path, { force: true, recursive })
  } catch (err) {
    log.warn('session-store', `failed to purge ${path}`, err instanceof Error ? err.message : err)
  }
}

/** Remember the window's size + position so the next launch reopens at it (see createWindow). */
export function saveWindowBounds(bounds: WindowBounds): void {
  const s = loadAppStateForWrite()
  if (!s) return
  saveAppState({ ...s, windowBounds: bounds })
}
