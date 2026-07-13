import { z } from 'zod'

/**
 * The typed IPC contract. Zod schemas validate at the main-process boundary;
 * the inferred types flow to the renderer through the preload bridge.
 *
 * This is a scaffold-stage placeholder surface (app info + echo) that proves the
 * round-trip works end to end. The normalized engine-event vocabulary lands here
 * later (see architecture/engine-adapter-and-output-view.md).
 */

/**
 * Which engine drives a session. Per-session and immutable once a conversation starts (the context
 * lives in the engine process, so it can't be handed to a different engine mid-stream) — see
 * `[[codex-engine-selection-ux]]`. 'claude' is the default everywhere for back-compat. Pass-through
 * DISPLAY/ROUTING only — no subsystem branches on the value beyond picking the driver + profile.
 */
export const EngineIdSchema = z.enum(['claude', 'codex'])
export type EngineId = z.infer<typeof EngineIdSchema>

/** One selectable Codex model (from the engine's `model/list`) — for the model picker's OpenAI group. */
export const CodexModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
})
export type CodexModel = z.infer<typeof CodexModelSchema>

/** Codex sign-in state for the picker/Settings — 'chatgpt' authMethod = an active ChatGPT subscription. */
export const CodexAuthStatusSchema = z.object({
  signedIn: z.boolean(),
  authMethod: z.string().nullable(),
  requiresOpenaiAuth: z.boolean().nullable(),
})
export type CodexAuthStatus = z.infer<typeof CodexAuthStatusSchema>

/** engine:codexLoginProgress push — the Codex (ChatGPT OAuth) login state machine's steps. Unlike
 *  Claude's paste-code flow, Codex uses a loopback callback (localhost:1455), so there's no code to
 *  submit: `awaiting-browser` carries the OAuth URL (the manual fallback to the auto-opened browser),
 *  then the child auto-completes when the browser redirect lands. `completed` carries the fresh status. */
export const CodexLoginProgressSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('awaiting-browser'), url: z.string() }),
  z.object({ state: z.literal('verifying') }),
  z.object({ state: z.literal('completed'), status: CodexAuthStatusSchema.optional() }),
  z.object({ state: z.literal('failed'), message: z.string() }),
  z.object({ state: z.literal('cancelled') }),
  z.object({ state: z.literal('timeout') }),
])
export type CodexLoginProgress = z.infer<typeof CodexLoginProgressSchema>

// app:getInfo — no args; returns environment facts.
export const AppInfoSchema = z.object({
  appVersion: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

// update:status — the app self-update lifecycle (releases-and-updates.md). Pushed as it changes and
// seeded via update:getState. `downloading` carries the target version + a 0–100 percent; `ready`
// means a build is downloaded and a restart will install it.
export const UpdateStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('up-to-date') }),
  z.object({ state: z.literal('downloading'), version: z.string(), percent: z.number() }),
  z.object({ state: z.literal('ready'), version: z.string() }),
  z.object({ state: z.literal('error'), message: z.string() }),
])
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>

// update:whatsNew — the current version's release notes (markdown), returned once per update; null
// when already seen, on a fresh install, or when there's no matching CHANGELOG section.
export const WhatsNewSchema = z
  .object({ version: z.string(), markdown: z.string() })
  .nullable()
export type WhatsNew = z.infer<typeof WhatsNewSchema>

// feedback:submit — the user's typed feedback for the PRIVATE Supabase inbox (main/feedback.ts).
// `screenshot` is an optional data URL the user attached (downsized in main before upload);
// `includeLogs` opts into attaching a recent log tail. Caps keep a stray paste bounded; the
// diagnostics (version/os/engine/billing) are gathered in main, not trusted from the renderer.
export const FeedbackRequestSchema = z.object({
  kind: z.enum(['bug', 'idea', 'question']).default('bug'),
  message: z.string().trim().min(1).max(5000),
  email: z.string().trim().max(200).optional(),
  screenshot: z.string().max(8_000_000).optional(),
  includeLogs: z.boolean().optional(),
})
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>

// `error` is a friendly, already-classified string (never a raw network/db dump). Nothing comes
// back on success — the feedback lands privately, there's no link to surface.
export const FeedbackResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type FeedbackResult = z.infer<typeof FeedbackResultSchema>

// app:echo — proves argument validation across the boundary.
export const EchoRequestSchema = z.object({
  message: z.string().min(1).max(1000),
})
export type EchoRequest = z.infer<typeof EchoRequestSchema>

export const EchoResponseSchema = z.object({
  reply: z.string(),
})
export type EchoResponse = z.infer<typeof EchoResponseSchema>

// engine:probe — spawns the bundled engine's `--version` to prove it executes.
export const EngineProbeSchema = z.object({
  version: z.string(),
  path: z.string(),
  source: z.enum(['bundled', 'dev-fallback']),
})
export type EngineProbe = z.infer<typeof EngineProbeSchema>

// ── Engine adapter: the normalized event vocabulary ──────────────────────────
//
// THE portability boundary (engine-adapter-and-output-view.md §2). The renderer
// and output view depend on THESE shapes, never on Claude's raw stream-json — a
// future Codex adapter emits the same union. Two envelope rules are baked in:
//   • every event carries `sessionId` so the renderer routes multiplexed streams
//     to the right transcript (multi-session is per-project);
//   • `model` is pass-through DISPLAY ONLY — no Koda subsystem branches on it
//     (honors the hard no-model-names rule).

export const SessionStartedSchema = z.object({
  type: z.literal('SessionStarted'),
  sessionId: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  cwd: z.string(),
  /** The ENGINE's own session/thread id, when it differs from Koda's `sessionId`. Claude reuses the
   *  same id (`--resume <sessionId>`), so this is absent there; Codex generates its own thread id, which
   *  Koda persists to resume THAT thread by id on a later reattach. Pass-through only. */
  engineNativeId: z.string().optional(),
})

// `parentToolUseId` — set when an event belongs to a SUBAGENT's inner work (the
// Agent/Task launch tool_use id; from the engine's `parent_tool_use_id`). The
// renderer routes such events UNDER the matching SubagentCard instead of the main
// transcript. Absent ⇒ top-level (the common case). See spike/subagent/FINDINGS.md.

/** Token-level delta — drives the *live* paint; superseded by the finalized block. */
export const AssistantDeltaSchema = z.object({
  type: z.literal('AssistantDelta'),
  sessionId: z.string(),
  text: z.string(),
})

// Extended thinking. The engine emits `thinking_delta` events while the model
// reasons, but on subscription `-p` the reasoning TEXT is redacted (empty string +
// an encrypted signature — confirmed in spike/capture). So there's no chain-of-
// thought to render; what we CAN surface is what the TUI does: that thinking is
// happening + its magnitude. `estimatedTokens` is the engine's cumulative running
// estimate for the current thinking burst (monotonic; we display the latest).
export const ThinkingDeltaSchema = z.object({
  type: z.literal('ThinkingDelta'),
  sessionId: z.string(),
  estimatedTokens: z.number().optional(),
})

/** Finalized assistant text block — the output view's source of truth (markdown). */
export const AssistantBlockSchema = z.object({
  type: z.literal('AssistantBlock'),
  sessionId: z.string(),
  markdown: z.string(),
  parentToolUseId: z.string().optional(),
})

export const ToolRequestedSchema = z.object({
  type: z.literal('ToolRequested'),
  sessionId: z.string(),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  parentToolUseId: z.string().optional(),
})

export const ToolResultSchema = z.object({
  type: z.literal('ToolResult'),
  sessionId: z.string(),
  id: z.string(),
  output: z.string(),
  isError: z.boolean(),
  parentToolUseId: z.string().optional(),
})

/**
 * Context-window occupancy after a turn (drives the meter, ui-workspace.md §7a). Derived in the
 * adapter from the engine's `result.usage` + `result.modelUsage`. `contextTokens` is the current
 * prompt size (input + cache read + cache creation = what's in the window now); `contextWindow` is
 * the model's limit the ENGINE reports (`modelUsage[model].contextWindow`) — passed through opaquely,
 * never inferred from the model name. Undefined window ⇒ show absolute used, no denominator.
 */
export const ContextUsageSchema = z.object({
  contextTokens: z.number(),
  contextWindow: z.number().optional(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  outputTokens: z.number(),
})
export type ContextUsage = z.infer<typeof ContextUsageSchema>

/**
 * Per-model usage for ONE turn — the engine's `result.modelUsage` (keyed by model id) flattened to an
 * array. Lists every model the turn touched: the main model plus any aux model (e.g. the haiku titler),
 * each with its own cost + token split (cache called out). `costUsd` sums (≈) to the turn's
 * `total_cost_usd`. Accumulated per-session in the store to drive the Usage view's by-model breakdown.
 * `model` is the engine's raw id, passed through opaquely — display only, never branched on.
 */
export const ModelTurnUsageSchema = z.object({
  model: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
})
export type ModelTurnUsage = z.infer<typeof ModelTurnUsageSchema>

/** Accumulated per-model totals for a session (the running sum of `ModelTurnUsage` minus the model key,
 *  which is the record key). Persisted so the by-model breakdown survives a restart, like `spendUsd`. */
export const ModelSpendSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
})
export type ModelSpend = z.infer<typeof ModelSpendSchema>

/** One day's accumulated usage (main-side rollup persisted in userData) — the "where did my month go"
 *  history that outlives the in-memory open/restored sessions. `date` is local `YYYY-MM-DD`; `byModel`
 *  is the per-model split for that day. Drives the Usage view's History section. */
export const UsageHistoryDaySchema = z.object({
  date: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  turns: z.number(),
  byModel: z.record(z.string(), ModelSpendSchema),
  /** Cost split by ENGINE for the day ('claude'/'codex' → USD), so the History view can separate
   *  Anthropic plan-value from OpenAI plan-value rather than conflating two subscriptions' dollars in
   *  one bar. Optional for back-compat with days rolled up before engine-tagging existed (those render
   *  as a single un-split bar). */
  byEngine: z.record(z.string(), z.number()).optional(),
})
export type UsageHistoryDay = z.infer<typeof UsageHistoryDaySchema>

export const TurnCompleteSchema = z.object({
  type: z.literal('TurnComplete'),
  sessionId: z.string(),
  context: ContextUsageSchema.optional(),
  costEstimate: z.number().optional(),
  /** Per-model usage for this turn (from `result.modelUsage`); folded into the session's running
   *  `byModel` totals. Absent on an error result that carried no usage. */
  models: z.array(ModelTurnUsageSchema).optional(),
  stopReason: z.string().optional(),
})

export const EngineErrorSchema = z.object({
  type: z.literal('EngineError'),
  sessionId: z.string(),
  message: z.string(),
  fatal: z.boolean(),
  /** Optional coarse classification for account/provider availability. Used for passive status UI;
   *  the raw message stays intact for the transcript/log. */
  providerStatus: z.enum(['down']).optional(),
  /** A turn-level API failure the CLI surfaced as assistant text (a 5xx/429/auth error), lifted out of
   *  the transcript into the composer error banner. Non-fatal (the process lives; the turn just failed),
   *  so this flag — not `fatal` — is what tells the UI to show the retryable banner. */
  category: z.enum(['apiError']).optional(),
})

/** Provider-outage pill state (main→renderer push over `providerStatus`, seeded by `providerStatusGet`).
 *  Emitted only for feed-CONFIRMED outages that interrupted a turn; `down: false` clears the pill. */
export const ProviderStatusEventSchema = z.object({
  engine: z.string(),
  down: z.boolean(),
  /** Human-readable incident line for the tooltip (e.g. the status page's incident name). */
  note: z.string().optional(),
})
export type ProviderStatusEvent = z.infer<typeof ProviderStatusEventSchema>

// ── Subagents (the deferred 5th turn-item, now modeled) ──────────────────────
//
// The engine fans work out to subagents via the Agent (legacy "Task") tool. Its
// whole lifecycle streams to the parent process, keyed by ONE id: the Agent
// launch tool_use id (`toolUseId` here) == the engine's `task.tool_use_id` ==
// inner events' `parent_tool_use_id`. We model a card driven by that lifecycle,
// with the subagent's own prose + tool calls routed under it (parentToolUseId).
// Rolling token/duration counters captured for the card. See spike/subagent.

export const SubagentUsageSchema = z.object({
  totalTokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
})
export type SubagentUsage = z.infer<typeof SubagentUsageSchema>

/** A subagent launched — opens the card. From the Agent tool_use (or system/task_started). */
export const SubagentStartedSchema = z.object({
  type: z.literal('SubagentStarted'),
  sessionId: z.string(),
  toolUseId: z.string(),
  subagentType: z.string(),
  description: z.string(),
  prompt: z.string().optional(),
})

/** Live status while the subagent works — from system/task_progress + task_notification. */
export const SubagentProgressSchema = z.object({
  type: z.literal('SubagentProgress'),
  sessionId: z.string(),
  toolUseId: z.string(),
  /** Engine status string, e.g. 'completed' (task_notification). */
  status: z.string().optional(),
  /** Live one-liner, e.g. "Writing sub.txt". */
  description: z.string().optional(),
  lastToolName: z.string().optional(),
  usage: SubagentUsageSchema.optional(),
})

/** The subagent finished — its final output (the Agent tool_result text, cleaned). */
export const SubagentCompletedSchema = z.object({
  type: z.literal('SubagentCompleted'),
  sessionId: z.string(),
  toolUseId: z.string(),
  resultText: z.string().optional(),
  /** The Agent tool_result's error flag — a failed subagent must not read as success. */
  isError: z.boolean().optional(),
  usage: SubagentUsageSchema.optional(),
})

// ── Workflows (background multi-agent orchestration) ─────────────────────────
//
// The Workflow tool launches in the BACKGROUND and returns immediately with a Run ID
// + an on-disk run dir (spike/capture) — its result NEVER streams back into `-p`, so a
// plain transport dead-ends the user ("launched… Task ID …" then nothing; /workflows
// monitoring is TUI-only). Instead the workflow writes per-agent progress to
// `<dir>/journal.jsonl` (`{type:'started'|'result', agentId, result?}`). Koda's main
// process WATCHES that journal and surfaces a live card, routing completion into the
// cross-session notification system. `dir` is main-internal (drives the watcher); the
// renderer renders from runId + name.

export const WorkflowStartedSchema = z.object({
  type: z.literal('WorkflowStarted'),
  sessionId: z.string(),
  runId: z.string(),
  /** Human label, from the Workflow tool_result "Summary:" line. */
  name: z.string(),
  /** Absolute run dir holding journal.jsonl — used by main's watcher, ignored by the renderer. */
  dir: z.string().optional(),
})

/** A workflow agent started or finished — parsed from the run dir's journal.jsonl. */
export const WorkflowAgentSchema = z.object({
  type: z.literal('WorkflowAgent'),
  sessionId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  status: z.enum(['running', 'done']),
  /** The agent's returned value (on 'done'); may be long, so trimmed by the watcher. */
  result: z.string().optional(),
})

/** The workflow went quiet after producing results — surfaced as complete + a notification. */
export const WorkflowCompletedSchema = z.object({
  type: z.literal('WorkflowCompleted'),
  sessionId: z.string(),
  runId: z.string(),
  agentCount: z.number(),
})

