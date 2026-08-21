import { z } from 'zod'

/**
 * The typed IPC contract. Zod schemas validate at the main-process boundary;
 * the inferred types flow to the renderer through the preload bridge.
 *
 * This is the whole product surface, grouped by subsystem under the `// ── … ──`
 * banners: the engine adapter's normalized event vocabulary (THE portability
 * boundary — see architecture/engine-adapter-and-output-view.md), the approval
 * gate, dual-git (safety + user), project files, terminal, remote control, and
 * settings, among others. Not every subsystem has a banner yet — preview and
 * mini apps carry schemas here without one.
 *
 * Adding a call means touching four layers in step: a name in
 * `shared/channels.ts`, schemas/types here, a handler in `src/main/ipc.ts`, and
 * a method on `KodaApi` wired in `src/preload/index.ts`.
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
  /** The account state is unknown because the local Codex probe failed; never present on older clients. */
  probeFailed: z.boolean().optional(),
})
export type CodexAuthStatus = z.infer<typeof CodexAuthStatusSchema>

/** UI-neutral model catalog returned for every registered engine. Provider-specific probes are
 *  normalized here so desktop and phone render the same ready/empty/auth/error state instead of
 *  independently interpreting Codex-shaped transport fields. */
export const ProviderCatalogAvailabilitySchema = z.enum([
  'ready',
  'checking',
  'signed-out',
  'probe-failed',
  'empty',
])
export type ProviderCatalogAvailability = z.infer<typeof ProviderCatalogAvailabilitySchema>

export const ProviderModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
})
export type ProviderModel = z.infer<typeof ProviderModelSchema>

export const ProviderModelCatalogSchema = z.object({
  availability: ProviderCatalogAvailabilitySchema,
  models: z.array(ProviderModelSchema),
})
export type ProviderModelCatalog = z.infer<typeof ProviderModelCatalogSchema>

export const ProviderModelCatalogsSchema = z.record(EngineIdSchema, ProviderModelCatalogSchema)
export type ProviderModelCatalogs = Record<EngineId, ProviderModelCatalog>

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
})

/** Dynamic, per-session capability truth. `engine-capabilities.ts` describes what a DRIVER knows how
 * to do; this describes what the spawned engine actually loaded in this cwd. Keep the two separate:
 * configuration is intent, while this snapshot is runtime evidence. */
export const SessionCapabilityStatusSchema = z.enum(['ready', 'disabled', 'installable', 'degraded'])
export type SessionCapabilityStatus = z.infer<typeof SessionCapabilityStatusSchema>

export const SessionCapabilitySchema = z.object({
  id: z.enum(['koda-tools', 'playbooks', 'browser-testing']),
  label: z.string(),
  status: SessionCapabilityStatusSchema,
  /** A short diagnostic, present only when it helps explain a non-ready state. */
  detail: z.string().optional(),
})
export type SessionCapability = z.infer<typeof SessionCapabilitySchema>

export const SessionMcpServerSchema = z.object({
  name: z.string(),
  status: z.string(),
  /** Bare server-local tool names; the snapshot's top-level `tools` list is fully namespaced. */
  tools: z.array(z.string()),
})
export type SessionMcpServer = z.infer<typeof SessionMcpServerSchema>

export const SessionCapabilitySnapshotSchema = z.object({
  engine: EngineIdSchema,
  cwd: z.string(),
  observedAt: z.number().int().nonnegative(),
  source: z.enum(['engine-init', 'native-probe']),
  capabilities: z.array(SessionCapabilitySchema),
  /** Exact runtime inventory, useful for diagnosis and future capability surfaces. */
  tools: z.array(z.string()),
  skills: z.array(z.string()),
  agents: z.array(z.string()),
  plugins: z.array(z.string()),
  mcpServers: z.array(SessionMcpServerSchema),
})
export type SessionCapabilitySnapshot = z.infer<typeof SessionCapabilitySnapshotSchema>

/** Emitted after startup attestation and again only when native engine evidence changes. */
export const SessionCapabilitiesUpdatedSchema = z.object({
  type: z.literal('SessionCapabilitiesUpdated'),
  sessionId: z.string(),
  snapshot: SessionCapabilitySnapshotSchema,
})

/**
 * How an engine reattaches its own conversation — an OPAQUE, driver-owned blob. Koda stores it,
 * persists it, and hands it back on a reattach; only the driver that minted it reads or validates
 * `data` (Claude: its session id + turn count; Codex: its thread id). Two envelope fields are
 * engine-neutral on purpose: `engine` routes the blob back to its owner, and `resumable` is the
 * driver's own answer to "is there a conversation here yet" — the shared layer needs that to decide
 * whether a respawn reattaches or starts clean, and guessing it from disk was never reliable.
 */
export const ResumeCursorSchema = z.object({
  engine: EngineIdSchema,
  resumable: z.boolean(),
  data: z.record(z.string(), z.unknown()),
})
export type ResumeCursor = z.infer<typeof ResumeCursorSchema>

/** The driver's resume state changed (session start, and after every turn it completes). The renderer
 *  persists the latest one so a restart can hand it straight back. */
