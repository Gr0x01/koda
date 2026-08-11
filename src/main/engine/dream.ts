/**
 * The overnight dream — Koda's first auto-inference feature (dream-plan.md, decision-log 08-03).
 *
 * Schedule is activity-following, not wall-clock: consolidation fires ~2.5h after the day's LAST
 * engine activity anywhere, once per quiet stretch, so it keys off the user's real rhythm (RB often
 * starts work at 2–3am — a fixed hour would collide). Each eligible project gets one windowless
 * session (the phone-session machinery reused) that runs the memory-tidy discipline; anything
 * needing a human is auto-declined by the gate and flagged in that project's active-context. The
 * separately gated REM half then revisits one problem the user already worked on and leaves a
 * read-only morning brief. REM is "paralyzed" mechanically: mutating tools are denied and the turn
 * runs in a disposable safety-checkpoint clone that is removed before its digest is written.
 *
 * Inert unless the user-facing `loadDreamEnabled()` setting is on. The generative second turn has a
 * separate hidden `loadRemEnabled()` dogfood gate, so enabling tidy never silently opts into REM.
 *
 * Containment: a labeled safety-git checkpoint before each project's turn, and a post-turn scope
 * tripwire that reverts any change OUTSIDE `.koda/memory/` back to that checkpoint. The turn itself
 * runs under the normal broker gate (per-tool checkpoints included).
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, powerMonitor, powerSaveBlocker } from 'electron'
import type { EngineSessionManager } from './sessions'
import { loadDreamEnabled, loadRemEnabled } from '../settings'
import { checkpoint } from '../safety-git/checkpoint'
import { checkpointChanges } from '../safety-git/changes'
import { restore } from '../safety-git/restore'
import { runGit } from '../safety-git/repo'
import { createCheckpointSandbox, removeCheckpointSandbox } from '../safety-git/sandbox'
import { writeFileAtomic } from '../atomic-write'
import { log } from '../logger'

/** Quiet stretch that means "done for now". Env override (minutes) is for live-fire testing only. */
const QUIET_MS = (Number(process.env.KODA_DREAM_QUIET_MIN) || 150) * 60_000
/** Dreams are a NIGHTLY read of the whole day, not a break-time reflex (RB 08-05: pure
 *  activity-following fired on his daily 6-9am family break). A night opens at 21:00 local and the
 *  morning tail covers working into the wee hours; outside those hours the timer parks until open. */
const NIGHT_OPEN_HOUR = 21
const NIGHT_TAIL_END_HOUR = 12
/** At most one dream per project per this window — belt; quiet + new-material are the real gates. */
const FLOOR_MS = 6 * 3_600_000
/** A dream night visits at most this many projects so a busy day can't burn the plan. */
const MAX_PROJECTS = 3
/** Hard cap on one project's turn before we interrupt it. Deliberately kept alongside the idle cap
 *  below: Hermes's cron measures ONLY inactivity ("a job can run for hours if it's actively working"),
 *  but an unattended dream spends the user's own plan window while they sleep, so a busy runaway gets
 *  a ceiling too. */
const TURN_CAP_MS = 25 * 60_000
/** REM is an ideation pass, not a second shift. */
const REM_TURN_CAP_MS = 15 * 60_000
/** Interrupt a turn that's WORKING but silent this long — a stalled engine (hung tool, dead stream)
 *  shouldn't burn the full wall-clock cap doing nothing. Activity = engine events (sessions
 *  lastEngineEventAt), the Hermes-cron idle-based-timeout lesson. */
const IDLE_CAP_MS = 5 * 60_000
/** The quiet-night token (the Hermes `[SILENT]` convention): the dream says exactly this when there
 *  was nothing to do, and the digest records one dated line instead of a padded summary. Deterministic
 *  string check — only an exact match (whole trimmed reply) counts, so "I considered saying quiet
 *  night but…" still records in full. */