// ── Account rate-limit windows (the 5-hour + weekly subscription caps) ───────
//
// DISTINCT from context-window usage (ContextUsage, per-conversation token budget).
// These are the ACCOUNT-level subscription windows — the same ones the TUI's /usage
// shows. The engine emits a `rate_limit_event` on every turn carrying the currently
// binding window (verified vs the real CLI 2.1.187): its type, reset time, and a
// coarse status band. Note: the stream does NOT carry a precise "% used" — only the
// reset timestamp + status. All fields are pass-through DISPLAY ONLY (no Koda
// subsystem branches on `rateLimitType`, honoring the no-model-names spirit).
export const RateLimitInfoSchema = z.object({
  /** 'five_hour' | 'weekly' (engine vocabulary; rendered to a human label, never branched on). */
  rateLimitType: z.string(),
  /** Unix seconds when this window resets. */
  resetsAt: z.number(),
  /** Coarse band → the dot color: 'allowed' (green) | 'warning' (amber) | 'rejected' (red). */
  status: z.string(),
  /** True when the account is currently spending overage past the window. */
  isUsingOverage: z.boolean().optional(),
  /** Real % of the window consumed (0–100) WHEN the engine reports it — Codex/OpenAI's app-server gives
   *  an exact `usedPercent`; the Claude stream does NOT (band + reset only). Display-only, a measured
   *  fill not an estimate. Absent ⇒ render band-only (no bar). */
  usedPercent: z.number().optional(),
})
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>

/** Session usage as one snapshot — context fill + spend from the persisted session, account windows
 *  from the live stream. Rides the remote transcript reply so a phone joining a session seeds its
 *  meters immediately instead of showing nothing until the next turn reports them. Same shape the
 *  phone accumulates live from the event stream (its SessionUsage). */
export type RemoteUsageSnapshot = {
  spendUsd: number
  byModel: Record<string, ModelSpend>
  context?: ContextUsage
  /** Keyed by rateLimitType ('five_hour'/'weekly'), newest wins — account-level, same as the desktop. */
  rateLimits: Record<string, RateLimitInfo>
}

/** A rate-limit window update (account-level, not per-session) — surfaced in the status bar.
 *  Carries `sessionId` per the envelope rule, but the renderer keys the global map by rateLimitType
 *  (newest wins across all sessions) since the windows are an account fact, not a session fact. */
export const RateLimitUpdateSchema = z.object({
  type: z.literal('RateLimitUpdate'),
  sessionId: z.string(),
  info: RateLimitInfoSchema,
})

// Per-session approval posture. ask/acceptEdits/auto are implemented in OUR gate (the engine stays in
// default permission mode so every tool reaches the prompt-tool to be checkpointed, then the gate
// decides). `plan` is the exception: it's the engine's real --permission-mode plan (read-only until
// ExitPlanMode), so switching into or out of it requires a respawn (the engine can't change
// --permission-mode live on a -p process). Approving the plan auto-flips the session to the chosen
// build tier (Auto or Check first) — the engine self-exits plan there.
// USER-FACING: only three are pickable — Auto, Plan first, Check first. The edits-vs-commands split is
// engineer granularity that doesn't match a vibecoder's mental model (and safety-git + the
// destructive-git tripwire cover the real risk in every mode), so `acceptEdits` is no longer offered.
//   ask         — "Check first": prompt before every edit + command
//   acceptEdits — auto-approve edits, still ask before commands. NOT user-pickable; kept for the gate
//                 + legacy sessions persisted in it (post-plan "Approve & build" now lands in `auto`)
//   plan        — "Plan first": read-only; agent researches + presents a plan via ExitPlanMode first
//   auto        — "Auto": auto-approve everything (≈ bypassPermissions)
// The destructive-git tripwire (hard deny) and always-confirm tools (e.g. restore) apply in ALL modes.
export const ApprovalModeSchema = z.enum(['ask', 'acceptEdits', 'plan', 'auto'])
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>

/** A session's approval posture changed — broadcast so every surface showing the control follows the
 *  one that changed it (desktop pill ↔ phone sheet), instead of each hydrating once and drifting. */
export const ApprovalModeChangedSchema = z.object({
  type: z.literal('ApprovalModeChanged'),
  sessionId: z.string(),
  mode: ApprovalModeSchema,
})

/** A session's model/effort intent changed — same broadcast contract as ApprovalModeChanged, so the
 *  desktop pill and the phone sheet follow whichever surface changed it. Carries the FULL current pair
 *  (undefined model ⇒ engine default); engineId rides along only when the change switched engines. */
export const ModelEffortChangedSchema = z.object({
  type: z.literal('ModelEffortChanged'),
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  engineId: EngineIdSchema.optional(),
})

export const EngineEventSchema = z.discriminatedUnion('type', [
  SessionStartedSchema,
  AssistantDeltaSchema,
  ThinkingDeltaSchema,
  AssistantBlockSchema,
  ToolRequestedSchema,
  ToolResultSchema,
  TurnCompleteSchema,
  EngineErrorSchema,
  SubagentStartedSchema,
  SubagentProgressSchema,
  SubagentCompletedSchema,
  WorkflowStartedSchema,
  WorkflowAgentSchema,
  WorkflowCompletedSchema,
  RateLimitUpdateSchema,
  ApprovalModeChangedSchema,
  ModelEffortChangedSchema,
])
export type EngineEvent = z.infer<typeof EngineEventSchema>

/** The user's own turn text, captured for the replay log. The engine event stream never carries the
 *  human's prompts (each renderer adds them optimistically when it sends) — so a phone session's
 *  buffered history would be missing the user's side. The manager records one of these per remote turn,
 *  interleaved with the engine events, so the adopted transcript shows both halves of the conversation. */
export const RemoteUserTurnSchema = z.object({
  type: z.literal('RemoteUserTurn'),
  sessionId: z.string(),
  text: z.string(),
})
export type RemoteUserTurn = z.infer<typeof RemoteUserTurnSchema>

/** One item in a headless session's replay log — either a normalized engine event or a captured user
 *  turn. Replayed in order to rebuild the transcript. */
export const ReplayEntrySchema = z.union([EngineEventSchema, RemoteUserTurnSchema])
export type ReplayEntry = z.infer<typeof ReplayEntrySchema>

/** A live headless (phone-started, windowless) session the desktop is adopting: its identity plus the
 *  full replay log (engine events + user turns) to feed through the reducer so the transcript
 *  materializes like a local session's. `model` is the user's chosen model (undefined ⇒ engine
 *  default); the label is derived in the renderer from the replayed content. See
 *  EngineSessionManager.adoptHeadlessForWindow. */
export const AdoptedHeadlessSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  engineId: EngineIdSchema,
  model: z.string().optional(),
  events: z.array(ReplayEntrySchema),
})
export type AdoptedHeadlessSession = z.infer<typeof AdoptedHeadlessSessionSchema>
export const AdoptedHeadlessListSchema = z.array(AdoptedHeadlessSessionSchema)

/** Push payload telling a window that a phone just started/resumed a session in the project it has open
 *  (so it should adopt this project's headless sessions). Carries the project only as a sanity tag. */
export const HeadlessAppearedSchema = z.object({ projectPath: z.string() })
export type HeadlessAppeared = z.infer<typeof HeadlessAppearedSchema>

/** Push payload asking a window to archive one of its project's past sessions (a phone swipe) — the
 *  renderer owns the session store while the window is open, so it performs the move + persists. */
export const ArchiveRequestedSchema = z.object({ sessionId: z.string() })
export type ArchiveRequested = z.infer<typeof ArchiveRequestedSchema>

/** Push payload asking a window to rename one of its live sessions (a phone rename) — same
 *  renderer-owns-the-store rule as ArchiveRequested. */
export const RenameRequestedSchema = z.object({ sessionId: z.string(), name: z.string() })
export type RenameRequested = z.infer<typeof RenameRequestedSchema>

/** Push payload carrying a phone turn's user text into the window that ALREADY owns the session — sent
 *  live when a window adopted the session before this turn (it was open on the project when the phone
 *  started it, so it adopted empty). The engine stream never echoes the human's prompt, so without this
 *  the Mac transcript misses the user bubble and the tab keeps its "From your phone" default. `text` is
 *  the raw prompt ('' for an image-only turn); the renderer derives the bubble and titles from it. */
export const RemoteUserTurnLiveSchema = z.object({ sessionId: z.string(), text: z.string() })
export type RemoteUserTurnLive = z.infer<typeof RemoteUserTurnLiveSchema>

// ── Engine adapter: renderer→main commands ───────────────────────────────────

export const StartSessionRequestSchema = z.object({
  /** Project working directory; defaults to the engine's launch cwd if omitted. */
  cwd: z.string().optional(),
  /** Reattach a persisted session by id (spawns `claude --resume <id>`) instead of starting fresh.
   *  Must pair with the same `cwd` the session was created in (resume is cwd-scoped; spike/resume). */
  resumeSessionId: z.string().optional(),
  /** Spawn a FRESH session with this exact id (`claude --session-id <id>`, no --resume). Used when a
   *  session's engine was dropped before its first turn (e.g. a Plan-mode switch) — there's no prior
   *  conversation to resume, so respawn clean under the same id. Mutually exclusive with resumeSessionId. */
  sessionId: z.string().optional(),
  /** Start in plan mode (--permission-mode plan): the agent researches read-only and presents a
   *  plan via ExitPlanMode before it's allowed to build. Approving the plan transitions the same
   *  session out of plan mode (spike/capture). Honored only with the broker wired. */
  planMode: z.boolean().optional(),
  /** The model to run (`--model <X>`) — an engine alias (`opus`/`sonnet`/`haiku`) OR any full id the
   *  user typed (e.g. an older `claude-…` to fall back to when the latest misbehaves). Omitted ⇒ the
   *  engine's own default for the plan. Pass-through ONLY — no Koda subsystem branches on the value
   *  (honors the no-model-names rule); the engine validates it and falls back if it's retired. The
   *  engine can't change model live on a -p process, so switching reattaches (--resume --model). */
  model: z.string().optional(),
  /** Reasoning effort for the session (`--effort <low|medium|high|xhigh|max>`); absent ⇒ engine
   *  default (adaptive). The exact terms the engine's `--effort` flag accepts — pass-through only,
   *  never inspected. Like --model it's spawn-time, so changing it reattaches the session. */
  effort: z.string().optional(),
  /** Which engine drives this session (`claude` | `codex`); absent ⇒ 'claude'. Selects the driver +
   *  the env/binary profile. Immutable once the conversation starts — switching engine respawns a
   *  fresh session (the UI only allows it before the first turn). */
  engineId: EngineIdSchema.optional(),
  /** The engine's own native session/thread id to resume (Codex thread id, from a prior
   *  `SessionStarted.engineNativeId`). Only meaningful with `resumeSessionId` + `engineId:'codex'` —
   *  lets the Codex driver resume THAT thread by id (context preserved) instead of starting fresh. */
  engineNativeId: z.string().optional(),
}).refine((a) => !(a.resumeSessionId && a.sessionId), {
  message: 'resumeSessionId (--resume) and sessionId (--session-id) are mutually exclusive',
  path: ['sessionId'],
})
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>

/** cwd is echoed back so the renderer can persist it and pass it on a later resume. */
export const StartSessionResponseSchema = z.object({ sessionId: z.string(), cwd: z.string() })
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>

/** An inline image attached to a turn — base64 + its media type. The engine accepts these as
 *  Anthropic image content blocks over stream-json input (verified spike/capture). Lets a
 *  non-coder paste/drag a screenshot or mockup, which a text-only composer couldn't carry. */
export const ImageAttachmentSchema = z.object({
  mediaType: z.string(), // image/png | image/jpeg | image/gif | image/webp
  dataBase64: z.string(),
})
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>

export const SendTurnRequestSchema = z
  .object({
    sessionId: z.string(),
    text: z.string(), // may be empty when images are attached
    images: z.array(ImageAttachmentSchema).optional(),
  })
  // A turn must carry SOMETHING — text or at least one image.
  .refine((r) => r.text.trim().length > 0 || (r.images?.length ?? 0) > 0, {
    message: 'a turn needs text or an image',
  })
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>

/** Shared shape for the session-targeted commands that take no other args. */
export const SessionRefSchema = z.object({ sessionId: z.string() })
export type SessionRef = z.infer<typeof SessionRefSchema>

// ── Side questions ("btw" / aside) ───────────────────────────────────────────
//
// A quick question answered from the live conversation's context WITHOUT entering it — the renderer
// mints an `asideId` to correlate the streamed answer (sessionId alone isn't enough; a session could
// in principle have asked more than one over its life).
export const AskAsideRequestSchema = z.object({
  sessionId: z.string(),
  asideId: z.string(),
  question: z.string().min(1),
})
export type AskAsideRequest = z.infer<typeof AskAsideRequestSchema>

export const CancelAsideRequestSchema = z.object({ sessionId: z.string(), asideId: z.string() })
export type CancelAsideRequest = z.infer<typeof CancelAsideRequestSchema>

/** Streamed answer to a side question (main→renderer): `delta` chunks accumulate; `done` carries the
 *  full text; `error` carries a human message. `text` is empty only on a contentless `done`. */
export const AsideEventSchema = z.object({
  sessionId: z.string(),
  asideId: z.string(),
  kind: z.enum(['delta', 'done', 'error']),
  text: z.string(),
})
export type AsideEvent = z.infer<typeof AsideEventSchema>

// ── Safety-git: the recovery surface ─────────────────────────────────────────
//
// The deterministic undo stack (dual-git.md §2) surfaced in human terms: a
// timeline the user reads, and a restore that rewinds the working tree. Recovery
// is keyed by sessionId — main resolves the project dir, never trusting a path
// from the renderer.

export const CheckpointSchema = z.object({
  id: z.string(),
  /** Human-terms label, from the user's turn prompt. */
  label: z.string(),
  /** Unix seconds. */
  createdAt: z.number(),
  /** True once the on-device model has rewritten `label` into a final, standalone phrase — the
   *  renderer then shows it verbatim instead of wrapping the raw `Before "…"` placeholder. */
  humanized: z.boolean().optional(),
  /** 'moment' = a turn/edit/recovery point the user navigates by; 'step' = a per-tool safety
   *  snapshot, hidden from the timeline (kept for fine restore). See safety-git/checkpoint.ts. */
  kind: z.enum(['moment', 'step']).optional(),
})
export type Checkpoint = z.infer<typeof CheckpointSchema>

/** safety:list response — the timeline, newest first. Project-scoped (root from the window). */
export const CheckpointListSchema = z.array(CheckpointSchema)

/** A checkpoint id is always a git SHA — pin the shape so it can't be smuggled in as a git flag
 *  (`--output=…`) when placed positionally in a diff/show/checkout (defense-in-depth at the boundary). */
const CheckpointIdSchema = z.string().regex(/^[0-9a-f]{7,40}$/)

export const SafetyRestoreRequestSchema = z.object({ checkpointId: CheckpointIdSchema })
export type SafetyRestoreRequest = z.infer<typeof SafetyRestoreRequestSchema>

/** safety:changes — what going back to a checkpoint would undo (checkpoint → current working tree). */
export const SafetyChangesRequestSchema = z.object({ checkpointId: CheckpointIdSchema })
export type SafetyChangesRequest = z.infer<typeof SafetyChangesRequestSchema>

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
})
export type ChangedFile = z.infer<typeof ChangedFileSchema>

export const SafetyChangesResultSchema = z.object({
  files: z.array(ChangedFileSchema),
  truncated: z.boolean(),
})
export type SafetyChangesResult = z.infer<typeof SafetyChangesResultSchema>

/** safety:fileDiff — one changed file's content at the checkpoint vs now (drives the recovery diff). */
export const SafetyFileDiffRequestSchema = z.object({
  checkpointId: CheckpointIdSchema,
  path: z.string(),
})
export type SafetyFileDiffRequest = z.infer<typeof SafetyFileDiffRequestSchema>

export const SafetyFileDiffResultSchema = z.object({
  before: z.string(),
  after: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
})
export type SafetyFileDiffResult = z.infer<typeof SafetyFileDiffResultSchema>

// ── Dogfood logging: renderer → main ─────────────────────────────────────────
//
// Renderer-side warnings/errors and uncaught failures, forwarded so a run leaves
// ONE readable trail in the main log file. warn/error only (never console.log) —
// args are pre-serialized to strings in the renderer to keep the payload trivial
// and the boundary unsurprising.