export const ResumeCursorUpdatedSchema = z.object({
  type: z.literal('ResumeCursorUpdated'),
  sessionId: z.string(),
  cursor: ResumeCursorSchema,
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

/** Incremental output from a still-running tool. The final ToolResult remains authoritative. */
export const ToolProgressSchema = z.object({
  type: z.literal('ToolProgress'),
  sessionId: z.string(),
  id: z.string(),
  output: z.string(),
})

/** The engine's current turn plan, normalized into the same statuses as Koda's task list. */
export const PlanUpdateSchema = z.object({
  type: z.literal('PlanUpdate'),
  sessionId: z.string(),
  steps: z.array(z.object({ id: z.string(), subject: z.string(), status: z.string() })),
})

/** The engine replaced older thread context with a compact summary and continued. */
export const ContextCompactedSchema = z.object({
  type: z.literal('ContextCompacted'),
  sessionId: z.string(),
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

/** A context-only refresh outside turn completion, used when compaction usage arrives late. */
export const ContextUsageUpdateSchema = z.object({
  type: z.literal('ContextUsageUpdate'),
  sessionId: z.string(),
  context: ContextUsageSchema,
})

/**
 * Per-model usage for ONE turn, normalized at the provider adapter. Lists every model the turn
 * identified, each with its own reported cost + token split (cache called out). `costUsd` is zero when
 * the provider reports tokens but no authoritative dollar cost. Accumulated in the store to drive the
 * Usage view's by-model breakdown. `model` is the engine's raw id, passed through opaquely — display
 * only, never branched on.
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

/** Terminal reason paired with a pre-start rejection. New clients use EngineError.category to offer
 * retry; the companion TurnComplete keeps pre-category clients from leaving busy latched and explicitly
 * says no turn succeeded. There is no client-version negotiation yet, so those builds may still treat
 * any TurnComplete as a success haptic — an unavoidable compatibility tradeoff, not a clean guarantee. */
export const TURN_REJECTED_STOP_REASON = 'turn_rejected' as const

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
  /** `apiError`: a turn-level API failure the CLI surfaced as assistant text (a 5xx/429/auth error),
   *  lifted out of the transcript into the composer error banner. Non-fatal (the process lives; the turn
   *  just failed), so this flag — not `fatal` — is what tells the UI to show the retryable banner.
   *  `turnRejected`: the live process rejected this turn before it started; the process remains reusable,
   *  but the turn is terminal and retryable.
   *  `resumeMiss`: the driver asked its engine to reattach a conversation the engine no longer holds.
   *  Consumed by the session manager (it restarts the session clean and posts the recovery notice), so
   *  it never reaches a surface. */
  category: z.enum(['apiError', 'turnRejected', 'resumeMiss']).optional(),
})

/** The severity the provider's status page is reporting, so the chip's word stays honest — a slowdown is
 *  never called an "outage". Ranked worst-first in the watcher; the renderer maps each to a plain word. */
export const ProviderKindSchema = z.enum(['outage', 'partial', 'degraded', 'maintenance'])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

/** Provider-health state (main→renderer push over `providerStatus`, seeded by `providerStatusGet`).
 *  Emitted only for feed-CONFIRMED incidents; `down: false` clears it. */
export const ProviderStatusEventSchema = z.object({
  engine: z.string(),
  down: z.boolean(),
  /** Human-readable incident line for the tooltip (e.g. the status page's incident name). */
  note: z.string().optional(),
  /** Reported severity — drives the chip word (outage / degraded / …). Absent when `down: false`. */
  kind: ProviderKindSchema.optional(),
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
  /** Engine task id — distinct from the Agent tool_use id; required for a targeted stop. */
  taskId: z.string().optional(),
  subagentType: z.string(),
  description: z.string(),
  prompt: z.string().optional(),
})

/** Live status while the subagent works — from system/task_progress + task_notification. */
export const SubagentProgressSchema = z.object({
  type: z.literal('SubagentProgress'),
  sessionId: z.string(),
  toolUseId: z.string(),
  taskId: z.string().optional(),
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
  taskId: z.string().optional(),
  resultText: z.string().optional(),
  /** A user-targeted stop is distinct from a failed or successful finished child. */
  outcome: z.enum(['completed', 'interrupted', 'unknown']).optional(),
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

/** Koda stopped observing a workflow before it could confirm completion. One event settles both the
 * coordinator and every unresolved member so no surface can retain a half-live state. */
export const WorkflowObservationEndedSchema = z.object({
  type: z.literal('WorkflowObservationEnded'),
  sessionId: z.string(),
  runId: z.string(),
  unresolvedAgentIds: z.array(z.string()),
})

// ── Account rate-limit windows (the 5-hour + weekly subscription caps) ───────
//
// DISTINCT from context-window usage (ContextUsage, per-conversation token budget).
// These are the ACCOUNT-level subscription windows — the same ones the TUI's /usage
// shows. The engine emits a `rate_limit_event` on every turn carrying the currently
// binding window (verified vs the real CLI 2.1.187): its type, reset time, and a
// coarse status band. Since ~2026-07 (verified 07-22 vs 2.1.205) the event also
// carries a precise `utilization`, and the server may report only windows near
// their cap — a quiet window is simply absent. All fields are pass-through DISPLAY
// ONLY (no Koda subsystem branches on `rateLimitType` for behavior).
export const RateLimitInfoSchema = z.object({
  /** 'five_hour' | 'weekly' | 'seven_day' (engine vocabulary; rendered to a human label). */
  rateLimitType: z.string(),
  /** Unix seconds when this window resets. */
  resetsAt: z.number(),
  /** Coarse band → the dot color: 'allowed' (green) | 'warning' (amber) | 'rejected' (red). */
  status: z.string(),
  /** True when the account is currently spending overage past the window. */
  isUsingOverage: z.boolean().optional(),
  /** Real % of the window consumed (0–100) WHEN the engine reports it — Codex's app-server gives an
   *  exact `usedPercent`; the Claude stream carries `utilization` since ~2026-07 (mapped to this).
   *  Display-only, a measured fill not an estimate. Absent ⇒ render band-only (no bar). */
  usedPercent: z.number().optional(),
  /** Milliseconds since epoch when Koda observed this fact. Optional for persisted back-compat. */
  observedAt: z.number().optional(),
  /** Provenance used by the reconciler; stronger complete reads cannot be displaced by sparse pushes. */
  source: z.enum(['disk', 'stream', 'poll', 'snapshot']).optional(),
})
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>

/** `rateLimitType` (engine vocabulary) → the human word for that window (the status bar's gauge label). */
export function windowLabel(type: string): string {
  if (type === 'five_hour') return '5-hour'
  // Claude reports its weekly cap as 'seven_day'; same human word as Codex's 'weekly'.
  if (type === 'weekly' || type === 'seven_day') return 'weekly'
  // A per-model weekly cap ('seven_day_fable') — its own window, named so it reads as one.
  if (type.startsWith('seven_day_')) return `weekly · ${type.slice('seven_day_'.length).replace(/_/g, ' ')}`
  return type.replace(/_/g, ' ')
}

/** Session usage as one snapshot — context fill + spend from the persisted session, account windows
 *  from the live stream. Rides the remote transcript reply so a phone joining a session seeds its
 *  meters immediately instead of showing nothing until the next turn reports them. Same shape the
 *  phone accumulates live from the event stream (its SessionUsage). */
export type RemoteUsageSnapshot = {
  spendUsd: number
  byModel: Record<string, ModelSpend>
  context?: ContextUsage
  /** Account-level windows for EVERY engine (engine → rateLimitType → info, newest wins) — the plan
   *  panel labels each engine's windows, so it carries both plans regardless of the session's engine. */
  rateLimits: Record<string, Record<string, RateLimitInfo>>
}

/** The latest noteworthy terminal state of one live session, exposed in the phone launcher. Main owns
 *  the fact; each remote head owns whether it has seen a successful completion. The opaque revision must
 *  change at every terminal edge so a persisted phone acknowledgement cannot hide later work. */
export type RemoteTerminalAttention = {
  kind: 'done' | 'error'
  revision: string
}

/** A rate-limit window update (account-level, not per-session) — surfaced in the status bar.
 *  Carries `sessionId` per the envelope rule, but the renderer keys the global map by rateLimitType
 *  (newest wins across all sessions) since the windows are an account fact, not a session fact. */
export const RateLimitUpdateSchema = z.object({
  type: z.literal('RateLimitUpdate'),
  sessionId: z.string(),
  /** Stamped by the emitting driver — the authoritative attribution. A receiver inferring the engine
   *  from its own session state can misfile a window when that state is cold (the phone's cold-open). */
  engine: EngineIdSchema.optional(),
  info: RateLimitInfoSchema,
  /** When present, this update came from an AUTHORITATIVE full snapshot (Codex's `account/rateLimits/read`),
   *  and this array is the COMPLETE set of window types the engine currently reports. Receivers prune any
   *  window for this engine NOT in the list — that's how a stale slot (a window the plan stopped reporting,
   *  whose real reset is far off) gets dropped instead of lingering as a ghost. Absent ⇒ a sparse push:
   *  merge only, never prune (Claude's per-turn stream, Codex's opportunistic `updated` push). */
  authoritativeTypes: z.array(z.string()).optional(),
  /** Main's reconciled truth after applying this update. New desktop heads replace their local engine
   *  map with it; optional so older Mac/phone versions keep their merge-only behavior. */
  reconciledWindows: z.record(z.string(), RateLimitInfoSchema).optional(),
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

const ReplaySequenceSchema = z.object({
  /** Stable identity inside one session's durable replay. Present only once a phone/headless replay
   *  log owns the event; optional keeps ordinary local streams and older sidecars compatible. */
  replaySeq: z.number().int().positive().optional(),
})

/** The native event a normalized one was translated from, plus the engine's own ids for it. Koda's
 *  typed vocabulary stays deliberately small, so this is what keeps it from being LOSSY: whatever the
 *  engine said is still attached when a later question needs an unmapped field, without a new spike
 *  into the wire format. Drivers stamp it; `stripRawEnvelope` drops it at the serialization doors (see
 *  sessions.ts `forward`), so it is a main-process diagnostic, not renderer/phone/disk payload.
 *
 *  Present on every event translated from an engine message. Events Koda MINTS itself (a resume
 *  cursor, a spawn failure, a workflow watcher's progress) have no native message and carry none —
 *  absent means "Koda said this", not "the engine's words were lost". */
export const RawEngineEventSchema = z.object({
  /** Which engine's wire this came off. */
  source: EngineIdSchema,
  /** The engine's own name for the message — Claude's `type`/`subtype`, Codex's JSON-RPC method. */
  method: z.string(),
  /** The engine's ids for this message (Claude: tool_use_id/task_id; Codex: itemId/turnId/threadId),
   *  kept flat so a fold over events can join children to parents without reparsing the payload. */
  ids: z.record(z.string(), z.string()).optional(),
  /** The native message verbatim. Unknown by design — nothing above the driver interprets it. */
  payload: z.unknown().optional(),
})
export type RawEngineEvent = z.infer<typeof RawEngineEventSchema>

const RawEnvelopeSchema = z.object({
  raw: RawEngineEventSchema.optional(),
})

export const EngineEventSchema = z
  .discriminatedUnion('type', [
    SessionStartedSchema,
    SessionCapabilitiesUpdatedSchema,
    ResumeCursorUpdatedSchema,
    AssistantDeltaSchema,
    ThinkingDeltaSchema,
    AssistantBlockSchema,
    ToolRequestedSchema,
    ToolProgressSchema,
    ToolResultSchema,
    PlanUpdateSchema,
    ContextCompactedSchema,
    ContextUsageUpdateSchema,
    TurnCompleteSchema,
    EngineErrorSchema,
    SubagentStartedSchema,
    SubagentProgressSchema,
    SubagentCompletedSchema,
    WorkflowStartedSchema,
    WorkflowAgentSchema,
    WorkflowCompletedSchema,
    WorkflowObservationEndedSchema,
    RateLimitUpdateSchema,
    ApprovalModeChangedSchema,
    ModelEffortChangedSchema,
  ])
  .and(ReplaySequenceSchema)
  .and(RawEnvelopeSchema)
export type EngineEvent = z.infer<typeof EngineEventSchema>

/** Drop the native envelope before an event is serialized to disk or sent to another process. The
 *  payload roughly doubles every event, and no surface outside main reads it — losslessness is for
 *  answering "what did the engine actually say", which is a main-process question. */
export function stripRawEnvelope<T extends { raw?: RawEngineEvent }>(event: T): T {
  if (!event.raw) return event
  const { raw: _raw, ...rest } = event
  return rest as T
}

/** Passive completion truth for one live session. `none` means this task has no known loose work,
 * not that the aggregate worktree is clean. `mixedPaths` were already dirty at the turn boundary;
 * Koda knows this task changed them but cannot claim ownership of the earlier hunks. */
export const TaskCompletionStateSchema = z.object({
  sessionId: z.string(),
  state: z.enum(['none', 'loose-ends', 'needs-check', 'unversioned']),
  paths: z.array(z.string()).max(500),
  mixedPaths: z.array(z.string()).max(500).default([]),
  // Only real evidence failures. Concurrent writers in one tree are ordinary parallel work, not a
  // user-facing warning: that reason fired on every multi-session day and could not be resolved from
  // the UI, so it read as permanent decoration. The overlap signal still exists as internal
  // attribution evidence (`CompletionTurnBoundary.overlappingWriters`); it just never reaches a badge.
  // The structural fix is separate workspaces — Documents/architecture/session-workstream-isolation.md.
  reason: z.enum(['checkpoint-failed', 'git-probe-failed']).optional(),
})
export type TaskCompletionState = z.infer<typeof TaskCompletionStateSchema>
export const TaskCompletionStatesSchema = z.array(TaskCompletionStateSchema)

/** A safety checkpoint id is always a git SHA. Presentation receipts carry the same portable handle
 * as Recovery, so define the boundary once before either contract uses it. */
export const CheckpointIdSchema = z.string().regex(/^[0-9a-f]{7,40}$/)

/** Portable file identity carried by Koda's presentation plane. Main derives the workspace root from
 * `sessionId`; clients and agents may name only a normalized workspace-relative POSIX path. */
export const StageWorkspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      path !== '.' &&
      path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'expected a normalized workspace-relative path',
  )

const StageLocationSchema = z
  .object({
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .superRefine(({ line, column }, ctx) => {
    if (column !== undefined && line === undefined)
      ctx.addIssue({ code: 'custom', path: ['column'], message: 'column requires line' })
  })

export const PresentFileStageReceiptSchema = z
  .object({
    kind: z.literal('present-file'),
    id: z.string().min(1).max(160),
    sessionId: z.string().min(1),
    path: StageWorkspacePathSchema,
    view: z.enum(['document', 'file', 'diff']),
    /** Required for diff view: the safety-git baseline is the portable meaning of this diff. */
    checkpointId: CheckpointIdSchema.optional(),
  })
  .and(StageLocationSchema)
  .superRefine(({ view, line, checkpointId }, ctx) => {
    if (line !== undefined && view !== 'file')
      ctx.addIssue({ code: 'custom', path: ['line'], message: 'locations require the file view' })
    if (view === 'diff' && checkpointId === undefined)
      ctx.addIssue({ code: 'custom', path: ['checkpointId'], message: 'diff view requires a checkpoint' })
    if (view !== 'diff' && checkpointId !== undefined)
      ctx.addIssue({ code: 'custom', path: ['checkpointId'], message: 'checkpoint requires the diff view' })
  })

/** Deliberately mirrors safety-git's changed-file evidence without importing a main-process module. */
export const StageChangedFileSchema = z.object({
  path: StageWorkspacePathSchema,
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
})

export const TurnChangesStageReceiptSchema = z.object({
  kind: z.literal('turn-changes'),
  id: z.string().min(1).max(160),
  sessionId: z.string().min(1),
  /** The safety-git baseline for exact diffs, absent only when checkpoint evidence failed. */
  checkpointId: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  files: z.array(StageChangedFileSchema).max(500),
  complete: z.boolean(),
  overlapObserved: z.boolean().default(false),
})

export const StageReceiptSchema = z.union([
  PresentFileStageReceiptSchema,
  TurnChangesStageReceiptSchema,
])
export type StageReceipt = z.infer<typeof StageReceiptSchema>
export const StageReceiptsSchema = z.array(StageReceiptSchema).max(1000)

export const ResolveStageLinkRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  href: z.string().trim().min(1).max(8192),
})
export type ResolveStageLinkRequest = z.infer<typeof ResolveStageLinkRequestSchema>

export const StageLinkTargetSchema = z.union([
  z
    .object({
      kind: z.literal('file'),
      path: StageWorkspacePathSchema,
      /** Desktop-only projection. Remote doors intentionally omit absolute paths. */
      absolutePath: z.string().min(1).optional(),
    })
    .and(StageLocationSchema),
  z.object({ kind: z.enum(['declined', 'missing']), reason: z.string().optional() }),
])
export type StageLinkTarget = z.infer<typeof StageLinkTargetSchema>

/** An inline image attached to a turn — base64 + its media type. `name` is present for a phone-side
 * document attachment that uses the same transport envelope. */
export const ImageAttachmentSchema = z.object({
  mediaType: z.string(), // image/png | image/jpeg | image/gif | image/webp
  dataBase64: z.string(),
  name: z.string().optional(),
})
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>

/** Lightweight attachment identity safe to retain after a successful turn. Exact base64 bytes are
 * bounded, temporary retry material; replay keeps only this provenance unless the turn is unresolved. */
export const AttachmentProvenanceSchema = z.object({
  mediaType: z.string(),
  name: z.string().optional(),
})
export type AttachmentProvenance = z.infer<typeof AttachmentProvenanceSchema>

/** The phone's transport attempt and the human's logical turn are deliberately separate identities.
 * A lost ack retries the same attempt; an engine failure creates a new attempt for the same client turn. */
export const RemoteTurnIdentitySchema = z.object({
  attemptId: z.string().min(1).max(160).optional(),
  clientTurnId: z.string().min(1).max(160).optional(),
})
export type RemoteTurnIdentity = z.infer<typeof RemoteTurnIdentitySchema>

/** Main's admission receipt lets a recovering phone distinguish a resend that is still running from
 * one whose completion happened while the app was gone. Older Macs omit it; clients treat that as a
 * fresh acceptance and continue listening for the ordinary terminal event. */
export const RemoteTurnReceiptSchema = z.object({
  status: z.enum(['accepted', 'already-running', 'already-complete']),
})
export type RemoteTurnReceipt = z.infer<typeof RemoteTurnReceiptSchema>

/** Total exact attachment payload retained for one unresolved retry. Larger turns keep provenance and
 * require reattachment, rather than growing replay/localStorage without bound. */
export const MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS = 2_000_000

/** Exact bytes admitted to durable replay/failure state. Turn transport keeps its existing independent
 * request limits; this cap protects sidecar/local hydration even when data bypasses normal intake. */
export const DurableAttachmentPayloadSchema = z
  .array(ImageAttachmentSchema)
  .min(1)
  .superRefine((attachments, ctx) => {
    const total = attachments.reduce((chars, attachment) => chars + attachment.dataBase64.length, 0)
    if (total > MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS)
      ctx.addIssue({ code: 'custom', message: 'durable attachment payload exceeds the retry cap' })
  })

/** The user's own turn text, captured for the replay log. The engine event stream never carries the
 *  human's prompts (each renderer adds them optimistically when it sends) — so a phone session's
 *  buffered history would be missing the user's side. The manager records one of these per remote turn,
 *  interleaved with the engine events, so the adopted transcript shows both halves of the conversation. */
export const RemoteUserTurnSchema = z.object({
  type: z.literal('RemoteUserTurn'),
  sessionId: z.string(),
  text: z.string(),
  /** Stable logical phone bubble. Repeated engine attempts may emit another replay boundary with the
   * same id; transcript reducers reconcile those boundaries to one visible user row. */
  clientTurnId: z.string().min(1).max(160).optional(),
  hadAttachments: z.boolean().optional(),
  attachments: z.array(AttachmentProvenanceSchema).min(1).optional(),
  /** True when the original send included an image even if its bytes were not retained in this replay.
   * Optional for older replay sidecars; consumers treat the legacy `(image)` sentinel conservatively. */
  hadImages: z.boolean().optional(),
  /** Exact retry bytes when the owning surface durably retained them. A missing array with hadImages=true
   * means "ask for the images again", never "send the caption by itself". */
  images: DurableAttachmentPayloadSchema.optional(),
  replaySeq: z.number().int().positive().optional(),
})
export type RemoteUserTurn = z.infer<typeof RemoteUserTurnSchema>

/** Stable identity + exact send material for one failed user turn. Transcript ids survive ordinary
 * persistence; replay ids survive reconstruction. At least one is required so a retry never falls back
 * to whichever user row happens to be newest after pagination or reconnect. */
export const TurnFailureTargetSchema = z
  .object({
    userId: z.number().int().positive().optional(),
    replaySeq: z.number().int().positive().optional(),
    clientTurnId: z.string().min(1).max(160).optional(),
    text: z.string(),
    hadImages: z.boolean(),
    hadAttachments: z.boolean().optional(),
    attachments: z.array(AttachmentProvenanceSchema).min(1).optional(),
    images: DurableAttachmentPayloadSchema.optional(),
  })
  .superRefine((target, ctx) => {
    if (
      target.userId === undefined &&
      target.replaySeq === undefined &&
      target.clientTurnId === undefined
    )
      ctx.addIssue({ code: 'custom', message: 'a failed turn needs a stable user identity' })
    const exactHasImage = target.images?.some((item) => item.mediaType.startsWith('image/')) === true
    const exactHasDocument = target.images?.some((item) => !item.mediaType.startsWith('image/')) === true
    if (exactHasImage && !target.hadImages)
      ctx.addIssue({ code: 'custom', message: 'retained image bytes require hadImages=true' })
    if (exactHasDocument && target.hadAttachments !== true)
      ctx.addIssue({ code: 'custom', message: 'retained document bytes require hadAttachments=true' })
    if (target.attachments?.length && target.hadAttachments !== true)
      ctx.addIssue({ code: 'custom', message: 'attachment provenance requires hadAttachments=true' })
  })
export type TurnFailureTarget = z.infer<typeof TurnFailureTargetSchema>

/** One canonical, raw-free durable terminal failure. The same envelope can ride its user transcript row
 * and the top level of a transcript response, so a relay page cut cannot separate retry semantics from
 * the target. `target` is absent only when the engine failed before any user turn existed. */
export const TurnFailureEnvelopeSchema = z
  .object({
    error: EngineErrorSchema.and(ReplaySequenceSchema),
    target: TurnFailureTargetSchema.optional(),
  })
  .superRefine(({ error }, ctx) => {
    if (!error.fatal && error.category !== 'apiError' && error.category !== 'turnRejected')
      ctx.addIssue({ code: 'custom', message: 'only retryable terminal failures are durable' })
  })
export type TurnFailureEnvelope = z.infer<typeof TurnFailureEnvelopeSchema>

/** One item in a headless session's replay log — either a normalized engine event or a captured user
 *  turn. Replayed in order to rebuild the transcript. */
export const ReplayEntrySchema = z.union([EngineEventSchema, RemoteUserTurnSchema])
export type ReplayEntry = z.infer<typeof ReplayEntrySchema>

/** Main-owned workflow observation that survives a renderer reload. Unlike transcript status, this is
 * ephemeral runtime truth: the run id identifies the watcher and the member ids are its unresolved set. */
export const ActiveWorkflowSnapshotSchema = z.object({
  runId: z.string(),
  runningAgentIds: z.array(z.string()),
})
export type ActiveWorkflowSnapshot = z.infer<typeof ActiveWorkflowSnapshotSchema>

/** A live session the renderer is adopting: either a phone-started/windowless engine or one this same
 *  BrowserWindow still owns after its renderer reloaded. Its replay log rebuilds any missing live
 *  transcript state. `model` is the user's chosen model (undefined ⇒ engine default); the label comes
 *  from the persisted store when main already settled one, and is derived from replay otherwise. */
export const AdoptedHeadlessSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  engineId: EngineIdSchema,
  model: z.string().optional(),
  effort: z.string().optional(),
  /** The label main already settled (auto-title or phone rename) — adoption uses it verbatim instead
   *  of regenerating, so a name the user has seen never changes on open. */
  label: z.string().optional(),
  userNamed: z.boolean().optional(),
  /** True only when the live engine was started or resumed from the phone. Optional so a renderer can
   *  survive a mixed-version development reload while main and preload restart at different times. */
  fromRemote: z.boolean().optional(),
  /** The gate's ACTUAL posture for this session (not the window's default) — a phone-started session
   *  may have had its mode changed before any window ever opened. The tab must display what's really
   *  enforced, never a guessed default that could silently show a looser posture than the gate has. */
  approvalMode: ApprovalModeSchema,
  /** Main-process truth at the instant ownership moves to this window. A renderer may already have a
   *  cold copy of the same session after a window close/reopen; these fields distinguish an actually
   *  live parent/child from transcript-only states that hydration correctly settled as inactive. */
  working: z.boolean().optional(),
  activeSubagentToolUseIds: z.array(z.string()).optional(),
  activeWorkflows: z.array(ActiveWorkflowSnapshotSchema).optional(),
  /** Latest main-owned runtime capability evidence. Ephemeral: adoption carries it across renderer
   *  ownership changes, but it never enters transcript persistence or replay. */
  capabilities: SessionCapabilitySnapshotSchema.optional(),
  /** Latest replaceable Stage intent, carried across a renderer reload/adoption but not transcript. */
  stageReceipts: z.array(StageReceiptSchema).max(2).optional(),
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
export const RemoteUserTurnLiveSchema = z.object({
  sessionId: z.string(),
  text: z.string(),
  clientTurnId: z.string().min(1).max(160).optional(),
  hadAttachments: z.boolean().optional(),
  attachments: z.array(AttachmentProvenanceSchema).min(1).optional(),
  /** True when the original turn included inline image bytes. Optional only for an older main process;
   * current senders include it even when false so a renderer never has to infer from display text. */
  hadImages: z.boolean().optional(),
  /** Exact retry bytes. The initial live publish carries inline images; if the attempt fails, main may
   * update the same row with its bounded whole attachment set, including documents. Missing bytes with
   * attachment provenance means the user must reattach rather than silently retrying partial work. */
  images: z.array(ImageAttachmentSchema).min(1).optional(),
  replaySeq: z.number().int().positive().optional(),
  /** Remote turns append a bubble; a local turn already has an optimistic bubble and only needs its
   *  durable replay identity stamped onto that row. Optional defaults to append for older senders. */
  append: z.boolean().optional(),
})
export type RemoteUserTurnLive = z.infer<typeof RemoteUserTurnLiveSchema>

// ── Engine adapter: renderer→main commands ───────────────────────────────────

export const StartSessionRequestSchema = z.object({
  /** Project working directory; defaults to the engine's launch cwd if omitted. */
  cwd: z.string().optional(),
  /** Spawn under this exact session id (a restart, a posture respawn, or the phone's chosen id).
   *  Omitted ⇒ a fresh id is minted. Whether the engine REATTACHES its conversation is `resumeCursor`'s
   *  job, not this field's. */
  sessionId: z.string().optional(),
  /** The driver-owned resume blob this session last reported (`ResumeCursorUpdated`), handed straight
   *  back so the engine reattaches its own conversation. Opaque here; the owning driver validates it and
   *  starts clean if it can't. Absent ⇒ a fresh conversation. Pair with the same `cwd` the session was
   *  created in (resume is cwd-scoped; spike/resume). */
  resumeCursor: ResumeCursorSchema.optional(),
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
  /** Highest durable replay identity already rendered for this restored session. Carries the cursor
   *  across archive→resume even if the renderer's debounced project save has not landed yet. */
  replaySeq: z.number().int().nonnegative().optional(),
})
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>

/** cwd + the resolved fresh-session posture are echoed back so main remains the one durable owner of
 *  what the next chat starts on. Posture stays optional for compatibility with an older main. */
export const StartSessionResponseSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  engineId: EngineIdSchema.optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
})
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>

export const SendTurnRequestSchema = z
  .object({
    sessionId: z.string(),
    text: z.string(), // may be empty when images are attached
    images: z.array(ImageAttachmentSchema).optional(),
    attemptId: z.string().min(1).max(160).optional(),
    clientTurnId: z.string().min(1).max(160).optional(),
  })
  // A turn must carry SOMETHING — text or at least one image.
  .refine((r) => r.text.trim().length > 0 || (r.images?.length ?? 0) > 0, {
    message: 'a turn needs text or an image',
  })
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>

/** Shared shape for the session-targeted commands that take no other args. */
export const SessionRefSchema = z.object({ sessionId: z.string() })
export type SessionRef = z.infer<typeof SessionRefSchema>

/** Stop one background child without interrupting the parent conversation or its other children. */
export const StopSubagentRequestSchema = z.object({ sessionId: z.string(), taskId: z.string() })
export type StopSubagentRequest = z.infer<typeof StopSubagentRequestSchema>

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
  /** Present only for a session Stage diff. Main validates window ownership and derives that cwd;
   * Recovery omits it and stays anchored to the sender window's project root. */
  sessionId: z.string().min(1).optional(),
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

// ── Session naming: the sessions map's title + overview ──────────────────────
//
// sessions:name — name a thread through the app-global generated-text choice. A selected Claude or
// Codex model uses the schema-constrained initial/regenerate split; Apple Intelligence or plain local
// text supplies the safe initial-title floor. Main never throws, and `overview` may be empty when only
// the floor answered.

export const SessionNameKindSchema = z.enum(['initial', 'regenerate'])
export type SessionNameKind = z.infer<typeof SessionNameKindSchema>

export const SessionNameRequestSchema = z.object({
  /** Which flavour of the prompt split to run. */
  kind: SessionNameKindSchema,
  /** The evidence to name from: the user's own messages first, then what the agent did. */
  evidence: z.string(),
  /** The title the session carries now — a regenerate keeps it when the subject hasn't moved. */
  currentTitle: z.string().optional(),
  /** Sibling-session names — an exactly-colliding answer gets a date suffix so names stay distinct. */
  avoid: z.array(z.string()).max(24).optional(),
})
export type SessionNameRequest = z.infer<typeof SessionNameRequestSchema>

export const SessionNameResponseSchema = z.object({
  title: z.string(),
  /** One plain sentence for the map's second line. Empty when only the floor could answer. */
  overview: z.string(),
})
export type SessionNameResponse = z.infer<typeof SessionNameResponseSchema>

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

/** main→renderer: a tool is waiting on the user (Ask-me mode). requestId = the engine's tool_use_id.
 *  `reason` (optional): why the gate forced this ask when the posture wouldn't have — e.g. the
 *  self-protection tier naming what the action touches ("this project's guardrail switches"). An
 *  unexplained card in Auto gets rubber-stamped; the reason is what makes the forced ask meaningful. */
export const ApprovalRequestSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  reason: z.string().optional(),
})
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export const ApprovalRequestsSchema = z.array(ApprovalRequestSchema)

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

/** Reasoning budget for a generated-text turn. `off` preserves Claude's fast, zero-thinking path;
 *  engines without a true off mode interpret it as their default budget. Other values remain the
 *  engine's own terms and are mapped only inside its structured-generation adapter. */
export const TextGenerationEffortSchema = z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
export type TextGenerationEffort = z.infer<typeof TextGenerationEffortSchema>

/** The app-global writer for small generated-text jobs. Apple stays the default because it is local
 *  and spends no provider usage. Cloud choices use the same provider model catalog as session chat
 *  and run through one ephemeral, non-mutating structured-generation boundary. `plain` preserves a
 *  real no-AI choice. */
export const TextGenerationModelSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('apple') }),
  z.object({ provider: z.literal('plain') }),
  z.object({
    provider: z.literal('claude'),
    model: z.enum(['fable', 'haiku', 'sonnet', 'opus']),
    // Stored choices from before effort was exposed keep their exact fast behavior.
    effort: TextGenerationEffortSchema.default('off'),
  }),
  z.object({
    provider: z.literal('codex'),
    model: z.string().trim().min(1),
    effort: TextGenerationEffortSchema.default('medium'),
  }),
])
export type TextGenerationModel = z.infer<typeof TextGenerationModelSchema>