export const QUIET_NIGHT = 'Quiet night — memory already lean.'
/** Don't fire while the user is at the keyboard; re-check later instead. */
const RECHECK_MS = 30 * 60_000
/** Skip the night when the 5-hour window is already this used. */
const HEADROOM_LIMIT_PCT = 80
/** REM is optional and more speculative than the tidy, so it only spends a relatively empty window. */
const REM_HEADROOM_LIMIT_PCT = 60

const DREAM_PROMPT = `This is an unattended overnight maintenance turn — the user is asleep and nobody is watching. Your ONLY job is to consolidate THIS project's memory in .koda/memory/. Approvals are auto-declined tonight: if something would need one, skip it and flag it instead.

1. Read .koda/memory/MEMORY.md and active-context.md. Skim today's transcripts for this project (under ~/.claude/projects/, matched by the cwd field inside the .jsonl files) only as far as needed to spot decisions, reversals, or shipped work the memory hasn't recorded — sample with Grep and targeted reads, never read multi-MB files wholesale.
2. Apply the memory skill's tidy discipline as DELTA edits, never wholesale rewrites: strike active-context lines whose work shipped or verified; keep active-context to one-liners + pointers, moving narrative into the right topic note; fold replaced approaches into their survivor (keep the lesson, delete the leftover and its index line); keep every index line in sync with its note. KEEP WEIRD SPECIFICS — concrete gotchas relocate verbatim, only narrative compresses. Also prune rot while distilling: entries that were stale on arrival (PR numbers, commit hashes, task-progress logs — git already records those), negative claims about tools ("X is broken" — these harden into refusals that outlive the fix), and approaches that never actually worked recorded as if they were reliable workflows; a still-live blocker becomes a dated open problem in active-context, the rest goes. Never delete or archive a decision record. If memory is already lean, change nothing — a no-op is a valid result.
3. Anything that needs a human (a contradiction you didn't fix, a distillation too risky to do blind, wrong-but-authoritative facts, a bug noticed in passing) goes as a dated one-liner under a "**Dream flags:**" section at the bottom of active-context.md — max 3 lines; delete your own stale flags whose issue is resolved. Flags must never accrete.
4. Touch NOTHING outside .koda/memory/ — no code, no Documents/, no git. End with a 3–6 line plain-language summary of what you consolidated, flagged, or skipped; that message becomes the night's digest entry the user reads in the morning. If you changed nothing AND flagged nothing, your entire final message must be exactly "${QUIET_NIGHT}" — nothing else; never combine it with content.`

export const NO_REM_PROBLEM = 'No REM problem — nothing previously worked and stuck.'

/** An explicit focus is a dogfood seam, not a second queue system. It is a one-line handoff in the
 *  always-loaded file the dream already reads; normal sessions remove it once the result is reviewed. */
export function remFocus(activeContext: string): string | undefined {
  const match = activeContext.match(/^\s*(?:[-*]\s*)?\*\*REM focus(?:\s*\([^)]*\))?:?\*\*\s*:?\s*(.+)$/im)
  return match?.[1]?.trim() || undefined
}

export function remPrompt(focus?: string): string {
  const selected = focus
    ? `The user explicitly selected this problem. Work on exactly this:\n\n<rem-focus>${focus}</rem-focus>`
    : `Choose ONE real unresolved problem from active-context.md, in-flight.md, the relevant topic note, and today's project transcripts. It must have evidence of prior work or failed attempts; an untouched backlog item is not primed enough. If none qualifies, end with exactly "${NO_REM_PROBLEM}".`

  return `This is the generative REM half of an unattended overnight dream. The slow-wave memory tidy just finished. Nobody is watching, so you must remain read-only: do not edit, write, delete, run git, launch agents, call external services, or take any action on a proposed solution. Mutating tools are mechanically denied. Your only output is the final waking brief; Koda will store it after deleting this disposable project snapshot.

${selected}

Use the project's actual evidence, not a generic brainstorm:
1. Prime the problem: state what was attempted, where it failed, and the constraints that survived those failures. Read the relevant files and targeted transcript passages; do not trust a summary when the underlying artifact is available.
2. Diverge through THREE genuinely different mechanisms: (a) a distant analogy from another subsystem, project, or field, (b) a constraint inversion that questions one load-bearing assumption, and (c) a recombination of useful pieces from approaches that failed. Cosmetic variants count as one idea.
3. Preserve all three candidates. Then pressure-test them for feasibility, contradiction with known evidence, and the cheapest observation that could falsify each. Do not let novelty masquerade as correctness.
4. Name one most testable next move for the waking user. It must be a bounded experiment, not a rebuild plan, and nothing is adopted tonight.

Keep the final brief under 3,500 characters with exactly these headings:
## Problem
## What the failures say
## Three distant connections
## Most testable next move
## Reasons this may be wrong
## Waking decision

Mark observed facts, inferences, and speculation plainly. Never claim the problem is solved.`
}