export const RendererLogSchema = z.object({
  level: z.enum(['warn', 'error']),
  args: z.array(z.string()),
})
export type RendererLog = z.infer<typeof RendererLogSchema>

/** app:setAttentionCount — how many sessions need the user (drives the macOS dock badge). */
export const AttentionCountSchema = z.object({ count: z.number().int().min(0) })
export type AttentionCount = z.infer<typeof AttentionCountSchema>

// ── Local-assist: on-device QoL micro-tasks ──────────────────────────────────
//
// assist:title — turn a first prompt into a clean session title via the on-device model, or a
// deterministic first-words fallback. Always resolves to a usable string (main never throws here).

export const AssistTitleRequestSchema = z.object({ text: z.string() })
export type AssistTitleRequest = z.infer<typeof AssistTitleRequestSchema>

export const AssistTitleResponseSchema = z.object({ title: z.string() })
export type AssistTitleResponse = z.infer<typeof AssistTitleResponseSchema>

// ── Approval gate: the permission broker's decision surface ───────────────────
//
// The broker (src/main/broker) mediates every tool call. In the default
// Auto-approve mode main answers immediately; in "Ask me" mode it pushes an
// ApprovalRequest to the renderer and WAITS (no timeout) for the user's decision.
// ToolDecision is engine-neutral (engine-adapter-and-output-view.md §2): `allow`
// and `allow-with-edit` are distinct kinds so consumers never probe for an
// optional input field. The renderer only ever produces allow/deny in v0;
// allow-with-edit exists for the gate (and a future inline-edit UI).

export const ToolDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }),
  z.object({ kind: z.literal('allow-with-edit'), input: z.unknown() }),
  z.object({ kind: z.literal('deny'), reason: z.string().optional() }),
])
export type ToolDecision = z.infer<typeof ToolDecisionSchema>

/** main→renderer: a tool is waiting on the user (Ask-me mode). requestId = the engine's tool_use_id. */
export const ApprovalRequestSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

/** main→renderer: every pending approval for a session is void (its engine ended). Clear the UI. */
export const ApprovalCancelledSchema = z.object({ sessionId: z.string() })
export type ApprovalCancelled = z.infer<typeof ApprovalCancelledSchema>

/** main→renderer: one specific request was answered (possibly on another head) — clear just that
 *  prompt so a stale "Needs your approval" doesn't latch on heads that didn't answer it. */
export const ApprovalResolvedSchema = z.object({ sessionId: z.string(), requestId: z.string() })
export type ApprovalResolved = z.infer<typeof ApprovalResolvedSchema>

/** renderer→main: the user's answer to a pending approval. */
export const ApprovalResolveSchema = z.object({
  requestId: z.string(),
  decision: ToolDecisionSchema,
})
export type ApprovalResolve = z.infer<typeof ApprovalResolveSchema>

// Per-session: the renderer owns each session's posture and pushes it to the gate (on start,
// reattach, and user change). `getApprovalMode` returns the default posture new sessions start at.
export const SetApprovalModeSchema = z.object({ sessionId: z.string(), mode: ApprovalModeSchema })
export type SetApprovalMode = z.infer<typeof SetApprovalModeSchema>

// Per-session model/effort intent, pushed at pick time (not just on the next reattach) so main's map
// stays current for remote heads and a real change broadcasts ModelEffortChanged to every surface.
// Always the FULL pair — a partial would make the other field reset to default on the next respawn.
export const SetModelEffortSchema = z.object({
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  engineId: EngineIdSchema.optional(),
})
export type SetModelEffort = z.infer<typeof SetModelEffortSchema>

// ── Recently-used models ──────────────────────────────────────────────────────
//
// Koda can't enumerate the models available to the user (no engine/API surface for it), and must
// never ship a hardcoded version list (it rots + asserts which models exist). Instead the model
// picker offers the engine's stable ALIASES plus the full ids the user has actually typed — so an
// older model they fall back to (e.g. when the latest regresses) becomes a one-click quick-pick next
// time, a list built from real usage rather than one Koda maintains. Stored app-global in settings.
export const AddRecentModelSchema = z.object({ model: z.string() })
export type AddRecentModel = z.infer<typeof AddRecentModelSchema>

// ── App preferences (the Settings pane) ───────────────────────────────────────
//
// The user-facing app preferences the Settings pane edits. DISTINCT from per-session state (approval
// posture, model — saved in the session blob) and from recentModels (usage tracking, not a chosen
// preference). Theme is renderer-only (localStorage), so it isn't here. Persisted in main's
// koda-settings.json. Curated, not exhaustive — keys are added as real settings land, never a knob
// farm (curate-not-configure). `settings:set` takes a PARTIAL and returns the full, re-clamped object.
/** How aggressively the renderer downscales an image before sending it to the engine. Image token
 *  cost scales with pixel area, so the cap on the *longest edge* is the real lever (re-encoding to a
 *  smaller file at the same dimensions does NOT change the token count). 'high' ≈ the most detail
 *  current models keep (≈2576px long edge); 'balanced' matches the standard-model resize target;
 *  'max' trades fine detail for the biggest saving. */
export const ImageDetailSchema = z.enum(['high', 'balanced', 'max'])
export type ImageDetail = z.infer<typeof ImageDetailSchema>

/** Longest-edge pixel cap per detail level. The renderer never upscales — an image already under its
 *  cap keeps its dimensions (and is still re-encoded to WebP to shrink the payload). */
export const IMAGE_DETAIL_CAPS: Record<ImageDetail, number> = {
  high: 2576,
  balanced: 1568,
  max: 1024,
}

/** The on-screen rectangle (CSS px, viewport-relative) of the preview iframe, reported by the renderer
 *  so main can `capturePage` exactly that region for the agent's `view_preview` capability
 *  (preview-surface.md, Rung 3 — the agent sees the rendered preview). */
export const PreviewRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
})
export type PreviewRect = z.infer<typeof PreviewRectSchema>

/** How to re-run a session's last preview (the "Restart preview" button). A `dev` preview replays the
 *  agent's dev-server command; a `static` preview re-shows a project `.html` file (its `koda-preview://`
 *  URL is rebuilt from the window's current token, so it survives a restart even though the token rotated).
 *  Remembered per session and persisted, so a preview is one click to bring back after it's torn down. */
export const PreviewRestartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dev'), command: z.string().min(1), cwd: z.string().optional() }),
  z.object({ kind: z.literal('static'), relPath: z.string().min(1) }),
])
export type PreviewRestart = z.infer<typeof PreviewRestartSchema>

/** The `preview:restart` invoke payload — the session to bring the preview back for + how to do it. */
export const PreviewRestartRequestSchema = z.object({
  sessionId: z.string().min(1),
  restart: PreviewRestartSchema,
})

/** The optional Playwright capability's install lifecycle (playwright/manager.ts). Distinct from the
 *  `playwrightEnabled` SETTING (user intent): a user can have it enabled while the download is still
 *  `installing`, or `error` after a failed download. The agent is wired only at `ready` + enabled. */
export const PlaywrightStateSchema = z.enum(['not-installed', 'installing', 'ready', 'error'])
export type PlaywrightState = z.infer<typeof PlaywrightStateSchema>

/** Push/return payload for the Settings UI: where the install stands + the user's toggle + an
 *  optional progress/status line. */
export const PlaywrightStatusSchema = z.object({
  state: PlaywrightStateSchema,
  enabled: z.boolean(),
  message: z.string().optional(),
})
export type PlaywrightStatus = z.infer<typeof PlaywrightStatusSchema>

/** Which credential the engine bills against (Settings → Account). Declared here because
 *  KodaSettingsSchema references it; the verdict-dependent billing schemas live near AuthVerdict.
 *  - `subscription`: always the Pro/Max plan; stop at the limit.
 *  - `auto`: subscription normally, fall back to the API key when the plan limit is hit (after a
 *    one-time confirm) until that window resets, then back to subscription.
 *  - `api`: always the API key. */
export const BillingModeSchema = z.enum(['subscription', 'auto', 'api'])
export type BillingMode = z.infer<typeof BillingModeSchema>

/** Codex's billing credential (Settings → OpenAI). Simpler than Claude's 3-way: v1 has no plan-limit
 *  auto-fallback for Codex, so it's a straight choice — `subscription` (the ChatGPT login) or `api` (a
 *  BYO OpenAI key). Unlike the env-key Claude uses, the key is WRITTEN into Codex's isolated home via
 *  `codex login --with-api-key`; switching back restores the ChatGPT login (see reconcileCodexAuth). */
export const CodexBillingModeSchema = z.enum(['subscription', 'api'])
export type CodexBillingMode = z.infer<typeof CodexBillingModeSchema>

export const KodaSettingsSchema = z.object({
  /** The posture new sessions start at. `plan` is per-session only (spawn-time --permission-mode), so
   *  it's never a valid default — main clamps it to 'auto' on both read and write. */
  defaultApprovalMode: ApprovalModeSchema,
  /** On-device assist (Apple Foundation Models): clean session titles + humanized recovery labels.
   *  Default-on; the engine falls back to a deterministic floor when off or unavailable. */
  assistEnabled: z.boolean(),
  /** Native notification when a BACKGROUNDED session finishes / errors / needs approval. Default-on;
   *  still requires OS notification permission. The in-app tab ring + dock badge are unaffected. */
  notificationsEnabled: z.boolean(),
  /** Ping (macOS banner + phone push) once when a MAXED 5-hour usage window resets — never on windows you
   *  didn't cap out. Default-on; read live by the main-process notifier so a change applies immediately. */
  usageResetNotify: z.boolean(),
  /** Ping (macOS banner + phone push) once when a provider outage that interrupted a turn is over —
   *  the "Claude is back up" doorbell. Only feed-confirmed outages ever watch; nothing runs otherwise.
   *  Default-on; read live by the main-process watcher so a change applies immediately. */
  providerStatusNotify: z.boolean(),
  /** Whether the agent may start the live-preview dev server without a confirm (preview-surface.md).
   *  Default-on; off forces a human confirm before the spawn (a long-lived process is weightier). */
  previewAutoStart: z.boolean(),
  /** How much pasted/dropped images are shrunk before they're sent to the agent. Image *token* cost is
   *  set by resolution (not file size), so the renderer downscales the longest edge to this cap before
   *  re-encoding to WebP — a real token saving on big screenshots, and it keeps the payload under the
   *  API's per-image limit. Default 'balanced'. See IMAGE_DETAIL_CAPS for the pixel caps. */
  imageDetail: ImageDetailSchema,
  /** How many days a saved scratch image (the on-disk copy of a pasted/dropped image, in
   *  `.koda/scratch/`) is kept before it's pruned. `0` means keep forever. Default 7. */
  scratchRetentionDays: z.number(),
  /** Optional Playwright browser-testing capability — lets the agent drive a real browser to confirm
   *  web work *works* (not just renders). Default-OFF: turning it on downloads ~150 MB of Chromium
   *  into a shared dir (once, reused by every project). The agent only gets browser tools when this is
   *  on AND the download completed. Install *state* is runtime (playwright:status), not persisted here. */
  playwrightEnabled: z.boolean(),
  /** Whether the user has completed the first-run onboarding wizard (architecture/onboarding.md).
   *  App-global, once per install: App.tsx shows the wizard while this is false, then sets it true. */
  hasOnboarded: z.boolean(),
  /** Which credential the engine bills against. `subscription` (default) = the user's Pro/Max plan via
   *  the shared ~/.claude login; `api` = an opt-in BYO API key (stored encrypted, NOT here — see
   *  api-key.ts) injected at spawn through buildEngineEnv. Switching is user-visible (Settings → Account)
   *  and never silent — the two differ in the one thing the user cares about: plan window vs real $. */
  billingMode: BillingModeSchema,
  /** Codex's billing credential — `subscription` (ChatGPT login, default) or `api` (BYO OpenAI key,
   *  stored encrypted per-engine in api-key.ts). Separate from `billingMode` (Anthropic) because each
   *  engine is a distinct provider account; switching is user-visible (Settings → OpenAI). */
  codexBillingMode: CodexBillingModeSchema,
  /** Remote Control (remote-control-security.md, Phase 0): whether the LAN server that lets a phone
   *  drive the live agent is running. Default-OFF and meant to be turned on only on a trusted network
   *  for dogfooding — it opens a LAN port, the opposite of the shipped "no inbound port" design, which
   *  Phase 1 replaces with outbound polling. Persisted so an enabled server auto-starts on boot. */
  remoteEnabled: z.boolean(),
  /** Anonymous usage events (telemetry.ts). Default-ON with presented consent: sends are also gated on
   *  hasOnboarded, so nothing flows until the user has seen the toggle on the onboarding safety step;
   *  off means zero pings. On sends fixed event names with typed props tied to a random install id,
   *  never content (no file paths, prompts, code, or project names — enforced by the event map's
   *  types, not by scrubbing). The site's /privacy Analytics section describes exactly this; change
   *  them together. */
  telemetryEnabled: z.boolean(),
  /** Persisted workspace pane sizes — the resizable dividers (everything but the fixed rail). Widths
   *  in px; fracs are 0–1 shares. Global (not per-project): pane sizes are a layout preference. Main
   *  clamps on read, so a hand-edited file can't produce an unusable layout. */
  layout: z.object({
    sidebarWidth: z.number(),
    sessionsFrac: z.number(),
    conversationWidth: z.number(),
    artifactSplitFrac: z.number(),
  }),
})
export type KodaSettings = z.infer<typeof KodaSettingsSchema>
export type WorkspaceLayoutSizes = KodaSettings['layout']

// ── Remote Control (remote-control-security.md, Phase 0) ─────────────────────
/** A device that completed pairing (for the Settings device list). Opaque id only — the bearer token
 *  stays in the main process and is never sent to the renderer. */
export const RemoteDeviceSchema = z.object({
  id: z.string(),
  label: z.string(),
  pairedAt: z.number(),
})
export type RemoteDevice = z.infer<typeof RemoteDeviceSchema>

/** Settings → Remote state: whether the LAN server runs, the URL + pairing code to enter on the phone,
 *  paired devices, and the live connected-client count (drives the "remote active" indicator). */
export const RemoteStateSchema = z.object({
  running: z.boolean(),
  url: z.string().nullable(),
  code: z.string().nullable(),
  devices: z.array(RemoteDeviceSchema),
  connectedClients: z.number(),
  /** False only in the open-source build, where the phone-control stack is absent — the UI hides the
   *  Remote surfaces instead of showing controls that can never work. Absent = available. */
  available: z.boolean().optional(),
})
export type RemoteState = z.infer<typeof RemoteStateSchema>

export const RemoteSetEnabledSchema = z.object({ enabled: z.boolean() })
export type RemoteSetEnabled = z.infer<typeof RemoteSetEnabledSchema>

export const RemoteRevokeSchema = z.object({ id: z.string() })
export type RemoteRevoke = z.infer<typeof RemoteRevokeSchema>

/** Cloud relay account state (Phase 1b) — whether the Mac is signed into the Supabase account the
 *  phone pairs against. Never carries a token. */
export const RemoteAuthStateSchema = z.object({
  signedIn: z.boolean(),
  email: z.string().nullable(),
  userId: z.string().nullable(),
})
export type RemoteAuthState = z.infer<typeof RemoteAuthStateSchema>

export const RemoteRequestOtpSchema = z.object({ email: z.string().email() })
export type RemoteRequestOtp = z.infer<typeof RemoteRequestOtpSchema>
export const RemoteVerifyOtpSchema = z.object({ email: z.string().email(), code: z.string().min(4).max(12) })
export type RemoteVerifyOtp = z.infer<typeof RemoteVerifyOtpSchema>