export const KodaSettingsSchema = z.object({
  /** The posture new sessions start at. `plan` is per-session only (spawn-time --permission-mode), so
   *  it's never a valid default — main clamps it to 'auto' on both read and write. */
  defaultApprovalMode: ApprovalModeSchema,
  /** On-device assist for humanized recovery labels. Session titles have their own generated-text
   *  choice below. Default-on; labels fall back to their deterministic text when off or unavailable. */
  assistEnabled: z.boolean(),
  /** Default writer for session names and saved-version descriptions. Apple runs on-device; a
   *  selected Claude or Codex model uses that provider account in a tiny ephemeral, non-mutating turn;
   *  plain uses the deterministic floor. Default Apple, with a one-time compatibility read for the
   *  former combined on-device-assist toggle. */
  textGenerationModel: TextGenerationModelSchema,
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
  /** How many days a top-level scratch attachment (the on-disk copy of a pasted/dropped image or
   *  document, in `.koda/scratch/`) is kept before it's pruned. Nested work artifacts are outside this
   *  bucket. `0` means keep forever. Default 7. */
  scratchRetentionDays: z.number(),
  /** How many days an archived session is kept before it's auto-deleted. `0` (the default) means keep
   *  forever — the safe posture, since archives live outside the safety-git undo net (a purge is
   *  permanent). Opt-in: set >0 from the Archived settings section to auto-tidy old chats. */
  archiveRetentionDays: z.number(),
  /** Optional Playwright browser-testing capability — lets the agent drive a real browser to confirm
   *  web work *works* (not just renders). Default-OFF: turning it on downloads ~150 MB of Chromium
   *  into a shared dir (once, reused by every project). The agent only gets browser tools when this is
   *  on AND the download completed. Install *state* is runtime (playwright:status), not persisted here. */
  playwrightEnabled: z.boolean(),
  /** Overnight memory tidy (dream-plan.md): a couple of quiet hours after the day's last turn, Koda
   *  consolidates the memory of the projects it worked in. Runs on the user's own plan while they're
   *  away, so default-OFF with plain wording at the toggle (Settings → Memory). Read live by the
   *  main-process scheduler; flipping it applies immediately. */
  dreamEnabled: z.boolean(),
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
  /** Whether a mini app's ask-or-fix line starts a FRESH conversation each calendar day (named for
   *  that day) instead of one ever-growing thread per app. Default-ON: a day thread is what makes an
   *  app's history browsable by date, and it keeps every turn from re-reading weeks of unrelated
   *  logging. Off restores the single forever-thread per app. Read live by both heads at dispatch. */
  appDaySessions: z.boolean(),
  /** Whether finishing may invoke one proportional fresh-review pass for work whose risk or visible
   *  quality bar earns the extra usage. Default-OFF; explicit review requests still work either way.
   *  Read at spawn (it gates a pack rule), so a change applies to the next session. */
  critiquePass: z.boolean(),
  /** Whether save composers improve the deterministic file-count description with the app-global
   *  generated-text choice. Default-ON. Off spawns nothing and spends no usage. Read live when a
   *  composer opens, so flipping it applies to the very next save. */
  suggestVersionMessage: z.boolean(),
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
  /** Every LAN address the phone could reach the Mac at (multi-homed Macs expose several). The QR bundles
   *  the alternates so the phone tries each — a stale alias or tunnel IP winning `url` no longer strands it. */
  hosts: z.array(z.string()),
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
  /** The stored sign-in is dead for good (revoked token family) — retrying can't fix it, only the
   *  user signing in again can. Drives the workspace banner + Settings prompt. */
  needsReSignin: z.boolean(),
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

// ── Connect tier (embedded tailnet node — connect-embedded-tailscale.md Build A) ──

/** The one lifecycle owner's state, plus whether this build/machine can run it at all. `path` is the
 *  peer route: 'relayed' is DERP, which is a WORKING connection and must never render as an error. */
export const ConnectStateSchema = z.object({
  /** False in the open-source build (no phone-control stack) or on a non-Mac. */
  available: z.boolean(),
  /** The dogfood flag (settings `connectNode`). Off = the whole surface stays hidden. */
  enabled: z.boolean(),
  state: z.enum(['idle', 'connecting', 'connected', 'reconnecting', 'failed']),
  reason: z
    .enum(['off', 'unavailable', 'signed-out', 'no-key', 'needs-approval', 'denied', 'helper-failed'])
    .optional(),
  /** The node's name ON THE TAILNET (from the helper's ready event, not the hostname we asked for). */
  nodeName: z.string().nullable(),
  path: z.enum(['direct', 'relayed']).nullable(),
})
export type ConnectState = z.infer<typeof ConnectStateSchema>

/** One device in the account's tailnet, as the Settings list renders it. */
export const ConnectDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  lastSeenAt: z.number().nullable(),
  online: z.boolean(),
  isThisMac: z.boolean(),
})
export type ConnectDevice = z.infer<typeof ConnectDeviceSchema>

