/**
 * Watches a background workflow's on-disk journal and surfaces it as live EngineEvents.
 *
 * The Workflow tool launches in the background and never streams its result back into `-p`
 * (spike/capture) — it writes per-agent progress to `<dir>/journal.jsonl` instead:
 *   {"type":"started","agentId":"…"}            an agent began
 *   {"type":"result","agentId":"…","result":"…"} an agent finished
 * We poll that file (it's created shortly after launch, append-only), translate new lines to
 * `WorkflowAgent` events, and — since the journal has no explicit "workflow done" record — infer
 * completion when it goes quiet after producing output. The watcher is owned by the session
 * manager and stopped when the session ends; a hard lifetime cap backstops a workflow that hangs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EngineEvent } from '@shared/ipc'
import { log } from '../logger'

const POLL_MS = 2000
/** Quiet period after the last journal change before we surface "complete" (+ a notification). The
 *  journal has no explicit done record, so this is a heuristic — generous enough to ride over the
 *  gap between agent waves in a multi-phase workflow. */
const COMPLETE_AFTER_QUIET_MS = 25_000
/** Keep watching well past "complete" so a late wave's agents still surface, then fully stop. */
const STOP_AFTER_QUIET_MS = 90_000
/** Backstop: stop watching after this long regardless (a hung/huge workflow shouldn't leak a timer). */
const MAX_LIFETIME_MS = 30 * 60 * 1000
/** Trim an agent result so a verbose return can't bloat the IPC payload / card. */
const RESULT_CAP = 2000
/** Trim the workflow's final return before it rides the next turn into the agent's context. */
const WORKFLOW_RESULT_CAP = 4000
/** How far up from the journal dir to look for the engine's `<sessionRoot>/workflows/<runId>.json`. */
const RESULT_FILE_MAX_WALK = 6