/** OTP request/verify outcome — `ok` plus a human error on failure and the fresh state on success. */
export const RemoteOtpResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  state: RemoteAuthStateSchema.optional(),
})
export type RemoteOtpResult = z.infer<typeof RemoteOtpResultSchema>

/** Cloud relay state — whether the account is signed in, the outbound channel is connected, and a phone
 *  is currently paired (a shared key is established). */
export const RemoteRelayStateSchema = z.object({
  signedIn: z.boolean(),
  running: z.boolean(),
  paired: z.boolean(),
})
export type RemoteRelayState = z.infer<typeof RemoteRelayStateSchema>

/** Pairing handshake material for the QR — a base64 blob the phone reads off-screen (out-of-band). */
export const RemoteRelayPairingSchema = z.object({ blob: z.string(), state: RemoteRelayStateSchema })
export type RemoteRelayPairing = z.infer<typeof RemoteRelayPairingSchema>

/** main→renderer push: the live remote-connection count changed (→ the "remote active" indicator). */
export const RemoteActivitySchema = z.object({ running: z.boolean(), connectedClients: z.number() })
export type RemoteActivity = z.infer<typeof RemoteActivitySchema>

/** Default pane sizes. `sidebarWidth` is the shared width of every left panel/nav (Sessions+Files,
 *  Source Control, Settings) — they read and resize one value so the panels stay a family. The single
 *  source of truth, shared by the renderer store and main's settings loader. */
export const DEFAULT_LAYOUT: WorkspaceLayoutSizes = {
  sidebarWidth: 320, // wider default now the ~56px activity rail is gone (changes-surface rework)
  sessionsFrac: 0.4,
  conversationWidth: 440,
  artifactSplitFrac: 0.5,
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** Floor for the left sidebar's px width — below this, session labels + the fuel gauge clip to
 *  garbage. The clamp enforces it on every setter; the sidebar also pins it as a CSS `min-width` so a
 *  stale persisted value (written before this floor existed) can't render sub-floor via inline width. */
export const SIDEBAR_MIN_WIDTH = 180

/** Clamp pane sizes to a usable range, falling back to the default for any non-finite value. Applied
 *  on every set (renderer) and on read (main) so neither a drag nor a hand-edited file can wedge the UI. */
export function clampLayout(p: Partial<WorkspaceLayoutSizes> | undefined): WorkspaceLayoutSizes {
  const v = { ...DEFAULT_LAYOUT, ...p }
  const fin = (n: number, d: number): number => (Number.isFinite(n) ? n : d)
  return {
    sidebarWidth: clamp(fin(v.sidebarWidth, DEFAULT_LAYOUT.sidebarWidth), SIDEBAR_MIN_WIDTH, 600),
    sessionsFrac: clamp(fin(v.sessionsFrac, DEFAULT_LAYOUT.sessionsFrac), 0.15, 0.85),
    // Despite the name this is the DOCK's width (SurfaceHost); the conversation is flex-1 and fills the
    // rest, so the dock's MAX is what floors how small the conversation can get. 1100 lets the
    // conversation shrink well under its old ~600 wall (e.g. to give Preview most of the room).
    conversationWidth: clamp(fin(v.conversationWidth, DEFAULT_LAYOUT.conversationWidth), 320, 1100),
    artifactSplitFrac: clamp(fin(v.artifactSplitFrac, DEFAULT_LAYOUT.artifactSplitFrac), 0.2, 0.8),
  }
}

/** A partial settings update — one or more fields. Must carry at least one (an empty patch is a bug). */
export const KodaSettingsPatchSchema = KodaSettingsSchema.partial().refine(
  (p) => Object.keys(p).length > 0,
  { message: 'settings patch must change at least one field' },
)
export type KodaSettingsPatch = z.infer<typeof KodaSettingsPatchSchema>

// ── Multi-session persistence ─────────────────────────────────────────────────
//
// Open sessions survive an app restart: the renderer's tab list + rendered transcript
// are saved to disk, and on the next turn the engine reattaches via `claude --resume`
// (spike/resume). The renderer OWNS the transcript shape — main stores `items` opaquely
// (z.unknown[]) and reads back only `{ id, cwd }` to repopulate recovery + resume dirs.

export const PersistedSessionSchema = z.object({
  id: z.string(),
  label: z.string(),
  cwd: z.string(),
  /** True once the user manually renamed the session — locks out the local-assist auto-title.
   *  Optional for backward-compat with blobs saved before this field existed. */
  userNamed: z.boolean().optional(),
  /** This session's approval posture (per-session, ui-workspace.md §7a). Optional for back-compat;
   *  absent ⇒ falls back to the default when restored. */
  approvalMode: ApprovalModeSchema.optional(),
  /** This session's chosen model (`--model` on reattach), or absent ⇒ engine default. Optional for
   *  back-compat. Display/pass-through only — never branched on (no-model-names rule). */
  model: z.string().optional(),
  /** This session's reasoning effort (`--effort` on reattach), or absent ⇒ engine default. Optional
   *  for back-compat. Pass-through only. */
  effort: z.string().optional(),
  /** Which engine drives this session (`claude` | `codex`). Absent ⇒ 'claude' (back-compat with blobs
   *  saved before multi-engine). Immutable once the conversation started, so it restores exactly. */
  engineId: EngineIdSchema.optional(),
  /** The engine's native thread id (Codex), so a restored session resumes THAT thread by id (context
   *  preserved). Absent for Claude / pre-multi-engine blobs. */
  engineNativeId: z.string().optional(),
  /** The renderer's rendered transcript (Entry[]); opaque to main. */
  items: z.array(z.unknown()),
  /** Last-known context-window usage, so the sidebar fuel gauge survives a restart instead of going
   *  blank until the session next runs a turn. Optional for backward-compat with older blobs. */
  context: ContextUsageSchema.optional(),
  /** Running estimated spend (USD) accumulated across this session's turns — the Usage view's number.
   *  Optional for backward-compat with blobs saved before spend tracking existed. */
  spendUsd: z.number().optional(),
  /** Per-model accumulated totals (cost + token split), keyed by the engine's model id — the Usage
   *  view's by-model breakdown. Optional for back-compat with blobs saved before this existed. */
  byModel: z.record(z.string(), ModelSpendSchema).optional(),
  /** How to restore the session's last preview after restart. Optional for back-compat with blobs
   *  saved before preview restart persistence existed. */
  lastPreview: PreviewRestartSchema.optional(),
})
export type PersistedSession = z.infer<typeof PersistedSessionSchema>

/** An archived (closed-but-kept) session — the same payload plus when it was archived. Archiving ends
 *  the live agent and removes the open tab, but keeps the whole conversation so it can be restored
 *  from Settings. Main stores `items` opaquely, same as live sessions. */
export const ArchivedSessionSchema = PersistedSessionSchema.extend({
  /** Epoch ms when archived — newest-first ordering + a "x ago" hint in the retrieval list. */
  archivedAt: z.number(),
})
export type ArchivedSession = z.infer<typeof ArchivedSessionSchema>

// version 2: per-project persistence (one project per window). The payload shape is unchanged from
// v1 (activeId + sessions) — the split is in main (a file per project, keyed by the window's root);
// main stamps the project path on disk, so it stays OUT of this renderer-facing payload. v1's single
// global blob is migrated on first boot (session-store.ts migrateV1IfPresent).
export const PersistedSessionsSchema = z.object({
  version: z.literal(2),
  /** The tab that was active at save time (restored on next launch). */
  activeId: z.string().nullable(),
  sessions: z.array(PersistedSessionSchema),
  /** Archived sessions, restorable from Settings. Optional for back-compat with blobs saved before
   *  archiving existed. */
  archived: z.array(ArchivedSessionSchema).optional(),
  /** Last-known account-level rate-limit windows, keyed by ENGINE then window type
   *  ('claude'/'codex' → 'five_hour'/'weekly') — each engine is a separate subscription with its own
   *  caps. So the footer survives a restart. Optional + `.catch` so a pre-per-engine FLAT blob
   *  (`{five_hour: …}`) degrades to "no windows" (they refresh on the next turn) rather than failing
   *  the whole session-blob parse and losing tabs. */
  rateLimits: z
    .record(z.string(), z.record(z.string(), RateLimitInfoSchema))
    .optional()
    .catch(undefined),
})
export type PersistedSessions = z.infer<typeof PersistedSessionsSchema>

// ── Project Files browser: read-only, path-contained filesystem access ────────
//
// Lets Koda stand alone (a Files browser so the user never needs VSCode beside it).
// EVERY access is contained to the project root in main (realpath-resolved, escapes
// rejected) and size-capped — the renderer can never read outside the project. Slice A
// roots at the launch cwd; one-project-per-window (Slice B) will resolve root per window.

export const FsEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir']),
})
export type FsEntry = z.infer<typeof FsEntrySchema>

/** fs:readDir — list a directory. `path` omitted ⇒ the project root. */
export const ReadDirRequestSchema = z.object({ path: z.string().optional() })
export type ReadDirRequest = z.infer<typeof ReadDirRequestSchema>

export const ReadDirResultSchema = z.object({
  /** The project root (anchors breadcrumbs; the boundary the renderer can't cross). */
  root: z.string(),
  /** The directory actually listed (absolute, realpath-resolved, within root). */
  path: z.string(),
  entries: z.array(FsEntrySchema),
})
export type ReadDirResult = z.infer<typeof ReadDirResultSchema>

/** fs:readFile — read a text file's contents (capped; binary refused). */
export const ReadFileRequestSchema = z.object({ path: z.string() })
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>

export const ReadFileResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  /** True when the file exceeded the size cap and `content` is the leading slice. */
  truncated: z.boolean(),
  /** True when the file looks binary (NUL byte) — `content` is empty, the view shows a notice. */
  binary: z.boolean(),
})
export type ReadFileResult = z.infer<typeof ReadFileResultSchema>

/** fs:writeFile — save the editor's contents back to a file. Main takes a safety-git checkpoint of
 *  the pre-edit tree FIRST (so the edit is recoverable, like an engine tool write), then writes. The
 *  file must already exist + be within the project root (you can only save a file you opened). */
export const WriteFileRequestSchema = z.object({
  path: z.string(),
  content: z.string(),
})
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>

export const WriteFileResultSchema = z.object({ path: z.string() })
export type WriteFileResult = z.infer<typeof WriteFileResultSchema>

/** fs:createFile — create a new empty document at the project root (name optional; deduped). The
 *  everyday-user "New document" entry point. Returns the created file's path so the renderer opens it. */
export const CreateFileRequestSchema = z.object({ name: z.string().optional() })
export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>

export const CreateFileResultSchema = z.object({ path: z.string() })
export type CreateFileResult = z.infer<typeof CreateFileResultSchema>

/** fs:listDocs — the flat "Documents" list behind the doc-first sidebar. Every prose doc under the
 *  project (recency-sorted, project-knowledge dirs excluded), so a non-engineer finds their writing
 *  by glancing instead of spelunking the tree. No args — main resolves the per-window root. */
export const ListDocsRequestSchema = z.object({})
export type ListDocsRequest = z.infer<typeof ListDocsRequestSchema>

export const ProjectDocSchema = z.object({
  /** Absolute, realpath-resolved path (the open/tab identity). */
  path: z.string(),
  /** Project-relative POSIX path — drives the location breadcrumb for docs outside the home folder. */
  rel: z.string(),
  /** The filename (extension stripped for display in the renderer). */
  name: z.string(),
  /** Last-modified epoch ms — the recency sort key. */
  mtimeMs: z.number(),
})
export type ProjectDoc = z.infer<typeof ProjectDocSchema>

export const ListDocsResultSchema = z.object({
  root: z.string(),
  docs: z.array(ProjectDocSchema),
})
export type ListDocsResult = z.infer<typeof ListDocsResultSchema>

/** guardrails:list — the behavior layer shaping the agent, for Settings → Guardrails. A Koda rule row
 *  is a *principle* — a human-scale grouping of several underlying pack rules (presentation only; the
 *  prompt is unchanged), toggled as one unit. `koda` scope = the curated bundled pack; `project` scope
 *  = this project's own CLAUDE.md (editable via path). */
export const GuardrailRuleSchema = z.object({
  scope: z.enum(['koda', 'project']),
  title: z.string(),
  /** A one-line plain-language description of the principle, shown under the title. Absent for the
   *  project's own CLAUDE.md row (which shows its raw text instead). */
  summary: z.string().optional(),
  /** The underlying guidance, revealed on demand: the member rules' text (Koda principle) or the raw
   *  CLAUDE.md (project rule). Read-only here — the prompt is never edited from this surface. */
  body: z.string(),
  /** Whether this principle is currently shaping the agent. A Koda principle is on unless every one of
   *  its member rules is disabled for this project; the project's own CLAUDE.md row is always on. */
  enabled: z.boolean(),
  /** `safety` when the principle bundles a rule that guards an irreversible/destructive action — it
   *  renders protected (a deliberate confirm to switch off). `preference` flexes freely. */
  kind: z.enum(['preference', 'safety']).optional(),
  /** `core` principles always apply; a `capability` principle (e.g. code) only matters when the work
   *  calls for it, and renders in its own recessed section. Absent for the project rule. */
  section: z.enum(['core', 'capability']).optional(),
  /** The handle guardrails:setEnabled flips to switch this principle off/on (it fans out to the member
   *  rules in main). Absent ⇒ not toggleable: the project's own CLAUDE.md, or a customized principle
   *  (which has Edit + Restore instead). */
  toggleKey: z.string().optional(),
  /** A Koda principle's id — drives Edit (fork the wording into this project via guardrails:setRuleOverride)
   *  and Restore. Absent for the project's own CLAUDE.md rule. */
  principleId: z.string().optional(),
  /** True when this Koda principle has been edited for this project: `body` is the user's text, there's
   *  no toggle, and Restore brings the bundled wording back. */
  customized: z.boolean().optional(),
  /** Absolute path to the source file — present only for the editable `project` rule (its CLAUDE.md),
   *  so the Settings surface can text-tweak it in place. Absent ⇒ a bundled Koda principle. */
  path: z.string().optional(),
})
export const GuardrailItemSchema = z.object({
  scope: z.enum(['koda', 'project']),
  name: z.string(),
  description: z.string(),
  /** The full file content (frontmatter + body), edited inline in the open panel. Saving a Koda
   *  default writes it into the project (a fork); saving a project item overwrites its file. */
  body: z.string(),
  /** Whether this skill/subagent is active. Koda defaults reflect the disabled set; project items on. */
  enabled: z.boolean(),
  /** The handle guardrails:setEnabled flips to switch a Koda default off/on. Absent for project items. */
  toggleKey: z.string().optional(),
  /** Absolute path to the source file — present only for editable `project` items. */
  openPath: z.string().optional(),
  /** True when this `project` item is a customized copy of a Koda default of the same name (made via
   *  "Edit" → fork). It supersedes that default, which is hidden; removing it restores the default. */
  isOverride: z.boolean().optional(),
})
export const GuardrailsLayerSchema = z.object({
  rules: z.array(GuardrailRuleSchema),
  skills: z.array(GuardrailItemSchema),
  subagents: z.array(GuardrailItemSchema),
})
export type GuardrailsLayer = z.infer<typeof GuardrailsLayerSchema>

/** memory:weight — how heavy the project's always-injected memory pair is (engine/pack.ts injects
 *  MEMORY.md + active-context.md into every session's system prompt). `heavy` drives the status-bar
 *  tidy pill; `chars` gives Settings → Memory a concrete size to show. */
export const MemoryWeightSchema = z.object({
  /** Whether the project has a memory index at all (no `.koda/memory/MEMORY.md` ⇒ nothing injected). */
  present: z.boolean(),
  chars: z.number(),
  heavy: z.boolean(),
})
export type MemoryWeight = z.infer<typeof MemoryWeightSchema>