interface DreamState {
  lastDream: Record<string, number>
  /** nightKey() of the last window that actually dreamed — one dream per night, ever. */
  lastNight?: string
}

/** Local-time gate: only from 21:00, or the pre-noon tail of a night that ran long. */
export function inDreamHours(d: Date): boolean {
  return d.getHours() >= NIGHT_OPEN_HOUR || d.getHours() < NIGHT_TAIL_END_HOUR
}

/** The night a moment belongs to = the local date of the most recent 21:00 boundary, so a 5am
 *  fire after a late session and last evening's 22:00 are the SAME night and can't both dream. */
export function nightKey(d: Date): string {
  const day = new Date(d.getTime())
  if (day.getHours() < NIGHT_OPEN_HOUR) day.setDate(day.getDate() - 1)
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`
}

/** Delay until the next 21:00 local — where a daytime or already-dreamed-tonight fire parks. */
export function msUntilNightOpen(d: Date): number {
  const open = new Date(d.getTime())
  open.setHours(NIGHT_OPEN_HOUR, 0, 0, 0)
  if (open.getTime() <= d.getTime()) open.setDate(open.getDate() + 1)
  return open.getTime() - d.getTime()
}

/** LOCAL date stamp (a 21:30 fire is that evening's — `toISOString` would stamp tomorrow). */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The session's name in the chat list and the archive. Says "Dream" so a night's work is findable by
 *  that word alone, and carries the LOCAL date. Locked against auto-retitling by startDreamSession. */
export function dreamSessionName(d: Date): string {
  return `Dream · ${localDate(d)}`
}

export function remSessionName(d: Date): string {
  return `Dream REM · ${localDate(d)}`
}

/** One night's digest entry from the turn's closing message. Every night leaves a dated trace — the
 *  distinctions ride the entry, not its existence: a quiet night is one line (never a padded summary),
 *  an interrupted/silent turn says so honestly, and only an exact quiet-token match counts as quiet. */
export function digestEntry(d: Date, reply: string | undefined, interrupted = false): string {
  const text = reply?.trim()
  if (!text) return `## ${localDate(d)} — no summary (the turn ended without a final message)`
  // Interrupted wins over everything, including a trailing quiet token: mid-work narration is not a
  // summary and must never masquerade as one (review catch — the header is the disambiguator).
  if (interrupted) return `## ${localDate(d)} — interrupted at the cap; last notes, not a summary\n${text.slice(0, 2000)}`
  if (text === QUIET_NIGHT) return `## ${localDate(d)} — quiet night, nothing to tidy`
  return `## ${localDate(d)}\n${text.slice(0, 2000)}`
}

const DIGEST_HEADER = '# Dream digest — one entry per night, newest first'

/** Prepend the night's entry under the header. Pre-header content (the retired launchd Phase 1
 *  wrote its own format) is preserved below, never rewritten. */
export function upsertDigest(existing: string, entry: string): string {
  const body = existing.startsWith(DIGEST_HEADER)
    ? existing.slice(DIGEST_HEADER.length).trimStart()
    : existing.trim()
  return `${DIGEST_HEADER}\n\n${entry}\n\n${body}`.trimEnd() + '\n'
}

const REM_DIGEST_HEADER = '# REM digest — one read-only problem brief per night, newest first'