/** Device list + why it may be empty, so the row can say something true instead of nothing. */
export const ConnectDevicesResultSchema = z.object({
  devices: z.array(ConnectDeviceSchema),
  error: z.string().optional(),
  pendingReset: z.object({ nodeId: z.string(), requestId: z.string().uuid() }).optional(),
})
export type ConnectDevicesResult = z.infer<typeof ConnectDevicesResultSchema>

/** One device asking to join this account's private network, as the Mac's prompt renders it. */
export const ConnectEnrollmentRequestSchema = z.object({
  requestId: z.string(),
  deviceName: z.string(),
  platform: z.string(),
  requestedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  status: z.enum(['pending', 'approved', 'denied']),
})
export type ConnectEnrollmentRequest = z.infer<typeof ConnectEnrollmentRequestSchema>

/** The waiting devices, plus why the list may be empty. `available` is false when this Mac holds no
 *  approver credential: it cannot prove it is already on the network, so it cannot decide anything,
 *  and the row has to say that rather than render "nothing is waiting". */
export const ConnectEnrollmentsResultSchema = z.object({
  requests: z.array(ConnectEnrollmentRequestSchema),
  available: z.boolean(),
  error: z.string().optional(),
})
export type ConnectEnrollmentsResult = z.infer<typeof ConnectEnrollmentsResultSchema>

export const ConnectEnrollmentDecideSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
})
export type ConnectEnrollmentDecide = z.infer<typeof ConnectEnrollmentDecideSchema>

export const ConnectEnrollmentDecideResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
})
export type ConnectEnrollmentDecideResult = z.infer<typeof ConnectEnrollmentDecideResultSchema>

export const ConnectRevokeSchema = z.object({ nodeId: z.string().min(1), requestId: z.string().uuid().optional() })
export type ConnectRevoke = z.infer<typeof ConnectRevokeSchema>

/** Account-wide reset crosses three planes; a partial failure names the ones that did not clear. */
export const ConnectRevokeResultSchema = z.object({
  ok: z.boolean(),
  failed: z.array(z.enum(['tailnet', 'pairing', 'account', 'local'])),
  message: z.string().optional(),
  requestId: z.string().uuid().optional(),
  requiresReauth: z.boolean().optional(),
})
export type ConnectRevokeResult = z.infer<typeof ConnectRevokeResultSchema>

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

/** Bounds for the Stage's persisted px width (`conversationWidth`, see below). Absolute and
 *  window-independent, so they are only half the story: what the Stage may be DRAWN at also depends on
 *  the room the window has, which is `fitStage` in src/renderer/src/surface/stage-layout.ts. Named here
 *  so that seam reads the same numbers this clamp writes. */
export const STAGE_MIN_WIDTH = 320
export const STAGE_MAX_WIDTH = 1100

/** Clamp pane sizes to a usable range, falling back to the default for any non-finite value. Applied
 *  on every set (renderer) and on read (main) so neither a drag nor a hand-edited file can wedge the UI. */
