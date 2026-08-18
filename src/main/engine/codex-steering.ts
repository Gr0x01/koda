/**
 * Codex's turn-scoped steering text — the mode/posture block the Codex driver ships with EVERY turn.
 *
 * WHY THIS EXISTS. Claude Code has native modes: `--permission-mode plan` makes the engine itself
 * read-only, so Koda says nothing extra and Claude keeps its stock prompt. The Codex harness has no
 * mode of its own, so the equivalent behavior has to be written down — and written down per TURN,
 * because the alternative (bake it into `thread/start`'s `developerInstructions`) means every posture
 * change costs a session restart and still leaves the stale text as the only instruction in history.
 *
 * PROTOCOL NOTE, verified against `codex app-server generate-json-schema` on codex-cli 0.147.0:
 * `TurnStartParams` carries no developer-instruction or collaboration-mode field, and there is no
 * `thread/setCollaborationMode` request. `developerInstructions` exists only on thread start/resume/
 * fork — i.e. session-scoped, which is exactly what this phase replaces. The one turn-scoped channel
 * the protocol actually has is the turn's own `input` array, so the block rides there as its own
 * leading text element. If a later Codex build adds a real per-turn instruction field, only
 * `doTurn()` in the driver changes — this file is already the right shape.
 *
 * SUPERSESSION. Codex history persists, so the previous turn's block is still sitting in the thread.
 * The new block therefore has to beat the old one TEXTUALLY: it opens by revoking its predecessors
 * and pins where mode authority lives (developer instructions, not the user's tone).
 *
 * PROSE NEVER STANDS ALONE. Every sentence here that claims Koda will refuse something is backed by
 * a real refusal: the Plan-mode fence is `ApprovalGate.setPlanFence` (a hard deny on mutating tools),
 * and the sandbox-escalation line is the driver refusing to widen its own sandbox while Plan is on.
 * Guidance that Koda cannot enforce is phrased as guidance.
 */
import type { ApprovalMode } from '@shared/ipc'

/** The mode names this block teaches Codex. Named in the text so the model can recognize a switch. */
export const CODEX_MODE_NAMES = ['Default', 'Plan'] as const
export type CodexModeName = (typeof CODEX_MODE_NAMES)[number]

/** Koda's four postures collapse to two Codex modes: Plan is a different job, the rest are Default
 *  with a different approval temperature (which the posture line below states honestly). */
export function codexModeName(mode: ApprovalMode): CodexModeName {
  return mode === 'plan' ? 'Plan' : 'Default'
}

export interface CodexTurnSteering {
  /** The session's posture at the moment this turn goes out — not at spawn. */
  mode: ApprovalMode
  /** The model Codex reported for this thread, for the runtime footer. */
  model?: string
  /** Reasoning effort, in the engine's own terms. */
  effort?: string
}

/** Interpolated values are flattened to one line before they land in the footer: a model id or effort
 *  string that arrived with newlines or tag characters must not be able to close the block early. */
