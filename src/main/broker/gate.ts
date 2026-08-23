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
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  destructiveGit,
  isMutating,
  isEditTool,
  checkpointLabel,
  isAlwaysConfirm,
  isSelfCheckpointing,
  isUserQuestion,
  isPreviewTool,
  protectedTarget,
  type DestructiveGitHit,
} from './policy'

/**
 * Why the card is asking, in the terms the person reading it can act on. The scope is the honest
 * part: a local rewrite still has the old tip in the reflog, while a force-push has already reached
 * a server Koda can't reach back into. Saying "Koda can't undo this" about a recoverable rebase
 * would train the user to ignore the warning that matters.
 */
function destructiveGitReason(hit: DestructiveGitHit): string {
  return hit.scope === 'remote'
    ? `This rewrites history you've already published (${hit.what}). Koda can't undo it once it runs, so it always checks with you first.`
    : `This rewrites your project's history (${hit.what}). Koda's recovery net covers your files but can't restore history, so it always checks with you first. Git keeps your previous position in its reflog if you need to get back.`
}

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

/** What an unattended (overnight-dream) session hears instead of a prompt. */
const UNATTENDED_REASON =
  'This is an unattended overnight run: anything needing a human is declined, not asked. The user has NOT consented to this action — do not retry it or attempt the same outcome via a different path. Skip it and flag it for a normal session instead.'

/**
 * What an engine WITHOUT a native plan mode hears when it reaches for a mutation in Plan posture.
 * Claude gets this guarantee from `--permission-mode plan` inside the engine; Codex has no such mode,
 * so this deny is what makes Plan a mode there instead of a request (the turn's steering block says
 * this refusal exists — codex-steering.ts, PLAN_BODY — and this is the half that makes it true).
 */
const PLAN_FENCE_REASON =
  'Plan mode is active: Koda declines every change to the project while planning, and this decline is a hard stop rather than a prompt. Do not retry it, reword it, or reach the same outcome another way. Keep exploring read-only and put the action in the plan; the user leaves Plan mode themselves.'

/** REM may inspect only local evidence. This is intentionally narrower than policy.isMutating:
 *  browser/preview/web/task tools may not edit project files, but they still act outside the dream. */
const REM_EVIDENCE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

/** Tidy may inspect local project evidence and edit only the project's real memory tree. Network,
 * shell, browser/capability, and unknown tools are outside an unattended consolidation pass. */
const MEMORY_TIDY_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

function realMemoryTargets(projectRoot: string, targets: string[], existingOnly = false): string[] | null {
  if (!targets.length) return null
  try {
    const realProject = realpathSync(projectRoot)
    const realMemory = realpathSync(join(realProject, '.koda', 'memory'))
    if (!realMemory.startsWith(realProject + sep)) return null
    const resolved = targets.map((target) => {
      const requested = resolve(realProject, target)
      // Existing leaves are realpath'd directly. A new leaf has no realpath yet, so resolve its
      // existing parent and rejoin the basename; both forms defeat `..` and symlink escapes.
      if (existingOnly && !existsSync(requested)) throw new Error('target does not exist')
      return existsSync(requested)
        ? realpathSync(requested)
        : join(realpathSync(dirname(requested)), basename(requested))
    })
    return resolved.every((target) => target.startsWith(realMemory + sep)) ? resolved : null
  } catch {
    return null
  }
}

function containedMemoryEdit(projectRoot: string, input: unknown): boolean {
  const i = input as Record<string, unknown> | null | undefined
  const targets = [i?.file_path, i?.path, i?.notebook_path, ...(Array.isArray(i?.file_paths) ? i.file_paths : [])]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  return realMemoryTargets(projectRoot, targets) !== null
}

/** Parse only a single, non-recursive `rm` invocation. No shell operators, expansion, escapes,
 * globs, double quotes, option surface beyond `-f`, or token concatenation. A filename this tiny
 * grammar cannot express is left for a normal attended session. */