export function clampLayout(p: Partial<WorkspaceLayoutSizes> | undefined): WorkspaceLayoutSizes {
  const v = { ...DEFAULT_LAYOUT, ...p }
  const fin = (n: number, d: number): number => (Number.isFinite(n) ? n : d)
  return {
    sidebarWidth: clamp(fin(v.sidebarWidth, DEFAULT_LAYOUT.sidebarWidth), SIDEBAR_MIN_WIDTH, 600),
    sessionsFrac: clamp(fin(v.sessionsFrac, DEFAULT_LAYOUT.sessionsFrac), 0.15, 0.85),
    // Despite the name this is the DOCK's width (SurfaceHost); the conversation is flex-1 and fills the
    // rest. The wide ceiling is the user's PREFERENCE, kept intact through a narrow window so widening
    // it gives them back what they chose; `fitStage` is what holds that preference inside the room.
    conversationWidth: clamp(
      fin(v.conversationWidth, DEFAULT_LAYOUT.conversationWidth),
      STAGE_MIN_WIDTH,
      STAGE_MAX_WIDTH,
    ),
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
  /** True once the user manually renamed the session — locks out the generated title.
   *  Optional for backward-compat with blobs saved before this field existed. */
  userNamed: z.boolean().optional(),
  /** One plain sentence saying what this thread is about — the sessions map's second line, generated
   *  beside the title (sessions:name). Absent ⇒ the row shows only its title. */
  overview: z.string().optional(),
  /** Epoch ms of this session's last OBSERVED activity (a turn sent, a turn finished, an approval
   *  asked). The sessions map settles a thread out of the list from this, and any new activity
   *  un-settles it — done-ness is never filed by hand. Absent ⇒ never settles (an older blob has no
   *  observation to age). */
  lastActivityAt: z.number().optional(),
  /** The user-message count this thread was last re-named at. Regeneration fires at fixed crossings
   *  (2, 5, then every 10), so the count alone says "we are AT a crossing", never "we just reached
   *  one" — and turns that add no user message (a doc edit, the handoff prompt, an image-only turn)
   *  would re-fire naming at the same count for as long as the thread sits there. Persisted so the
   *  crossing stays spent across a restart. Absent ⇒ never named by a crossing. */
  namedAtTurns: z.number().int().nonnegative().optional(),
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
  /** The driver-owned resume blob (see `ResumeCursorSchema`), so a restored session hands its engine
   *  back exactly what that engine needs to reattach. Absent ⇒ the session restarts clean. */
  resumeCursor: ResumeCursorSchema.optional(),
  /** The renderer's rendered transcript (Entry[]); opaque to main. */
  items: z.array(z.unknown()),
  /** Highest durable replay row this renderer applied. Main filters an adoption/phone replay after
   *  this cursor, so legitimate repeated text never needs content-based deduplication. */
  replaySeq: z.number().int().nonnegative().optional(),
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
  /** Legacy session-scoped document stars. New builds migrate these paths into the project's
   *  `starredDocs` list below and never write this field. It remains readable so a star held only by an
   *  old live or archived session is not lost during the upgrade. */
  keptDocs: z.array(z.string()).optional(),
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

/** One readable turn baked into the archive metadata so the retrieval list can preview a chat WITHOUT
 *  loading its (potentially large) transcript body. Snapshotted at archive time — an archived chat is
 *  immutable, so the tail never changes. */
export const ArchivedPreviewTurnSchema = z.object({
  kind: z.enum(['user', 'assistant']),
  text: z.string(),
})
export type ArchivedPreviewTurn = z.infer<typeof ArchivedPreviewTurnSchema>

/** The LIGHT half of an archived session — everything except the transcript `items`, which live in a
 *  per-session body file (session-store.ts). This is what boot reads and the Settings list renders, so
 *  it must stay small: a heavy project can hold 100+ archives, and loading every full transcript just to
 *  draw a list is the exact O(n)-blob cost the split removes. Restore fetches the body on demand. */
export const ArchivedSessionMetaSchema = ArchivedSessionSchema.omit({ items: true }).extend({
  /** The last few turns' text, for the list's expandable preview. Optional/back-compat: a meta migrated
   *  from a pre-split blob always has it; absence just shows "no preview". */
  preview: z.array(ArchivedPreviewTurnSchema).optional(),
  /** Highest entry (and subagent-child) id in the transcript, so boot can advance the id counter past a
   *  not-yet-restored archive WITHOUT loading its body (else a new entry could reuse a held id → collide
   *  on restore). Optional/back-compat; absent ⇒ treated as 0. */
  maxItemId: z.number().optional(),
})
export type ArchivedSessionMeta = z.infer<typeof ArchivedSessionMetaSchema>

/** One Koda-observed rename/move/delete that must also be applied to legacy star sources which were
 *  unavailable when the filesystem change happened. Paths are project-relative prefixes; `to: null`
 *  is a tombstone, while a string rebases that prefix and all descendants. */
export const LegacyKeptDocPathChangeSchema = z.object({
  from: z.string(),
  to: z.string().nullable(),
})
export type LegacyKeptDocPathChange = z.infer<typeof LegacyKeptDocPathChangeSchema>

// version 3: project-wide document stars. Version 2 introduced per-project persistence (one project
// per window); version 3 changes the payload so an older build refuses it instead of Zod-stripping the
// project-level star fields and rewriting the file. Main reads and migrates v2 explicitly.
export const PersistedSessionsSchema = z.object({
  version: z.literal(3),
  /** The tab that was active at save time (restored on next launch). */
  activeId: z.string().nullable(),
  sessions: z.array(PersistedSessionSchema),
  /** Project-wide document stars — normalized project-relative POSIX paths, in the user's order.
   *  Paths only: titles and other metadata are re-read from `library:query`. Optional for back-compat
   *  with stores written while stars still lived on individual sessions. */
  starredDocs: z.array(z.string()).optional(),
  /** Paths already imported from legacy per-session `keptDocs` fields. Keeping this small migration
   *  ledger prevents a delayed archived-session read from resurrecting a document the user has since
   *  unstarred, while still allowing an archive unavailable on the first upgraded launch to contribute
   *  its unique paths later. */
  legacyKeptDocsImported: z.array(z.string()).optional(),
  /** Append-only path repairs for legacy star sources that may arrive after a Koda rename/move/delete
   *  (an archive index that could not be read that launch, or retired local pins awaiting a save ack). */
  legacyKeptDocPathChanges: z.array(LegacyKeptDocPathChangeSchema).optional(),
  /** True only after a successful archive-index read was hydrated and the resulting project stars were
   *  acknowledged in this same hot-store write. Retention protects expired archive-only legacy stars
   *  until this marker lands. */
  legacyKeptDocsMigrationComplete: z.boolean().optional(),
  /** Archived sessions, restorable from Settings. Optional for back-compat with blobs saved before
   *  archiving existed. */
  archived: z.array(ArchivedSessionSchema).optional(),
  /** Legacy per-project copy, read only for back-compat. Account usage now belongs to main's global
   *  reconciler and is no longer written into every project session file. */
  rateLimits: z
    .record(z.string(), z.record(z.string(), RateLimitInfoSchema))
    .optional()
    .catch(undefined),
})
export type PersistedSessions = z.infer<typeof PersistedSessionsSchema>

// A boot-time store read, carrying the two things the renderer cannot otherwise learn: how many rows
// had to be set aside on an otherwise-fine read, and — when the read failed outright — whether the copy
// the user is told about actually landed on disk. Both drive the data-integrity banner, which is only
// honest if it gets the real answers (it used to claim a kept copy unconditionally, and said nothing at
// all about set-aside rows). A FAILED read is `ok: false`, never an empty list: the renderer must not
// hydrate on it, because hydrating un-gates the debounced save that writes emptiness over the real file.
/** `null` = nobody got to say (a failure short of the store layer, e.g. the IPC itself). */
export type BackupKept = boolean | null

export type SessionsLoadResult =
  | {
      ok: true
      data: PersistedSessions | null
      droppedSessions: number
      /** A cold metadata row matched a hot chat, but its body was not readable, so the hot fallback
       * stayed live. Optional for mixed-version renderer/main reloads. */
      unreadableArchiveBodyIds?: string[]
    }
  | { ok: false; backupKept: BackupKept }

export type ArchivedLoadResult =
  | { ok: true; archived: ArchivedSessionMeta[]; droppedArchives: number }
  | { ok: false; backupKept: BackupKept }

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
  /** A displayable image (png/jpg/gif/webp/svg/…): its loadable `koda-preview://` URL. The surface
   *  renders it as an image instead of the "binary" notice. Absent for non-image files. */
  imageUrl: z.string().optional(),
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

export const WriteFileResultSchema = z.object({
  path: z.string(),
  /** False when the pre-edit checkpoint could not be taken: the save landed, but there is no recovery
   *  point behind it. The editors say so — Koda's whole promise is that every change has an undo, and
   *  a user who is never told believes in one that isn't there. */
  checkpointed: z.boolean(),
})
export type WriteFileResult = z.infer<typeof WriteFileResultSchema>

/**
 * Main REFUSES a content-destroying edit (delete, overwrite, bulk replace) it could not first make
 * undoable, and rejects with a message opening with this exact phrase followed by ", so <what did not
 * happen>." Electron wraps a rejection's message inside its own text and loses the error type across
 * the boundary, so the renderer recovers the user-facing sentence by matching the phrase.
 *
 * A save is deliberately NOT in this set: refusing it would strand the user's typed work with nowhere
 * to put it. `WriteFileResult.checkpointed` carries that case instead.
 */
export const NO_UNDO_POINT = "Couldn't make an undo point"

/** The user-facing refusal sentence inside a rejected IPC call, or null if this wasn't that failure. */
export function undoPointRefusal(err: unknown): string | null {
  const at = String(err).indexOf(NO_UNDO_POINT)
  return at === -1 ? null : String(err).slice(at)
}

/** fs:createFile — create a new empty document in Documents/ or an existing contained folder. */
export const CreateFileRequestSchema = z.object({
  name: z.string().optional(),
  parent: z.string().optional(),
  /** The session this document is being made out of, written straight into the new file's `source:`
   *  frontmatter (`ProjectDoc.source`). Optional because a document can be made with no conversation
   *  in front of it, and an absent provenance is honest where a guessed one is not. Written ONCE, at
   *  creation: it records where the document came from, so a later edit from a different chat must
   *  not overwrite it. */
  source: z.string().optional(),
})
export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>

export const CreateFileResultSchema = z.object({ path: z.string() })
export type CreateFileResult = z.infer<typeof CreateFileResultSchema>

/** fs:listDocs — the flat "Documents" list behind the doc-first sidebar. Every prose doc under the
 *  project (recency-sorted, project-knowledge dirs excluded), so a non-engineer finds their writing
 *  by glancing instead of spelunking the tree. No args — main resolves the per-window root. */
export const ListDocsRequestSchema = z.object({})
export type ListDocsRequest = z.infer<typeof ListDocsRequestSchema>

/**
 * What a document is FOR — the Library's filter row. Closed at six by decision (RB, 2026-08-13):
 * each answers "what is this for" instead of "where does it live", and `note` is the honest catch-all
 * so nothing gets mis-filed to make the list work. Deliberately NOT derived from the folder: folders
 * under `Documents/` are topics by shipped instruction, and this repository already has the two
 * taxonomies disagreeing (`Documents/site/` holds research, a plan, a reference list and a design
 * brief). Authored in the file's own frontmatter, which is then the only source of truth.
 * Do not extend this list without re-reading Documents/architecture/document-workspace.md.
 */
export const DocKindSchema = z.enum(['plan', 'decision', 'research', 'guide', 'reference', 'note'])
export type DocKind = z.infer<typeof DocKindSchema>

export const ProjectDocSchema = z.object({
  /** Absolute, realpath-resolved path (the open/tab identity). */
  path: z.string(),
  /** Project-relative POSIX path — drives the location breadcrumb for docs outside the home folder. */
  rel: z.string(),
  /** The filename (extension stripped for display in the renderer). */
  name: z.string(),
  /** Last-modified epoch ms — the recency sort key. */
  mtimeMs: z.number(),
  // The four authored fields below all come from the file's own YAML frontmatter, which both editors
  // already round-trip byte-for-byte. Every one is optional and every one stays optional: most
  // documents in an existing project predate the convention, and a doc list that throws (or hides a
  // file) because nobody wrote frontmatter is worse than one with gaps.
  /** Authored `title:` — what the Library shows instead of the filename. Absent ⇒ fall back to `name`. */
  title: z.string().optional(),
  /** Authored `description:` — the Library's one-line subtitle, and the field that makes a library
   *  browsable at all. Never derive it: a scraped first paragraph is an excerpt, and putting one in
   *  this slot is exactly what makes the surface read as the file tree it replaced. Absent ⇒ render
   *  `LibraryDoc.excerpt` instead. */
  description: z.string().optional(),
  /** Authored `kind:` — one of the closed six. Absent means unwritten OR unrecognized: `.catch()`
   *  degrades a typo'd kind to absent rather than failing the whole listing, since one bad file must
   *  not blank the user's Library. Readers wanting a kind for EVERY document use
   *  `LibraryDoc.resolvedKind`, which applies the folder fallback once, in main. */
  kind: DocKindSchema.optional().catch(undefined),
  /** Authored `source:` — the id of the session this document came out of, written once at creation.
   *  Provenance lives in the file rather than the `docmeta` sidecar because the sidecar is keyed by a
   *  hash of the relative path, so it dies on a rename or a move, which is precisely when "where did
   *  this come from" is worth the most. The id outlives the session (sessions archive and delete), so
   *  anything that turns this into a door must define what a dead pointer does. */
  source: z.string().optional(),
})
export type ProjectDoc = z.infer<typeof ProjectDocSchema>

export const ListDocsResultSchema = z.object({
  root: z.string(),
  docs: z.array(ProjectDocSchema),
})
export type ListDocsResult = z.infer<typeof ListDocsResultSchema>

/** library:resolve — refresh an exact set of remembered document paths without depending on the
 *  recency-sorted discovery list's 300-row display cap. Missing, moved, or no-longer-eligible paths
 *  are omitted so the renderer can keep their shortcuts visibly stale without granting them file
 *  actions. The batch is bounded at the IPC edge; 1,000 is comfortably above the discovery cap while
 *  preventing one renderer request from opening an unbounded number of files. */
export const LibraryResolveRequestSchema = z.object({
  rels: z.array(z.string().min(1).max(4096)).max(1000),
})
export type LibraryResolveRequest = z.infer<typeof LibraryResolveRequestSchema>

export const LibraryResolveResultSchema = z.object({
  root: z.string(),
  docs: z.array(ProjectDocSchema),
})
export type LibraryResolveResult = z.infer<typeof LibraryResolveResultSchema>

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

/** memory:weight — how heavy the project's memory navigation pair is. The pair is retrieved on demand,
 *  while `project-card.md` is the bounded ambient summary. `heavy` drives the status-bar tidy pill;
 *  `chars` gives Settings → Memory a concrete size to show. */
export const MemoryWeightSchema = z.object({
  /** Whether the project has a memory index at all. */
  present: z.boolean(),
  chars: z.number(),
  heavy: z.boolean(),
})
export type MemoryWeight = z.infer<typeof MemoryWeightSchema>

/** backup:* — encrypted cloud backup (blind E2E: the server only ever holds ciphertext; the vault
 *  key + recovery code never leave the user's side). Dogfood-flagged. See main/backup/index.ts. */
export const BackupStatusSchema = z.object({
  /** The dogfood flag (`backupEnabled` / KODA_BACKUP=1). Off ⇒ the section shows a quiet inert note. */
  enabled: z.boolean(),
  /** Backup rides the same Supabase account as remote control; signed-out ⇒ point at Koda account. */
  signedIn: z.boolean(),
  state: z.enum(['idle', 'backing-up', 'error', 'too-large']),
  lastBackupAt: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  error: z.string().optional(),
})
export type BackupStatus = z.infer<typeof BackupStatusSchema>

/** One backed-up project, as listed from the cloud (metadata only — name/time/size, never content).
 *  Bundle fields absent = only the docs replica has uploaded; replica fields absent = vice versa. */
export const BackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectHash: z.string(),
  projectName: z.string(),
  lastBackupAt: z.number().optional(),
  sizeBytes: z.number().optional(),
  replicaAt: z.number().optional(),
  replicaSizeBytes: z.number().optional(),
  docCount: z.number().optional(),
})
export type BackupManifest = z.infer<typeof BackupManifestSchema>

export const BackupRestoreRequestSchema = z.object({
  /** 16 hex chars (sha256 prefix of the source path) — shape-checked so it can never smuggle path
   *  segments into the storage object key. */
  sourceProjectHash: z.string().regex(/^[0-9a-f]{16}$/),
  /** Must be a fresh/empty folder — restore never writes over a live project (main enforces too). */
  targetDir: z.string().min(1),
  /** Fresh-Mac path: decodes to the vault key (and becomes this Mac's key on success). */
  recoveryCode: z.string().optional(),
})
export type BackupRestoreRequest = z.infer<typeof BackupRestoreRequestSchema>

export const BackupRestoreResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type BackupRestoreResult = z.infer<typeof BackupRestoreResultSchema>

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

/** scratch:save — persist a pasted/dropped attachment to the project's `.koda/scratch/` folder so it
 *  outlives the conversation and the agent can re-read it by path. Images arrive already compressed by
 *  the composer; document files (csv/pdf) arrive raw and carry `fileName` so the saved copy keeps a
 *  recognizable name. Returns the project-relative path. Best-effort on the renderer side: a failure
 *  just means no durable copy. */
export const ScratchSaveRequestSchema = z.object({
  mediaType: z.string(),
  dataBase64: z.string(),
  fileName: z.string().optional(),
})
export type ScratchSaveRequest = z.infer<typeof ScratchSaveRequestSchema>

export const ScratchSaveResultSchema = z.object({ path: z.string() })
export type ScratchSaveResult = z.infer<typeof ScratchSaveResultSchema>

/** The engine-facing note appended to a turn when document files (csv/pdf) ride along as saved
 *  `.koda/scratch/` paths. ONE builder for both attach heads — the desktop composer (store.send) and
 *  a phone turn landing in main (sessions.sendTurn) — so the promote-out-of-scratch instruction can't
 *  drift between them. */
