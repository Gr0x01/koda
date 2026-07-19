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
 * Deliberately NOT a library (small files, same call style as settings.ts). All access is fail-soft:
 * a missing/corrupt file restores nothing, and a failed write never breaks the caller.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ArchivedSessionMetaSchema,
  ArchivedSessionSchema,
  PersistedSessionsSchema,
  type ArchivedPreviewTurn,
  type ArchivedSession,
  type ArchivedSessionMeta,
  type PersistedSessions,
  type ReplayEntry,
} from '@shared/ipc'
import { writeFileAtomic } from './atomic-write'
import { loadArchiveRetentionDays } from './settings'
import { log } from './logger'

/** The on-disk per-project shape = the renderer's blob + the project it belongs to (main-stamped). */
const StoredProjectSchema = PersistedSessionsSchema.extend({ projectPath: z.string() })
type StoredProject = z.infer<typeof StoredProjectSchema>

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

/** v2 = the light metadata index (bodies split out). v1 = the old single blob with transcripts inline. */
const ArchiveIndexSchema = z.object({ version: z.literal(2), archived: z.array(ArchivedSessionMetaSchema) })
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
 *  applies the opt-in retention purge. Fail-soft: missing/corrupt reads as none. */
export function loadArchivedMeta(projectPath: string): ArchivedSessionMeta[] {
  let metas: ArchivedSessionMeta[] = []
  try {
    const raw = JSON.parse(readFileSync(archiveIndexPath(projectPath), 'utf8'))
    const v2 = ArchiveIndexSchema.safeParse(raw)
    if (v2.success) {
      metas = v2.data.archived
    } else {
      const v1 = ArchiveFileV1Schema.safeParse(raw)
      if (v1.success && v1.data.archived.length) {
        // One-shot: write each transcript to its own body file, build the light index, and keep the
        // original blob as `.v1.bak` (a real user's archives are irreplaceable — don't destroy on migrate).
        // COPY (not move) the backup so the original v1 stays at the index path until the new v2 index
        // atomically overwrites it — a crash mid-migration then re-reads valid v1 and re-migrates, rather
        // than finding no index and reading empty.
        try {
          copyFileSync(archiveIndexPath(projectPath), `${archiveIndexPath(projectPath)}.v1.bak`)
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
  } catch {
    return []
  }
  return applyArchiveRetention(projectPath, metas)
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
    return parsed.success ? parsed.data.items : null
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
}

/** Ingest full archives found still inline in a pre-split hot blob (loadProjectSessions migration) —
 *  split each to a body + metadata and merge into the index, newest-first. Returns whether the index
 *  write landed: the migration MUST NOT strip these archives from the hot file unless this is true, or a
 *  failed cold write would lose them from both places. */
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
  for (const m of metas) if (m.archivedAt < cutoff) deleteArchivedBody(projectPath, m.id)
  saveArchivedMeta(projectPath, kept)
  log.info('session-store', `auto-deleted ${metas.length - kept.length} archived session(s) past retention`, {
    project: projectPath,
    days,
  })
  return kept
}

/** The persisted sessions for a project, or null when its file is missing/corrupt/invalid. */
export function loadProjectSessions(projectPath: string): PersistedSessions | null {
  try {
    const stored = StoredProjectSchema.safeParse(JSON.parse(readFileSync(projectStorePath(projectPath), 'utf8')))
    if (!stored.success) return null
    // One-shot migration to the cold archive store: a pre-split store carries `archived` inline — move
    // them out (split to body + metadata) and rewrite the hot file without (shrinking it by whatever the
    // archive had grown to). After this runs once the branch never triggers again for that project.
    if (stored.data.archived?.length) {
      // Only strip the archives from the hot file once the cold write is CONFIRMED — otherwise a failed
      // cold write would delete them from both places (they're irreplaceable). On failure, leave the hot
      // file untouched so the archives survive inline and the migration retries next boot.
      if (ingestFullArchives(projectPath, stored.data.archived)) {
        const { archived: _archived, ...hot } = stored.data
        writeFileAtomic(projectStorePath(projectPath), JSON.stringify(hot, null, 2))
        log.info('session-store', 'migrated archived sessions to the cold store', {
          project: projectPath,
          count: stored.data.archived.length,
        })
        return PersistedSessionsSchema.parse(hot)
      }
      log.warn('session-store', 'archive cold-store migration write failed — kept inline for retry', {
        project: projectPath,
      })
    }
    // The renderer doesn't need projectPath back — PersistedSessionsSchema strips it.
    return PersistedSessionsSchema.parse(stored.data)
  } catch {
    return null
  }
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
  /** Optional so older state files (pre-bounds) still parse — absent ⇒ default size. */
  windowBounds: WindowBoundsSchema.optional(),
})
export type AppState = z.infer<typeof AppStateSchema>

const RECENTS_CAP = 20
const EMPTY_STATE: AppState = { version: 1, openProjects: [], recentProjects: [] }

function appStatePath(): string {
  return join(app.getPath('userData'), 'koda-app-state.json')
}

export function loadAppState(): AppState {
  try {
    const parsed = AppStateSchema.safeParse(JSON.parse(readFileSync(appStatePath(), 'utf8')))
    return parsed.success ? parsed.data : EMPTY_STATE
  } catch {
    return EMPTY_STATE
  }
}

function saveAppState(state: AppState): void {
  try {
    writeFileAtomic(appStatePath(), JSON.stringify(state, null, 2))
  } catch (err) {
    log.warn('session-store', 'failed to persist app state', err instanceof Error ? err.message : err)
  }
}

/** Record a project as open + bump it to the front of recents (deduped, capped). */
export function noteProjectOpened(projectPath: string): void {
  const s = loadAppState()
  const openProjects = s.openProjects.includes(projectPath) ? s.openProjects : [...s.openProjects, projectPath]
  const recentProjects = [projectPath, ...s.recentProjects.filter((p) => p !== projectPath)].slice(0, RECENTS_CAP)
  saveAppState({ ...s, openProjects, recentProjects })
}

/** Record a project window as closed (drops it from openProjects; stays in recents). */
export function noteProjectClosed(projectPath: string): void {
  const s = loadAppState()
  saveAppState({ ...s, openProjects: s.openProjects.filter((p) => p !== projectPath) })
}

/** Project deleted (moved to the Trash): drop it from both lists — a dead recents entry would
 *  otherwise linger until the cap pushes it out. */
export function noteProjectDeleted(projectPath: string): void {
  const s = loadAppState()
  saveAppState({
    ...s,
    openProjects: s.openProjects.filter((p) => p !== projectPath),
    recentProjects: s.recentProjects.filter((p) => p !== projectPath),
  })
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
  saveAppState({ ...loadAppState(), windowBounds: bounds })
}