/** guardrails:save — write a typed/pasted rule/skill/subagent straight to this project (no agent
 *  round-trip; the "Save" path of the authoring composer). A rule appends to the project CLAUDE.md;
 *  a skill/subagent is written verbatim to `.claude/{skills/<name>/SKILL.md,agents/<name>.md}` with
 *  the name taken from the pasted frontmatter. Checkpointed in main before the write (recoverable). */
export const GuardrailSaveRequestSchema = z.object({
  kind: z.enum(['rule', 'skill', 'subagent']),
  text: z.string(),
})
export type GuardrailSaveRequest = z.infer<typeof GuardrailSaveRequestSchema>

export const GuardrailSaveResultSchema = z.object({ path: z.string() })
export type GuardrailSaveResult = z.infer<typeof GuardrailSaveResultSchema>

/** guardrails:setEnabled — switch a bundled Koda default off (or back on) for THIS project. `key` is a
 *  rule/skill/subagent toggleKey from guardrails:list. Disabling never deletes the default (it lives in
 *  the immutable pack) — re-enabling restores it. Takes effect on the next session (the engine reads the
 *  disabled set at spawn). Persisted to `<project>/.koda/guardrails.json`. */
export const GuardrailSetEnabledRequestSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
})
export type GuardrailSetEnabledRequest = z.infer<typeof GuardrailSetEnabledRequestSchema>

/** guardrails:saveItemBody / guardrails:removeItem — a skill/subagent by kind + name.
 *  **saveItemBody** writes the edited content into this project's `.claude/`: for a Koda default that
 *  forks it (the copy supersedes the bundled one — subagent shadows by precedence, skills namespace-
 *  separate); for a project item it overwrites. **removeItem** deletes a project skill/subagent; if it
 *  forked a Koda default, that default reappears. Both checkpoint in main first (recoverable). */
export const GuardrailItemRefSchema = z.object({
  kind: z.enum(['skill', 'subagent']),
  name: z.string(),
})
export type GuardrailItemRef = z.infer<typeof GuardrailItemRefSchema>

export const GuardrailSaveItemBodyRequestSchema = GuardrailItemRefSchema.extend({ content: z.string() })
export type GuardrailSaveItemBodyRequest = z.infer<typeof GuardrailSaveItemBodyRequestSchema>

/** guardrails:setRuleOverride — edit a Koda rule principle's wording for this project (`text`), or
 *  restore the bundled default (`text: null`). Editing forks: the text is stored and the principle's
 *  member rules drop from the pack prompt; restore re-enables them. Checkpointed in main. */
export const GuardrailRuleOverrideRequestSchema = z.object({
  principleId: z.string(),
  text: z.string().nullable(),
})
export type GuardrailRuleOverrideRequest = z.infer<typeof GuardrailRuleOverrideRequestSchema>

/** skills:list — the Koda skills gallery (Settings → Skills): the bundled, curated Apache-2.0 subset of
 *  Anthropic's Agent Skills, with each skill's current active scope(s) layered on. A no-project window
 *  still gets the catalog + global state (only `project` needs an open folder). See skills-catalog.ts. */
export const SkillStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  blurb: z.string(),
  deps: z.string(),
  defaultActive: z.boolean(),
  global: z.boolean(),
  project: z.boolean(),
})
export type SkillState = z.infer<typeof SkillStateSchema>
export const SkillCatalogSchema = z.array(SkillStateSchema)

/** skills:setActive — turn a catalog skill on/off at a scope. 'global' copies it into a Koda-managed
 *  plugin dir loaded for every project (kept out of the user's ~/.claude); 'project' copies it into
 *  this project's `.claude/skills` (checkpointed in main, recoverable). Effective next session. */
export const SkillSetActiveRequestSchema = z.object({
  // A catalog skill id — also a single path segment (the folder copied/removed under userData or
  // .claude/skills), so constrain it to a safe slug: no separators, no traversal. Defense-in-depth
  // (skills-catalog.ts also refuses an id outside the catalog).
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  scope: z.enum(['global', 'project']),
  active: z.boolean(),
})
export type SkillSetActiveRequest = z.infer<typeof SkillSetActiveRequestSchema>

/** scratch:save — persist a pasted/dropped image (already compressed by the composer) to the project's
 *  `.koda/scratch/` folder so it outlives the conversation and the agent can re-read it by path. Returns
 *  the project-relative path. Best-effort on the renderer side: a failure just means no durable copy. */
export const ScratchSaveRequestSchema = z.object({ mediaType: z.string(), dataBase64: z.string() })
export type ScratchSaveRequest = z.infer<typeof ScratchSaveRequestSchema>

export const ScratchSaveResultSchema = z.object({ path: z.string() })
export type ScratchSaveResult = z.infer<typeof ScratchSaveResultSchema>

// ── Terminal surface (a real interactive shell in the window's project) ────────
/** Terminal viewport in character cells — the pty is sized to match xterm's fit. */
export const TerminalSizeSchema = z.object({
  cols: z.number().int().positive().max(2000),
  rows: z.number().int().positive().max(2000),
})
export type TerminalSize = z.infer<typeof TerminalSizeSchema>

/** A chunk of keystrokes typed into the terminal (renderer → pty stdin). */
export const TerminalInputSchema = z.object({ data: z.string() })
export type TerminalInput = z.infer<typeof TerminalInputSchema>

/** The shell spawned/ensured. `cwd` is the window's project (shown once as a hint). */
export const TerminalStartResultSchema = z.object({ ok: z.boolean(), cwd: z.string().optional() })
export type TerminalStartResult = z.infer<typeof TerminalStartResultSchema>

/** A chunk of pty output (main → renderer). */
export const TerminalDataSchema = z.object({ data: z.string() })
export type TerminalData = z.infer<typeof TerminalDataSchema>

/** The shell exited (main → renderer); the renderer offers to start a fresh one. */
export const TerminalExitSchema = z.object({ code: z.number().nullable() })
export type TerminalExit = z.infer<typeof TerminalExitSchema>

/** Pop the terminal shelf open (main → renderer; the agent's open_terminal tool). `command`, when set,
 *  is staged at the prompt for the user to review and run — Koda never runs it for them. */
export const TerminalShowSchema = z.object({ sessionId: z.string(), command: z.string().optional() })
export type TerminalShow = z.infer<typeof TerminalShowSchema>

// ── Doc presentation sidecar (.koda/docmeta/) ─────────────────────────────────
//
// Layout state the canonical markdown can't express, kept beside the file (not inside it) so the doc
// gets Notion-grade polish — resize a table column, reopen, it holds — without leaving plain markdown.
// First key: table column widths. See main/docmeta.ts, [[notion-replacement-no-jank]].

/** Column widths (px) for one table, keyed by its ordinal position in the doc. `cols` guards against a
 *  restructured table: a column-count mismatch ⇒ ignore the stale widths (fall back to auto). */
export const DocTableMetaSchema = z.object({
  // nonnegative (not positive): untouched earlier tables are stored as inert `cols: 0` placeholders so
  // the array stays index-aligned to the doc's table ordinals; the apply guard ignores a 0-col entry.
  cols: z.number().int().nonnegative(),
  widths: z.array(z.number()),
})

/** A document's sidecar. Each key is independent presentation state for the doc, kept beside the plain
 *  markdown file; designed to grow (new keys join with no migration). Written via a top-level MERGE so
 *  the doc's separate writers never clobber each other — see docmeta.ts.
 *   - `tables`: column widths (the table-resize overlay). */
export const DocMetaSchema = z.object({
  tables: z.array(DocTableMetaSchema).optional(),
})
export type DocMeta = z.infer<typeof DocMetaSchema>

/** docmeta:get / docmeta:set — read/write a doc's presentation sidecar. `path` is the doc's absolute
 *  path; main maps it to a project-relative key and stores under `.koda/docmeta/`. */
export const DocMetaGetRequestSchema = z.object({ path: z.string() })
export type DocMetaGetRequest = z.infer<typeof DocMetaGetRequestSchema>

export const DocMetaSetRequestSchema = z.object({ path: z.string(), meta: DocMetaSchema })
export type DocMetaSetRequest = z.infer<typeof DocMetaSetRequestSchema>

// ── Voice input: on-device push-to-talk dictation ─────────────────────────────
//
// The composer mic button. `voice:start` spawns the on-device Speech helper (one per window);
// transcript lines stream back over `voice:event` until `voice:stop`. Fail-soft: when there's no
// backend (non-mac / not built / spawn miss) start returns `{ started:false }` and the button just
// flashes "unavailable" — never an error. `end` marks the helper process exiting (any reason).

/** voice:start response — `started:false` ⇒ no backend; the renderer shows the unavailable state. */
export const VoiceStartResponseSchema = z.object({ started: z.boolean(), reason: z.string().optional() })
export type VoiceStartResponse = z.infer<typeof VoiceStartResponseSchema>

/** A dictation event pushed main→renderer. `partial` is the running hypothesis; `final` is appended to
 *  the draft; `error`/`end` stop the recording UI. `reason` accompanies `error` (permission|unsupported|…). */
export const VoiceEventSchema = z.object({
  type: z.enum(['ready', 'partial', 'final', 'error', 'end']),
  text: z.string().optional(),
  reason: z.string().optional(),
})
export type VoiceEvent = z.infer<typeof VoiceEventSchema>

// ── Runtime provisioning: install Node / Python on demand for machines that lack them ─────────────
//
// `runtime:status` reports whether the user already has the runtime (system), Koda installed it, or
// there's none yet. `runtime:install` fires the background download; `runtime:progress` streams its
// phases. All three are keyed by a runtime id so one set of channels serves every runtime.

/** The runtimes Koda can provision on demand (see src/main/runtime/registry.ts). */
export const RuntimeIdSchema = z.enum(['node', 'python'])
export type RuntimeId = z.infer<typeof RuntimeIdSchema>

/** `system` = the user's login PATH already has the runtime (no setup needed). `stale` = installed but
 *  a newer version is now pinned. installedVersion is set only when WE provisioned it. */
export const RuntimeStatusSchema = z.object({
  id: RuntimeIdSchema,
  state: z.enum(['system', 'installed', 'not_installed', 'stale', 'installing']),
  installedVersion: z.string().nullable(),
  pinnedVersion: z.string(),
})
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>

/** runtime:install ack — `ok:false` (with reason) when an install is already running. */
export const RuntimeInstallResultSchema = z.object({ ok: z.boolean(), reason: z.string().optional() })
export type RuntimeInstallResult = z.infer<typeof RuntimeInstallResultSchema>

/** runtime:progress push — tagged with `runtime` so a consumer filters to its row; `progress` (0–1)
 *  is set only during the download phase. */
export const RuntimeProgressSchema = z.object({
  runtime: RuntimeIdSchema,
  phase: z.enum(['download', 'verify', 'extract', 'done', 'error']),
  message: z.string(),
  progress: z.number().min(0).max(1).optional(),
})
export type RuntimeProgress = z.infer<typeof RuntimeProgressSchema>

// ── Onboarding sign-in (auth.ts) ─────────────────────────────────────────────────────────────────

/** The login/billing mode the wizard renders. `plan` = subscriptionType (max/pro), set only on a
 *  subscription login; `apiKeyTrap` flags a stray env API key shadowing the subscription. */
export const AuthVerdictSchema = z.object({
  mode: z.enum(['subscription', 'api-key', 'logged-out']),
  apiKeyTrap: z.boolean(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  detail: z.string(),
})
export type AuthVerdict = z.infer<typeof AuthVerdictSchema>

// ── Billing mode (Settings → Account) ────────────────────────────────────────────────────────────
//
// Subscription (default, shared ~/.claude login) vs an opt-in BYO API key. The key itself lives
// encrypted in api-key.ts — never in settings, never sent to the renderer; the UI only learns whether
// one EXISTS (`hasKey`) and the resulting auth verdict. BillingModeSchema is declared earlier (above
// KodaSettingsSchema, which uses it).

/** What Settings → Account renders: the active billing mode, whether a key is stored, and the engine's
 *  own view of the credential (email/plan, or the api-key-trap flag) read mode-aware. `apiActive` =
 *  whether the API key is what the NEXT turn will bill against right now — always true for 'api', true
 *  for 'auto' only while a plan-limit fallback window is live. Drives the status-bar chip + spend label. */
export const BillingStateSchema = z.object({
  mode: BillingModeSchema,
  hasKey: z.boolean(),
  apiActive: z.boolean(),
  verdict: AuthVerdictSchema,
  /** OpenAI/Codex billing (its own provider account): whether a BYO OpenAI key is stored, and the
   *  subscription-vs-api choice. `codexApiActive` = the key is the effective credential right now. */
  hasCodexKey: z.boolean(),
  codexMode: CodexBillingModeSchema,
  codexApiActive: z.boolean(),
})
export type BillingState = z.infer<typeof BillingStateSchema>

/** billing:activateFallback input — the user confirmed continuing on the API key after hitting the plan
 *  limit. `until` is the rejected window's `resetsAt` (unix seconds): API billing stays effective until
 *  then, then 'auto' reverts to subscription on its own. */
export const ApiFallbackRequestSchema = z.object({ until: z.number() })
export type ApiFallbackRequest = z.infer<typeof ApiFallbackRequestSchema>

/** The key the user pastes. Format-checked here (`sk-ant-` prefix) so an obvious paste error is caught
 *  before we bother spawning the engine to validate it. */
export const ApiKeySchema = z.string().trim().min(1).max(512)

/** billing:saveApiKey result — `ok:false` carries a human-readable reason (bad format, rejected by the
 *  engine, or a storage failure); `ok:true` carries the fresh state so the UI re-renders in one round-trip. */
export const BillingSaveResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: BillingStateSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type BillingSaveResult = z.infer<typeof BillingSaveResultSchema>

/** auth:detect result — `ok:false` carries why detection failed (missing binary / unparseable status). */
export const AuthDetectResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), verdict: AuthVerdictSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AuthDetectResult = z.infer<typeof AuthDetectResultSchema>

/** auth:loginStart ack — `ok:false` (with reason) when a login is already in flight or the spawn failed. */
export const AuthLoginStartResultSchema = z.object({ ok: z.boolean(), reason: z.string().optional() })
export type AuthLoginStartResult = z.infer<typeof AuthLoginStartResultSchema>

/** The code the user pastes from the browser → written to the login child's stdin. */
export const AuthCodeSchema = z.string().trim().min(1).max(4096)

/** auth:progress push — the login state machine's steps. `awaiting-code` carries the OAuth URL (manual
 *  fallback to the auto-opened browser); `completed` carries the fresh verdict when re-detection works. */
export const AuthProgressSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('awaiting-code'), url: z.string() }),
  z.object({ state: z.literal('verifying') }),
  z.object({ state: z.literal('completed'), verdict: AuthVerdictSchema.optional() }),
  z.object({ state: z.literal('failed'), message: z.string() }),
  z.object({ state: z.literal('cancelled') }),
  z.object({ state: z.literal('timeout') }),
])
export type AuthProgress = z.infer<typeof AuthProgressSchema>

/** scratch:list — page through the project's recent scratch images (the durable copies of pasted/dropped
 *  images in `.koda/scratch/`), newest first. The renderer requests an `[offset, offset+limit)` window so
 *  the Recent images strip can lazy-load; `total` is the full count so it knows when to stop. Each image
 *  carries its inline data so the renderer can thumbnail it and re-attach it to a turn. */
export const ScratchListRequestSchema = z.object({ offset: z.number(), limit: z.number() })
export type ScratchListRequest = z.infer<typeof ScratchListRequestSchema>

export const ScratchImageSchema = z.object({
  name: z.string(),
  relPath: z.string(),
  mediaType: z.string(),
  dataBase64: z.string(),
  mtime: z.number(),
})
export type ScratchImage = z.infer<typeof ScratchImageSchema>