export function attachedFilesNote(paths: string[]): string {
  const one = paths.length === 1
  const list = paths.map((p) => `\`${p}\``).join(', ')
  return `(The user attached ${one ? 'a file, saved at' : 'files, saved at'} ${list} — read ${one ? 'it' : 'them'} from ${one ? 'that path' : 'those paths'}. ${one ? "It's" : "They're"} staged in \`.koda/scratch/\`, which prunes by age: if ${one ? 'this file' : 'a file'} is data the project should keep — something you'll import or reference again — move it into the project properly and say so.)`
}

/** composer:pickFiles — native open dialog for the composer's attach menu. Main reads the picked files
 *  and returns their bytes; the renderer stages them exactly like a drop (images get compressed there). */
export const PickedFileSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  dataBase64: z.string(),
})
export type PickedFile = z.infer<typeof PickedFileSchema>

export const PickFilesResultSchema = z.object({ files: z.array(PickedFileSchema) })
export type PickFilesResult = z.infer<typeof PickFilesResultSchema>

/** composer:pickPath — "point at files or folders": a native dialog that returns the chosen absolute
 *  paths (empty on cancel). Nothing is copied — the paths are referenced in the message as-is. */
export const PickPathResultSchema = z.object({ paths: z.array(z.string()) })
export type PickPathResult = z.infer<typeof PickPathResultSchema>

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

/** Bounded phone replay of the same workspace pty. `reset` means the requested cursor fell outside the
 * retained output window (or belonged to a shell that has since respawned), so xterm replaces its view. */
export const RemoteTerminalStateSchema = z.object({
  cwd: z.string(),
  cursor: z.number().int().nonnegative(),
  data: z.string(),
  reset: z.boolean(),
  exited: z.boolean(),
  exitCode: z.number().int().nullable(),
})
export type RemoteTerminalState = z.infer<typeof RemoteTerminalStateSchema>

/** An unguessable, process-local input capability makes retries idempotent without persisting terminal
 * keystrokes. A new Stage open replaces the prior capability for that session. */
export const RemoteTerminalStartResultSchema = RemoteTerminalStateSchema.extend({ inputToken: z.string() })
export type RemoteTerminalStartResult = z.infer<typeof RemoteTerminalStartResultSchema>

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
 *   - `tables`: column widths (the table-resize overlay).
 *   - `fullWidth`: the doc renders edge-to-edge instead of the reading column. */
