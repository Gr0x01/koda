/**
 * The unmapped-event log — where an engine message Koda's typed vocabulary doesn't cover goes, so it
 * is never SILENTLY dropped.
 *
 * Koda's normalized `EngineEvent` union is deliberately small: two engines, one renderer, one output
 * view. The cost of a small vocabulary is that every engine bump can ship a message no driver maps,
 * and until now that message vanished inside a `default: break`. Then the only way to answer "does the
 * engine emit anything for X" was another wire spike. This log is the cheaper answer: one NDJSON file
 * per session under the app's log dir, holding the engine's own method name, its ids, and a truncated
 * payload.
 *
 * It is a local diagnostic file and nothing else: it never reaches the renderer, the phone, telemetry,
 * or the feedback pipeline (which attaches the run log, not this dir). Unlike `logger.ts` it DOES hold
 * engine payloads, which is the point — so it is capped hard (per entry, per method, per file) and old
 * files are pruned on first write of a run.
 *
 * NOTHING here runs on the hot path. The caller is mid-parse of a live engine stream, where a
 * synchronous directory scan, stat, or append would stall streamed text behind a diagnostic — and a
 * burst of novel messages would stall it repeatedly. Only the in-memory per-method counter is decided
 * inline; the serializing, pruning, and writing ride a fire-and-forget queue that swallows its own
 * failures.
 */
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { EngineId } from '@shared/ipc'
import { log } from '../logger'

/** One entry's payload slice. Enough to recognize the shape; not enough to hold a file's worth of tool output. */
const MAX_PAYLOAD_CHARS = 4096
/** Per session + method. A chatty unknown notification must not crowd out the rare one that matters. */
const MAX_PER_METHOD = 20
/** Sessions whose unmapped files are kept; older ones are pruned on the first write of a run. */
const KEEP_FILES = 20

const counts = new Map<string, number>()
let pruned = false
/** Serializes appends so two entries can never interleave inside one line, and keeps the file work off
 *  the caller's stack. Every link swallows its own failure — a diagnostic must not break a turn. */
let queue: Promise<void> = Promise.resolve()

function dir(): string {
  return join(app.getPath('logs'), 'unmapped')
}

/** Where a session's unmapped events land. Exported so a support answer can name the file. */
export function unmappedLogPath(sessionId: string): string {
  return join(dir(), `${safeName(sessionId)}.ndjson`)
}

/** Session ids are uuids today, but a hand-set id must never escape the log dir. */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'session'
}

/** Runs once per app run, inside the write queue — never on the caller's stack. */
async function pruneOldFiles(): Promise<void> {
  if (pruned) return
  pruned = true
  try {
    const names = (await readdir(dir())).filter((f) => f.endsWith('.ndjson'))
    const files: Array<{ p: string; at: number }> = []
    for (const name of names) {
      const p = join(dir(), name)
      try {
        files.push({ p, at: (await stat(p)).mtimeMs })
      } catch {
        /* vanished mid-scan — skip */
      }
    }
    files.sort((a, b) => a.at - b.at)
    for (const { p } of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      try {
        await unlink(p)
      } catch {
        /* already gone / locked — skip */
      }
    }
  } catch {
    /* dir unreadable or absent — nothing to prune */
  }
}

export interface UnmappedEngineEvent {
  /** Which engine's wire this came off. */
  source: EngineId
  /** The engine's own name for the message (Claude `type/subtype`, Codex JSON-RPC method). */
  method: string
  /** The engine's ids for it, when the shape carries any. */
  ids?: Record<string, string>
  /** The native message. Serialized truncated — never interpreted. */
  payload?: unknown
}

/**
 * Record one engine message no driver mapped. Never throws: a diagnostic that can break a live turn is
 * worse than a missing diagnostic.
 */
export function logUnmappedEvent(sessionId: string, event: UnmappedEngineEvent): void {
  const key = `${sessionId}:${event.source}:${event.method}`
  const seen = counts.get(key) ?? 0
  // The cap is the only decision made inline: one Map read on the caller's stack, and a message past
  // its cap costs nothing at all.
  if (seen >= MAX_PER_METHOD) return
  counts.set(key, seen + 1)
  const ts = new Date().toISOString()
  queue = queue.then(() => writeEntry(ts, sessionId, event, seen)).catch(() => {})
}

/** The whole file path: directory, one-time prune, serialize, append. Off the hot path, fail-soft. */
async function writeEntry(
  ts: string,
  sessionId: string,
  event: UnmappedEngineEvent,
  seen: number,
): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true })
    await pruneOldFiles()
    const line = JSON.stringify({
      ts,
      sessionId,
      source: event.source,
      method: event.method,
      ...(event.ids && Object.keys(event.ids).length ? { ids: event.ids } : {}),
      payload: truncate(event.payload),
      ...(seen + 1 === MAX_PER_METHOD ? { capped: true } : {}),
    })
    await appendFile(unmappedLogPath(sessionId), `${line}\n`)
    // One breadcrumb in the ordinary run log so the file is discoverable without knowing it exists.
    // Method name only — the payload stays in the local file.
    if (seen === 0)
      log.info('engine', 'unmapped engine event (logged for mapping)', {
        sessionId,
        source: event.source,
        method: event.method,
      })
  } catch {
    /* log dir unwritable — the turn continues */
  }
}

/** Settle every queued write. For tests and for a clean shutdown; nothing on the hot path awaits it. */
export function flushUnmappedLog(): Promise<void> {
  return queue
}

function truncate(payload: unknown): unknown {
  if (payload === undefined) return undefined
  let text: string
  try {
    text = JSON.stringify(payload) ?? String(payload)
  } catch {
    return '[unserializable]'
  }
  if (text.length <= MAX_PAYLOAD_CHARS) return payload
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}…[truncated ${text.length - MAX_PAYLOAD_CHARS} chars]`
}

/** Test seam: forget the per-method counters so a case starts from a clean cap. */
export function resetUnmappedLogCounts(): void {
  counts.clear()
  pruned = false
  queue = Promise.resolve()
}