export const ScratchListResultSchema = z.object({
  images: z.array(ScratchImageSchema),
  total: z.number(),
})
export type ScratchListResult = z.infer<typeof ScratchListResultSchema>

/** fs:renamePath — rename OR move a file/folder. Rename = a new name in the same folder; move = the
 *  same name in a different folder. Both are one `fs.rename`; main contains `from` (must exist) and
 *  `to` (parent must exist, both within the project root), refuses overwriting an existing target, and
 *  checkpoints the pre-move tree first so it's recoverable. Returns the new absolute path. */
export const RenamePathRequestSchema = z.object({ from: z.string(), to: z.string() })
export type RenamePathRequest = z.infer<typeof RenamePathRequestSchema>
export const RenamePathResultSchema = z.object({ path: z.string() })
export type RenamePathResult = z.infer<typeof RenamePathResultSchema>

/** fs:deletePath — delete a file or folder (recursive). Contained to the project root; the root
 *  itself can't be deleted. Main checkpoints the pre-delete tree first, so a delete is undoable from
 *  the recovery timeline like any other change. */
export const DeletePathRequestSchema = z.object({ path: z.string() })
export type DeletePathRequest = z.infer<typeof DeletePathRequestSchema>

/** fs:revealPath — reveal a file/folder in Finder. fs:openPath — open it in the OS default app.
 *  Both are read-only shell actions, path-contained to the project root. */
export const RevealPathRequestSchema = z.object({ path: z.string() })
export type RevealPathRequest = z.infer<typeof RevealPathRequestSchema>
export const OpenPathRequestSchema = z.object({ path: z.string() })
export type OpenPathRequest = z.infer<typeof OpenPathRequestSchema>

/** fs:createDir — create a new folder (name optional ⇒ "New folder", deduped). `parent` (an existing
 *  dir within the root) places it inside that folder; omitted ⇒ the project root. Returns the path. */
export const CreateDirRequestSchema = z.object({
  name: z.string().optional(),
  parent: z.string().optional(),
  // Land the folder in the user's Documents/ (where New document goes) instead of the project root —
  // used by the doc-first view's New-folder button so it appears where they expect.
  home: z.boolean().optional(),
})
export type CreateDirRequest = z.infer<typeof CreateDirRequestSchema>
export const CreateDirResultSchema = z.object({ path: z.string() })
export type CreateDirResult = z.infer<typeof CreateDirResultSchema>

/** fs:duplicatePath — copy a file/folder alongside itself as "<name> copy" (deduped). Contained to
 *  the project root; main checkpoints first, so the copy is undoable from the recovery timeline. */
export const DuplicatePathRequestSchema = z.object({ path: z.string() })
export type DuplicatePathRequest = z.infer<typeof DuplicatePathRequestSchema>
export const DuplicatePathResultSchema = z.object({ path: z.string() })
export type DuplicatePathResult = z.infer<typeof DuplicatePathResultSchema>

/** fs:importFiles — write files dragged in from Finder into `destDir` (an existing folder within the
 *  root) or, omitted, the user's Documents/ home. Bytes ride over IPC (no external path is followed);
 *  names are deduped so a drop never clobbers. Main checkpoints first, so an import is undoable. */
export const ImportFilesRequestSchema = z.object({
  destDir: z.string().optional(),
  files: z.array(z.object({ name: z.string(), data: z.instanceof(Uint8Array) })).min(1),
})
export type ImportFilesRequest = z.infer<typeof ImportFilesRequestSchema>
export const ImportFilesResultSchema = z.object({ paths: z.array(z.string()) })
export type ImportFilesResult = z.infer<typeof ImportFilesResultSchema>

/** fs:diffFile — the before/after pair that powers the live-edits diff. `before` is the file's
 *  contents at the turn-start safety-git baseline for `sessionId` (cumulative-this-turn diff); empty
 *  for a file created this turn, and HEAD when no sessionId/baseline is available (manual File→Diff
 *  toggle). `after` is the current on-disk contents. Both are size-capped + binary-refused like readFile. */
export const DiffFileRequestSchema = z.object({
  path: z.string(),
  /** The session whose edit opened this diff — selects the pinned turn-start baseline. */
  sessionId: z.string().optional(),
})
export type DiffFileRequest = z.infer<typeof DiffFileRequestSchema>

export const DiffFileResultSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
  /** True when either side exceeded the size cap (the diff view opens read-only). */
  truncated: z.boolean(),
  /** True when the current file looks binary — both sides empty, the view shows a notice. */
  binary: z.boolean(),
})
export type DiffFileResult = z.infer<typeof DiffFileResultSchema>

/** Which files a search/replace touches: everything, just prose docs, or just code (everything that
 *  isn't a doc). The friendly "narrow it down" control for a non-engineer — no glob syntax. */
export const SearchScopeSchema = z.enum(['all', 'docs', 'code'])
export type SearchScope = z.infer<typeof SearchScopeSchema>

/** fs:search — project-wide find (the Find overlay). Filenames match FUZZY (subsequence, ranked);
 *  file contents match plain case-insensitive substring. Contained to the project root, scope-filtered,
 *  and capped (see searchProject). The renderer gates on query length; main treats any non-empty query
 *  as searchable. */
export const SearchRequestSchema = z.object({
  query: z.string(),
  scope: SearchScopeSchema.optional(), // default 'all'
})
export type SearchRequest = z.infer<typeof SearchRequestSchema>

/** One content-line hit. `preview` is the (whitespace-trimmed, windowed) line text for display; the
 *  renderer re-finds + highlights the query within it, so no column offset is carried. */
export const SearchLineMatchSchema = z.object({
  line: z.number(), // 1-based
  preview: z.string(),
})
export type SearchLineMatch = z.infer<typeof SearchLineMatchSchema>

export const SearchFileResultSchema = z.object({
  path: z.string(), // absolute (the open target)
  rel: z.string(), // relative to the project root (display)
  name: z.string(), // basename
  /** The filename itself matched the query (the file is listed even with no content matches). */
  nameMatch: z.boolean(),
  /** Fuzzy filename-match score (higher = better) — the FILES section ranks by it. 0 when !nameMatch. */
  score: z.number(),
  matches: z.array(SearchLineMatchSchema),
})
export type SearchFileResult = z.infer<typeof SearchFileResultSchema>

export const SearchResultSchema = z.object({
  query: z.string(),
  /** A cap was hit (files scanned / matches collected) — results are partial. */
  truncated: z.boolean(),
  files: z.array(SearchFileResultSchema),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

/** fs:replaceAll — replace every case-insensitive occurrence of `query` with `replacement` across the
 *  project (same substring semantics + scope as content search, so the count matches what Find shows).
 *  Main checkpoints the whole tree via safety-git FIRST, so the whole replace is undoable from the
 *  recovery timeline as one step. Returns how much changed. Empty `query` is a no-op. */
export const ReplaceRequestSchema = z.object({
  query: z.string(),
  replacement: z.string(),
  scope: SearchScopeSchema.optional(), // default 'all'
})
export type ReplaceRequest = z.infer<typeof ReplaceRequestSchema>

export const ReplaceResultSchema = z.object({
  files: z.number(), // files changed
  replacements: z.number(), // total occurrences replaced
})
export type ReplaceResult = z.infer<typeof ReplaceResultSchema>

// ── User-git: the Source Control panel ────────────────────────────────────────
//
// The user's REAL `.git` (dual-git.md §3) — separate from safety-git's invisible undo store. Lean
// scope: detect / status / recent commits / init / commit. No path crosses the boundary (root is
// per-window in main); only a commit message does. Destructive ops do NOT exist at this layer.

export const GitRepoInfoSchema = z.object({
  isRepo: z.boolean(),
  /** Repo root (`--show-toplevel`), null when not a repo. */
  repoRoot: z.string().nullable(),
  /** True when the project is a SUBDIR of a larger repo — `git init` here would nest (renderer warns). */
  isSubdir: z.boolean(),
  /** Current branch; null when not a repo / detached HEAD / no commits yet. */
  branch: z.string().nullable(),
  /** The trunk ("main line"): local main, else master; null when neither exists. */
  defaultBranch: z.string().nullable(),
})
export type GitRepoInfo = z.infer<typeof GitRepoInfoSchema>

export const GitStatusFileSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'other']),
})
export type GitStatusFile = z.infer<typeof GitStatusFileSchema>

export const GitStatusResultSchema = z.object({
  files: z.array(GitStatusFileSchema),
  /** True when the changed count exceeded the cap and the list is clipped. */
  truncated: z.boolean(),
})
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>

export const GitCommitEntrySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  relativeDate: z.string(),
  authorName: z.string(),
})
export type GitCommitEntry = z.infer<typeof GitCommitEntrySchema>

// ── Commit graph (the "Versions" rail) ─────────────────────────────────────────
// Per-row draw instructions computed in main (git-graph.ts); the renderer just maps lanes→x,
// {0:top,1:node,2:bottom}→y and colors by `laneKinds`. Spans all LOCAL branches so the agent's
// abandoned branches are visible. See git-graph.ts for the why.

export const GitGraphRequestSchema = z.object({ limit: z.number().int().min(1).max(200).optional() })
export type GitGraphRequest = z.infer<typeof GitGraphRequestSchema>

export const GitGraphSegmentSchema = z.object({
  x1: z.number().int(),
  y1: z.number().int().min(0).max(2),
  x2: z.number().int(),
  y2: z.number().int().min(0).max(2),
  color: z.number().int(),
})

export const GitGraphRowSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  relativeDate: z.string(),
  authorName: z.string(),
  parents: z.array(z.string()),
  lane: z.number().int(),
  color: z.number().int(),
  isMerge: z.boolean(),
  segments: z.array(GitGraphSegmentSchema),
  branchLabel: z.string().nullable(),
  branchKind: z.enum(['head', 'merged', 'unmerged']).nullable(),
})
export type GitGraphRow = z.infer<typeof GitGraphRowSchema>

export const GitCommitGraphResultSchema = z.object({
  layout: z.object({
    rows: z.array(GitGraphRowSchema),
    laneCount: z.number().int(),
    /** color key → palette family ('main' | 'branch' | 'unmerged'). JSON keys are strings. */
    laneKinds: z.record(z.string(), z.enum(['main', 'branch', 'unmerged'])),
  }),
  unmergedBranches: z.array(z.object({ name: z.string() })),
  headBranch: z.string().nullable(),
  truncated: z.boolean(),
})
export type GitCommitGraphResult = z.infer<typeof GitCommitGraphResultSchema>

// ── Branch Review (focus an unmerged branch → merge-in or discard) ─────────────
const GitBranchNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)

export const GitBranchRequestSchema = z.object({ branch: GitBranchNameSchema })
export type GitBranchRequest = z.infer<typeof GitBranchRequestSchema>

export const GitBranchFileDiffRequestSchema = z.object({
  branch: GitBranchNameSchema,
  path: z.string(),
})
export type GitBranchFileDiffRequest = z.infer<typeof GitBranchFileDiffRequestSchema>

export const GitBranchOverviewSchema = z.object({
  name: z.string(),
  commits: z.array(GitCommitEntrySchema),
  files: z.array(GitStatusFileSchema),
  ahead: z.number().int(),
  truncated: z.boolean(),
})
export type GitBranchOverview = z.infer<typeof GitBranchOverviewSchema>

export const GitInitResultSchema = z.object({ alreadyExisted: z.boolean() })
export type GitInitResult = z.infer<typeof GitInitResultSchema>

export const GitCommitRequestSchema = z.object({ message: z.string().min(1).max(4096) })
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>

/** git:commitPaths — commit ONLY these (project-relative) paths, leaving other dirty files untouched.
 *  Powers the per-session "Save this session's work". */
export const GitCommitPathsRequestSchema = z.object({
  message: z.string().min(1).max(4096),
  paths: z.array(z.string()).min(1).max(5000),
})
export type GitCommitPathsRequest = z.infer<typeof GitCommitPathsRequestSchema>

/** A git commit/short SHA — pinned so it can't be smuggled in as a positional git flag. */
const GitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/)

/** git:renameHead — reword the just-saved version. `sha` pins WHICH version; the main process only
 *  proceeds if it's still HEAD (so this is a plain amend, never a history rewrite). */
export const GitRenameHeadRequestSchema = z.object({
  sha: GitShaSchema,
  message: z.string().min(1).max(4096),
})
export type GitRenameHeadRequest = z.infer<typeof GitRenameHeadRequestSchema>

/** git:fileDiff — a changed file's before/after (result reuses DiffFileResult). Without `ref`:
 *  HEAD → working tree (the "Changes" list). With `ref` (a commit SHA): ref^ → ref (a past version). */
export const GitFileDiffRequestSchema = z.object({ path: z.string(), ref: GitShaSchema.optional() })
export type GitFileDiffRequest = z.infer<typeof GitFileDiffRequestSchema>

/** git:commitChanges — the files a past version (commit) changed (result reuses GitStatusResult). */
export const GitCommitChangesRequestSchema = z.object({ sha: GitShaSchema })
export type GitCommitChangesRequest = z.infer<typeof GitCommitChangesRequestSchema>

/** Tagged result so the renderer can show specific copy per failure (no_identity, nothing_to_commit,
 *  …) without parsing an Electron-wrapped error string. */
export const GitCommitResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sha: z.string() }),
  z.object({
    ok: z.literal(false),
    // not_head: a rename target that's no longer the latest version (another version landed on top) —
    // renaming it would mean rewriting history, which we don't do here.
    // not_clean (restore only): unsaved changes exist — restoring would silently eat them.
    // nothing_to_commit on a restore means the files already match that version.
    code: z.enum(['no_identity', 'nothing_to_commit', 'not_a_repo', 'not_head', 'not_clean', 'git_failed']),
    message: z.string(),
  }),
])
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>

/** git:restoreVersion — make the files match `sha`, saved as a NEW version on top (no history
 *  rewrite; undoable by restoring forward again). Result reuses the tagged GitCommitResult. */
export const GitRestoreRequestSchema = z.object({ sha: GitShaSchema })
export type GitRestoreRequest = z.infer<typeof GitRestoreRequestSchema>

/** git:discardFile — drop one (project-relative) file's uncommitted change: revert a tracked file to
 *  the last version, or remove a new/untracked one. The main process checkpoints the tree first. */
export const GitDiscardFileRequestSchema = z.object({ path: z.string().min(1).max(4096) })
export type GitDiscardFileRequest = z.infer<typeof GitDiscardFileRequestSchema>

/** Tagged discard result. `no_checkpoint`: the safety-git undo point failed, so nothing was removed
 *  (a delete of an untracked file isn't otherwise recoverable — we refuse rather than lose it). */
export const GitDiscardResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['not_a_repo', 'no_checkpoint', 'git_failed']),
    message: z.string(),
  }),
])
export type GitDiscardResult = z.infer<typeof GitDiscardResultSchema>

/** git:syncState — does a remote exist, and how far ahead/behind is the current branch? Offline-only
 *  (never fetches): `behind` is as-of-last-fetch; `ahead` (versions that exist only on this machine)
 *  is the number the Backup card lives on. */
export const GitSyncStateSchema = z.object({
  hasRemote: z.boolean(),
  remoteName: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  /** The current branch's upstream ref (e.g. "origin/main"); null when the branch was never pushed. */
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  /** Short SHA of the remote branch tip — lets the graph mark "on GitHub up to here". */
  upstreamTip: z.string().nullable(),
  /**
   * True iff this read actually reached the remote (ls-remote/fetch succeeded). When false the numbers
   * are a best-effort local guess (offline/auth/detached) — the UI must NOT show a confident "on
   * GitHub" state, only "couldn't confirm · last known …". A false green is the one failure we refuse.
   */
  verified: z.boolean(),
})
export type GitSyncState = z.infer<typeof GitSyncStateSchema>