export const DocMetaSchema = z.object({
  tables: z.array(DocTableMetaSchema).optional(),
  fullWidth: z.boolean().optional(),
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
 *  the recovery timeline like any other change. `document` selects the stricter sidebar path: one
 *  regular Library document, force-captured even when project ignore rules hide it. */
export const DeletePathRequestSchema = z.object({ path: z.string(), document: z.literal(true).optional() })
export type DeletePathRequest = z.infer<typeof DeletePathRequestSchema>

/** fs:revealPath — reveal a file/folder in Finder. fs:openPath — open it in the OS default app.
 *  Both are read-only shell actions, path-contained to the project root. */
export const RevealPathRequestSchema = z.object({ path: z.string() })
export type RevealPathRequest = z.infer<typeof RevealPathRequestSchema>
export const OpenPathRequestSchema = z.object({ path: z.string() })
export type OpenPathRequest = z.infer<typeof OpenPathRequestSchema>

/** fs:startDrag — start a native OS drag of a project file/folder (drag out to Finder/Mail/etc). */
export const StartDragRequestSchema = z.object({ path: z.string() })
export type StartDragRequest = z.infer<typeof StartDragRequestSchema>

/** doc:exportPdf — save the open doc as a PDF. `html` is the doc surface's rendered body; main owns
 *  the page template. Resolves with the saved path, or null when the user cancels the save dialog. */
export const ExportPdfRequestSchema = z.object({ title: z.string(), html: z.string() })
export type ExportPdfRequest = z.infer<typeof ExportPdfRequestSchema>
export const ExportPdfResultSchema = z.object({ path: z.string().nullable() })
export type ExportPdfResult = z.infer<typeof ExportPdfResultSchema>

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

// ── The Library: documents as objects, not paths ──────────────────────────────
//
// One surface over machinery that already ships (`listProjectDocs` + `searchProject`), NOT a second
// index and NOT a second doc list. Both calls below live in main for one specific reason: the doc walk
// and the search walk use DIFFERENT exclusion sets. `listProjectDocs` skips DOCS_EXCLUDE_DIRS, skill
// and plugin marker dirs, and non-user files like CLAUDE.md; `searchProject` only skips `.git`,
// `node_modules` and `.koda`. A renderer that reached for `fs:search` directly would list vendored
// skill files and dependency READMEs the Documents pane correctly hides, and look broken to exactly
// the user this surface exists for. Main reconciles the two once so no caller can forget to.
// See Documents/architecture/document-workspace.md.

/** library:query — the Library's one read. An absent or empty `query` lists the whole library
 *  (recency-sorted) rather than nothing, because the surface opens before the user types. */
export const LibraryQueryRequestSchema = z.object({
  query: z.string().optional(),
  /** Absent or empty ⇒ every kind. Matched against `LibraryDoc.resolvedKind`, so a document with no
   *  authored `kind` is still reachable through its folder fallback instead of vanishing from a
   *  filtered list. */
  kinds: z.array(DocKindSchema).optional(),
  /** Max rows to return; absent ⇒ main's own cap. */
  limit: z.number().int().positive().optional(),
})
export type LibraryQueryRequest = z.infer<typeof LibraryQueryRequestSchema>

/** One Library row: the document's authored metadata plus everything the list needs to rank, filter
 *  and preview it without a second read per file. */
export const LibraryDocSchema = ProjectDocSchema.extend({
  /** The kind to render and filter on, always present: the authored `kind`, else inferred from the
   *  containing folder, else `note`. Resolved in main so the fallback exists exactly once — a
   *  renderer re-deriving it becomes the second source of truth this whole design removes. Compare
   *  with `kind` (inherited, optional) to tell an authored kind from an inferred one. */
  resolvedKind: DocKindSchema,
  /** First ~600 chars of the file (`docExcerpt`) — the preview shown when `description` is absent,
   *  never instead of it. Absent when the file could not be read: a preview is decoration and is
   *  never worth failing the listing over. */
  excerpt: z.string().optional(),
  /** The filename itself matched the query (the row is listed even with no content hits). Mirrors
   *  `SearchFileResult` so ranking behaves identically to the Find overlay. */
  nameMatch: z.boolean(),
  /** Fuzzy filename-match score (higher = better); 0 when `!nameMatch`. */
  score: z.number(),
  /** Content-line hits backing this row, for the preview. Empty for an unfiltered listing. */
  matches: z.array(SearchLineMatchSchema),
})
export type LibraryDoc = z.infer<typeof LibraryDocSchema>

export const LibraryQueryResultSchema = z.object({
  /** The project root the walk was contained to. */
  root: z.string(),
  /** Echoed back, so a response that lands after a newer keystroke can be dropped instead of shown. */
  query: z.string(),
  /** A cap was hit (files walked / matches collected) — results are partial, same meaning as
   *  `SearchResult.truncated`. */
  truncated: z.boolean(),
  docs: z.array(LibraryDocSchema),
})
export type LibraryQueryResult = z.infer<typeof LibraryQueryResultSchema>

/** Where an ask looks. Documents alone is table stakes (Notion Q&A has done it since 2023); the
 *  differentiating half is `sessions`, because most decisions happened in a conversation and were
 *  never written down, and only Koda was present for them. */
export const LibraryAskScopeSchema = z.enum(['all', 'documents', 'sessions'])
export type LibraryAskScope = z.infer<typeof LibraryAskScopeSchema>

/** library:ask — a question answered across the project's documents AND its session transcripts.
 *  File-first agentic search: no index, no embedding service. A hosted embedding API is named in
 *  `.koda/memory/memory-system.md` as the one choice that would break "nothing leaves your machine",
 *  and any index that does get built later is a derived, rebuildable projection of the markdown. */
export const LibraryAskRequestSchema = z.object({
  question: z.string(),
  scope: LibraryAskScopeSchema.optional(), // default 'all'
  /** Correlates one renderer request with `library:askCancel`; optional for older preloads. */
  requestId: z.string().min(1).max(128).optional(),
  /** Renderer proof that it synchronously wrote an IDLE hot-session snapshot immediately before this
   *  request. Main compares the stamp with live engine activity; absent/stale means session retrieval
   *  is partial, never that the debounced file is current by assumption. */
  hotStoreSavedAt: z.number().finite().nonnegative().optional(),
  /** The chat this ask was launched from, when there is one. An ask runs on THAT chat's engine, which
   *  is what the refusal copy says out loud, so the surface names the session and main reads the engine
   *  off it — the renderer never names an engine, because that would be a surface choosing a billing
   *  path. Absent (the Library opened with no chat in front) falls back to the last engine the user
   *  explicitly ran on. */
  sessionId: z.string().optional(),
})
export type LibraryAskRequest = z.infer<typeof LibraryAskRequestSchema>

/** A citation into a document. */
export const LibraryDocCitationSchema = z.object({
  kind: z.literal('document'),
  /** Absolute path — the open target. */
  path: z.string(),
  /** Project-relative POSIX path — what the chip's breadcrumb shows. */
  rel: z.string(),
  /** What the chip reads: the authored `title`, else the filename. */
  label: z.string(),
  /** Legacy/back-compat only. New answers cite the source as a whole because substring retrieval does
   *  not prove one preview line is the precise support for model-composed prose. */
  line: z.number().int().positive().optional(),
  /** Legacy/back-compat only; production no longer presents a first-match preview as an exact quote. */
  quote: z.string().optional(),
})
export type LibraryDocCitation = z.infer<typeof LibraryDocCitationSchema>

/** A citation into a conversation — the door no document tool can offer. That session may be archived
 *  or deleted, because a citation outlives the thread it names, and "nothing happens when you click"
 *  is not an answer to a dead pointer.
 *
 *  It is answered: renderer-side, follow this through `workspace/session-href.ts`
 *  (`resolveSessionDoor` for the live/archived/gone state, `followSession` to navigate,
 *  `followRefusalCopy` for what to say when it can't). Do not call `selectSession` on a stored id
 *  directly — that treats an archived chat, which is still nameable and still restorable, as dead. */
export const LibrarySessionCitationSchema = z.object({
  kind: z.literal('session'),
  sessionId: z.string(),
  /** What the chip reads: the session's label as it stood when the answer was formed. Stale by
   *  design; `resolveSessionDoor` re-reads the CURRENT label when the chip is drawn. */
  label: z.string(),
  /** Legacy/back-compat only; production citations are source-level. */
  quote: z.string().optional(),
})
export type LibrarySessionCitation = z.infer<typeof LibrarySessionCitationSchema>

export const LibraryCitationSchema = z.discriminatedUnion('kind', [
  LibraryDocCitationSchema,
  LibrarySessionCitationSchema,
])
export type LibraryCitation = z.infer<typeof LibraryCitationSchema>

export const LibraryAskResultSchema = z.object({
  /** Echoed back, so a late answer can be matched against the question still on screen. */
  question: z.string(),
  /** The prose answer. An EMPTY answer is a legitimate result and renders as "nothing found" — never
   *  as an error, and never padded into a manufactured summary (the editorial bar in
   *  `Documents/Goal sessions.md`: an empty result is a valid result; filling it is the failure). */
  answer: z.string(),
  /** What the answer rests on. An answer with zero citations is an unbacked claim about the user's own
   *  work, so a surface either shows where it came from or says it found nothing. */
  citations: z.array(LibraryCitationSchema),
  /** A search cap was hit before the answer was formed — it may be partial. */
  truncated: z.boolean().optional(),
})
export type LibraryAskResult = z.infer<typeof LibraryAskResultSchema>

/**
 * The marker on a `library:ask` rejection that is a deliberate REFUSAL rather than a failure: the
 * engine the user chose cannot satisfy Koda's ephemeral, non-mutating structured-generation
 * contract, so the ask never ran and nothing was billed (`library-ask.ts` → `engineAskRunner`).
 * Answering it on the other engine anyway would bill an account the user did not choose for this.
 *
 * It rides the error message because that is all an IPC rejection carries across the boundary (the
 * same reason `LibraryAsk.tsx` reads "no handler registered" off one). Main names the ENGINE and the
 * renderer owns the sentence, the same split `followRefusalCopy` uses: a refusal shown as "that
 * question could not be answered just now" describes a permanent answer as a transient one, and
 * leaves a user retrying an engine that cannot support this surface.
 */
export const ASK_ENGINE_REFUSAL = 'koda-ask-engine-refusal:'

/** The engine a `library:ask` rejection is refusing on, or `null` when the rejection is an ordinary
 *  failure. Shared so main and the renderer agree on one contract instead of two regexes. */
export function askRefusedEngine(error: unknown): EngineId | null {
  const message = error instanceof Error ? error.message : String(error)
  const at = message.indexOf(ASK_ENGINE_REFUSAL)
  if (at < 0) return null
  const id = message.slice(at + ASK_ENGINE_REFUSAL.length).trim().split(/\s/)[0]
  const parsed = EngineIdSchema.safeParse(id)
  return parsed.success ? parsed.data : null
}

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
  /** Commit time in epoch ms. The rail groups by calendar day; "23 hours ago" cannot name one. */
  committedAt: z.number(),
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
  unmergedBranches: z.array(
    z.object({
      name: z.string(),
      /** Commits this side line has that the current branch does not. */
      ahead: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Merge SHA → the commits it brought in, newest-first. The rail draws HEAD's first-parent chain,
   * so without this the work a merge carried in is fetched and laid out but never rendered, and the
   * merge can only be drawn as a curve around nothing. `partial` means the fetch window ended before
   * the walk reached the trunk, so the list is what we hold rather than everything that exists.
   */
  mergeInflows: z.record(
    z.string(),
    z.object({ shas: z.array(z.string()), partial: z.boolean() }),
  ),
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

/** git:proposeMessage — a description for the save the user is about to make, written from the diff
 *  by the app-global generated-text choice or its deterministic floor. Read-only: it never touches the
 *  index or the tree, and the returned text is a proposal the user edits. */
export const GitProposeMessageRequestSchema = z.object({})
export type GitProposeMessageRequest = z.infer<typeof GitProposeMessageRequestSchema>

export const GitProposeMessageResultSchema = z.object({
  /** Ready for the composer: a subject, or a subject and a short body. Never empty. */
  message: z.string(),
  /** Which route wrote it. `fallback` is the floor doing its job, never an error to surface. */
  source: z.enum(['engine', 'on-device', 'fallback']),
})
export type GitProposeMessageResult = z.infer<typeof GitProposeMessageResultSchema>

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
 *  has no surface at all). `dirtyCount` is that stranded working-tree change count when `statusKnown`
 *  is true; a failed probe stays explicit instead of masquerading as clean. `isCurrent` marks this
 *  window's own checkout (no "open" action for it). */
export const GitWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(), // null on a detached HEAD
  isCurrent: z.boolean(),
  dirtyCount: z.number().int().nonnegative(),
  statusKnown: z.boolean(),
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
  /** One-shot: this ProjectHome window was opened by "New Project…" (File menu), so it should land
   *  with the create-a-project modal already open. Cleared on first read — a renderer reload/HMR
   *  after the window resolves must not re-pop the modal. */
  newProjectIntent: z.boolean().default(false),
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

/** The agent-guidance pair (Claude reads CLAUDE.md, Codex reads AGENTS.md) — ONE guide, two names:
 *  intake authors a canonical AGENTS.md and symlinks CLAUDE.md to it, and main's healGuidelinesPair
 *  links whichever name a project is missing at open, so both engines always read the same file. A
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

/** app:dataIntegrity — the two APP-GLOBAL files that fall back to defaults when they can't be read, and
 *  whose fallback is therefore invisible unless something says so. (Per-PROJECT store failures ride
 *  SessionsLoadResult/ArchivedLoadResult instead, since those are answers to a specific project's load.)
 *  Everything here is false on a healthy machine, so the surfaces that ask simply render nothing. */
export const DataIntegritySchema = z.object({
  /** koda-app-state.json could not be read, so recents, reopen-on-boot and the window size all came
   *  back empty. ProjectHome uses this to say so, because an empty ProjectHome is otherwise
   *  indistinguishable from a first launch. */
  projectListUnreadable: z.boolean(),
  /** Whether the copy kept beside the unreadable project list actually landed. Also the gate on the way
   *  out: only a backed-up file may be replaced by the next project the user opens, so `false` means the
   *  notice must not promise that opening one fixes it. */
  projectListBackupKept: z.union([z.boolean(), z.null()]),
  /** The settings file was unreadable and its bytes still showed `billingMode: "api"`, so billing fell
   *  back to the subscription. A best-effort scan of the raw bytes (see settings.ts), surfaced because
   *  CLAUDE.md makes billing switches "user-visible, never silent". */
  billingModeReset: z.boolean(),
})
export type DataIntegrity = z.infer<typeof DataIntegritySchema>

/** project:delete — move a project's folder to the Trash after stopping + deregistering its mini
 *  apps. The renderer can only name paths it learned from project:getRecents / miniApps:list. */
export const ProjectDeleteRequestSchema = z.object({ path: z.string().min(1) })
export type ProjectDeleteRequest = z.infer<typeof ProjectDeleteRequestSchema>
export const ProjectDeleteResultSchema = z.object({})
export type ProjectDeleteResult = z.infer<typeof ProjectDeleteResultSchema>

/** miniApps:list — every registered mini app (all projects) + live supervisor state, for the launcher
 *  rail and the face view. Doubles as the renderer's feature gate: flag off ⇒ always [] ⇒ no rail,
 *  no App/Workshop toggle. `dir` is the app's identity (what miniApps:start takes back). */
/** The app's design tokens from its manifest (`koda-app.json` → `theme`) — CSS color values plus an
 *  optional font-family, any subset. Koda's overlay chrome on the face (summon pill, reply bubble,
 *  question chips) wears these so its floating pieces read as part of the app, not foreign chrome.
 *  Values are style-object CSS values, capped so a manifest can't smuggle novels into every window. */
export const MiniAppThemeSchema = z.object({
  accent: z.string().max(120).optional(),
  surface: z.string().max(120).optional(),
  text: z.string().max(120).optional(),
  border: z.string().max(120).optional(),
  font: z.string().max(200).optional(),
})
export type MiniAppTheme = z.infer<typeof MiniAppThemeSchema>

export const MiniAppInfoSchema = z.object({
  dir: z.string(),
  projectPath: z.string(),
  name: z.string(),
  state: z.enum(['starting', 'running', 'stopped', 'crashed']),
  url: z.string().optional(),
  /** Manifest icon inlined as a data URL; absent ⇒ monogram fallback. */
  iconDataUrl: z.string().optional(),
  /** Manifest theme tokens; absent ⇒ Koda's own tokens (the default chrome look). */
  theme: MiniAppThemeSchema.optional(),
})
export type MiniAppInfo = z.infer<typeof MiniAppInfoSchema>
export const MiniAppListSchema = z.array(MiniAppInfoSchema)

/** The ask-or-fix line's turn wrapper, shared by the desktop summon and the phone summon so the
 *  grounding never drifts between heads. RUN-mode framing (dogfood 08-03): a face turn lands in a
 *  fresh summon thread with no conversational context, and without this framing the pack's app-ask
 *  rule pattern-matched it and re-entered the recipe's shaping gate — clarifying questions plus an
 *  essay, in a side session the user never reads. So the wrapper must carry: the app already exists
 *  (operate, don't shape), data entries are recorded immediately with stated assumptions (the user's
 *  action carries meaning — they log what counts), and the closing message renders INSIDE the app,
 *  so it stays to a sentence or two. */
export function faceTurnText(appName: string, rel: string, msg: string): string {
  return (
    `I'm using the running "${appName}" mini app (its code and data live in \`${rel}\`): ${msg}\n\n` +
    `(Sent from the app's ask-or-fix line while looking at the app itself. This app already exists ` +
    `and I'm in the middle of using it — never re-enter shaping, invoke the create-mini-app skill, ` +
    `or propose a plan for this message; do the smallest thing that handles it. If it's data to ` +
    `record, write it through the app's own data contract — see its DATA.md and schema, never a ` +
    `side note — and record it immediately: my action carries meaning (I log what counts), so ` +
    `default to the reading that makes my action sensible and state any assumption you made in ` +
    `your reply rather than asking first. If it reports a problem or asks for a change to the app, ` +
    `edit the app's code in \`${rel}\`. My app view reloads automatically when your turn finishes, ` +
    `and your final message is shown to me INSIDE the app — one or two plain sentences, no headers ` +
    `or lists. Ask a question only if you truly can't proceed; every question pulls me out of the app.)`
  )
}

/** miniApps:start — start (or join) a REGISTERED app under the supervisor; resolves once it serves.
 *  Main validates `dir` against the registry — the renderer can only start apps the agent installed. */
export const MiniAppStartRequestSchema = z.object({ dir: z.string().min(1) })
export type MiniAppStartRequest = z.infer<typeof MiniAppStartRequestSchema>
export const MiniAppStartResultSchema = z.object({ url: z.string() })
export type MiniAppStartResult = z.infer<typeof MiniAppStartResultSchema>

/** miniApps:front — the app's project is already open in another window; surface that window and flip
 *  it to this app's face. `dir` is the app folder (which face to front); `projectPath` addresses the
 *  window. Both come from the launcher list, so they're already registry-validated. */
export const MiniAppFrontRequestSchema = z.object({
  dir: z.string().min(1),
  projectPath: z.string().min(1),
})
export type MiniAppFrontRequest = z.infer<typeof MiniAppFrontRequestSchema>

/** miniApps:bridgeInfo — per-app Lane B bridge state for the Settings toggle: whether the app may
 *  use the owner's API key (default off) and what its calls have cost so far. [] when the flag is
 *  off. Spend is an estimate from recorded token counts, for visibility, not billing. */
export const MiniAppBridgeInfoSchema = z.object({
  dir: z.string(),
  name: z.string(),
  consent: z.boolean(),
  spend: z.object({ inputTokens: z.number(), outputTokens: z.number(), usd: z.number() }),
})
export type MiniAppBridgeInfo = z.infer<typeof MiniAppBridgeInfoSchema>
export const MiniAppBridgeListSchema = z.array(MiniAppBridgeInfoSchema)

/** miniApps:setBridgeConsent — the owner's explicit, per-app allow/revoke. */
export const MiniAppBridgeConsentRequestSchema = z.object({
  dir: z.string().min(1),
  allowed: z.boolean(),
})
export type MiniAppBridgeConsentRequest = z.infer<typeof MiniAppBridgeConsentRequestSchema>

/** The shape exposed on `window.koda` — implemented in preload, consumed in the renderer. */
export type FileMenuCommand = 'newDocument' | 'newFolder' | 'importFiles' | 'filesImported' | 'exportPdf'

export interface KodaApi {
  getAppInfo: () => Promise<AppInfo>
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
  stopSubagent: (args: StopSubagentRequest) => Promise<void>
  disposeSession: (args: SessionRef) => Promise<void>
  /** Load persisted sessions on boot. `ok: true` with `data: null` means this project has nothing saved
   *  yet; `ok: false` means the store exists and could not be read, which must NOT hydrate. */
  loadSessions: () => Promise<SessionsLoadResult>
  /** Persist the open sessions + transcripts (debounced in the renderer). True only once the exact
   *  blob is on disk; migrations that would delete their old copy gate on this acknowledgement. */
  saveSessions: (data: PersistedSessions) => Promise<boolean>
  /** Archived sessions ride a separate COLD store (never the hot blob above — the 53MB-freeze bug).
   *  Split further: this loads/saves only the LIGHT metadata index (transcript bodies live in per-session
   *  files, fetched on restore) so boot and every archive/delete stay small regardless of history size.
   *  `loadArchived` also runs the opt-in retention purge. Save fires only when the list changes.
   *
   *  `saveArchived` is ACKNOWLEDGED (`true` = the index is on disk with exactly this list). Archiving,
   *  restoring and deleting each move a session BETWEEN the hot store and this index, and the hot half
   *  always lands — so a caller that is about to remove a session from one side must gate that removal on
   *  this boolean, or a failed index write drops the chat from both places at once. */
  loadArchived: () => Promise<ArchivedLoadResult>
  saveArchived: (archived: ArchivedSessionMeta[]) => Promise<boolean>
  /** Fetch one archived session's full transcript body (its `items`) — only needed to restore it. `null`
   *  means the read failed (so restore keeps the archive instead of destroying it); `[]` is a clean but
   *  genuinely empty transcript. */
  loadArchivedBody: (id: string) => Promise<unknown[] | null>
  /** Persist one archived session's transcript body. True only once the exact body is on disk; archive
   *  metadata and hot-session removal must not proceed on a failed body write. */
  writeArchivedBody: (id: string, items: unknown[]) => Promise<boolean>
  /** Delete one archived session's body file (called when the archive is restored or deleted). */
  deleteArchivedBody: (id: string) => Promise<void>
  /** Claim this window's project's live headless (phone-started) sessions + get their replayable
   *  history, so the desktop can show sessions launched from the phone. Empty when there are none. */
  adoptHeadlessSessions: () => Promise<AdoptedHeadlessSession[]>
  /** A phone started/resumed a session in the project this window has open → adopt it live. */
  onHeadlessAppeared: (listener: (payload: HeadlessAppeared) => void) => () => void
  /** The phone asked to archive a past session in this window's project → store.archiveSession. */
  onArchiveRequested: (listener: (payload: ArchiveRequested) => void) => () => void
  /** The phone asked to rename a live session in this window's project → store.renameSession. */
  onRenameRequested: (listener: (payload: RenameRequested) => void) => () => void
  /** A turn appended to a session THIS window owns but didn't send itself: a phone turn. */
  onRemoteUserTurn: (listener: (payload: RemoteUserTurnLive) => void) => () => void
  /** A scratch image was saved main-side (a phone turn's image) → refresh the Recent images strip. */
  onScratchChanged: (listener: () => void) => () => void
  /** Subscribe to the normalized event stream; returns an unsubscribe fn. */
  onEngineEvent: (listener: (event: EngineEvent) => void) => () => void
  /** Subscribe to passive, main-owned completion state (not part of transcript/replay). */
  onCompletionState: (listener: (state: TaskCompletionState) => void) => () => void
  /** Catch up after a renderer reload without persisting stale completion claims across app restarts. */
  listCompletionStates: () => Promise<TaskCompletionState[]>
  /** Subscribe to engine-neutral Stage intent (separate from transcript/replay). */
  onStageReceipt: (listener: (receipt: StageReceipt) => void) => () => void
  /** Catch up the latest presentation + completed-turn receipt for this window's live sessions. */
  listStageReceipts: () => Promise<StageReceipt[]>
  /** Resolve a markdown-local href against main-owned session/window workspace identity. */
  resolveStageLink: (args: ResolveStageLinkRequest) => Promise<StageLinkTarget>
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
  /** Engine-generated session title + overview line (falls back to the local-assist floor; never rejects). */
  nameSession: (args: SessionNameRequest) => Promise<SessionNameResponse>
  // Project Files browser (read-only, contained to the project root in main).
  /** List a directory (path omitted ⇒ project root). */
  readDir: (args: ReadDirRequest) => Promise<ReadDirResult>
  /** Flat recency-sorted list of every prose doc under the project (the doc-first sidebar). */
  listDocs: (args: ListDocsRequest) => Promise<ListDocsResult>
  /** Resolve remembered Library-relative paths exactly, independent of the discovery list cap. */
  libraryResolve: (args: LibraryResolveRequest) => Promise<LibraryResolveResult>
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
  /** Open the native File-menu picker, then import into Documents/. Null when the picker is cancelled. */
  importFilesFromMenu: () => Promise<ImportFilesResult | null>
  /** Reveal a file/folder in Finder. */
  revealPath: (args: RevealPathRequest) => Promise<void>
  /** Open a file/folder in the OS default app. */
  openPath: (args: OpenPathRequest) => Promise<void>
  /** Start a native OS drag of a project file/folder. Resolves once the drag is underway. */
  startDrag: (args: StartDragRequest) => Promise<void>
  /** Create a new folder (at the root, or inside `parent`). */
  createDir: (args: CreateDirRequest) => Promise<CreateDirResult>
  /** Read a file's pinned pre-turn + current contents for the live-edits diff view. */
  diffFile: (args: DiffFileRequest) => Promise<DiffFileResult>
  /** Project-wide find: filename + content matches across the project root (capped, contained). */
  search: (args: SearchRequest) => Promise<SearchResult>
  /** Project-wide replace (safety-git-checkpointed first; undoable as one step). Returns the counts. */
  replaceAll: (args: ReplaceRequest) => Promise<ReplaceResult>
  // The Library — the document surface.
  /** The Library's one read: the project's documents, narrowed by text and kind, already filtered
   *  through the doc list's own exclusion rules in main. */
  libraryQuery: (args: LibraryQueryRequest) => Promise<LibraryQueryResult>
  /** Ask a question across the project's documents AND its session transcripts; the answer carries
   *  citations into both. */
  libraryAsk: (args: LibraryAskRequest) => Promise<LibraryAskResult>
  /** Cancel an in-flight one-shot whose result no longer has a surface to land on. */
  cancelLibraryAsk: (requestId: string) => void
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
  /** A proposed description for the save about to happen. Read-only; never blocks the save. */
  gitProposeMessage: (args: GitProposeMessageRequest) => Promise<GitProposeMessageResult>
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
  /** App-global files main couldn't read this run (project list, settings). All-false when healthy. */
  getDataIntegrity: () => Promise<DataIntegrity>
  /** A native File-menu action for this project window. */
  onFileMenuCommand: (listener: (command: FileMenuCommand) => void) => () => void
  /** Delete a project (ProjectHome only): stop its apps, move the folder to the Trash, drop recents. */
  deleteProject: (args: ProjectDeleteRequest) => Promise<ProjectDeleteResult>
  // Mini apps (the face — seam ③, flag-gated in main).
  /** Registered mini apps + live state; [] when the mini-apps flag is off. */
  miniAppsList: () => Promise<MiniAppInfo[]>
  /** Start (or join) a registered mini app under the supervisor; resolves once it's serving. */
  miniAppsStart: (args: MiniAppStartRequest) => Promise<MiniAppStartResult>
  /** Subscribe to registry/run-state changes (re-fetch the list on fire); returns an unsubscribe fn. */
  onMiniAppsChanged: (listener: () => void) => () => void
  /** Surface the window already showing this app and flip it to the app's face (already-open path). */
  miniAppsFront: (args: MiniAppFrontRequest) => Promise<void>
  /** main→renderer: front this window's app face for `dir` (the already-open handoff). Unsubscribe fn. */
  onFrontFace: (listener: (dir: string) => void) => () => void
  /** Per-app API-key consent + spend for the Settings toggle; [] when the flag is off. */
  miniAppsBridgeInfo: () => Promise<MiniAppBridgeInfo[]>
  /** Allow or revoke one app's use of the owner's API key. */
  miniAppsSetBridgeConsent: (args: MiniAppBridgeConsentRequest) => Promise<void>
  // Approval gate ("Ask me" mode).
  /** Subscribe to tool-approval requests; returns an unsubscribe fn. */
  onApprovalRequest: (listener: (req: ApprovalRequest) => void) => () => void
  /** Subscribe to session-wide approval cancellations; returns an unsubscribe fn. */
  onApprovalCancelled: (listener: (e: ApprovalCancelled) => void) => () => void
  /** Subscribe to single-request resolutions (answered on any head); returns an unsubscribe fn. */
  onApprovalResolved: (listener: (e: ApprovalResolved) => void) => () => void
  /** Read this window's still-pending prompts after a renderer reload missed their live push. */
  getPendingApprovals: () => Promise<ApprovalRequest[]>
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
  /** Provider-keyed model catalogs for picker surfaces. Adding a provider extends this DTO rather than
   *  adding another provider-specific desktop/phone transport pair. */
  getProviderModelCatalogs: () => Promise<ProviderModelCatalogs>
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
  /** Resolve a doc-relative image `ref` (against the doc at `docPath`) to a `koda-preview://` URL the
   *  renderer can load; null if it escapes the project or doesn't exist. */
  docAssetUrl: (docPath: string, ref: string) => Promise<string | null>
  /** Export the open doc as a PDF (save dialog + auto-open). Null path = user cancelled. */
  exportPdf: (args: ExportPdfRequest) => Promise<ExportPdfResult>
  /** Re-run a session's last preview (dev command or static file) when it's been torn down — the
   *  "Restart preview" button. Resolves with the served URL (main also pushes `preview:show`), or
   *  rejects if the command fails to come up / the file is gone. */
  previewRestart: (sessionId: string, restart: PreviewRestart) => Promise<{ url: string }>
  /** Subscribe to "show this preview URL" pushes (the agent started the dev server, or the user hit
   *  Restart); returns an unsubscribe fn. The renderer opens/points the preview surface at the URL, on
   *  the editor of the session that triggered it (`sessionId`) — not whichever session is focused when
   *  it lands — and remembers `restart` so the preview can be brought back after it's gone. */
  onPreviewShow: (listener: (url: string, sessionId: string, restart: PreviewRestart) => void) => () => void
  /** Subscribe to "that dev server stopped serving" pushes (it exited, crashed, or was replaced). The
   *  renderer drops the live mark on any preview surface pointed at `url`, so the tab stops showing a
   *  running app that isn't. Returns an unsubscribe fn. */
  onPreviewStopped: (listener: (url: string) => void) => () => void
  /** Subscribe to main's "measure the preview iframe" requests (the agent called view_preview):
   *  reply via respondPreviewCapture with the iframe's rect, or null if no preview is showing.
   *  Returns an unsubscribe fn. */
  onPreviewCaptureRequest: (listener: (correlationId: string) => void) => () => void
  /** Answer a capture request with the preview iframe's on-screen rect (null = nothing to capture) and
   *  the window's devicePixelRatio (so main caps the capture by PHYSICAL pixels — the real token lever). */
  respondPreviewCapture: (correlationId: string, rect: PreviewRect | null, dpr: number) => void
  /** Persist a pasted/dropped attachment to the project's `.koda/scratch/` folder; returns its relative path. */
  saveScratchImage: (args: ScratchSaveRequest) => Promise<ScratchSaveResult>
  /** Composer attach menu: native file dialog → picked files' bytes (staged like a drop). */
  pickComposerFiles: () => Promise<PickFilesResult>
  /** Composer attach menu: "point at a file or folder" → the chosen absolute path (null = canceled). */
  pickComposerPath: () => Promise<PickPathResult>
  /** Page through this project's recent scratch images (newest first) for the Recent images strip. */
  listScratchImages: (args: ScratchListRequest) => Promise<ScratchListResult>
  /** Read a doc's presentation sidecar (table column widths, …). Empty `{}` when none/unreadable. */
  getDocMeta: (args: DocMetaGetRequest) => Promise<DocMeta>
  /** Persist a doc's presentation sidecar. Best-effort (a lost column width never breaks anything). */
  setDocMeta: (args: DocMetaSetRequest) => Promise<void>
  /** How heavy this project's memory navigation pair is (status-bar pill + Settings → Memory). */
  getMemoryWeight: () => Promise<MemoryWeight>
  /** Cloud-backup status for THIS project (Settings → Backup). Cheap; safe to poll on section open. */
  getBackupStatus: () => Promise<BackupStatus>
  /** Bundle + seal + upload this project now (the "Back up now" button). Resolves to fresh status. */
  backupNow: () => Promise<BackupStatus>
  /** The full recovery code — only ever called from a user-initiated reveal, never auto-shown.
   *  `unreadable` (vs. plain absent) tells Settings the key file exists but this Mac can't open it —
   *  a state that must never read as "nothing to show yet". */
  getBackupRecoveryCode: () => Promise<{ code: string | null; unreadable: boolean }>
  /** Every backed-up project on this account (the restore picker; metadata only). */
  listCloudBackups: () => Promise<BackupManifest[]>
  /** Rebuild a backed-up project into a fresh folder (disaster recovery / fresh Mac). */
  restoreCloudBackup: (args: BackupRestoreRequest) => Promise<BackupRestoreResult>
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

  // Connect tier (connect-embedded-tailscale.md Build A) — the embedded tailnet node.
  /** The node's live state for the "reachable from your phone" row. */
  getConnectState: () => Promise<ConnectState>
  /** The account's devices from the coordination plane (network call; may return an error string). */
  getConnectDevices: () => Promise<ConnectDevicesResult>
  /** Reset all remote access; nodeId is an ownership/retry handle, not per-device scope. */
  revokeConnectDevice: (args: ConnectRevoke) => Promise<ConnectRevokeResult>
  /** Force a full rejoin (leave + the one door) when the row says this Mac is not reachable. */
  reconnectConnectNode: () => Promise<ConnectState>
  /** main→renderer push: the node's state or peer path changed. */
  onConnectActivity: (listener: (state: ConnectState) => void) => () => void
  /** The devices waiting to join this account's private network. Empty with `available:false` when
   *  this Mac cannot prove it is already on it. */
  getConnectEnrollments: () => Promise<ConnectEnrollmentsResult>
  /** Allow or refuse one waiting device. Approval mints nothing here: the waiting device asks again
   *  and gets its own key, so no credential is ever parked anywhere waiting to be collected. */
  decideConnectEnrollment: (args: ConnectEnrollmentDecide) => Promise<ConnectEnrollmentDecideResult>
  // Provider-outage watch (engine/status-watch.ts) — the status-bar pill.
  /** Subscribe to provider outage/recovery pushes; unsubscribe fn. */
  onProviderStatus: (listener: (e: ProviderStatusEvent) => void) => () => void
  /** Current down-state (engines mid-outage), for seeding a window that opens during one. */
  getProviderStatus: () => Promise<ProviderStatusEvent[]>
  /** On-arrival re-check (window focus / launch): surface a confirmed incident the user hasn't hit yet. */
  refreshProviderStatus: (engines: string[]) => Promise<void>
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
  /** Subscribe to cloud-account auth changes (sign-in restored, or dead-token needs-re-sign-in). */
  onRemoteAuthChanged: (listener: (state: RemoteAuthState) => void) => () => void
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
