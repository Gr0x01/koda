/**
 * The approval gate — the thin last layer of the guardrails (engine-adapter-and-output-view.md §3).
 * The real judgment is the prompt guidance; this gate is deliberately minimal: a hard-stop
 * tripwire, the Auto-approve / Ask-me mode, and the load-bearing per-tool safety checkpoint.
 *
 * No Electron, no HTTP, no MCP — the broker (server.ts) calls `decide`, and the manager injects
 * the checkpoint + renderer-push callbacks. That keeps the policy testable and the wiring obvious.
 */
import type { ApprovalMode, ApprovalRequest, ToolDecision } from '@shared/ipc'
import type { ApproveRequest } from './types'
import {
  destructiveGit,
  isMutating,
  isEditTool,
  checkpointLabel,
  isAlwaysConfirm,
  isSelfCheckpointing,
  isUserQuestion,
  isPreviewTool,
} from './policy'

/**
 * Take a safety checkpoint of the session's working tree under `label`, completing BEFORE it
 * returns (so the snapshot exists before the engine runs the tool). Manager-owned: fail-soft
 * (never throws) and serialized per project dir. Returns false if the checkpoint couldn't be
 * taken, so the gate can let the user know recovery may be limited.
 */
export type CheckpointFn = (sessionId: string, label: string) => Promise<boolean>

/** Push a pending tool-approval to the renderer (Ask-me mode). */
export type PushRequest = (req: ApprovalRequest) => void

/** Tell the renderer to clear all pending approvals for a session whose engine ended. */
export type PushCancelled = (sessionId: string) => void

/** Tell every head one specific request was answered, so a head that DIDN'T answer it (e.g. the Mac
 *  while the phone resolved) clears its now-stale prompt instead of latching on "Needs your approval". */
export type PushResolved = (sessionId: string, requestId: string) => void

/** Tell the renderer recovery may be limited for the action just allowed (checkpoint failed). */
export type WarnFn = (sessionId: string, message: string) => void

export class ApprovalGate {
  /** The posture new sessions start at (seeded from the persisted setting). */
  private defaultMode: ApprovalMode = 'auto'
  /** Whether the agent may start the preview dev server without a confirm (Settings → previewAutoStart,
   *  default true). False forces a human confirm before the spawn, in every posture. */
  private previewAutoStart = true
  /** Per-session posture overrides — the renderer owns each session's mode and pushes it here. */
  private readonly modes = new Map<string, ApprovalMode>()
  /** requestId (= engine tool_use_id) → pending "Ask me" resolver. `at` feeds the phone's
   *  "Needs you · waiting Xm" readout; `toolName`/`input` let a late-joining head (the phone) rebuild
   *  the prompt it never saw pushed live (pendingRequests). */
  private readonly pending = new Map<
    string,
    { resolve: (d: ToolDecision) => void; sessionId: string; at: number; toolName: string; input: unknown }
  >()

  constructor(
    private readonly checkpoint: CheckpointFn,
    private readonly pushRequest: PushRequest,
    private readonly pushCancelled: PushCancelled,
    private readonly pushResolved: PushResolved,
    private readonly warn: WarnFn,
  ) {}

  setDefaultMode(mode: ApprovalMode): void {
    this.defaultMode = mode
  }
  getDefaultMode(): ApprovalMode {
    return this.defaultMode
  }
  setPreviewAutoStart(on: boolean): void {
    this.previewAutoStart = on
  }
  setSessionMode(sessionId: string, mode: ApprovalMode): void {
    this.modes.set(sessionId, mode)
  }
  /** A session's posture, or the default until the renderer has set one. Public so a remote head can
   *  read the same mode the local window shows (remote-control-security.md §4 — remote inherits local
   *  policy exactly; the phone is another head with the same controls, not a stricter regime). */
  getSessionMode(sessionId: string): ApprovalMode {
    return this.modeFor(sessionId)
  }
  /** A session's posture, or the default until the renderer has set one. */
  private modeFor(sessionId: string): ApprovalMode {
    return this.modes.get(sessionId) ?? this.defaultMode
  }