/** git:push — push the current branch (sets upstream on first push). Tagged like GitCommitResult:
 *  `push_rejected` = the remote has versions we don't (needs a merge — agent's job); `push_auth` =
 *  credentials refused; `no_remote` routes the renderer back to Publish. */
export const GitPushResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no_remote', 'push_rejected', 'push_auth', 'git_failed']),
    message: z.string(),
  }),
])
export type GitPushResult = z.infer<typeof GitPushResultSchema>

/** git:worktrees — the checkouts on disk (`git worktree list`). Surfaces the worktrees a past session
 *  left behind: invisible otherwise (their branches show in the graph, but their *uncommitted* work
 *  has no surface at all). `dirtyCount` is that stranded working-tree change count; `isCurrent` marks
 *  this window's own checkout (no "open" action for it). */
export const GitWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(), // null on a detached HEAD
  isCurrent: z.boolean(),
  dirtyCount: z.number().int().nonnegative(),
  lastActivity: z.string(), // relative date of the worktree's HEAD commit ('' if none / unreadable)
  locked: z.boolean(),
  prunable: z.boolean(), // the folder is gone — git would prune it
})
export type GitWorktree = z.infer<typeof GitWorktreeSchema>
export const GitWorktreeListSchema = z.array(GitWorktreeSchema)
export type GitWorktreeList = z.infer<typeof GitWorktreeListSchema>

/** git:mergedStrays / git:tidyStrays — leftovers from finished work: branches fully merged into the
 *  trunk (plus the clean worktrees checked out on them). Listing is read-only; tidy recomputes the
 *  list in the main process and uses only refusal-safe git (`branch -d`, `worktree remove` without
 *  --force), so a raced dirty tree or unmerged commit fails that item instead of losing work. */
export const GitMergedStraySchema = z.object({
  branch: z.string(),
  worktreePath: z.string().nullable(), // a clean checkout removed together with the branch
})
export type GitMergedStray = z.infer<typeof GitMergedStraySchema>
export const GitMergedStrayListSchema = z.array(GitMergedStraySchema)
export type GitMergedStrayList = z.infer<typeof GitMergedStrayListSchema>

/** Optional `only` limits the tidy to those branches (the per-row remove); omitted ⇒ every safe stray. */
export const GitTidyStraysRequestSchema = z.object({ only: z.array(z.string()).optional() })
export type GitTidyStraysRequest = z.infer<typeof GitTidyStraysRequestSchema>

export const GitTidyResultSchema = z.object({
  removed: z.array(z.string()),
  failed: z.array(z.object({ branch: z.string(), message: z.string() })),
})
export type GitTidyResult = z.infer<typeof GitTidyResultSchema>

/** git:worktreeOpen — open a worktree's folder as a project in its OWN window (focus it if already
 *  open). Distinct from project:open, which swaps the calling window in place — a worktree is *another*
 *  workspace you want alongside the current one, not a replacement for it. */
export const WorktreeOpenRequestSchema = z.object({ path: z.string() })
export type WorktreeOpenRequest = z.infer<typeof WorktreeOpenRequestSchema>

// ── One-project-per-window ────────────────────────────────────────────────────
//
// A window IS a project. On boot the renderer asks which project it is; '' means a ProjectHome
// window (no folder picked yet → show the picker). Opening a folder transitions THIS window in place
// (or focuses the window already showing it). Main owns the project↔window mapping; the renderer
// only ever holds the path for display.

export const ProjectContextSchema = z.object({
  /** Absolute project root, or '' for a ProjectHome window awaiting a folder. */
  projectPath: z.string(),
})
export type ProjectContext = z.infer<typeof ProjectContextSchema>

/** project:chooseFolder — native open-directory dialog on the calling window; null if cancelled. */
export const ChooseFolderResultSchema = z.object({ path: z.string().nullable() })
export type ChooseFolderResult = z.infer<typeof ChooseFolderResultSchema>

export const ProjectOpenRequestSchema = z.object({ path: z.string() })
export type ProjectOpenRequest = z.infer<typeof ProjectOpenRequestSchema>

/** project:create — make a NEW project folder and open it as this window's project. `name` is a single
 *  folder name (no path separators); `parentDir` is the directory to create it in (omit ⇒ ~/Koda).
 *  Main validates the name, mkdirs the folder, and returns it like project:open. */
export const ProjectCreateRequestSchema = z.object({
  name: z.string(),
  parentDir: z.string().optional(),
})
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>

/** Per-engine agent-guidance files (engine-keyed: Claude reads CLAUDE.md, Codex reads AGENTS.md). A
 *  project "already has guidelines" if ANY of these exists — so a project set up for one engine isn't
 *  re-intaked by another. Add the next engine's file here when it lands. */
export const GUIDELINES_FILES = ['CLAUDE.md', 'AGENTS.md'] as const

/** project:hasGuidelines — does this window's project already have an agent-guidance file? Drives the
 *  one-time intake offer (no guidelines yet ⇒ offer to set them up; present ⇒ never touch them). */
export const ProjectHasGuidelinesResultSchema = z.object({ hasGuidelines: z.boolean() })
export type ProjectHasGuidelinesResult = z.infer<typeof ProjectHasGuidelinesResultSchema>

/** project:open result. `alreadyOpen` ⇒ the folder was open in another window (now focused); this
 *  window did NOT change — the renderer stays on ProjectHome. Otherwise this window became the
 *  project's window and should switch to the workspace + hydrate. */
export const ProjectOpenResultSchema = z.object({
  projectPath: z.string(),
  alreadyOpen: z.boolean(),
})
export type ProjectOpenResult = z.infer<typeof ProjectOpenResultSchema>

export const RecentProjectsSchema = z.array(z.string())

