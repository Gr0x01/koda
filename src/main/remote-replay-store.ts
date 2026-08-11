/**
 * Durable normalized replay for phone/headless sessions.
 *
 * The engine's own JSONL omits subagent sidechains and task notifications, while the rendered session
 * store is owned by a desktop renderer that a headless session does not have. Keep the already-normalized
 * non-streaming replay in a small per-session JSONL sidecar so task identity, trajectory, and results
 * survive a Koda restart without introducing a second transcript model.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ReplayEntrySchema, type ReplayEntry } from '@shared/ipc'
import { writeFileAtomic } from './atomic-write'
import { log } from './logger'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

function replayDir(projectPath: string): string {
  return join(app.getPath('userData'), `koda-replay-${hash(projectPath)}.bodies`)
}

function replayPath(projectPath: string, sessionId: string): string {
  return join(replayDir(projectPath), `${hash(sessionId)}.jsonl`)
}

function remap(entry: ReplayEntry, sessionId: string): ReplayEntry {
  return entry.sessionId === sessionId ? entry : { ...entry, sessionId }
}

export function appendRemoteReplay(projectPath: string, sessionId: string, entry: ReplayEntry): void {
  try {
    const path = replayPath(projectPath, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    // A killed process can leave the last JSON row half-written. Start the next append on a fresh
    // line so that damaged row cannot swallow the first valid event after Koda relaunches.
    let needsSeparator = false
    if (existsSync(path)) {
      let fd: number | undefined
      try {
        fd = openSync(path, 'r')
        const size = fstatSync(fd).size
        if (size > 0) {
          const lastByte = Buffer.allocUnsafe(1)
          readSync(fd, lastByte, 0, 1, size - 1)
          needsSeparator = lastByte[0] !== 0x0a
        }
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    appendFileSync(path, `${needsSeparator ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    log.warn('session-store', 'failed to append remote replay', err instanceof Error ? err.message : err)
  }
}

export function replaceRemoteReplay(projectPath: string, sessionId: string, entries: readonly ReplayEntry[]): void {
  try {
    const path = replayPath(projectPath, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
    writeFileAtomic(path, body ? `${body}\n` : '')
  } catch (err) {
    log.warn('session-store', 'failed to replace remote replay', err instanceof Error ? err.message : err)
  }
}

/** The session was permanently removed (or restored from a merged archive body). */
export function deleteRemoteReplay(projectPath: string, sessionId: string): void {
  try {
    unlinkSync(replayPath(projectPath, sessionId))
  } catch {
    /* already gone / never recorded */
  }
}

/** The project itself was deleted, so no prompt/result sidecar may survive under its path hash. */
export function purgeRemoteReplayProject(projectPath: string): void {
  try {
    rmSync(replayDir(projectPath), { recursive: true, force: true })
  } catch (err) {
    log.warn('session-store', 'failed to purge remote replay', err instanceof Error ? err.message : err)
  }
}

/** Malformed/truncated rows are skipped; a later append starts fresh, so a tear costs only its row. */
export function loadRemoteReplay(
  projectPath: string,
  storedSessionId: string,
  liveSessionId = storedSessionId,
): ReplayEntry[] {
  try {
    const path = replayPath(projectPath, storedSessionId)
    if (!existsSync(path)) return []
    const out: ReplayEntry[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = ReplayEntrySchema.safeParse(raw)
      if (parsed.success) out.push(remap(parsed.data, liveSessionId))
    }
    return out
  } catch (err) {
    log.warn('session-store', 'failed to read remote replay', err instanceof Error ? err.message : err)
    return []
  }
}
