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
import { join } from 'node:path'
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

export class WorkflowWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private linesSeen = 0
  private readonly agents = new Set<string>()
  private lastChange = Date.now()
  private readonly startedAt = Date.now()
  private done = false

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly dir: string,
    private readonly emit: (event: EngineEvent) => void,
    /** Called once the watcher finishes (completed or timed out) so the owner can drop it. */
    private readonly onFinished: (runId: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    try {
      this.readNewLines() // bumps lastChange (and clears `done`) when new agents appear
    } catch (err) {
      log.warn('workflow', 'journal read failed', { runId: this.runId, err: err instanceof Error ? err.message : err })
    }
    const quietFor = Date.now() - this.lastChange
    const expired = Date.now() - this.startedAt > MAX_LIFETIME_MS

    // Surface "complete" + notify ONCE, the first time the journal goes quiet after producing
    // output. We keep watching afterward so a later wave's agents still surface (readNewLines emits
    // them), but we don't re-notify — `done` stays set so this fires a single time.
    if (!this.done && this.linesSeen > 0 && quietFor > COMPLETE_AFTER_QUIET_MS) {
      this.done = true
      this.emit({ type: 'WorkflowCompleted', sessionId: this.sessionId, runId: this.runId, agentCount: this.agents.size })
    }

    // Fully stop once it's been quiet long past completion, or hit the lifetime backstop.
    if (expired || (this.linesSeen > 0 && quietFor > STOP_AFTER_QUIET_MS)) {
      if (!this.done) {
        this.emit({ type: 'WorkflowCompleted', sessionId: this.sessionId, runId: this.runId, agentCount: this.agents.size })
      }
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
        this.emit({ type: 'WorkflowAgent', sessionId: this.sessionId, runId: this.runId, agentId, status: 'running' })
      } else if (rec.type === 'result') {
        this.agents.add(agentId)
        const result = typeof rec.result === 'string' ? rec.result.slice(0, RESULT_CAP) : undefined
        this.emit({ type: 'WorkflowAgent', sessionId: this.sessionId, runId: this.runId, agentId, status: 'done', result })
      }
    }
    this.linesSeen = lines.length
    this.lastChange = Date.now()
    // NB: do NOT re-arm `done` here. A late wave's agents still surface (emitted above), but we
    // notify "complete" only ONCE — re-completing per wave would spam the user with notifications.
  }

  private finish(): void {
    this.stop()
    this.onFinished(this.runId)
  }
}
