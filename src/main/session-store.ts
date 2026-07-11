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
import { existsSync, readFileSync, renameSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ArchivedSessionSchema, PersistedSessionsSchema, type ArchivedSession, type PersistedSessions } from '@shared/ipc'
import { writeFileAtomic } from './atomic-write'
import { log } from './logger'

/** The on-disk per-project shape = the renderer's blob + the project it belongs to (main-stamped). */
const StoredProjectSchema = PersistedSessionsSchema.extend({ projectPath: z.string() })
type StoredProject = z.infer<typeof StoredProjectSchema>

/** Stable per-project filename: hash the project path so no path chars / length leak into the name. */
function projectStorePath(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), `koda-sessions-${hash}.json`)
}

// ── Archived sessions: the COLD file ─────────────────────────────────────────
// Archives used to ride inside the hot store above — which the renderer re-serializes, IPCs, and main
// rewrites every ~500ms while a session streams. A dogfood project accumulated 169 archived transcripts
// (~50MB of the 53MB file), so every save froze both processes for ~1s and every read paid the same.
// The cold file is touched ONLY on archive / restore / delete; the hot store never carries `archived`
// again (loadProjectSessions migrates any it finds, one-shot).

const ArchiveFileSchema = z.object({ version: z.literal(1), archived: z.array(ArchivedSessionSchema) })

function archiveStorePath(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
  return join(app.getPath('userData'), `koda-archive-${hash}.json`)
}

/** A project's archived sessions, newest first. Fail-soft: missing/corrupt file reads as none. */
export function loadArchivedSessions(projectPath: string): ArchivedSession[] {
  try {
    const parsed = ArchiveFileSchema.safeParse(JSON.parse(readFileSync(archiveStorePath(projectPath), 'utf8')))
    return parsed.success ? parsed.data.archived : []
  } catch {
    return []
  }
}

export function saveArchivedSessions(projectPath: string, archived: ArchivedSession[]): void {
  try {
    writeFileAtomic(archiveStorePath(projectPath), JSON.stringify({ version: 1, archived }))
  } catch (err) {
    log.warn('session-store', 'failed to persist archived sessions', err instanceof Error ? err.message : err)
  }
}

/** The persisted sessions for a project, or null when its file is missing/corrupt/invalid. */
export function loadProjectSessions(projectPath: string): PersistedSessions | null {
  try {
    const stored = StoredProjectSchema.safeParse(JSON.parse(readFileSync(projectStorePath(projectPath), 'utf8')))
    if (!stored.success) return null
    // One-shot migration to the cold archive file: a pre-split store carries `archived` inline — move
    // them out and rewrite the hot file without (shrinking it by whatever the archive had grown to).
    // After this runs once the branch never triggers again for that project.
    if (stored.data.archived?.length) {
      saveArchivedSessions(projectPath, [...stored.data.archived, ...loadArchivedSessions(projectPath)])
      const { archived: _archived, ...hot } = stored.data
      writeFileAtomic(projectStorePath(projectPath), JSON.stringify(hot, null, 2))
      log.info('session-store', 'migrated archived sessions to the cold store', {
        project: projectPath,
        count: stored.data.archived.length,
      })
      return PersistedSessionsSchema.parse(hot)
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

/** Remember the window's size + position so the next launch reopens at it (see createWindow). */
export function saveWindowBounds(bounds: WindowBounds): void {
  saveAppState({ ...loadAppState(), windowBounds: bounds })
}
