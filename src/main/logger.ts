/**
 * Dogfood logger — a single readable trail of a Koda run so failures can be
 * diagnosed after the fact (the `npm run dev` terminal scrolls away and the
 * renderer's devtools console is unreachable once you've moved on).
 *
 * Tees every entry to the console (so the live terminal keeps working) AND
 * appends it as NDJSON — one `{ts, level, scope, msg, data}` per line — to a
 * per-run file under the OS log dir (`~/Library/Logs/Koda/` on macOS). One file
 * per app launch keeps a session's trail self-contained and bounded.
 *
 * It's a DIAGNOSTIC trail — failures, crashes, and thin lifecycle breadcrumbs so
 * "what was happening when it broke" is recoverable. It deliberately does NOT
 * record Claude's content or tool payloads (see sessions.ts logEvent).
 */
import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type LogLevel = 'info' | 'warn' | 'error'

/** Keep this many recent runs on disk; older run files are pruned on launch. */
const KEEP_RUNS = 8
/** Hard cap on a single run's file so a runaway loop can't fill the disk. */
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB

let stream: WriteStream | null = null
let logFilePath = ''
let bytesWritten = 0
let capped = false

// A broken stdout/socket makes console.* throw EIO; the crash trap below logs
// that, which writes to console again → an infinite EIO loop that once wrote
// 500 MB in one run. Swallow console failures so logging can never feed itself.
function safeConsole(level: LogLevel, tag: string, extra: unknown): void {
  try {
    if (level === 'error') console.error(tag, extra)
    else if (level === 'warn') console.warn(tag, extra)
    else console.log(tag, extra)
  } catch {
    // console (stdout/pipe) is gone; the file stream still has the entry.
  }
}

/** Delete all but the newest KEEP_RUNS `koda-*.log` files. Never throws. */
function pruneOldRuns(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('koda-') && f.endsWith('.log'))
      .map((f) => join(dir, f))
      .sort() // filenames are chronological ISO stamps
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) {
      try {
        unlinkSync(f)
      } catch {
        /* file locked or already gone — skip */
      }
    }
  } catch {
    /* dir unreadable — nothing to prune */
  }
}

/** Open the per-run log file and install last-ditch crash traps. Idempotent. */
export function initLogger(): string {
  if (stream) return logFilePath
  const dir = app.getPath('logs') // ~/Library/Logs/Koda once app name is set
  mkdirSync(dir, { recursive: true })
  pruneOldRuns(dir)
  // Colons/dots are filename-hostile; ISO with them swapped sorts chronologically.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  logFilePath = join(dir, `koda-${stamp}.log`)
  stream = createWriteStream(logFilePath, { flags: 'a' })

  // A hard failure should still leave a trail, not vanish with the process.
  process.on('uncaughtException', (err) => {
    write('error', 'process', 'uncaughtException', errData(err))
  })
  process.on('unhandledRejection', (reason) => {
    write('error', 'process', 'unhandledRejection', errData(reason))
  })

  write('info', 'logger', `logging to ${logFilePath}`)
  return logFilePath
}

function errData(value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value
}

function write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  const tag = `[${scope}] ${msg}`
  const extra = data !== undefined ? data : ''
  safeConsole(level, tag, extra)

  if (!stream || capped) return // pre-init or size-capped: console only, never throw
  const entry = { ts: new Date().toISOString(), level, scope, msg, ...(data !== undefined && { data }) }
  try {
    const line = JSON.stringify(entry) + '\n'
    bytesWritten += Buffer.byteLength(line)
    if (bytesWritten > MAX_FILE_BYTES) {
      capped = true
      stream.write(
        JSON.stringify({ ts: new Date().toISOString(), level: 'warn', scope: 'logger', msg: `file capped at ${MAX_FILE_BYTES} bytes; further entries go to console only` }) + '\n'
      )
      return
    }
    stream.write(line)
  } catch {
    // Logging must never break a caller (e.g. a circular `data`); console already has it.
  }
}

export const log = {
  info: (scope: string, msg: string, data?: unknown) => write('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => write('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => write('error', scope, msg, data),
}

/** Absolute path to this run's log file (empty before initLogger). Used by the feedback sink to
 *  attach a recent tail when the user opts in. */
export function currentLogFile(): string {
  return logFilePath
}