function simpleRmTargets(command: unknown): string[] | null {
  if (typeof command !== 'string' || /[\r\n]/.test(command)) return null
  const tokens: string[] = []
  let at = 0
  while (at < command.length) {
    while (/\s/.test(command[at] ?? '')) at++
    if (at >= command.length) break
    if (command[at] === "'") {
      const end = command.indexOf("'", at + 1)
      if (end < 0 || (command[end + 1] && !/\s/.test(command[end + 1]))) return null
      tokens.push(command.slice(at + 1, end))
      at = end + 1
      continue
    }
    const start = at
    while (at < command.length && !/\s/.test(command[at])) at++
    const token = command.slice(start, at)
    if (!token || /[;&|`$<>(){}[\]*?!\\"'#~]/.test(token)) return null
    tokens.push(token)
  }
  if (tokens.shift() !== 'rm') return null
  if (tokens[0] === '-f') tokens.shift()
  if (tokens[0] === '--') tokens.shift()
  if (!tokens.length || tokens.some((token) => token.startsWith('-'))) return null
  return tokens
}

function containedMemoryDelete(projectRoot: string, input: unknown): boolean {
  const command = (input as { command?: unknown } | null | undefined)?.command
  const targets = simpleRmTargets(command)
  if (!targets) return false
  const real = realMemoryTargets(projectRoot, targets, true)
  return Boolean(real?.every((target) => target.endsWith('.md') && statSync(target).isFile()))
}

function isMemorySkill(input: unknown): boolean {
  return (input as { skill?: unknown } | null | undefined)?.skill === 'memory'
}

/** Attached to a user's deny when they gave no reason of their own. Without it the engine sees a
 *  bare rejection and commonly retries the same action reworded or reaches the same outcome down a
 *  different path — the denial has to say the user's no covers the OUTCOME, not this one phrasing
 *  (the Hermes denial register: "silence is not consent" engineering, applied to an explicit no). */
const USER_DENY_REASON =
  "The user declined this. Do not retry it, rephrase it, or attempt the same outcome via a different path — ask what they'd prefer instead."

/** Not every deny is a no — some tools' deny buttons mean something specific, and the blanket
 *  register would contradict them (review catch: "Keep planning" got told never to re-present the
 *  plan). These carry their own voice instead. */
const TOOL_DENY_REASONS: Record<string, string> = {
  ExitPlanMode: 'The user wants to keep planning — revise the plan from their feedback and present it again.',
  mcp__koda_broker__ensure_tool:
    "The user declined the install. Don't install it another way (no brew/curl/npm end-runs) — continue with the tools already on the machine.",
}

/** A pending ask found still open at a genuine TurnComplete: its asking tool call already ended with
 *  the turn (the engine aborted the `approve` on its ~1025s idle timeout and moved on, leaving the
 *  requestId with no cancel event), so no one is awaiting it. NOT the user-decline register — nobody
 *  declined; the request simply outlived its turn. */
const STRANDED_TURN_ENDED_REASON =
  'The tool call that asked for this ended along with its turn, so this approval no longer applies. Do not act on it; if the work still matters, start it again.'

/** The engine cancelled its own in-flight `approve` request (its MCP idle-abort, or a dead request
 *  stream) while the user was still deciding. The slot is answerable by no one now. */
const STRANDED_ABANDONED_REASON =
  'The engine cancelled this request before it was answered, so the approval no longer applies.'

export class ApprovalGate {
  /** The posture new sessions start at (seeded from the persisted setting). */
  private defaultMode: ApprovalMode = 'auto'
  /** Whether the agent may start the preview dev server without a confirm (Settings → previewAutoStart,
   *  default true). False forces a human confirm before the spawn, in every posture. */
  private previewAutoStart = true
  /** Per-session posture overrides — the renderer owns each session's mode and pushes it here. */
  private readonly modes = new Map<string, ApprovalMode>()
  /** Unattended sessions (the overnight dream): anything that would ASK is DENIED instead — no
   *  window will ever show the prompt, so waiting means hanging the turn until the MCP timeout. */
  private readonly unattended = new Set<string>()
  /** Mechanically paralyzed sessions (REM): reads pass; every project/state mutation is denied. */
  private readonly readOnly = new Set<string>()
  /** Sessions whose engine has no plan mode of its own (capabilities `planMode: 'turnText'`, i.e.
   *  Codex). While their posture is `plan`, this gate IS the fence — see PLAN_FENCE_REASON. */
  private readonly planFenced = new Set<string>()
  /** The posture the IN-FLIGHT turn was actually steered with, pinned by the driver at the moment it
   *  rendered that turn's mode block. The fence follows this, not the live posture: a mode the user
   *  changes mid-turn reaches the model on the NEXT turn (that is what the block's supersession text
   *  promises), so relaxing — or tightening — the fence underneath a running turn would enforce a
   *  mode the model was never told about. Absent between turns, when the live posture is the truth. */
  private readonly turnMode = new Map<string, ApprovalMode>()
  /** Overnight tidy sessions: local evidence reads plus edits contained to this real memory tree. */
  private readonly memoryTidyRoots = new Map<string, string>()
  /** requestId (= engine tool_use_id) → pending "Ask me" resolver. `at` feeds the phone's
   *  "Needs you · waiting Xm" readout; `toolName`/`input` let a late-joining head (the phone) rebuild
   *  the prompt it never saw pushed live (pendingRequests). */
  private readonly pending = new Map<
    string,
    {
      resolve: (d: ToolDecision) => void
      sessionId: string
      at: number
      toolName: string
      input: unknown
      reason?: string
    }
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
  setUnattended(sessionId: string, on: boolean): void {
    if (on) this.unattended.add(sessionId)
    else this.unattended.delete(sessionId)
  }
  setReadOnly(sessionId: string, on: boolean): void {
    if (on) this.readOnly.add(sessionId)
    else this.readOnly.delete(sessionId)
  }
  /** Does Koda have to enforce Plan mode for this session itself? Set from the engine's declared
   *  capabilities at spawn, never from an engine-name check here. */
  setPlanFence(sessionId: string, on: boolean): void {
    if (on) this.planFenced.add(sessionId)
    else this.planFenced.delete(sessionId)
  }
  /** A turn just went out steered with `mode` (pin), or a turn ended (`null`, release). Called from the
   *  driver's own turn delivery, so the pinned value is exactly what the model was told this turn. */
  pinTurnMode(sessionId: string, mode: ApprovalMode | null): void {
    if (mode) this.turnMode.set(sessionId, mode)
    else this.turnMode.delete(sessionId)
  }
  setMemoryTidyRoot(sessionId: string, projectRoot: string | null): void {
    if (projectRoot) this.memoryTidyRoots.set(sessionId, projectRoot)
    else this.memoryTidyRoots.delete(sessionId)
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
   * The decision flow. Context denials first (a denied tool won't run, so it needs no checkpoint);
   * then the mode decision, which the forced-ask tiers can override; then — only when we're about to
   * allow a MUTATING tool — the checkpoint, awaited so it lands before the engine acts on the allow.
   *
   * Destructive git used to short-circuit here as a hard deny. It's a forced ask now (below, beside
   * the self-protection tier): the deny couldn't stop the operation, only relocate it to the user's
   * terminal, and it stranded anyone mid-rebase who didn't already know Git.
   */
  async decide(sessionId: string, req: ApproveRequest, signal?: AbortSignal): Promise<ToolDecision> {
    if (this.readOnly.has(sessionId) && !REM_EVIDENCE_TOOLS.has(req.toolName)) {
      return {
        kind: 'deny',
        reason:
          'This is a read-only overnight REM pass. Do not edit files, run commands, launch tools, or act on the idea. Continue with read-only evidence and put the proposal in the waking brief.',
      }
    }

    const memoryRoot = this.memoryTidyRoots.get(sessionId)
    if (memoryRoot) {
      if (req.toolName === 'Skill' && isMemorySkill(req.input)) return { kind: 'allow' }
      const memoryDelete = req.toolName === 'Bash' && containedMemoryDelete(memoryRoot, req.input)
      if (
        !MEMORY_TIDY_READ_TOOLS.has(req.toolName) &&
        !(isEditTool(req.toolName) && containedMemoryEdit(memoryRoot, req.input)) &&
        !memoryDelete
      ) {
        return {
          kind: 'deny',
          reason:
            'This is an overnight memory tidy. Only local reads, the memory playbook, realpath-contained memory edits, and simple deletion of contained Markdown notes are allowed. Do not use network tools or another path; skip the action and mention it in the digest instead.',
        }
      }
      // The user opted into memory consolidation; a simple contained note deletion is the one shell
      // action the tidy contract requires. Checkpoint it, then allow directly so an unattended
      // accept-edits posture does not turn “remove the replaced note” into an impossible prompt.
      if (memoryDelete) {
        const ok = await this.checkpoint(sessionId, checkpointLabel(req.toolName, req.input))
        if (!ok) this.warn(sessionId, "couldn't snapshot before removing the replaced memory note — it was left in place")
        return ok
          ? { kind: 'allow' }
          : {
              kind: 'deny',
              reason: 'Koda could not make the recovery point required before deleting that memory note. Leave it in place and mention it in the digest.',
            }
      }
    }

    // AskUserQuestion is answered THROUGH the permission response: the engine reads the user's picks
    // from the tool's `answers` input (supplied as updatedInput), then runs the tool. So always await
    // the user here — even in Auto — because auto-allowing with the original (empty `answers`) input
    // makes the engine record "(no option selected)" for every question ("you didn't pick"). The
    // renderer's QuestionCard surfaces the options and resolves this pending request with
    // `allow-with-edit` carrying {questions, answers}. Read-only → no checkpoint. (See the memory note
    // askuserquestion-answer-via-updatedinput for the engine-side mechanism.)
    if (isUserQuestion(req.toolName)) {
      if (this.unattended.has(sessionId)) return { kind: 'deny', reason: UNATTENDED_REASON }
      return this.askUser(sessionId, req, undefined, signal)
    }

    // Plan posture on an engine with no native plan mode: deny the mutation outright. Asking the user
    // would be incoherent — the mode's own text tells the agent this cannot be approved while Plan is
    // on. `Bash` is deliberately exempt: a Codex command runs in that engine's read-only sandbox (the
    // driver refuses to widen it while planning), so commands are exploration — tests, builds, and
    // checks are the part of planning worth keeping. Questions above are already past this point:
    // asking the user IS planning. A denied tool never runs, so no checkpoint is owed.
    // The mode this turn is being JUDGED under: the one it was steered with while it is still running,
    // the live posture between turns. A switch mid-turn changes the next turn, not this one.
    const steeredMode = this.turnMode.get(sessionId) ?? this.modeFor(sessionId)
    const planFenced = this.planFenced.has(sessionId) && steeredMode === 'plan'
    if (planFenced && isMutating(req.toolName) && req.toolName !== 'Bash') {
      return { kind: 'deny', reason: PLAN_FENCE_REASON }
    }

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
    // Self-protection tier: a mutation aimed at Koda's own machinery (guardrail switches, the
    // recovery store, app settings/bundle) is a forced ASK even in Auto — the user can allow it,
    // but it never happens without them seeing it (policy.ts protectedTarget). The hit's human-terms
    // `what` rides the request as `reason` so the card can say WHY Auto suddenly asked — an
    // unexplained prompt just gets rubber-stamped.
    const protectedHit = protectedTarget(req.toolName, req.input)
    // Destructive-git tier: rewriting or deleting history is a forced ask even in Auto, for the same
    // reason as self-protection — the user may well want it, what's banned is it happening unseen.
    const gitHit = destructiveGit(req.toolName, req.input)
    // Under the plan fence the only mutating tool that reaches here is a command, and it runs inside
    // the engine's read-only sandbox (the driver refuses to widen it while planning). Prompting for
    // every `grep`/`npm test` would make planning unusable and would be asking about something that
    // cannot change the project. The forced-ask tiers above still apply, so a protected target or a
    // destructive-git command is still put to the user.
    const ask =
      forcePreviewConfirm ||
      isAlwaysConfirm(req.toolName) ||
      protectedHit !== null ||
      gitHit !== null ||
      (!planFenced && this.shouldAsk(this.modeFor(sessionId), req.toolName))
    const reason = protectedHit
      ? `This changes ${protectedHit.what} — Koda always checks with you first.`
      : gitHit
        ? destructiveGitReason(gitHit)
        : undefined
    const decision: ToolDecision = ask
      ? this.unattended.has(sessionId)
        ? { kind: 'deny', reason: UNATTENDED_REASON }
        : await this.askUser(sessionId, req, reason, signal)
      : { kind: 'allow' }

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

  /** "Ask me" mode — push to the renderer and wait indefinitely (no timeout; the engine waits too).
   *  The optional `signal` is the asking transport's cancellation (Claude's MCP `approve` request):
   *  if the engine abandons that request while the user is still deciding — its idle-abort, or a dead
   *  request stream — the slot must not linger, or it gates the next turn's admission with a card no
   *  head can answer. So hook the abort to clean the slot exactly like one slot of the turn-end sweep. */
  private askUser(sessionId: string, req: ApproveRequest, reason?: string, signal?: AbortSignal): Promise<ToolDecision> {
    return new Promise<ToolDecision>((resolve) => {
      // Already abandoned before we could even register (the engine can cancel during the synchronous
      // decision path). Deny straight away and never push a card no one is waiting behind.
      if (signal?.aborted) {
        resolve({ kind: 'deny', reason: STRANDED_ABANDONED_REASON })
        return
      }
      this.pending.set(req.toolUseId, {
        resolve,
        sessionId,
        at: Date.now(),
        toolName: req.toolName,
        input: req.input,
        reason,
      })
      this.pushRequest({ sessionId, requestId: req.toolUseId, toolName: req.toolName, input: req.input, reason })
      // Idempotent with a user answer (resolve/cancel already dropped the slot) and with the turn-end
      // sweep — whichever lands first wins; discardPending no-ops once the slot is gone.
      signal?.addEventListener('abort', () => this.discardPending(req.toolUseId, STRANDED_ABANDONED_REASON), {
        once: true,
      })
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
        out.push({ sessionId, requestId, toolName: slot.toolName, input: slot.input, reason: slot.reason })
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
    // A bare deny from the user gets the standing register: the no covers the outcome, not this one
    // phrasing. Exceptions: AskUserQuestion ("deny" = answer in the composer instead, not a no) and
    // the tools whose deny has its own meaning (TOOL_DENY_REASONS).
    if (decision.kind === 'deny' && !decision.reason && !isUserQuestion(slot.toolName)) {
      slot.resolve({ kind: 'deny', reason: TOOL_DENY_REASONS[slot.toolName] ?? USER_DENY_REASON })
      return
    }
    slot.resolve(decision)
  }

  /**
   * The session's ENGINE PROCESS ended (dispose/crash) — every pending approval for it is now
   * answerable by no one. Resolve them as deny so the awaiting broker handlers unblock and don't
   * leak, and tell the renderer to clear its prompts. (The deny response goes to a dead socket;
   * harmless.)
   *
   * This is NOT a session-identity event: the process dies and respawns under the SAME session id
   * on every broker recovery, model/effort change, and plan-mode crossing — this fires every time.
   * It must never touch `modes`/`unattended` (a session's posture), or every respawn would silently
   * reset the user's approval mode back to default. That's `forgetSession`'s job, called only from
   * the sites where the session itself is truly over.
   */
  cancelSession(sessionId: string): void {
    for (const [requestId, slot] of this.pending) {
      if (slot.sessionId === sessionId) {
        this.pending.delete(requestId)
        slot.resolve({ kind: 'deny', reason: 'session ended' })
      }
    }
    // The process that was running the steered turn is gone, so nothing is in flight to protect. Left
    // pinned, a stale mode would judge the FIRST turn of the respawned process.
    this.turnMode.delete(sessionId)
    this.pushCancelled(sessionId)
  }

  /** Drop one pending slot, clear its card on every head, and unblock the awaiting broker handler with
   *  a deny carrying `reason`. NOT resolve(): its bare-deny branch substitutes the standing user-decline
   *  register, which is the wrong voice for a slot no one is answering. No-op if already gone, so the
   *  turn-end sweep, an engine-side abort, and a user answer can race without double-clearing a card. */
  private discardPending(requestId: string, reason: string): void {
    const slot = this.pending.get(requestId)
    if (!slot) return
    this.pending.delete(requestId)
    this.pushResolved(slot.sessionId, requestId)
    slot.resolve({ kind: 'deny', reason })
  }

  /**
   * A genuine TurnComplete arrived — sweep any pending ask this session still holds. The engine blocks
   * its turn synchronously on a pending `approve`, so a real turn end proves no live caller is awaiting
   * any of these slots; whatever is left was stranded (the engine aborted its `approve` on the ~1025s
   * MCP idle timeout and moved on, sending no cancellation), and left in place it would gate the next
   * turn's admission — "This session is waiting for your answer" — with a card the renderer already
   * cleared at turn-complete, so nothing on screen to answer and the session bricked until restart.
   *
   * This is the backstop for part 1: if the engine ever DOES send a cancellation for its idle abort,
   * askUser's signal hook cleans the slot first and this finds nothing left to do.
   */
  sweepStranded(sessionId: string): void {
    for (const [requestId, slot] of this.pending) {
      if (slot.sessionId === sessionId) this.discardPending(requestId, STRANDED_TURN_ENDED_REASON)
    }
  }

  /**
   * The session ITSELF is over — its identity is gone, not just its process. Forgets its posture
   * override and unattended flag. Call this from true end sites only (tab closed, archived, reaped,
   * remote tier disabled, window closed, app quit) — never from the engine-process-exit path (see
   * cancelSession).
   *
   * Session ids are randomUUID()s, so no LATER, DIFFERENT session ever reuses one — the only way
   * either flag reactivates is a human resuming this exact conversation. For `modes` that's harmless
   * hygiene: worst case a resume restores the user's own last posture to their own chat. `unattended`
   * is the one that matters — left set, a resumed overnight-dream conversation would auto-deny every
   * forced ask (AskUserQuestion, exit-plan-mode, checkpoint restore, protected-target writes) with
   * text telling the model the user has NOT consented, while the user sits there watching it refuse.
   */
  forgetSession(sessionId: string): void {
    this.modes.delete(sessionId)
    this.unattended.delete(sessionId)
    this.readOnly.delete(sessionId)
    this.planFenced.delete(sessionId)
    this.turnMode.delete(sessionId)
    this.memoryTidyRoots.delete(sessionId)
  }
}
