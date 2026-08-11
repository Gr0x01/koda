/**
 * Account usage poll — ask the engine for the FULL plan picture instead of waiting for it to volunteer.
 *
 * Why this exists: Koda's plan gauge used to be fed entirely by the `rate_limit_event` the stream emits
 * per turn. Since ~2026-07 the server only reports windows it deems newsworthy (a window past its 75%
 * threshold), so at ordinary usage it reports NOTHING and the gauge sat empty — while Anthropic's own
 * Claude app showed every window, because it calls the OAuth usage endpoint directly. That endpoint is
 * closed to us (Consumer ToS bans using subscription OAuth tokens in another product), but the bundled
 * CLI's own `/usage` command makes the same call with its own credentials, and driving the bundled CLI
 * as a subprocess is the sanctioned path. See usage-limits-data-and-tos.md.
 *
 * `claude -p "/usage" --output-format json` is a LOCAL command: 0 turns, 0 tokens, $0, ~500ms. Its
 * `result` is prose meant for a human, so we parse text — the seam that can break on an engine bump.
 * The engine-contract smoke test asserts this parse, so a re-bundle catches a format change instead of
 * the gauge silently going quiet again.
 */
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { RateLimitInfo } from '@shared/ipc'
import { rateLimitBand } from '@shared/rate-limits'
import { resolveEnginePath } from './binary'
import { buildEngineEnv } from './env'
import { log } from '../logger'

const execFileP = promisify(execFile)

/** The server flips a window to its warning threshold at 75% (observed: `seven_day` at 79% past its
 *  0.75 threshold). Match it so the poll's dot color agrees with the stream's own band. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * "Aug 2 at 6:49am" / "Aug 5 at 7am" → unix seconds.
 *
 * The engine prints its own local time (it renders the tz it's running in, which is ours — same process
 * env), so a local-time Date is right. The year is absent: every plan window resets within 7 days, so
 * the candidate year closest to now is the intended one (that's what makes a Dec→Jan reset land).
 */
function parseReset(text: string, now: number): number | undefined {
  const m = /^([A-Za-z]+)\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim())
  if (!m) return undefined
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
  if (month < 0) return undefined
  const day = Number(m[2])
  const minute = m[4] ? Number(m[4]) : 0
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0)
  const thisYear = new Date(now).getFullYear()
  let best: number | undefined
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const t = new Date(year, month, day, hour, minute).getTime()
    if (best === undefined || Math.abs(t - now) < Math.abs(best - now)) best = t
  }
  return best === undefined ? undefined : Math.round(best / 1000)
}

/**
 * One `/usage` line → a window. The engine's vocabulary:
 *   "Current session"            → five_hour
 *   "Current week (all models)"  → seven_day        (the stream's own name for the weekly cap)
 *   "Current week (Fable)"       → seven_day_fable  (a per-model weekly cap; rendered "weekly (fable)")
 * Model-keyed weeklies are matched generically so a new model name doesn't need a code change.
 */
function parseLine(line: string, now: number): RateLimitInfo | undefined {
  const m = /^Current\s+(session|week)\s*(?:\(([^)]+)\))?\s*:\s*(.+)$/i.exec(line.trim())
  if (!m) return undefined
  const scope = m[2]?.trim().toLowerCase()
  const rateLimitType =
    m[1].toLowerCase() === 'session'
      ? 'five_hour'
      : !scope || scope === 'all models'
        ? 'seven_day'
        : `seven_day_${scope.replace(/[^a-z0-9]+/g, '_')}`

  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(m[3])
  // Strip a trailing "(America/Chicago)" — the tz annotation, not part of the timestamp.
  const reset = /resets\s+(.+?)\s*(?:\([^)]*\))?\s*$/i.exec(m[3])
  if (!pct || !reset) return undefined
  const resetsAt = parseReset(reset[1], now)
  if (resetsAt === undefined) {
    // A window without a reset time can't be rendered honestly (the row shows "resets …"), so it's
    // dropped — logged raw so a format drift is diagnosable from the log rather than invisible.
    log.warn('usage', 'unparsed reset time in /usage output', { line })
    return undefined
  }
  const usedPercent = Number(pct[1])
  return { rateLimitType, resetsAt, status: rateLimitBand(usedPercent), usedPercent }
}

export type UsagePollResult = {
  windows: RateLimitInfo[]
  /** True only when both baseline windows arrived and every recognized window parsed. Any weaker
   *  read is a sparse update, never authority to erase a previously known window. */
  complete: boolean
}

export function authoritativeUsageTypes(
  result: UsagePollResult,
  prior: Record<string, RateLimitInfo>,
  nowSec = Date.now() / 1000,
): string[] | undefined {
  if (!result.complete) return undefined
  const types = new Set(result.windows.map((window) => window.rateLimitType))
  // The CLI always names the two baseline windows, but model-specific weeklies can appear or vanish
  // without an end marker. Omission therefore cannot prove one is gone. Preserve a previously known
  // optional window until its measured reset expires; the normal live-window filter clears it then.
  for (const [type, info] of Object.entries(prior)) {
    if (type !== 'five_hour' && type !== 'seven_day' && info.resetsAt > nowSec) types.add(type)
  }
  return [...types]
}

function parseResult(result: string, now = Date.now()): UsagePollResult {
  const windows: RateLimitInfo[] = []
  let everyNamedWindowParsed = true
  for (const line of result.split('\n')) {
    const windowLine = /^Current\s+(session|week)\b/i.test(line.trim())
    const info = parseLine(line, now)
    if (info) windows.push(info)
    else if (windowLine) everyNamedWindowParsed = false
  }
  const types = new Set(windows.map((window) => window.rateLimitType))
  // Authority requires positive proof that the CLI's two baseline subscription windows arrived.
  // Merely seeing no malformed line is insufficient: stdout can truncate, or upstream can rename a
  // line so it no longer matches our `Current …` recognizer. Model-specific weeklies are optional.
  const complete = everyNamedWindowParsed && types.has('five_hour') && types.has('seven_day')
  return { windows, complete }
}

/** Pull every plan window the engine reports. Returns [] when it reports none (an API-key account has
 *  no plan windows) — the caller treats [] as "nothing to publish", never as "all windows are clear". */
export async function pollAccountUsage(
  opts: { resourcesPath?: string; binaryPath?: string } = {},
): Promise<UsagePollResult> {
  const bin = opts.binaryPath ?? resolveEnginePath({ resourcesPath: opts.resourcesPath }).path
  const { stdout } = await execFileP(bin, ['-p', '/usage', '--output-format', 'json'], {
    // The engine chokepoint: strips a stray ANTHROPIC_API_KEY so the poll reads the SAME credential the
    // session spawns will bill to. /usage is local, so this never reaches the API either way.
    env: buildEngineEnv(process.env),
    // A neutral cwd: no project CLAUDE.md, plugins, or MCP servers to load for a local command.
    cwd: tmpdir(),
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)?.result
  if (typeof result !== 'string') return { windows: [], complete: false }
  const observedAt = Date.now()
  const parsed = parseResult(result, observedAt)
  return {
    ...parsed,
    windows: parsed.windows.map((window) => ({
      ...window,
      observedAt,
      source: parsed.complete ? 'snapshot' : 'poll',
    })),
  }
}

/** Exported for the engine-contract test, which asserts the real CLI's output still parses. */
export const __parseUsageForTest = { parseLine, parseReset, parseResult }