export function remDigestEntry(
  d: Date,
  reply: string | undefined,
  interrupted = false,
  containmentHeld = true,
): string {
  const text = reply?.trim()
  const status = !containmentHeld
    ? ' — CONTAINMENT FAILED; inspect the Dream log and leftover sandbox before using this result'
    : interrupted
      ? ' — interrupted at the cap; last notes, not a finished brief'
      : ''
  if (!text) return `## ${localDate(d)}${status || ' — no brief (the turn ended without a final message)'}`
  return `## ${localDate(d)}${status}\n${text.slice(0, 3800)}`
}

export function upsertRemDigest(existing: string, entry: string): string {
  const body = existing.startsWith(REM_DIGEST_HEADER)
    ? existing.slice(REM_DIGEST_HEADER.length).trimStart()
    : existing.trim()
  return `${REM_DIGEST_HEADER}\n\n${entry}\n\n${body}`.trimEnd() + '\n'
}

/** Pure eligibility logic, split out for tests. `force` (the dev-menu trigger) skips the timing
 *  gates but never the memory-tree or busy-session checks. */
export function eligibleProjects(
  activity: Map<string, number>,
  lastDream: Record<string, number>,
  now: number,
  hasMemory: (cwd: string) => boolean,
  busy: (cwd: string) => boolean,
  force = false,
): string[] {
  return [...activity.entries()]
    .filter(([cwd, at]) => {
      const prior = lastDream[cwd] ?? 0
      const settled =
        at > prior && // new material since the last dream
        now - prior >= FLOOR_MS &&
        now - at >= QUIET_MS // the project itself has settled
      return (force || settled) && hasMemory(cwd) && !busy(cwd)
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROJECTS)
    .map(([cwd]) => cwd)
}

export class DreamScheduler {
  private readonly activity = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly statePath = join(app.getPath('userData'), 'koda-dream.json')

  constructor(private readonly sessions: EngineSessionManager) {}

  /** Called from the session manager on every send and turn-end. Cheap; re-arms the quiet timer. */
  noteActivity(cwd: string): void {
    if (!cwd) return
    this.activity.set(cwd, Date.now())
    this.arm()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The toggle changed: re-arm soon so turning it ON late in the evening — after quiet has already
   *  set in — still dreams tonight instead of waiting for the next activity to start the clock. */
  recheck(): void {
    this.arm(60_000)
  }

  /** Dev-menu live-fire: dream NOW, skipping the quiet timer, the at-desk/battery/headroom guards,
   *  and the per-project timing gates. Containment (pre-checkpoint, scope tripwire, turn cap,
   *  auto-declined approvals) applies exactly as on a real night — that's what's being tested. */
  dreamNow(): void {
    log.info('dream', 'forced run from Developer menu')
    this.fire(true).catch((err) =>
      log.warn('dream', 'forced run failed', err instanceof Error ? err.message : err),
    )
  }

  private arm(delay?: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (!loadDreamEnabled()) return
    const latest = Math.max(0, ...this.activity.values())
    const wait = delay ?? Math.max(60_000, latest + QUIET_MS - Date.now())
    this.timer = setTimeout(() => {
      this.fire().catch((err) => {
        log.warn('dream', 'fire failed; re-arming', err instanceof Error ? err.message : err)
        this.arm(RECHECK_MS)
      })
    }, wait)
    // A sleeping Mac holds the timer; it fires late on wake, and the at-desk guard below keeps a
    // wake-morning dream from colliding with the user sitting down to work.
    this.timer.unref?.()
  }

  private userAtDesk(): boolean {
    try {
      return powerMonitor.getSystemIdleTime() < 600
    } catch {
      return false
    }
  }

  private onBattery(): boolean {
    try {
      return powerMonitor.isOnBatteryPower()
    } catch {
      return false
    }
  }

  private headroomOk(limit = HEADROOM_LIMIT_PCT): boolean {
    try {
      const limits = this.sessions.remoteRateLimits()
      for (const windows of Object.values(limits)) {
        const five = (windows as Record<string, { usedPercent?: number }>)['five_hour']
        if (five?.usedPercent != null && five.usedPercent >= limit) return false
      }
    } catch {
      /* no data = proceed; the poll may simply not have run yet */
    }
    return true
  }

  private loadState(): DreamState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as DreamState
      return {
        lastDream: parsed.lastDream ?? {},
        lastNight: typeof parsed.lastNight === 'string' ? parsed.lastNight : undefined,
      }
    } catch {
      return { lastDream: {} }
    }
  }

  private async fire(force = false): Promise<void> {
    if (this.running) return
    // A forced run is its own consent — the explicit menu click stands in for the toggle.
    if (!force && !loadDreamEnabled()) return
    const now = Date.now()
    if (!force) {
      const latest = Math.max(0, ...this.activity.values())
      if (now - latest < QUIET_MS) return this.arm()
      if (!inDreamHours(new Date(now))) return this.arm(msUntilNightOpen(new Date(now)))
      if (this.userAtDesk() || this.onBattery() || !this.headroomOk()) return this.arm(RECHECK_MS)
    }

    const state = this.loadState()
    // One dream per night window — a morning break after a night that already dreamed stays quiet.
    if (!force && state.lastNight === nightKey(new Date(now)))
      return this.arm(msUntilNightOpen(new Date(now)))
    const busy = (cwd: string) =>
      this.sessions.remoteSessionList().some((s) => s.cwd === cwd && this.sessions.isWorking(s.id))
    const targets = eligibleProjects(
      this.activity,
      state.lastDream,
      now,
      (cwd) => existsSync(join(cwd, '.koda', 'memory', 'MEMORY.md')),
      busy,
      force,
    )
    // A project blocked only by the floor or a busy session deserves a later look, not a lost night.
    if (targets.length === 0) {
      if (force) log.info('dream', 'forced run: no eligible project (needs activity this app-run + .koda/memory + idle session)')
      return this.arm(RECHECK_MS)
    }

    this.running = true
    const blocker = powerSaveBlocker.start('prevent-app-suspension')
    // Persisted with the first per-project write below; a forced run spends the night too (it just
    // dreamed — an auto re-run the same evening would be a double).
    state.lastNight = nightKey(new Date())
    try {
      await this.sessions.reapDreamSessions() // end last night's un-adopted sessions before starting new ones
      for (const cwd of targets) {
        // The user sat down mid-pass — stop here; the remaining projects keep their eligibility.
        // (A forced run is the user watching on purpose — don't bail on their own keystrokes.)
        if (!force && this.userAtDesk()) {
          log.info('dream', 'user returned mid-pass; abandoning remaining projects')
          break
        }
        state.lastDream[cwd] = Date.now()
        writeFileAtomic(this.statePath, JSON.stringify(state, null, 2))
        await this.dreamProject(cwd, force || loadRemEnabled(), force).catch((err) =>
          log.warn('dream', `project pass failed: ${cwd}`, err instanceof Error ? err.message : err),
        )
      }
    } finally {
      powerSaveBlocker.stop(blocker)
      this.running = false
    }
  }

  private async dreamProject(cwd: string, includeRem = false, forceRem = false): Promise<void> {
    const pre = await checkpoint(cwd, 'before overnight memory tidy')
    log.info('dream', `starting overnight tidy: ${cwd}`)
    // One Date for the session name AND the digest stamp — a turn crossing midnight must not name
    // itself yesterday and stamp its digest tomorrow.
    const night = new Date()
    const { sessionId } = await this.sessions.startDreamSession(cwd, dreamSessionName(night))
    let outcome: 'completed' | 'interrupted' | 'failed' = 'failed'
    let tidyReply: string | undefined
    let tidyError: unknown
    try {
      await this.sessions.sendTurn(sessionId, DREAM_PROMPT, undefined, 'remote')
      outcome = await this.waitForTurnEnd(sessionId)
      tidyReply = this.sessions.lastAssistantReply(sessionId)
    } catch (err) {
      tidyError = err
      tidyReply = `Dream tidy failed before it could leave a summary: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      // The unattended turn is over — every later turn on this session is a human's (the morning
      // adoption, or a resume), so forced asks must go back to asking instead of auto-denying
      // (gate.ts UNATTENDED_REASON). Not startDreamSession's job: an open window can adopt this tab
      // WHILE the dream is still running (notifyDesktopOfHeadless), and clearing there would let the
      // dream start prompting a window nobody's watching at 3am. Tied to a `finally`, not sequential
      // awaits: by here `startDreamSession` has already persisted this as a listed, resumable chat —
      // if `sendTurn`/`waitForTurnEnd` throws (the freshly spawned child already exited: auth expiry,
      // an engine update mid-flight, a bad flag), the flag must still clear, or the user opens this
      // chat in the morning and every forced ask auto-denies while telling the model they never
      // consented — the exact bug this exists to fix, just reached from the throwing path (CRITICAL).
      this.sessions.clearUnattended(sessionId)
    }
    if (pre.id) await this.revertOutOfScope(cwd, pre.id)
    // The scheduler, not the agent, writes the digest — so an interrupted or silent night still
    // leaves its dated trace (a night with no record is indistinguishable from a night that never
    // ran, which is exactly the ambiguity the 08-07 dream flag caught). Written after the scope
    // revert; `.koda/memory/` is in scope so this can't be swept by it.
    this.writeDigest(cwd, night, tidyReply, outcome === 'interrupted')
    if (tidyError) throw tidyError
    if (includeRem && outcome === 'completed') await this.runRem(cwd, night, forceRem)
    log.info('dream', `finished overnight tidy: ${cwd}`)
  }

  /** The read-only generative half. It gets a fresh post-tidy checkpoint and is skipped entirely if
   *  that checkpoint cannot be made: paralysis is a mechanism, not a sentence in the prompt. */
  private async runRem(cwd: string, night: Date, force = false): Promise<void> {
    if (!force && !this.headroomOk(REM_HEADROOM_LIMIT_PCT)) {
      log.info('dream', `REM skipped for plan headroom: ${cwd}`)
      this.writeRemDigest(cwd, night, 'REM skipped — the current plan window was over 60% used.', false, true)
      return
    }
    let pre: Awaited<ReturnType<typeof checkpoint>>
    try {
      pre = await checkpoint(cwd, 'before overnight REM')
    } catch (err) {
      log.warn('dream', `REM skipped because its safety checkpoint threw: ${cwd}`, err instanceof Error ? err.message : err)
      this.writeRemDigest(
        cwd,
        night,
        'REM skipped — Koda could not make the safety checkpoint that keeps the pass read-only.',
        false,
        true,
      )
      return
    }
    if (!pre.id) {
      log.warn('dream', `REM skipped because its safety checkpoint failed: ${cwd}`)
      this.writeRemDigest(
        cwd,
        night,
        'REM skipped — Koda could not make the safety checkpoint that keeps the pass read-only.',
        false,
        true,
      )
      return
    }

    let sandbox: string
    try {
      sandbox = await createCheckpointSandbox(cwd, pre.id)
    } catch (err) {
      log.warn('dream', `REM skipped because its sandbox failed: ${cwd}`, err instanceof Error ? err.message : err)
      this.writeRemDigest(
        cwd,
        night,
        'REM skipped — Koda could not materialize the disposable safety snapshot.',
        false,
        true,
      )
      return
    }

    let focus: string | undefined
    try {
      focus = remFocus(readFileSync(join(sandbox, '.koda', 'memory', 'active-context.md'), 'utf8'))
    } catch {
      /* the prompt can still choose from the other project evidence */
    }

    log.info('dream', `starting read-only REM pass: ${cwd}`)
    let sessionId: string
    try {
      const started = await this.sessions.startDreamSession(sandbox, remSessionName(night), {
        visible: false,
        readOnly: true,
      })
      sessionId = started.sessionId
    } catch (err) {
      const reply = `REM failed before its isolated session could start: ${err instanceof Error ? err.message : String(err)}`
      log.warn('dream', `REM session start failed: ${cwd}`, err instanceof Error ? err.message : err)
      const cleaned = await removeCheckpointSandbox(sandbox).then(() => true).catch(() => false)
      this.writeRemDigest(cwd, night, reply, false, cleaned)
      return
    }

    let outcome: 'completed' | 'interrupted' = 'completed'
    let reply: string | undefined
    try {
      await this.sessions.sendTurn(sessionId, remPrompt(focus), undefined, 'remote')
      outcome = await this.waitForTurnEnd(sessionId, REM_TURN_CAP_MS)
      reply = this.sessions.lastAssistantReply(sessionId)
    } catch (err) {
      reply = `REM failed before it could leave a brief: ${err instanceof Error ? err.message : String(err)}`
      log.warn('dream', `REM turn failed: ${cwd}`, err instanceof Error ? err.message : err)
    }

    // Tear down the hidden engine before deleting its working copy; an interrupt request alone is not
    // proof the child stopped and a hung child could otherwise keep writing into the sandbox.
    let terminal = true
    try {
      await this.sessions.dispose(sessionId)
      this.sessions.forgetSession(sessionId)
    } catch (err) {
      terminal = false
      log.warn('dream', `REM session teardown failed: ${cwd}`, err instanceof Error ? err.message : err)
    }

    const containmentHeld = terminal
      ? await removeCheckpointSandbox(sandbox).then(() => true).catch((err) => {
          log.warn('dream', `REM sandbox cleanup failed: ${sandbox}`, err instanceof Error ? err.message : err)
          return false
        })
      : false
    this.writeRemDigest(cwd, night, reply, outcome === 'interrupted', containmentHeld)
    log.info('dream', `finished read-only REM pass: ${cwd}`)
  }

  /** Append the night's entry to the project's dream digest — the one file RB reads to judge the
   *  feature. Fail-soft: a digest write must never fail the night. */
  private writeDigest(cwd: string, night: Date, reply: string | undefined, interrupted: boolean): void {
    const path = join(cwd, '.koda', 'memory', 'dream-digest.md')
    try {
      let existing = ''
      try {
        existing = readFileSync(path, 'utf8')
      } catch {
        /* first night — no digest yet */
      }
      writeFileAtomic(path, upsertDigest(existing, digestEntry(night, reply, interrupted)))
    } catch (err) {
      log.warn('dream', `digest write failed: ${cwd}`, err instanceof Error ? err.message : err)
    }
  }

  private writeRemDigest(
    cwd: string,
    night: Date,
    reply: string | undefined,
    interrupted: boolean,
    containmentHeld: boolean,
  ): void {
    const path = join(cwd, '.koda', 'memory', 'rem-digest.md')
    try {
      let existing = ''
      try {
        existing = readFileSync(path, 'utf8')
      } catch {
        /* first REM night */
      }
      writeFileAtomic(path, upsertRemDigest(existing, remDigestEntry(night, reply, interrupted, containmentHeld)))
    } catch (err) {
      log.warn('dream', `REM digest write failed: ${cwd}`, err instanceof Error ? err.message : err)
    }
  }

  /** Poll the working flag; a turn that's silent past the idle cap (stalled engine) or running past
   *  the wall-clock cap (busy runaway on the user's plan window) gets interrupted, not left all night.
   *
   *  `working` isn't a pure turn-boundary signal — `handleClose` clears it on EVERY engine exit,
   *  including a mid-turn broker-recovery respawn, and the new child only re-sets it once its first
   *  delta lands (a real gap: the respawn's own auto-resume nudge goes out after the fresh process
   *  finishes spawning + re-registering the broker, which comfortably outlasts one 15s tick but not
   *  two). A poll landing in that gap must not read as "turn over" — that clears `unattended` and lets
   *  `resumeAfterReconnect` hand the dream turn to a windowless session with nobody enforcing the caps
   *  below (W2). `recoveringBroker` was considered instead, but it's cleared right after the respawn's
   *  `start()` call returns — BEFORE the new child has even reported in, let alone re-set `working` —
   *  so it closes only the front half of the gap. Requiring two consecutive not-working reads (one
   *  full extra poll interval) covers the whole thing without needing to reach into that internal set.
   *
   *  That extra poll interval is exactly what W3 doesn't want on the CLEAN-finish path: dreamProject's
   *  finally clears `unattended` only once this resolves, and the tab unlocks its composer on
   *  `TurnComplete` too — every poll tick this function spends confirming an already-real completion is
   *  a tick where the adopted tab looks answerable but every forced ask still auto-denies. So the sleeps
   *  below race against `sessions.awaitTurnEnd` (fired only by a genuine TurnComplete/fatal error, never
   *  by the respawn dip above) and wake immediately on a real finish, while a benign respawn's silence
   *  never resolves it and this falls through to the two-consecutive-poll check exactly as before. */
  private async waitForTurnEnd(sessionId: string, capMs = TURN_CAP_MS): Promise<'completed' | 'interrupted'> {
    const started = Date.now()
    const deadline = started + capMs
    // One promise for the whole wait: `awaitTurnEnd` registers a single resolver per sessionId, so a
    // second call would silently discard the first (nobody left to resolve it).
    const ended = this.sessions.awaitTurnEnd(sessionId)
    let turnEnded = false
    ended.then(() => (turnEnded = true))
    const sleep = (ms: number) => Promise.race([ended, new Promise((r) => setTimeout(r, ms))])
    await sleep(5_000)
    let idleStreak = 0
    while (!turnEnded && idleStreak < 2) {
      if (this.sessions.isWorking(sessionId)) {
        idleStreak = 0
        const lastEvent = Math.max(started, this.sessions.lastEngineEventAt(sessionId))
        const stalled = Date.now() - lastEvent > IDLE_CAP_MS
        if (stalled || Date.now() > deadline) {
          log.warn('dream', `${stalled ? 'idle cap' : 'turn cap'} hit; interrupting ${sessionId}`)
          this.sessions.interrupt(sessionId)
          // Let the engine finish flushing before the scope scan reads the tree — an in-flight
          // write racing the revert is exactly the mess the tripwire exists to prevent.
          const settle = Date.now() + 60_000
          while (this.sessions.isWorking(sessionId) && Date.now() < settle)
            await new Promise((r) => setTimeout(r, 5_000))
          return 'interrupted'
        }
      } else {
        idleStreak++
      }
      if (!turnEnded && idleStreak < 2) await sleep(15_000)
    }
    return 'completed'
  }

  /** The scope tripwire: anything the dream changed outside .koda/memory/ goes back to the
   *  pre-dream checkpoint. Added files are deleted; modified/deleted files are checked out.
   *  A snapshot is taken first so even a wrong revert is recoverable from the safety timeline,
   *  and a truncated diff (>500 files — a runaway) triggers a FULL restore, not a partial one. */
  private async revertOutOfScope(cwd: string, checkpointId: string): Promise<void> {
    const changes = await checkpointChanges(cwd, checkpointId).catch(() => null)
    if (!changes) return
    if (changes.truncated) {
      log.warn('dream', `scope tripwire: diff truncated (runaway change set) — full restore in ${cwd}`)
      await restore(cwd, checkpointId).catch((err) =>
        log.warn('dream', 'full restore failed', err instanceof Error ? err.message : err),
      )
      return
    }
    const outside = changes.files.filter((f) => !f.path.startsWith('.koda/memory/'))
    if (outside.length === 0) return
    log.warn('dream', `scope tripwire: reverting ${outside.length} out-of-scope change(s) in ${cwd}`)
    await checkpoint(cwd, 'before overnight scope revert') // whatever the revert removes stays recoverable
    for (const f of outside) {
      try {
        if (f.status === 'added') await rm(join(cwd, f.path), { force: true })
        else await runGit(cwd, ['checkout', checkpointId, '--', f.path])
      } catch (err) {
        log.warn('dream', `revert failed for ${f.path}`, err instanceof Error ? err.message : err)
      }
    }
  }
}