  /**
   * The decision flow. Tripwire first (a denied tool won't run, so it needs no checkpoint); then
   * the mode decision; then — only when we're about to allow a MUTATING tool — the checkpoint,
   * awaited so it lands before the engine acts on the allow.
   */
  async decide(sessionId: string, req: ApproveRequest): Promise<ToolDecision> {
    const tripwire = destructiveGit(req.toolName, req.input)
    if (tripwire) {
      return {
        kind: 'deny',
        reason: `Koda blocks destructive git (${tripwire.what}) — it rewrites history that safety-git can't recover. Ask the user to run this themselves if they're sure.`,
      }
    }

    // AskUserQuestion is answered THROUGH the permission response: the engine reads the user's picks
    // from the tool's `answers` input (supplied as updatedInput), then runs the tool. So always await
    // the user here — even in Auto — because auto-allowing with the original (empty `answers`) input
    // makes the engine record "(no option selected)" for every question ("you didn't pick"). The
    // renderer's QuestionCard surfaces the options and resolves this pending request with
    // `allow-with-edit` carrying {questions, answers}. Read-only → no checkpoint. (See the memory note
    // askuserquestion-answer-via-updatedinput for the engine-side mechanism.)
    if (isUserQuestion(req.toolName)) return this.askUser(sessionId, req)

    // Recovery restore (any always-confirm tool) ALWAYS surfaces a confirm — even in Auto-approve —
    // because it can throw away forward work. Different tier from the tripwire above: that's a hard
    // deny; this is a forced ask the user can still allow (dual-git.md §2). Otherwise the session's
    // posture decides: ask everything / ask only on non-edit mutations (commands) / auto-approve.
    // Starting the preview server is frictionless ONLY in Auto posture with previewAutoStart on. If
    // the user turned previewAutoStart off, OR deliberately set a stricter posture (Ask / Accept-edits),
    // confirm the spawn first — a long-lived process is weightier than an edit, and a strict posture
    // shouldn't be silently bypassed (PREVIEW_TOOL is read-only, so shouldAsk would never catch it).
    const forcePreviewConfirm =
      isPreviewTool(req.toolName) && (!this.previewAutoStart || this.modeFor(sessionId) !== 'auto')
    const ask =
      forcePreviewConfirm || isAlwaysConfirm(req.toolName) || this.shouldAsk(this.modeFor(sessionId), req.toolName)
    const decision: ToolDecision = ask ? await this.askUser(sessionId, req) : { kind: 'allow' }

    // Skip the pre-checkpoint for self-snapshotting tools (restore_checkpoint snapshots internally) —
    // a second one here is redundant and would leak the raw tool name into the recovery timeline.
    if (decision.kind !== 'deny' && isMutating(req.toolName) && !isSelfCheckpointing(req.toolName)) {
      const ok = await this.checkpoint(sessionId, checkpointLabel(req.toolName, req.input))
      if (!ok) this.warn(sessionId, `couldn't snapshot before ${req.toolName} — recovery may be limited for this action`)
    }
    return decision
  }

  /**
   * Does this tool need a human confirm under the given posture?
   *   auto        → never (allow all)
   *   ask         → always (prompt on everything that reaches the gate)
   *   acceptEdits → only for non-edit mutations (commands like Bash); edits + reads pass through
   *   plan        → rides the acceptEdits branch: the engine is read-only in plan mode, so the only
   *                 mutating tool reaching the gate is ExitPlanMode (always-confirmed before this).
   * INVARIANT: `plan` MUST decide identically to `acceptEdits` here. Approving a plan flips the gate
   * to acceptEdits and releases the approval near-simultaneously (store.answerApproval), so the
   * engine's first post-plan tool could be decided while the gate still reads `plan` — harmless only
   * while the two branches agree. Diverge them and that race becomes a mis-decided first edit.
   */
  private shouldAsk(mode: ApprovalMode, toolName: string): boolean {
    if (mode === 'auto') return false
    if (mode === 'ask') return true
    return isMutating(toolName) && !isEditTool(toolName) // acceptEdits / plan
  }

  /** "Ask me" mode — push to the renderer and wait indefinitely (no timeout; the engine waits too). */
  private askUser(sessionId: string, req: ApproveRequest): Promise<ToolDecision> {
    return new Promise<ToolDecision>((resolve) => {
      this.pending.set(req.toolUseId, { resolve, sessionId, at: Date.now(), toolName: req.toolName, input: req.input })
      this.pushRequest({ sessionId, requestId: req.toolUseId, toolName: req.toolName, input: req.input })
    })
  }

  /** Sessions currently blocked on a human answer (approvals AND AskUserQuestion ride the same map) —
   *  the phone's "Needs you" triage. `oldestAt` = when the longest-waiting prompt was raised. */
  pendingBySession(): Record<string, { count: number; oldestAt: number }> {
    const out: Record<string, { count: number; oldestAt: number }> = {}
    for (const { sessionId, at } of this.pending.values()) {
      const cur = out[sessionId]
      if (cur) {
        cur.count += 1
        cur.oldestAt = Math.min(cur.oldestAt, at)
      } else {
        out[sessionId] = { count: 1, oldestAt: at }
      }
    }
    return out
  }

  /** Full pending prompts for one session — so a head that connects AFTER the live push (the phone
   *  opening a session the agent already blocked on) can rebuild the approval/question card it never
   *  saw. The live `pushRequest` only reaches heads attached at push time; this is the catch-up read. */
  pendingRequests(sessionId: string): ApprovalRequest[] {
    const out: ApprovalRequest[] = []
    for (const [requestId, slot] of this.pending) {
      if (slot.sessionId === sessionId)
        out.push({ sessionId, requestId, toolName: slot.toolName, input: slot.input })
    }
    return out
  }

  /** The user answered a pending approval. No-op if it's already gone (resolved/cancelled). */
  resolve(requestId: string, decision: ToolDecision): void {
    const slot = this.pending.get(requestId)
    if (!slot) return
    this.pending.delete(requestId)
    // Broadcast the resolution so every head clears this one prompt — the answering head already
    // dropped it optimistically (idempotent there); a second head that didn't answer needs telling.
    this.pushResolved(slot.sessionId, requestId)
    slot.resolve(decision)
  }

  /**
   * The session's engine ended (dispose/crash) — every pending approval for it is now answerable
   * by no one. Resolve them as deny so the awaiting broker handlers unblock and don't leak, and
   * tell the renderer to clear its prompts. (The deny response goes to a dead socket; harmless.)
   */
  cancelSession(sessionId: string): void {
    for (const [requestId, slot] of this.pending) {
      if (slot.sessionId === sessionId) {
        this.pending.delete(requestId)
        slot.resolve({ kind: 'deny', reason: 'session ended' })
      }
    }
    this.modes.delete(sessionId)
    this.pushCancelled(sessionId)
  }
}