export class WorkflowWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private linesSeen = 0
  private readonly agents = new Set<string>()
  /** Members whose journal has a start but no result. They become unknown if observation ends. */
  private readonly runningAgents = new Set<string>()
  private lastChange = Date.now()
  private readonly startedAt = Date.now()
  private done = false
  private stopped = false
  private resultDelivered = false

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly dir: string,
    private readonly emit: (event: EngineEvent) => void,
    /** Called once the watcher finishes (completed or timed out) so the owner can drop it. */
    private readonly onFinished: (runId: string) => void,
    /** Called once, when the workflow's own result file reports `status:completed`, with the framed
     *  result text to ride the session's NEXT human turn back into the agent's context. Optional so
     *  callers that only want the user-facing card/notification can skip result delivery. */
    private readonly onResult?: (resultText: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  /** Exact members whose start is still missing a result. Main snapshots this across renderer/phone
   *  reattachment so hydration can restore only work the live watcher still observes. */
  activeAgentIds(): string[] {
    return [...this.runningAgents]
  }

  /** User-visible work is live until coordinator completion, or whenever a late wave has a member
   *  without a result. The watcher itself intentionally outlives this state to catch possible writers. */
  isLive(): boolean {
    return !this.stopped && (!this.done || this.runningAgents.size > 0)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const unresolvedAgentIds = [...this.runningAgents]
    // A quiet completion with every known result is already terminal. Every other teardown is one
    // atomic observer-loss fact: a missing result is not success, and the coordinator is not live.
    if (!this.done || unresolvedAgentIds.length > 0) {
      this.emit({
        type: 'WorkflowObservationEnded',
        sessionId: this.sessionId,
        runId: this.runId,
        unresolvedAgentIds,
      })
    }
    this.runningAgents.clear()
  }

  private tick(): void {
    try {
      this.readNewLines() // bumps lastChange (and clears `done`) when new agents appear
    } catch (err) {
      log.warn('workflow', 'journal read failed', { runId: this.runId, err: err instanceof Error ? err.message : err })
    }
    // Deliver the workflow's final return to the agent, keyed off the AUTHORITATIVE `status:completed`
    // in the engine's own result file — not the journal-quiet heuristic below (which only drives the
    // user-facing card + notification). Best-effort and fire-once; if the file's absent/partial we just
    // never deliver (falls back to notify-only), never crash.
    if (this.onResult && !this.resultDelivered) this.maybeDeliverResult()
    const quietFor = Date.now() - this.lastChange
    const expired = Date.now() - this.startedAt > MAX_LIFETIME_MS

    // Surface "complete" + notify ONCE, the first time the journal goes quiet after producing
    // output. We keep watching afterward so a later wave's agents still surface (readNewLines emits
    // them), but we don't re-notify — `done` stays set so this fires a single time.
    if (!this.done && this.linesSeen > 0 && this.runningAgents.size === 0 && quietFor > COMPLETE_AFTER_QUIET_MS) {
      this.done = true
      this.emit({ type: 'WorkflowCompleted', sessionId: this.sessionId, runId: this.runId, agentCount: this.agents.size })
    }

    // Fully stop once a settled journal has been quiet long past completion, or hit the lifetime
    // backstop. Journal quiet is not evidence that a member whose `started` line has no matching
    // result stopped writing: keep observing that known owner across arbitrarily long agent work.
    if (expired || (this.linesSeen > 0 && this.runningAgents.size === 0 && quietFor > STOP_AFTER_QUIET_MS)) {
      this.finish()
    }
  }

  private readNewLines(): void {
    const path = join(this.dir, 'journal.jsonl')
    if (!existsSync(path)) return
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= this.linesSeen) return
    for (let i = this.linesSeen; i < lines.length; i++) {
      let rec: { type?: string; agentId?: string; result?: unknown }
      try {
        rec = JSON.parse(lines[i])
      } catch {
        continue
      }
      const agentId = typeof rec.agentId === 'string' ? rec.agentId : undefined
      if (!agentId) continue
      if (rec.type === 'started') {
        this.agents.add(agentId)
        this.runningAgents.add(agentId)
        this.emit({ type: 'WorkflowAgent', sessionId: this.sessionId, runId: this.runId, agentId, status: 'running' })
      } else if (rec.type === 'result') {
        this.agents.add(agentId)
        this.runningAgents.delete(agentId)
        const result = typeof rec.result === 'string' ? rec.result.slice(0, RESULT_CAP) : undefined
        this.emit({ type: 'WorkflowAgent', sessionId: this.sessionId, runId: this.runId, agentId, status: 'done', result })
      }
    }
    this.linesSeen = lines.length
    this.lastChange = Date.now()
    // NB: do NOT re-arm `done` here. A late wave's agents still surface (emitted above), but we
    // notify "complete" only ONCE — re-completing per wave would spam the user with notifications.
  }

  /** The journal we poll lives at `<sessionRoot>/subagents/workflows/<runId>/journal.jsonl`, but the
   *  workflow's final return + explicit `status` land in a SIBLING `<sessionRoot>/workflows/<runId>.json`.
   *  Walk up from the journal dir (layout can shift across engine versions) until we find it. */
  private locateResultFile(): string | null {
    let cur = this.dir
    for (let i = 0; i < RESULT_FILE_MAX_WALK; i++) {
      const candidate = join(cur, 'workflows', `${this.runId}.json`)
      if (existsSync(candidate)) return candidate
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return null
  }

  private maybeDeliverResult(): void {
    const path = this.locateResultFile()
    if (!path) return
    let rec: { status?: string; result?: unknown; summary?: unknown; workflowName?: unknown }
    try {
      rec = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return // half-written / not JSON yet — try again next tick
    }
    if (rec.status !== 'completed') return // still running (e.g. a long pause between waves)
    this.resultDelivered = true
    // Coordinator completion begins the same late-wave observation window as a final journal row.
    // Without this reset, a result file discovered after a long-running member crossed the old journal
    // quiet threshold would settle that member and stop the observer in the same tick.
    this.lastChange = Date.now()
    // The engine's result file is stronger evidence than journal quiet. Settle any member whose
    // final journal line lagged or never arrived, then publish the coordinator's completion now so
    // an immediate engine close cannot downgrade confirmed work to observer loss.
    for (const agentId of this.runningAgents) {
      this.emit({ type: 'WorkflowAgent', sessionId: this.sessionId, runId: this.runId, agentId, status: 'done' })
    }
    this.runningAgents.clear()
    if (!this.done) {
      this.done = true
      this.emit({ type: 'WorkflowCompleted', sessionId: this.sessionId, runId: this.runId, agentCount: this.agents.size })
    }
    const label =
      (typeof rec.workflowName === 'string' && rec.workflowName) ||
      (typeof rec.summary === 'string' && rec.summary) ||
      'workflow'
    const body =
      typeof rec.result === 'string' ? rec.result : JSON.stringify(rec.result ?? null, null, 2)
    const text =
      `<workflow-result runId="${this.runId}">\n` +
      `The background workflow "${label}" you launched earlier has completed. Its result:\n\n` +
      `${body.slice(0, WORKFLOW_RESULT_CAP)}\n` +
      `</workflow-result>`
    this.onResult?.(text)
  }

  private finish(): void {
    this.stop()
    this.onFinished(this.runId)
  }
}