/** The shape exposed on `window.koda` — implemented in preload, consumed in the renderer. */
export interface KodaApi {
  getAppInfo: () => Promise<AppInfo>
  echo: (args: EchoRequest) => Promise<EchoResponse>
  probeEngine: () => Promise<EngineProbe>
  // App self-update (releases-and-updates.md).
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  quitAndInstallUpdate: () => Promise<void>
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void
  /** The current version's release notes, once per update (null otherwise) → the "What's New" popup. */
  getWhatsNew: () => Promise<WhatsNew>
  /** Post in-app feedback to the private Supabase inbox; resolves ok or a friendly error. */
  submitFeedback: (args: FeedbackRequest) => Promise<FeedbackResult>
  // Engine adapter.
  startSession: (args: StartSessionRequest) => Promise<StartSessionResponse>
  sendTurn: (args: SendTurnRequest) => Promise<void>
  interruptSession: (args: SessionRef) => Promise<void>
  disposeSession: (args: SessionRef) => Promise<void>
  /** Load persisted sessions on boot (null when there are none). */
  loadSessions: () => Promise<PersistedSessions | null>
  /** Fire-and-forget: persist the open sessions + transcripts (debounced in the renderer). */
  saveSessions: (data: PersistedSessions) => void
  /** Archived sessions ride a separate COLD file (never the hot blob above — the 53MB-freeze bug).
   *  load on boot; save fires only when the archived list changes (archive / restore / delete). */
  loadArchived: () => Promise<ArchivedSession[]>
  saveArchived: (archived: ArchivedSession[]) => void
  /** Claim this window's project's live headless (phone-started) sessions + get their replayable
   *  history, so the desktop can show sessions launched from the phone. Empty when there are none. */
  adoptHeadlessSessions: () => Promise<AdoptedHeadlessSession[]>
  /** A phone started/resumed a session in the project this window has open → adopt it live. */
  onHeadlessAppeared: (listener: (payload: HeadlessAppeared) => void) => () => void
  /** The phone asked to archive a past session in this window's project → store.archiveSession. */
  onArchiveRequested: (listener: (payload: ArchiveRequested) => void) => () => void
  /** The phone asked to rename a live session in this window's project → store.renameSession. */
  onRenameRequested: (listener: (payload: RenameRequested) => void) => () => void
  /** A phone turn on a session THIS window already owns (adopted before the turn) → append + auto-title. */
  onRemoteUserTurn: (listener: (payload: RemoteUserTurnLive) => void) => () => void
  /** Subscribe to the normalized event stream; returns an unsubscribe fn. */
  onEngineEvent: (listener: (event: EngineEvent) => void) => () => void
  // Side questions ("btw" / aside) — answered from the live conversation without entering it.
  askAside: (args: AskAsideRequest) => Promise<void>
  cancelAside: (args: CancelAsideRequest) => Promise<void>
  /** Subscribe to streamed side-question answers; returns an unsubscribe fn. */
  onAsideEvent: (listener: (event: AsideEvent) => void) => () => void
  // Safety-git recovery (Settings → Recovery) — project-scoped (root from the window).
  listCheckpoints: () => Promise<Checkpoint[]>
  restoreCheckpoint: (args: SafetyRestoreRequest) => Promise<Checkpoint>
  /** What going back to a checkpoint would undo (changed-file list). */
  checkpointChanges: (args: SafetyChangesRequest) => Promise<SafetyChangesResult>
  /** One changed file's before/after for the recovery diff view. */
  checkpointFileDiff: (args: SafetyFileDiffRequest) => Promise<SafetyFileDiffResult>
  /** Fire-and-forget: forward a renderer warning/error into the main log file. */
  logFromRenderer: (entry: RendererLog) => void
  /** Fire-and-forget: set the macOS dock badge to the number of sessions needing attention. */
  setAttentionCount: (count: number) => void
  /** On-device clean session title from the first prompt (deterministic fallback; never rejects). */
  assistTitle: (args: AssistTitleRequest) => Promise<AssistTitleResponse>
  // Project Files browser (read-only, contained to the project root in main).
  /** List a directory (path omitted ⇒ project root). */
  readDir: (args: ReadDirRequest) => Promise<ReadDirResult>
  /** Flat recency-sorted list of every prose doc under the project (the doc-first sidebar). */
  listDocs: (args: ListDocsRequest) => Promise<ListDocsResult>
  /** Read a text file's contents (size-capped; binary refused). */
  readFile: (args: ReadFileRequest) => Promise<ReadFileResult>
  /** Save the editor's contents to a file (safety-git checkpoints the pre-edit tree first). */
  writeFile: (args: WriteFileRequest) => Promise<WriteFileResult>
  /** Watch an open file for on-disk changes so the editor can re-read (fire-and-forget). */
  watchFile: (args: ReadFileRequest) => void
  /** Stop watching a file (call when its editor surface unmounts). */
  unwatchFile: (args: ReadFileRequest) => void
  /** A watched file changed on disk — the payload is the path string passed to watchFile. */
  onFileChanged: (listener: (path: string) => void) => () => void
  /** Watch the project's Documents/ folder so the doc list refreshes on agent/external adds+removes. */
  watchDocs: () => void
  /** Stop watching the Documents/ folder (call when the docs sidebar unmounts). */
  unwatchDocs: () => void
  /** The Documents/ folder changed on disk — re-fetch listDocs. */
  onDocsChanged: (listener: () => void) => () => void
  /** Create a new empty document at the project root (the "New document" entry point). */
  createFile: (args: CreateFileRequest) => Promise<CreateFileResult>
  /** Rename or move a file/folder (checkpointed first). Returns the new path. */
  renamePath: (args: RenamePathRequest) => Promise<RenamePathResult>
  /** Delete a file/folder, recursive (checkpointed first). */
  deletePath: (args: DeletePathRequest) => Promise<void>
  /** Duplicate a file/folder as "<name> copy" (checkpointed first). Returns the new path. */
  duplicatePath: (args: DuplicatePathRequest) => Promise<DuplicatePathResult>
  /** Import Finder-dragged files into a folder (or Documents/), checkpointed first. Returns new paths. */
  importFiles: (args: ImportFilesRequest) => Promise<ImportFilesResult>
  /** Reveal a file/folder in Finder. */
  revealPath: (args: RevealPathRequest) => Promise<void>
  /** Open a file/folder in the OS default app. */
  openPath: (args: OpenPathRequest) => Promise<void>
  /** Create a new folder (at the root, or inside `parent`). */
  createDir: (args: CreateDirRequest) => Promise<CreateDirResult>
  /** Read a file's pinned pre-turn + current contents for the live-edits diff view. */
  diffFile: (args: DiffFileRequest) => Promise<DiffFileResult>
  /** Project-wide find: filename + content matches across the project root (capped, contained). */
  search: (args: SearchRequest) => Promise<SearchResult>
  /** Project-wide replace (safety-git-checkpointed first; undoable as one step). Returns the counts. */
  replaceAll: (args: ReplaceRequest) => Promise<ReplaceResult>
  // Source Control (user-git — the real `.git`).
  /** Is the project a git repo, and is it the root or a subdir of one? */
  gitDetect: () => Promise<GitRepoInfo>
  /** Working-tree changes (capped, NUL-safe). */
  gitStatus: () => Promise<GitStatusResult>
  /** The commit graph across all local branches (lanes + the agent's abandoned branches). */
  gitGraph: (args: GitGraphRequest) => Promise<GitCommitGraphResult>
  /** `git init` at the project root (idempotent). */
  gitInit: () => Promise<GitInitResult>
  /** Stage all + commit. Tagged result so the renderer can show per-failure copy. */
  gitCommit: (args: GitCommitRequest) => Promise<GitCommitResult>
  /** Commit only the given paths (per-session save); other dirty files stay uncommitted. */
  gitCommitPaths: (args: GitCommitPathsRequest) => Promise<GitCommitResult>
  gitRenameHead: (args: GitRenameHeadRequest) => Promise<GitCommitResult>
  /** Make the files match a past version, saved as a new version on top (never a history rewrite). */
  gitRestoreVersion: (args: GitRestoreRequest) => Promise<GitCommitResult>
  /** Discard one file's uncommitted change (revert an edit, or remove a new file). Checkpointed first. */
  gitDiscardFile: (args: GitDiscardFileRequest) => Promise<GitDiscardResult>
  /** A changed file's diff for the artifact zone — HEAD→working tree, or a commit's ref^→ref. */
  gitFileDiff: (args: GitFileDiffRequest) => Promise<DiffFileResult>
  /** The files a past version (commit) changed. */
  gitCommitChanges: (args: GitCommitChangesRequest) => Promise<GitStatusResult>
  /** Branch Review: what's on an unmerged branch that isn't in the current branch (commits + files). */
  gitBranchOverview: (args: GitBranchRequest) => Promise<GitBranchOverview>
  /** One file's diff for a branch Review (merge-base→branch tip). */
  gitBranchFileDiff: (args: GitBranchFileDiffRequest) => Promise<DiffFileResult>
  /** Discard a local branch (the manual destructive op; renderer confirms first). */
  gitDiscardBranch: (args: GitBranchRequest) => Promise<void>
  /** Remote backup state: has a remote, and how many versions exist only on this machine. */
  gitSyncState: () => Promise<GitSyncState>
  /** Push the current branch (sets upstream on first push). Tagged result for per-failure copy. */
  gitPush: () => Promise<GitPushResult>
  /** The worktrees on disk — the checkouts a past session left behind (with their stranded dirty count). */
  gitWorktrees: () => Promise<GitWorktreeList>
  /** Leftovers from finished work: branches fully merged into the trunk (+ their clean checkouts). */
  gitMergedStrays: () => Promise<GitMergedStrayList>
  /** Remove merged strays (safe git only: `branch -d`, `worktree remove`). `only` ⇒ just those branches. */
  gitTidyStrays: (args?: GitTidyStraysRequest) => Promise<GitTidyResult>
  /** Open a worktree's folder as a project in its own window (focus if already open). */
  openWorktree: (args: WorktreeOpenRequest) => Promise<ProjectOpenResult>
  // One-project-per-window.
  /** This window's project ('' ⇒ ProjectHome). */
  getProjectContext: () => Promise<ProjectContext>
  /** Native open-directory dialog on this window; null if cancelled. */
  chooseFolder: () => Promise<ChooseFolderResult>
  /** Open a folder as this window's project in place (or focus the window already showing it). */
  openProject: (args: ProjectOpenRequest) => Promise<ProjectOpenResult>
  /** Create a new project folder (under parentDir, default ~/Koda) and open it as this window's project. */
  createProject: (args: ProjectCreateRequest) => Promise<ProjectOpenResult>
  /** Whether this window's project already has an agent-guidance file (CLAUDE.md/AGENTS.md). */
  hasGuidelines: () => Promise<ProjectHasGuidelinesResult>
  /** Recent project paths, most-recent-first (for the ProjectHome screen). */
  getRecentProjects: () => Promise<string[]>
  // Approval gate ("Ask me" mode).
  /** Subscribe to tool-approval requests; returns an unsubscribe fn. */
  onApprovalRequest: (listener: (req: ApprovalRequest) => void) => () => void
  /** Subscribe to session-wide approval cancellations; returns an unsubscribe fn. */
  onApprovalCancelled: (listener: (e: ApprovalCancelled) => void) => () => void
  /** Subscribe to single-request resolutions (answered on any head); returns an unsubscribe fn. */
  onApprovalResolved: (listener: (e: ApprovalResolved) => void) => () => void
  /** Answer a pending approval. */
  resolveApproval: (args: ApprovalResolve) => Promise<void>
  setApprovalMode: (args: SetApprovalMode) => Promise<void>
  getApprovalMode: () => Promise<ApprovalMode>
  /** Push a session's model/effort pick to main at pick time (see SetModelEffortSchema). */
  setModelEffort: (args: SetModelEffort) => Promise<void>
  // Model picker.
  /** Full model ids the user has explicitly chosen, most-recent-first (engine aliases excluded —
   *  they're always offered). Powers the picker's "Recently used" quick-picks. */
  getRecentModels: () => Promise<string[]>
  /** Record a model id the user chose; returns the updated recents list (capped, deduped). */
  addRecentModel: (args: AddRecentModel) => Promise<string[]>
  /** Codex models the account can use (the picker's OpenAI group). Empty when not signed in / no codex. */
  getCodexModels: () => Promise<CodexModel[]>
  /** Codex sign-in state (for the picker + Settings → AI providers). */
  getCodexAuthStatus: () => Promise<CodexAuthStatus>
  /** Start Codex (ChatGPT OAuth) sign-in — spawns `codex login`, opens the browser, completes on the
   *  loopback callback. Watch onCodexLoginProgress for steps. `ok:false` if one's already in flight. */
  startCodexLogin: () => Promise<AuthLoginStartResult>
  /** Abort an in-flight Codex sign-in (user backed out). */
  cancelCodexLogin: () => Promise<void>
  /** Subscribe to Codex login state-machine steps; returns an unsubscribe fn. */
  onCodexLoginProgress: (listener: (event: CodexLoginProgress) => void) => () => void
  // App preferences (the Settings pane).
  /** Read all app preferences. */
  getSettings: () => Promise<KodaSettings>
  /** Merge a partial update; returns the full, re-clamped settings (a live default-mode change also
   *  updates the gate so already-open windows pick it up for new sessions). */
  updateSettings: (patch: KodaSettingsPatch) => Promise<KodaSettings>
  /** DEV-only retest affordance: wipe all settings to defaults (re-shows onboarding). Returns the
   *  reset settings and broadcasts the change like updateSettings. */
  resetSettings: () => Promise<KodaSettings>
  /** Subscribe to "open Settings" from the app-menu item / ⌘,; returns an unsubscribe fn. */
  onOpenSettings: (listener: () => void) => () => void
  /** Subscribe to app-global settings changes (broadcast to every window so live gates re-sync);
   *  returns an unsubscribe fn. */
  onSettingsChanged: (listener: (settings: KodaSettings) => void) => () => void
  /** Subscribe to the pre-quit flush request: fire any pending debounced saves synchronously (the
   *  preload acks to main right after the listener returns); returns an unsubscribe fn. */
  onFlushState: (listener: () => void) => () => void
  // Preview surface (preview-surface.md).
  /** The window's static-preview entry URL. With an absolute `filePath` (the active editor tab),
   *  preview points at that file (if it's `.html`/`.htm` and inside the project); else the project-root
   *  `index.html`. Null if no project OR the target file doesn't exist (so the manual "Preview" button
   *  can hide itself rather than open onto the blank "nothing to preview" placeholder). */
  previewStaticUrl: (filePath?: string) => Promise<string | null>
  /** Re-run a session's last preview (dev command or static file) when it's been torn down — the
   *  "Restart preview" button. Resolves with the served URL (main also pushes `preview:show`), or
   *  rejects if the command fails to come up / the file is gone. */
  previewRestart: (sessionId: string, restart: PreviewRestart) => Promise<{ url: string }>
  /** Subscribe to "show this preview URL" pushes (the agent started the dev server, or the user hit
   *  Restart); returns an unsubscribe fn. The renderer opens/points the preview surface at the URL, on
   *  the editor of the session that triggered it (`sessionId`) — not whichever session is focused when
   *  it lands — and remembers `restart` so the preview can be brought back after it's gone. */
  onPreviewShow: (listener: (url: string, sessionId: string, restart: PreviewRestart) => void) => () => void
  /** Subscribe to main's "measure the preview iframe" requests (the agent called view_preview):
   *  reply via respondPreviewCapture with the iframe's rect, or null if no preview is showing.
   *  Returns an unsubscribe fn. */
  onPreviewCaptureRequest: (listener: (correlationId: string) => void) => () => void
  /** Answer a capture request with the preview iframe's on-screen rect (null = nothing to capture) and
   *  the window's devicePixelRatio (so main caps the capture by PHYSICAL pixels — the real token lever). */
  respondPreviewCapture: (correlationId: string, rect: PreviewRect | null, dpr: number) => void
  /** Persist a pasted/dropped image to the project's `.koda/scratch/` folder; returns its relative path. */
  saveScratchImage: (args: ScratchSaveRequest) => Promise<ScratchSaveResult>
  /** Page through this project's recent scratch images (newest first) for the Recent images strip. */
  listScratchImages: (args: ScratchListRequest) => Promise<ScratchListResult>
  /** Read a doc's presentation sidecar (table column widths, …). Empty `{}` when none/unreadable. */
  getDocMeta: (args: DocMetaGetRequest) => Promise<DocMeta>
  /** Persist a doc's presentation sidecar. Best-effort (a lost column width never breaks anything). */
  setDocMeta: (args: DocMetaSetRequest) => Promise<void>
  /** How heavy this project's always-injected memory pair is (status-bar pill + Settings → Memory). */
  getMemoryWeight: () => Promise<MemoryWeight>
  /** The behavior layer (Settings → Guardrails): the curated Koda pack + this project's rules/skills/subagents. */
  listGuardrails: () => Promise<GuardrailsLayer>
  /** Write a typed/pasted rule/skill/subagent straight to this project (the "Save" authoring path). */
  saveGuardrail: (args: GuardrailSaveRequest) => Promise<GuardrailSaveResult>
  /** Switch a bundled Koda default off/on for this project (Settings → Guardrails toggle). */
  setGuardrailEnabled: (args: GuardrailSetEnabledRequest) => Promise<void>
  /** Save an edited skill/subagent body into this project (forks a Koda default, overwrites a project one). */
  saveItemBody: (args: GuardrailSaveItemBodyRequest) => Promise<GuardrailSaveResult>
  /** Remove a project skill/subagent (delete the file); a fork of a Koda default restores that default. */
  removeGuardrailItem: (args: GuardrailItemRef) => Promise<void>
  /** Edit a Koda rule principle's wording for this project, or restore its default (`text: null`). */
  setRuleOverride: (args: GuardrailRuleOverrideRequest) => Promise<void>
  /** The skills gallery (Settings → Skills): the bundled Apache-2.0 catalog + each skill's active scopes. */
  listSkills: () => Promise<SkillState[]>
  /** Turn a catalog skill on/off globally or per-project (Settings → Skills). Effective next session. */
  setSkillActive: (args: SkillSetActiveRequest) => Promise<void>
  // Voice input (on-device push-to-talk dictation).
  /** Begin dictation; `started:false` ⇒ no on-device backend (the button flashes unavailable). */
  startVoice: () => Promise<VoiceStartResponse>
  /** Stop the active dictation. */
  stopVoice: () => Promise<void>
  /** Subscribe to dictation events (ready/partial/final/error/end); returns an unsubscribe fn. */
  onVoiceEvent: (listener: (event: VoiceEvent) => void) => () => void
  // Optional Playwright browser-testing capability.
  /** Current install state + the user's toggle (the Settings row renders from this on mount). */
  playwrightStatus: () => Promise<PlaywrightStatus>
  /** Turn it on → kick the background Chromium download; returns the now-'installing' status. */
  enablePlaywright: () => Promise<PlaywrightStatus>
  /** Subscribe to download progress (state + status line); returns an unsubscribe fn. */
  onPlaywrightProgress: (listener: (status: PlaywrightStatus) => void) => () => void
  // Runtime provisioning — Node / Python (Settings → Toolkit + the onboarding toolkit step).
  /** Whether the user already has this runtime, Koda installed it, or none yet — decides what to offer. */
  getRuntimeStatus: (runtime: RuntimeId) => Promise<RuntimeStatus>
  /** Kick the background install for one runtime (fire-and-forget); watch onRuntimeProgress for phases. */
  installRuntime: (runtime: RuntimeId) => Promise<RuntimeInstallResult>
  /** Subscribe to install progress (download/verify/extract/done/error); each event is tagged with its
   *  `runtime` so a row filters to its own. Returns an unsubscribe fn. */
  onRuntimeProgress: (listener: (event: RuntimeProgress) => void) => () => void
  // Onboarding sign-in (subscription OAuth).
  /** Read the current login/billing mode — drives the adaptive ✓ when already signed in. */
  detectAuth: () => Promise<AuthDetectResult>
  /** Start subscription OAuth (spawns the CLI, opens the browser); watch onAuthProgress for steps. */
  startLogin: () => Promise<AuthLoginStartResult>
  /** Submit the code copied from the browser (written to the login child's stdin). */
  submitAuthCode: (code: string) => Promise<void>
  /** Abort an in-flight login (user backed out). The existing credential is untouched. */
  cancelLogin: () => Promise<void>
  /** Subscribe to login progress (awaiting-code/verifying/completed/failed/…); returns an unsubscribe fn. */
  onAuthProgress: (listener: (event: AuthProgress) => void) => () => void
  // Billing mode (Settings → Account).
  /** Read the active billing mode + whether an API key is stored + the engine's mode-aware verdict. */
  getBillingState: () => Promise<BillingState>
  /** Recent daily usage rollups (newest first) for the Usage view's History section. */
  getUsageHistory: () => Promise<UsageHistoryDay[]>
  /** Validate + store an API key (encrypted) and switch to API billing. `ok:false` carries why. */
  saveApiKey: (key: string) => Promise<BillingSaveResult>
  /** Remove the stored key and switch back to subscription billing. Returns the fresh state. */
  removeApiKey: () => Promise<BillingState>
  /** Validate + store an OpenAI API key (encrypted) for Codex. `ok:false` carries why. */
  saveCodexApiKey: (key: string) => Promise<BillingSaveResult>
  /** Remove the stored OpenAI key and switch Codex back to the ChatGPT subscription. Returns fresh state. */
  removeCodexApiKey: () => Promise<BillingState>
  /** 'auto' mode: confirm continuing on the API key after hitting the plan limit, until `until` (the
   *  rejected window's resetsAt). Returns the fresh state (apiActive now true). */
  activateApiFallback: (req: ApiFallbackRequest) => Promise<BillingState>
  // Remote Control (Settings → Remote, remote-control-security.md Phase 0).
  /** Read the LAN server state (running/url/pairing code/devices/connected count) for the Remote pane. */
  getRemoteState: () => Promise<RemoteState>
  /** Start or stop the LAN remote server (persists the preference); returns the fresh state. */
  setRemoteEnabled: (args: RemoteSetEnabled) => Promise<RemoteState>
  /** Rotate the pairing code (the old one stops working); returns the fresh state. */
  newRemoteCode: () => Promise<RemoteState>
  /** Revoke a paired device by token; returns the fresh state. */
  revokeRemoteDevice: (args: RemoteRevoke) => Promise<RemoteState>
  /** Subscribe to remote-connection activity (the "remote session active" indicator); unsubscribe fn. */
  onRemoteActivity: (listener: (activity: RemoteActivity) => void) => () => void
  // Provider-outage watch (engine/status-watch.ts) — the status-bar pill.
  /** Subscribe to provider outage/recovery pushes; unsubscribe fn. */
  onProviderStatus: (listener: (e: ProviderStatusEvent) => void) => () => void
  /** Current down-state (engines mid-outage), for seeding a window that opens during one. */
  getProviderStatus: () => Promise<ProviderStatusEvent[]>
  // Cloud relay account (Phase 1b) — email-OTP sign-in shared by Mac + phone.
  /** Read whether the Mac is signed into the cloud relay account. */
  getRemoteAuth: () => Promise<RemoteAuthState>
  /** Send the 6-digit OTP code to an email; returns ok/error. */
  requestRemoteOtp: (args: RemoteRequestOtp) => Promise<RemoteOtpResult>
  /** Verify the code → signed in; returns ok/error + fresh state. */
  verifyRemoteOtp: (args: RemoteVerifyOtp) => Promise<RemoteOtpResult>
  /** Sign out of the cloud relay account; returns the fresh (signed-out) state. */
  signOutRemoteAccount: () => Promise<RemoteAuthState>
  // Cloud relay (Phase 1b outbound transport + QR pairing).
  /** Read the relay state (signed-in / connected / paired). */
  getRelayState: () => Promise<RemoteRelayState>
  /** Whether the from-anywhere cloud tier is enabled on this Mac (LAN-only release flag). */
  getCloudRelayEnabled: () => Promise<boolean>
  /** Start the relay (if needed) and issue a pairing blob for the QR; returns the blob + fresh state. */
  pairRelayDevice: () => Promise<RemoteRelayPairing>
  /** Forget the paired phone (drop the relay + relay keys), staying signed in; returns fresh state. */
  forgetRelayDevice: () => Promise<RemoteRelayState>
  /** Subscribe to relay pairing-activity changes; returns an unsubscribe fn. */
  onRelayActivity: (listener: (state: RemoteRelayState) => void) => () => void
  // Terminal surface (a Dock tool — a real interactive shell in the window's project).
  /** Spawn (or re-ensure) the window's shell at this size; respawns if the prior one exited. */
  startTerminal: (size: TerminalSize) => Promise<TerminalStartResult>
  /** Send typed keystrokes to the shell's stdin. */
  sendTerminalInput: (args: TerminalInput) => void
  /** Tell the shell the viewport resized (so full-screen TUIs reflow). */
  resizeTerminal: (size: TerminalSize) => void
  /** Subscribe to shell output; returns an unsubscribe fn. */
  onTerminalData: (listener: (chunk: TerminalData) => void) => () => void
  /** Subscribe to the shell-exited signal; returns an unsubscribe fn. */
  onTerminalExit: (listener: (info: TerminalExit) => void) => () => void
  /** Subscribe to "pop the terminal shelf" pushes (the agent's open_terminal tool). The renderer opens
   *  the shelf and, if `command` is set, stages it at the prompt for the user to run. Returns an
   *  unsubscribe fn. */
  onTerminalShow: (listener: (info: TerminalShow) => void) => () => void
}