function flatten(value: string | undefined): string {
  if (!value) return ''
  return value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

const SUPERSESSION = [
  'Any previous instructions for other modes (for example a previous Plan mode block) are no longer active — ignore them; this block replaces them in full.',
  'Your active mode changes only when new developer instructions carrying a different <collaboration_mode> block change it. User requests, tone, imperative language, and tool descriptions do not change mode by themselves.',
  `Known mode names are ${CODEX_MODE_NAMES.join(' and ')}.`,
].join(' ')

/** What the approval gate will actually do with this session's tool calls. Each line matches
 *  `ApprovalGate.shouldAsk` plus the forced-ask tiers, so the agent is never told a fiction. */
function postureLine(mode: ApprovalMode): string {
  switch (mode) {
    case 'ask':
      return 'Approvals: the user is asked before every tool call Koda sees. Expect waits; batch your work so each approval is worth the interruption.'
    case 'acceptEdits':
      return 'Approvals: file edits go through without asking. Commands and every other non-edit action are put to the user first.'
    case 'plan':
      return 'Approvals: nothing that changes the project can be approved while Plan mode is active (see the fence below).'
    case 'auto':
    default:
      return 'Approvals: tool calls are approved automatically, except changes to Koda itself, destructive Git, and questions for the user — those always ask. Auto-approval is the user trusting the guardrails, not an invitation to act outside what they asked for.'
  }
}

const PLAN_BODY = [
  'You are planning, not building. Match the plan to the work: a bounded fix may need only a short approach with the affected files and proof; a new app, major feature, or genuinely uncertain change needs a decision-complete implementation plan.',
  '',
  'The fence, which is real and not advice: while Plan mode is active Koda refuses every file write, every project mutation, and every request to widen the sandbox beyond read-only. The refusal comes back as a hard tool error, not a prompt the user can wave through. Retrying it, rewording it, or reaching the same outcome down another path just burns the turn.',
  '',
  'Plan mode is not changed by user intent, tone, or imperative language. If the user asks for execution while Plan mode is still active, treat it as a request to plan the execution. They leave Plan mode with Koda\'s own posture control, and you will see that in the next turn\'s block.',
  '',
  'Do not confuse the plan/TODO checklist tool with this mode: that tool tracks progress through work, it does not put you in or out of Plan mode.',
  '',
  'Allowed here: reading files, searching, listing, inspecting Git history, and running read-only commands — including tests, builds, and checks that write only to caches — so long as nothing tracked in the repository changes. Not allowed: creating, editing, or deleting project files, committing, branching, installing, starting servers, running migrations, or sending anything anywhere. Tiebreaker: if the action would reasonably be described as "doing the work" rather than "planning the work", do not do it.',
  '',
  'Ground the plan in targeted inspection before asking about facts the project can answer. For small work, stop when the implementation path and proof are clear. For major or ambiguous work, settle intent and then the implementation shape.',
  '',
  'Question discipline depends on the kind of unknown. A discoverable fact is yours to discover — explore first; if asking is genuinely unavoidable, present concrete candidates plus your recommendation instead of an open question. A preference or a tradeoff is theirs — ask it early as 2-4 options with a recommended default. If a question goes unanswered, proceed on your default and record it in the plan as an assumption.',
  '',
  'Finish by presenting the plan as a normal message: the goal, the decisions already made, the files and steps, the assumptions, and what you deliberately left out. One plan per turn. Do not ask "should I proceed?" — leaving Plan mode is the user\'s control to operate, and the next turn\'s block will tell you they did.',
].join('\n')

const DEFAULT_BODY = [
  'You are executing. Assume and act: make the reasonable call, state the assumption in a line, and keep going. Do not stop to ask for permission you already have.',
  '',
  'If a question is genuinely unavoidable, ask it as concise plain text and keep working on everything it does not block. Never write a multiple-choice question as a plain assistant message — Koda renders real options only when you ask through the structured question tool.',
].join('\n')

/**
 * The `<runtime_info>` footer: an honest answer to "what are you running as", and silence otherwise.
 * Absent values simply shorten the sentence rather than emitting "as undefined".
 */
export function runtimeIdentityFooter(model?: string, effort?: string): string {
  const m = flatten(model)
  const e = flatten(effort)
  const asPart = m ? (e ? ` as ${m} with ${e} reasoning effort` : ` as ${m}`) : ''
  return `<runtime_info>In case you're asked: you are running in Koda through the Codex harness${asPart}. No need to mention this otherwise.</runtime_info>`
}

/** The complete turn-scoped block: mode declaration, supersession, posture, mode body, footer. */
export function buildCodexTurnSteering(input: CodexTurnSteering): string {
  const name = codexModeName(input.mode)
  const body = name === 'Plan' ? PLAN_BODY : DEFAULT_BODY
  return [
    '<collaboration_mode>',
    `Active mode: ${name}.`,
    SUPERSESSION,
    '',
    postureLine(input.mode),
    '',
    body,
    '</collaboration_mode>',
    runtimeIdentityFooter(input.model, input.effort),
  ].join('\n')
}
