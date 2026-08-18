/**
 * The Codex engine driver — the second engine behind the same adapter seam as `adapter.ts`
 * (architecture/multi-engine-codex.md, Piece 2). It drives `codex app-server --stdio` (bidirectional
 * JSON-RPC) instead of `claude -p` (one-way NDJSON), but emits the SAME normalized `EngineEvent`s
 * upward, so the session manager, IPC, renderer, and output view never learn a second vocabulary.
 *
 * Two protocol differences from Claude shape the file:
 *   1. JSON-RPC has three inbound message classes — responses to OUR calls, server NOTIFICATIONS
 *      (the stream), and server-initiated REQUESTS (the native per-tool approvals, where Claude needs
 *      an MCP broker). We route by shape: id+result → our pending map; method, no id → notification;
 *      method + id → a server request we must answer.
 *   2. Approvals arrive natively (no broker). We map each onto the SAME engine-neutral `gate.decide()`
 *      Claude reaches through the broker — so checkpoint-before-allow + the per-cwd mutex + the
 *      3-tier posture are preserved by construction (broker/gate.ts is untouched).
 *
 * INVARIANT carried over from the Claude driver: never `await` a server-request handler inside the
 * stdout drain — detach it. A handler can block on a human approval for minutes; awaiting it would
 * stall the read loop and a full pipe buffer would deadlock the engine.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { z } from 'zod'
import { TURN_REJECTED_STOP_REASON } from '@shared/ipc'
import type {
  ApprovalMode,
  EngineEvent,
  RawEngineEvent,
  ResumeCursor,
  SessionCapabilitySnapshot,
  ToolDecision,
} from '@shared/ipc'
import { rateLimitBand } from '@shared/rate-limits'
import {
  buildSessionCapabilitySnapshot,
  codexMcpServers,
  codexSkillNames,
} from '@shared/session-capabilities'
import type { EngineSession, EventSink, TurnImage } from './adapter'
import { buildCodexTurnSteering } from './codex-steering'
import { resolveEnginePath } from './binary'
import { buildEngineEnv, type EngineEnvOptions } from './env'
import { looksLikeProviderDown } from './status-watch'
import type { ApproveRequest, DecideFn } from '../broker/types'
import { BROKER_TOKEN_ENV, SERVER_NAME as BROKER_SERVER_NAME } from '../broker/server'
import type { McpStdioServer } from '../playwright/manager'
import { log } from '../logger'
import { logUnmappedEvent } from './unmapped-log'

export interface CodexSessionOpts {
  sessionId: string
  cwd: string
  /** The gate — Codex calls it directly from its approval callbacks (no broker on the Codex path). */
  decide: DecideFn
  /** Guardrail text → Codex's `developerInstructions` (ADDITIVE; never `baseInstructions`, which would
   *  REPLACE Codex's own agent prompt). Undefined only when no Koda rules/memory/docs are available.
   *  DURABLE text only: the always-on pack, project card, and skills. Anything that can change inside a
   *  conversation belongs in the per-turn block (codex-steering.ts), not here. */
  developerInstructions?: string
  /** The session's approval posture at spawn. Kept live by `setApprovalMode` and re-rendered into the
   *  steering block on every turn, so switching posture mid-thread never needs a respawn. */
  approvalMode?: ApprovalMode
  /** Per-project native skill overrides. Paths identify the installed bundled skill or a project
   *  `.claude/skills` fork; passed as `skills.config` at process start so Settings toggles are real
   *  delivery controls rather than prompt-level stand-down prose. */
  skillConfig?: Array<{ path: string; enabled: boolean }>
  /** Whether this project's switches intentionally leave any Koda playbook enabled. Runtime
   * `skills/list` still decides ready vs degraded. */
  playbooksExpected?: boolean
  /** Preferred model id; ignored if the account's `model/list` doesn't include it (we fall back to the
   *  account default — a ChatGPT subscription rejects the `-codex` thread/start default). */
  model?: string
  /** Reasoning effort, passed through to the first turn (engine's own terms). */
  effort?: string
  /** This session's last resume cursor, handed back verbatim by the shared layer. THIS driver owns the
   *  shape (see `codexResumeCursor`): a valid cursor resumes that Codex thread by id (`thread/resume`,
   *  proven cross-process in spike/codex/verify-resume.mjs), anything else starts a fresh thread. Used
   *  on a restart-reattach AND a mid-conversation model/effort change (resume takes a model override, so
   *  the context survives the respawn). */
  resumeCursor?: ResumeCursor
  /** process.resourcesPath in the packaged app; omit in dev (resolves the Homebrew/dev codex). */
  resourcesPath?: string
  /** Explicit binary to spawn, bypassing resolveEnginePath — used by the engine-contract smoke test to
   *  drive a CANDIDATE codex build. Omit in production (resolves bundled → dev-fallback). */
  binaryPath?: string
  /** Auth/billing for buildEngineEnv — the manager sets engineId:'codex' + apiMode/apiKey. The broker
   *  bearer token (KODA_BROKER_TOKEN) rides here as `env.inject` when brokerUrl is set. */
  env?: EngineEnvOptions
  /** Koda's capability tools (preview / preview_file / view_preview / recovery / ensure_tool): the
   *  broker's streamable-HTTP MCP endpoint for this session, attached as `mcp_servers.koda_broker` so
   *  Codex can call them — the SAME broker Claude uses, minus its `approve` permission tool (Codex
   *  approvals are native). Absent ⇒ no capability tools (the v1 parity gap). */
  brokerUrl?: string
  /** The Playwright browser-verify MCP server (stdio), attached as `mcp_servers.playwright` when the
   *  optional browser-testing capability is wired — the SAME server Claude gets, so Codex reaches the
   *  same `playwright__*` tools. Absent ⇒ no browser tools (capability off / not installed). */
  playwrightServer?: McpStdioServer
  /** Fired once when the child exits (any cause) so the manager can drop its handle + tear down. */
  onClose?: (sessionId: string) => void
  /** The posture this turn's steering block actually declared, reported as the turn goes out. The owner
   *  pins the gate's fence to it so a posture change made WHILE the turn runs cannot relax or tighten
   *  the rules the model was steered under — the new mode reaches it on the next turn, which is exactly
   *  what the block's supersession text promises. */
  onTurnSteered?: (mode: ApprovalMode) => void
}

/**
 * Codex's resume cursor — the shape THIS driver owns inside the opaque `ResumeCursor.data`. Codex
 * reattaches by its OWN thread id, which is not Koda's session id. `turns` rides along for the
 * envelope's `resumable` answer only: Codex mints the thread during `thread/start`, before the user has
 * said anything, so a thread id alone was never proof that a conversation exists.
 */
const CodexResumeDataSchema = z.object({
  threadId: z.string().min(1),
  turns: z.number().int().nonnegative(),
})
type CodexResumeData = z.infer<typeof CodexResumeDataSchema>

/** Build this driver's cursor. Exported so the session manager can hand one back without reading it. */
export function codexResumeCursor(threadId: string, turns: number): ResumeCursor {
  return { engine: 'codex', resumable: turns > 0, data: { threadId, turns } }
}

/** Validate a cursor as OURS. A Claude blob or a hand-edited file starts a fresh thread instead. */
export function parseCodexResumeCursor(cursor: ResumeCursor | undefined): CodexResumeData | null {
  if (!cursor || cursor.engine !== 'codex') return null
  const parsed = CodexResumeDataSchema.safeParse(cursor.data)
  return parsed.success ? parsed.data : null
}

/** The Codex thread a live session is on, for the features that fork it (a side question). Reading the
 *  blob stays in the driver that owns it; callers pass the cursor and get an id or nothing. */
export function codexThreadId(cursor: ResumeCursor | undefined): string | undefined {
  return parseCodexResumeCursor(cursor)?.threadId
}

/** Launch a long-lived Codex session. Spawns immediately; the init handshake runs async and the first
 *  turn (if sent before it finishes) queues until the thread is ready. */
export function startCodexSession(onEvent: EventSink, opts: CodexSessionOpts): EngineSession {
  return new CodexSession(onEvent, opts)
}

/**
 * Map Codex's `TurnStatus` (`completed | interrupted | failed | inProgress`) onto the engine-neutral
 * `stopReason` the renderer understands (Claude's vocabulary: `success` / `error_*` / undefined).
 * Codex's SUCCESS sentinel is `completed` — it MUST normalize to "no notice" (undefined), not pass
 * through: the renderer flags any unrecognized non-`success` value as an abnormal "turn ended early —
 * X", which mislabeled every normal Codex turn as "TURN ENDED EARLY — COMPLETED". Only a genuine
 * `failed` surfaces a notice; an `interrupted` turn is a benign stop (the user knows they stopped it).
 */
function normalizeTurnStatus(status?: string): string | undefined {
  return status === 'failed' ? 'error_during_execution' : undefined
}

/** A compact human label for the delegated-work card. Codex's collaboration wire carries the full
 * assignment rather than a separate role/name, so use its first meaningful line and leave the whole
 * prompt available on the card for inspection. */
export function delegationDescription(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return 'Delegated task'
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}…`
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

const CAPABILITY_PROBE_TIMEOUT_MS = 2_000
const CAPABILITY_SETTLE_DELAY_MS = 1_500
const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 4_000

/** A startup inventory is additive: never let a protocol regression or slow MCP server block the
 * conversation. Each native read has one deadline and consumes no model turn; a late RPC response is
 * still drained by the ordinary pending-call map. The caller may perform one bounded settling read
 * when expected evidence is initially absent, because MCP and plugin startup can finish just after
 * thread creation. */
function boundedCapabilityProbe(promise: Promise<unknown>): Promise<{ value?: unknown; failed: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { value?: unknown; failed: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ failed: true }), CAPABILITY_PROBE_TIMEOUT_MS)
    timer.unref?.()
    promise.then(
      (value) => finish({ value, failed: false }),
      () => finish({ failed: true }),
    )
  })
}

/** The engine ANSWERED our call with a JSON-RPC error — as opposed to the transport dying under us.
 *  Only the former tells us anything about the request we made (e.g. that a thread is gone). */
export class CodexRpcError extends Error {}

interface McpToolElicitation {
  toolName: string
  input: unknown
}

interface CodexCollabAgentState {
  status?: string
  message?: string | null
}

type McpElicitationResponse = {
  action: 'accept' | 'decline'
  content: null
  _meta: null
}

/** Codex represents MCP tool approval as a form elicitation. Recover the original MCP tool name from
 * its deterministic fallback question and route it through Koda's existing gate. Other MCP
 * elicitations are genuine server-supplied forms/URLs; Koda has no renderer for those yet, so they
 * fail safe instead of being silently accepted. */
export function parseMcpToolElicitation(params: unknown): McpToolElicitation | null {
  const p = (params ?? {}) as Record<string, unknown>
  const meta = (p._meta ?? {}) as Record<string, unknown>
  if (p.mode !== 'form' || meta.codex_approval_kind !== 'mcp_tool_call') return null
  const server = typeof p.serverName === 'string' ? p.serverName : ''
  const message = typeof p.message === 'string' ? p.message : ''
  const tool = /run tool "([^"]+)"\??$/.exec(message)?.[1]
  if (!server || !tool) return null
  return { toolName: `mcp__${server}__${tool}`, input: meta.tool_params }
}

export function mcpElicitationResponse(accepted: boolean): McpElicitationResponse {
  return { action: accepted ? 'accept' : 'decline', content: null, _meta: null }
}

/**
 * JSON-RPC messages this driver ignores ON PURPOSE, so the unmapped log stays signal. Anything not
 * here and not translated below is logged — that is the "never silently swallowed" contract.
 *  - reasoning items: already carried live by the reasoning deltas.
 *  - userMessage items: Koda's own turn echoed back.
 *  - `item/started/agentMessage`: the finalized `completed` item is the block Koda renders.
 *  - the acked server requests (time, attestation, token refresh): answers, not events.
 */
const DELIBERATELY_IGNORED = new Set([
  'item/started/reasoning',
  'item/completed/reasoning',
  'item/started/userMessage',
  'item/completed/userMessage',
  'item/started/agentMessage',
  'item/started/contextCompaction',
  'item/started/collabAgentToolCall',
  'item/started/subAgentActivity',
  'request/currentTime/read',
  'request/attestation/generate',
  'request/chatgptAuthTokens/refresh',
])

/** Codex's own ids for a notification, flattened so a consumer can join a child thread to its launch
 *  without re-reading the payload. Only keys the message actually carries appear. */
export function codexIds(params: unknown): Record<string, string> | undefined {
  const p = (params ?? {}) as Record<string, unknown>
  const item = (p.item ?? {}) as Record<string, unknown>
  const turn = (p.turn ?? {}) as Record<string, unknown>
  const ids: Record<string, string> = {}
  const put = (key: string, value: unknown) => {
    if (typeof value === 'string' && value) ids[key] = value
  }
  put('threadId', p.threadId)
  put('turnId', turn.id ?? p.turnId)
  put('itemId', item.id ?? p.itemId)
  put('agentThreadId', item.agentThreadId)
  return Object.keys(ids).length ? ids : undefined
}

const EARLY_CHILD_NOTIFICATION_METHODS = new Set([
  'item/started',
  'item/completed',
  'turn/started',
  'turn/completed',
])
const MAX_PENDING_CHILD_THREADS = 16
const MAX_PENDING_CHILD_NOTIFICATIONS = 64
type PendingChildNotification = { method: string; params: unknown }

class CodexSession implements EngineSession {
  readonly id: string
  private readonly cwd: string
  private readonly child: ChildProcessWithoutNullStreams
  private readonly onEvent: EventSink
  private readonly opts: CodexSessionOpts

  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private threadId: string | null = null
  /** Completed turns on THIS thread, carried forward from the cursor we resumed with. Codex hands out a
   *  thread id before the user has said anything, so this is what makes the cursor's `resumable` honest. */
  private turns = 0
  private currentTurnId: string | null = null
  private ready = false
  private disposed = false
  /** Transport truth is separate from an intentional dispose. Startup probes are fail-soft, but a
   *  dead child is not a degraded capability state and must never be promoted to SessionStarted. */
  private closed = false
  /** Resolves dispose()'s await once the child's 'close' actually fires (so a respawn-with-same-id
   *  doesn't create the replacement before this one's teardown ran — mirrors the Claude adapter). */
  private closeResolve?: () => void
  /** Turns sent before the thread handshake finished — flushed in order once ready. */
  private readonly turnQueue: { text: string; images?: TurnImage[] }[] = []
  /** itemId → file path, captured from `item/started` (fileChange) so the file-change approval — whose
   *  params DON'T carry the path — can label the gate request + checkpoint with the real file. */
  private readonly itemPaths = new Map<string, string[]>()
  /** Cumulative reasoning chars this turn → a rough ThinkingDelta token estimate (reset each turn). */
  private reasoningChars = 0
  /** Latest thread token-usage snapshot — turned into ContextUsage on turn completion (the meter). */
  private lastTokenUsage: CodexThreadTokenUsage | null = null
  /** Newer servers can emit both the contextCompaction item and the deprecated thread notification. */
  private compactionNotifiedThisTurn = false
  /** The first replacement usage snapshot after compaction must repaint even if the turn already ended. */
  private awaitingCompactionUsage = false
  /** Codex streams every collaboration child on the parent's app-server connection. Keep the child
   *  thread → spawn item relationship so its messages/tools render under one delegated-work card
   *  rather than leaking into the parent transcript. */
  private readonly childLaunchIds = new Map<string, string>()
  private readonly childTurnIds = new Map<string, string>()
  private readonly childFinalText = new Map<string, string>()
  /** Child output can beat the parent's subAgentActivity item across Codex's async event producers.
   *  Hold only the lifecycle/item notifications needed to reconstruct its card once that link lands. */
  private readonly pendingChildNotifications = new Map<string, PendingChildNotification[]>()
  /** A stop can race the child's first turn/started notification. Remember it and interrupt as soon
   *  as Codex gives us the turn id instead of telling the user the task could not be stopped. */
  private readonly pendingChildStops = new Set<string>()
  /** The native notification being translated right now — stamped onto every event it produces. */
  private nativeRaw: RawEngineEvent | undefined
  /** The session's posture RIGHT NOW. Every turn re-renders the steering block from it, so a switch
   *  mid-thread lands on the next turn with no respawn (engine-capabilities: planMode 'turnText'). */
  private approvalMode: ApprovalMode
  /** The posture actually RENDERED into the running turn's block, or null between turns. Every
   *  per-turn safety decision reads this, never `approvalMode`: the user can flip posture while a turn
   *  runs, and a turn must be held to the rules its own block gave the model. Same lifecycle as the
   *  gate's pin — set as the turn goes out, cleared when it ends. */
  private steeredTurnMode: ApprovalMode | null = null
  /** The model Codex actually resolved for this thread — the runtime-identity footer's honest answer. */
  private activeModel = ''

  constructor(onEvent: EventSink, opts: CodexSessionOpts) {
    this.onEvent = onEvent
    this.opts = opts
    this.id = opts.sessionId
    this.cwd = opts.cwd
    this.approvalMode = opts.approvalMode ?? 'auto'

    const loc = opts.binaryPath
      ? { path: opts.binaryPath, source: 'dev-fallback' as const }
      : resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' })
    const env = buildEngineEnv(process.env, { ...opts.env, engineId: 'codex' })
    // `-c check_for_update_on_startup=false`: suppress the startup version-check network call. Codex
    // never self-replaces (manual `codex update`), so the binary stays pinned without an env toggle.
    const args = [
      'app-server',
      '--stdio',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      `tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`,
    ]
    if (opts.skillConfig?.length) {
      const entries = opts.skillConfig
        .map(({ path, enabled }) => `{path=${JSON.stringify(path)},enabled=${enabled ? 'true' : 'false'}}`)
        .join(',')
      args.push('-c', `skills.config=[${entries}]`)
    }
    // Attach Koda's capability tools as a streamable-HTTP MCP server (the same broker Claude consults).
    // The bearer token is read from the env var the broker token was injected as (KODA_BROKER_TOKEN),
    // so it never lands in argv/process listings. The `-c` value is parsed as TOML — hence the quotes.
    if (opts.brokerUrl) {
      args.push('-c', `mcp_servers.${BROKER_SERVER_NAME}.url="${opts.brokerUrl}"`)
      args.push('-c', `mcp_servers.${BROKER_SERVER_NAME}.bearer_token_env_var="${BROKER_TOKEN_ENV}"`)
    }
    // Playwright is a STDIO server (command/args/env), attached the same session-scoped way as the
    // broker. Each `-c` value is TOML; JSON.stringify yields valid TOML basic-strings/arrays for these
    // (macOS paths have no `"`/`\`), and env vars go as dotted keys to sidestep inline-table quoting.
    if (opts.playwrightServer) {
      const pw = opts.playwrightServer
      args.push('-c', `mcp_servers.playwright.command=${JSON.stringify(pw.command)}`)
      args.push('-c', `mcp_servers.playwright.args=${JSON.stringify(pw.args)}`)
      for (const [key, value] of Object.entries(pw.env)) {
        args.push('-c', `mcp_servers.playwright.env.${key}=${JSON.stringify(value)}`)
      }
    }
    this.child = spawn(loc.path, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d) => log.warn('codex', 'stderr', String(d).slice(0, 500)))
    this.child.on('error', (err) => {
      this.emit({ type: 'EngineError', sessionId: this.id, message: `Codex failed to start: ${err.message}`, fatal: true })
    })
    this.child.on('close', () => {
      this.closed = true
      if (!this.disposed) log.info('codex', 'process closed', { sessionId: this.id })
      for (const p of this.pending.values()) p.reject(new Error('codex process closed'))
      this.pending.clear()
      this.opts.onClose?.(this.id)
      this.closeResolve?.() // unblock dispose()'s await
    })

    void this.init()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  private async init(): Promise<void> {
    try {
      await this.rpc('initialize', {
        clientInfo: { name: 'koda', title: 'Koda', version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      const model = await this.pickModel()
      // sandbox:'read-only' + approvalPolicy:'on-request' is load-bearing: it forces EVERY file change
      // and command to surface as a server-initiated approval → our gate sees them all → checkpoint-
      // before-mutation holds (the same guarantee Claude's broker gives by seeing every tool). The
      // write/command still runs after we reply 'accept' (proven in spike/codex/turn-capture).
      const params: Record<string, unknown> = {
        cwd: this.cwd,
        model,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        ...(this.opts.developerInstructions ? { developerInstructions: this.opts.developerInstructions } : {}),
        ...(this.opts.effort ? { config: { model_reasoning_effort: this.opts.effort } } : {}),
      }
      // Resume by thread id (loaded from disk, proven cross-process in spike/codex/verify-resume) when
      // the cursor names a thread that has actually held a turn — preserves context across a restart or
      // a model/effort change (resume takes the model override above). Fresh `thread/start` otherwise.
      const parsed = parseCodexResumeCursor(this.opts.resumeCursor)
      const resume = parsed && parsed.turns > 0 ? parsed : null
      const method = resume ? 'thread/resume' : 'thread/start'
      if (resume) params.threadId = resume.threadId
      let res: { thread?: { id?: string }; model?: string }
      try {
        res = (await this.rpc(method, params)) as { thread?: { id?: string }; model?: string }
      } catch (err) {
        // The engine refused to reattach the thread we named (deleted, stale, or from another account).
        // That is recoverable, not fatal: report a resume miss and let the owner restart this session
        // clean. A transport failure (the process died) is NOT a miss — it falls through to the fatal.
        if (resume && err instanceof CodexRpcError) {
          this.emit({
            type: 'EngineError',
            sessionId: this.id,
            message: 'the engine no longer holds this conversation',
            fatal: false,
            category: 'resumeMiss',
          })
          return
        }
        throw err
      }
      this.threadId = res?.thread?.id ?? resume?.threadId ?? null
      if (!this.threadId) throw new Error(`${method} returned no thread id`)
      this.turns = resume?.turns ?? 0
      const capabilitySnapshot = await this.attestCapabilities()
      this.assertTransportOpen()
      this.ready = true
      this.activeModel = res?.model ?? model ?? ''
      this.emit({
        type: 'SessionStarted',
        sessionId: this.id,
        model: this.activeModel,
        tools: capabilitySnapshot.tools,
        cwd: this.cwd,
      })
      this.emit({ type: 'SessionCapabilitiesUpdated', sessionId: this.id, snapshot: capabilitySnapshot })
      // The thread id is the whole of Codex's resume state; publish it before the first turn so a crash
      // or a posture respawn can hand it straight back.
      this.emitResumeCursor()
      // Pull a fresh window snapshot right away so the gauge shows the real number from the first paint,
      // not the stale boot-seeded value (the `updated` push is sparse — see refreshRateLimits).
      this.refreshRateLimits()
      // Flush any turns the user sent during the handshake, in order.
      for (const q of this.turnQueue.splice(0)) this.doTurn(q.text, q.images)
    } catch (err) {
      if (this.disposed) return
      this.emit({
        type: 'EngineError',
        sessionId: this.id,
        message: `Codex session failed to start: ${err instanceof Error ? err.message : String(err)}`,
        fatal: true,
      })
    }
  }

  /** Pick a model the account can actually use: the caller's choice if `model/list` includes it, else
   *  the account default, else the first non-`-codex` model (a ChatGPT subscription rejects `-codex`). */
  private async pickModel(): Promise<string | undefined> {
    const res = (await this.rpc('model/list', {}).catch(() => null)) as
      | { data?: Array<{ id?: string; isDefault?: boolean }> }
      | null
    const models = (res?.data ?? []).filter((m): m is { id: string; isDefault?: boolean } => !!m.id)
    if (models.length === 0) return this.opts.model // empty list → let the engine decide
    if (this.opts.model && models.some((m) => m.id === this.opts.model)) return this.opts.model
    const def = models.find((m) => m.isDefault)
    if (def) return def.id
    return (models.find((m) => !m.id.endsWith('-codex')) ?? models[0]).id
  }

  private assertTransportOpen(): void {
    if (this.closed) throw new Error('codex process closed during startup')
  }

  /** Ask Codex's app-server for its own workspace-scoped skill and MCP inventories. These are native,
   * zero-model-token reads after thread creation, so they attest the effective cwd/config without
   * launching a hidden agent turn or loading user MCPs in a separate probe process. MCP/plugin
   * startup is asynchronous in app-server, so missing expected evidence gets one delayed reread. */
  private async attestCapabilities(): Promise<SessionCapabilitySnapshot> {
    const first = await this.readCapabilitySnapshot()
    this.assertTransportOpen()
    if (!first.capabilities.some((capability) => capability.status === 'degraded')) return first

    await new Promise<void>((resolve) => setTimeout(resolve, CAPABILITY_SETTLE_DELAY_MS))
    if (this.disposed) throw new Error('codex session disposed during startup')
    this.assertTransportOpen()
    const settled = await this.readCapabilitySnapshot()
    this.assertTransportOpen()
    return settled
  }

  private async readCapabilitySnapshot(): Promise<SessionCapabilitySnapshot> {
    const [skillsProbe, mcpProbe] = await Promise.all([
      boundedCapabilityProbe(this.rpc('skills/list', { cwds: [this.cwd] })),
      // We consume only tool names + auth/connectivity. `full` also waits for every server's
      // resources/templates; one slow unrelated MCP could then exhaust our whole startup deadline and
      // make healthy Koda tools look absent. Codex exposes this narrow mode for exactly that case.
      boundedCapabilityProbe(
        this.rpc('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId: this.threadId }),
      ),
    ])
    const skills = skillsProbe.failed ? null : codexSkillNames(skillsProbe.value, this.cwd)
    const mcpServers = mcpProbe.failed ? null : codexMcpServers(mcpProbe.value)
    return buildSessionCapabilitySnapshot({
      engine: 'codex',
      cwd: this.cwd,
      source: 'native-probe',
      skills: skills ?? [],
      mcpServers: mcpServers ?? [],
      expected: {
        kodaTools: !!this.opts.brokerUrl,
        playbooks: this.opts.playbooksExpected ?? true,
        browserTesting: !!this.opts.playwrightServer,
      },
      probeFailed: {
        skills: skillsProbe.failed || skills === null,
        mcp: mcpProbe.failed || mcpServers === null,
      },
    })
  }

  sendTurn(text: string, images?: TurnImage[]): boolean {
    if (this.disposed) return false
    if (!this.ready) {
      this.turnQueue.push({ text, images })
      return true
    }
    return this.doTurn(text, images)
  }

  /**
   * The session's posture changed. Nothing is sent now — the next turn re-renders the steering block
   * from this value, which is the whole point of turn-scoped delivery: no respawn, no lost context,
   * and the previous mode's text stays in the thread where the new block explicitly supersedes it.
   * A queued turn (sent during the handshake) also picks this up, since the block is built at delivery.
   */
  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode
  }

  private doTurn(text: string, images?: TurnImage[]): boolean {
    if (!this.threadId) return false
    this.reasoningChars = 0
    this.compactionNotifiedThisTurn = false
    // The steering block leads the turn as its own text element — the only turn-scoped instruction
    // channel `turn/start` has (see codex-steering.ts for the protocol check). Built HERE, at
    // delivery, so it always states the posture the gate will actually enforce for this turn. Read the
    // live posture ONCE and hold it: everything downstream — the block, the driver's own refusals, the
    // gate's pin — must agree about what this turn was told, even if the user flips posture mid-turn.
    const steered = this.approvalMode
    this.steeredTurnMode = steered
    const input: unknown[] = [
      {
        type: 'text',
        text: buildCodexTurnSteering({
          mode: steered,
          model: this.activeModel || this.opts.model,
          effort: this.opts.effort,
        }),
        text_elements: [],
      },
      { type: 'text', text, text_elements: [] },
    ]
    // Report the mode this turn was steered with, BEFORE the turn goes out: the fence that judges
    // this turn's tool calls must be the one the model was just told about, even if the user flips
    // posture a second later while it runs.
    this.opts.onTurnSteered?.(steered)
    for (const img of images ?? []) {
      input.push({ type: 'image', url: `data:${img.mediaType};base64,${img.dataBase64}` })
    }
    this.rpc('turn/start', { threadId: this.threadId, input }).then(
      (res) => {
        const turnId = (res as { turn?: { id?: string } })?.turn?.id
        if (turnId) this.currentTurnId = turnId
      },
      (err) => {
        // No turn is running, so nothing is owed the block's rules until the next one goes out.
        this.steeredTurnMode = null
        if (this.disposed) return
        const message = `turn failed: ${err.message}`
        this.emit({
          type: 'EngineError',
          sessionId: this.id,
          message,
          fatal: false,
          category: 'turnRejected',
          ...(looksLikeProviderDown(message) ? { providerStatus: 'down' as const } : {}),
        })
        // `turnRejected` was added after the first phone client shipped. That client only releases its
        // busy gate for TurnComplete or a fatal EngineError, and marking this reusable process fatal
        // would be false. Pair the classified error with an explicitly unsuccessful legacy terminal.
        // The handshake carries no app/capability version, so we cannot withhold this from newer clients
        // or stop old clients that haptic on every TurnComplete; the new client suppresses that haptic.
        this.emit({
          type: 'TurnComplete',
          sessionId: this.id,
          stopReason: TURN_REJECTED_STOP_REASON,
        })
      },
    )
    return true
  }

  interrupt(): void {
    if (!this.threadId || !this.currentTurnId) return
    // Native graceful interrupt — no `control_request` workaround (Claude needed one). Fire-and-forget.
    this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId }).catch((err) =>
      log.warn('codex', 'interrupt failed', err instanceof Error ? err.message : err),
    )
  }

  stopTask(taskId: string): boolean {
    if (!this.childLaunchIds.has(taskId)) return false
    const turnId = this.childTurnIds.get(taskId)
    if (!turnId) {
      this.pendingChildStops.add(taskId)
      return true
    }
    this.interruptChild(taskId, turnId)
    return true
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.closed) return
    // Await the child's 'close' so the owner's respawn-with-same-id (start() does `await dispose(id)`
    // before re-registering) can't have the OLD child's late close tear down the NEW session's state.
    // A bounded race guards against 'close' never arriving (already-dead child, stuck pipe).
    const closed = new Promise<void>((resolve) => (this.closeResolve = resolve))
    this.child.kill('SIGKILL')
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 2000))])
  }

  // ── JSON-RPC framing ─────────────────────────────────────────────────────────
  /** Send a request, resolve with its result (or reject on a JSON-RPC error / process close). */
  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  /** Reply to a server-initiated request (an approval / ack). */
  private reply(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  private write(msg: unknown): void {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line)
    } catch {
      return // codex prints the occasional non-JSON line; ignore
    }

    // 1. Response to one of OUR calls (id present, no method).
    if (msg.id !== undefined && msg.method === undefined) {
      const slot = this.pending.get(msg.id as number)
      if (!slot) return
      this.pending.delete(msg.id as number)
      if (msg.error) slot.reject(new CodexRpcError(JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
      return
    }
    // 2. Server-initiated REQUEST (id + method): the native approval / ack channel. DETACH — never
    //    await inside the read loop (it can block on a human for minutes → pipe-buffer deadlock).
    if (msg.id !== undefined && typeof msg.method === 'string') {
      void this.handleServerRequest(msg.id as number, msg.method, msg.params)
      return
    }
    // 3. Notification (method, no id): the event stream.
    if (typeof msg.method === 'string') this.handleNotification(msg.method, msg.params)
  }

  // ── Notification → EngineEvent ────────────────────────────────────────────────
  private handleNotification(method: string, params: unknown): void {
    const previousRaw = this.nativeRaw
    this.nativeRaw = { source: 'codex', method, ids: codexIds(params), payload: params }
    try {
      this.translateNotification(method, params)
    } finally {
      // Restored rather than cleared: a buffered child notification replays INSIDE another
      // notification's translation, and the outer one still owns the events it emits afterwards.
      this.nativeRaw = previousRaw
    }
  }

  private translateNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    const eventThreadId = typeof p.threadId === 'string' ? p.threadId : ''
    const childLaunchId = eventThreadId ? this.childLaunchIds.get(eventThreadId) : undefined
    if (
      eventThreadId &&
      this.threadId &&
      eventThreadId !== this.threadId &&
      !childLaunchId &&
      EARLY_CHILD_NOTIFICATION_METHODS.has(method)
    ) {
      this.bufferPendingChildNotification(eventThreadId, method, params)
      return
    }
    switch (method) {
      case 'item/agentMessage/delta':
        // Child deltas have no parentToolUseId in the normalized protocol. Their finalized block below
        // carries the relationship, so ignore only the live delta instead of painting it as the lead.
        if (eventThreadId && eventThreadId !== this.threadId) break
        this.emit({ type: 'AssistantDelta', sessionId: this.id, text: String(p.delta ?? '') })
        break
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (eventThreadId && eventThreadId !== this.threadId) break
        this.reasoningChars += String(p.delta ?? '').length
        this.emit({ type: 'ThinkingDelta', sessionId: this.id, estimatedTokens: Math.ceil(this.reasoningChars / 4) })
        break
      case 'item/commandExecution/outputDelta':
        if (eventThreadId && eventThreadId !== this.threadId) break
        this.emit({
          type: 'ToolProgress',
          sessionId: this.id,
          id: String(p.itemId ?? ''),
          output: String(p.delta ?? ''),
        })
        break
      case 'turn/plan/updated': {
        if (eventThreadId && eventThreadId !== this.threadId) break
        const plan = (p.plan as Array<Record<string, unknown>>) ?? []
        this.emit({
          type: 'PlanUpdate',
          sessionId: this.id,
          steps: codexPlanSteps(plan),
        })
        break
      }
      case 'thread/compacted':
        if (eventThreadId && eventThreadId !== this.threadId) break
        this.emitCompaction()
        break
      case 'item/started':
        // The pre-switch queue holds early children. Keep this final guard for unlinked/nested work
        // so it can never be misrepresented as the lead's.
        if (eventThreadId && eventThreadId !== this.threadId && !childLaunchId) break
        this.onItem(p.item, 'started', childLaunchId)
        break
      case 'item/completed':
        if (eventThreadId && eventThreadId !== this.threadId && !childLaunchId) break
        this.onItem(p.item, 'completed', childLaunchId)
        break
      case 'thread/tokenUsage/updated':
        if (eventThreadId && eventThreadId !== this.threadId) break
        this.lastTokenUsage = (p.tokenUsage as CodexThreadTokenUsage) ?? this.lastTokenUsage
        if (this.awaitingCompactionUsage) {
          const context = this.contextUsage()
          if (context) {
            this.awaitingCompactionUsage = false
            this.emit({ type: 'ContextUsageUpdate', sessionId: this.id, context })
          }
        }
        break
      case 'turn/started': {
        const turnId = String((p.turn as { id?: string })?.id ?? p.turnId ?? '')
        if (childLaunchId) {
          this.childTurnIds.set(eventThreadId, turnId)
          this.emit({
            type: 'SubagentProgress',
            sessionId: this.id,
            toolUseId: childLaunchId,
            taskId: eventThreadId,
            status: 'running',
          })
          if (this.pendingChildStops.delete(eventThreadId)) this.interruptChild(eventThreadId, turnId)
          break
        }
        if (eventThreadId && eventThreadId !== this.threadId) break
        this.currentTurnId = turnId || this.currentTurnId
        break
      }
      case 'turn/completed': {
        const status = (p.turn as { status?: string })?.status
        if (childLaunchId) {
          this.emit({
            type: 'SubagentCompleted',
            sessionId: this.id,
            toolUseId: childLaunchId,
            taskId: eventThreadId,
            resultText: this.childFinalText.get(eventThreadId),
            outcome: status === 'interrupted' ? 'interrupted' : 'completed',
            isError: status === 'failed',
          })
          this.childLaunchIds.delete(eventThreadId)
          this.childTurnIds.delete(eventThreadId)
          this.childFinalText.delete(eventThreadId)
          this.pendingChildStops.delete(eventThreadId)
          // Collaboration spends the same account quota as the lead. Child usage must not replace the
          // parent's context meter, but it must refresh the account windows when that spend lands.
          this.refreshRateLimits()
          break
        }
        if (eventThreadId && eventThreadId !== this.threadId) break
        // A completed turn is what makes this thread worth reattaching to, so the cursor moves with it.
        this.turns += 1
        this.emitResumeCursor()
        this.emit({
          type: 'TurnComplete',
          sessionId: this.id,
          context: this.contextUsage(),
          stopReason: normalizeTurnStatus(status),
        })
        this.currentTurnId = null
        // Turn boundary: the live posture is the truth again, and the next turn's block will say so.
        this.steeredTurnMode = null
        // Refresh the account windows now that the turn spent tokens — the sparse `updated` push often
        // doesn't fire per turn, so an active read is what actually keeps the 5-hour gauge climbing.
        this.refreshRateLimits()
        break
      }
      case 'error': {
        if (eventThreadId && eventThreadId !== this.threadId) break
        const err = (p.error as { message?: string })?.message ?? 'engine error'
        this.emit({
          type: 'EngineError',
          sessionId: this.id,
          message: err,
          fatal: false,
          ...(looksLikeProviderDown(err) ? { providerStatus: 'down' as const } : {}),
        })
        break
      }
      case 'account/rateLimits/updated':
        this.emitRateLimits(p.rateLimits as CodexRateLimitSnapshot)
        break
      // Everything else (diff, mcp progress, an engine bump's new notification) is not surfaced — but
      // it is written to the session's unmapped log, so "does Codex emit anything for X" is answerable
      // from a real run instead of another wire spike.
      default:
        this.unmapped(method, params, codexIds(params))
    }
  }

  /** An `item` lifecycle event (started/completed) → a tool/assistant EngineEvent. The item's `type`
   *  discriminates; command + file changes become Bash/Write tool cards, agent messages become blocks. */
  private onItem(itemRaw: unknown, phase: 'started' | 'completed', parentToolUseId?: string): void {
    const item = (itemRaw ?? {}) as Record<string, unknown>
    const type = String(item.type ?? '')
    const id = String(item.id ?? '')
    switch (type) {
      case 'commandExecution':
        if (phase === 'started') {
          this.emit({
            type: 'ToolRequested',
            sessionId: this.id,
            id,
            name: 'Bash',
            input: { command: item.command },
            ...(parentToolUseId ? { parentToolUseId } : {}),
          })
        } else {
          const exit = item.exitCode
          this.emit({
            type: 'ToolResult',
            sessionId: this.id,
            id,
            output: String(item.aggregatedOutput ?? ''),
            isError: item.status === 'failed' || (typeof exit === 'number' && exit !== 0),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          })
        }
        break
      case 'fileChange': {
        const changes = (item.changes as Array<{ path?: string }>) ?? []
        const paths = changes.map((c) => c.path).filter((path): path is string => Boolean(path))
        const path = paths[0]
        if (phase === 'started') {
          if (paths.length) this.itemPaths.set(id, paths)
          this.emit({
            type: 'ToolRequested',
            sessionId: this.id,
            id,
            name: 'Write',
            input: { file_path: path, file_paths: paths },
            ...(parentToolUseId ? { parentToolUseId } : {}),
          })
        } else {
          this.emit({
            type: 'ToolResult',
            sessionId: this.id,
            id,
            output: paths.length ? `Updated ${paths.join(', ')}` : 'Updated files',
            isError: item.status === 'failed',
            ...(parentToolUseId ? { parentToolUseId } : {}),
          })
          this.itemPaths.delete(id)
        }
        break
      }
      case 'agentMessage':
        // Live deltas already painted the text; the completed item is the finalized markdown block.
        if (phase === 'completed') {
          const markdown = String(item.text ?? '')
          if (parentToolUseId) {
            this.emit({ type: 'AssistantBlock', sessionId: this.id, markdown, parentToolUseId })
            if (item.phase === 'final_answer') {
              const childThreadId = this.childThreadForLaunch(parentToolUseId)
              if (childThreadId) this.childFinalText.set(childThreadId, markdown)
            }
          } else this.emit({ type: 'AssistantBlock', sessionId: this.id, markdown })
        }
        break
      case 'contextCompaction':
        if (!parentToolUseId && phase === 'completed') this.emitCompaction()
        break
      case 'collabAgentToolCall':
        // 0.142.x represented a spawn with this item. Current Codex emits subAgentActivity below,
        // but keeping the old shape costs little and makes engine rollbacks safe.
        if (!parentToolUseId && phase === 'completed' && item.tool === 'spawnAgent') {
          const prompt = typeof item.prompt === 'string' ? item.prompt : ''
          const receiverThreadIds = Array.isArray(item.receiverThreadIds)
            ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string')
            : []
          for (const childThreadId of receiverThreadIds) {
            const state = ((item.agentsStates as Record<string, CodexCollabAgentState> | undefined) ?? {})[
              childThreadId
            ]
            const launchId = receiverThreadIds.length === 1 ? id : `${id}:${childThreadId}`
            this.startChildLifecycle(childThreadId, launchId, delegationDescription(prompt), prompt, state)
          }
        }
        break
      case 'subAgentActivity': {
        // 0.144.x's actual wire: `started` is a fresh child and `interacted` is a follow-up turn on an
        // existing idle child. A live app-server capture pins both shapes. If interacted ever arrives
        // while the child is still active, it is steering only — preserve that task's existing card.
        if (parentToolUseId || phase !== 'completed') break
        const kind = String(item.kind ?? '')
        const childThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : ''
        if (!childThreadId || (kind !== 'started' && kind !== 'interacted')) break
        if (kind === 'interacted' && this.childLaunchIds.has(childThreadId)) break
        const path = typeof item.agentPath === 'string' ? item.agentPath : ''
        const name = path.split('/').filter(Boolean).at(-1) ?? 'Delegated task'
        const description = kind === 'interacted' ? `Follow-up · ${name}` : name
        this.startChildLifecycle(childThreadId, id, description)
        break
      }
      // reasoning/userMessage/etc. are covered by deltas or are the user's own input — not surfaced
      // (DELIBERATELY_IGNORED). Any other item type is a shape Koda has no card for: log it.
      default:
        this.unmapped(`item/${phase}/${type || 'unknown'}`, item, codexIds({ item }))
    }
  }

  private startChildLifecycle(
    childThreadId: string,
    launchId: string,
    description: string,
    prompt?: string,
    state?: CodexCollabAgentState,
  ): void {
    this.childLaunchIds.set(childThreadId, launchId)
    this.emit({
      type: 'SubagentStarted',
      sessionId: this.id,
      toolUseId: launchId,
      taskId: childThreadId,
      subagentType: 'codex',
      description,
      ...(prompt ? { prompt } : {}),
    })
    if (state?.status) {
      this.emit({
        type: 'SubagentProgress',
        sessionId: this.id,
        toolUseId: launchId,
        taskId: childThreadId,
        status: state.status,
        ...(state.message ? { description: state.message } : {}),
      })
    }
    this.replayPendingChildNotifications(childThreadId)
  }

  private bufferPendingChildNotification(threadId: string, method: string, params: unknown): void {
    let pending = this.pendingChildNotifications.get(threadId)
    if (!pending) {
      if (this.pendingChildNotifications.size >= MAX_PENDING_CHILD_THREADS) return
      pending = []
      this.pendingChildNotifications.set(threadId, pending)
    }
    if (pending.length < MAX_PENDING_CHILD_NOTIFICATIONS) pending.push({ method, params })
  }

  private replayPendingChildNotifications(threadId: string): void {
    const pending = this.pendingChildNotifications.get(threadId)
    if (!pending) return
    this.pendingChildNotifications.delete(threadId)
    for (const notification of pending) this.handleNotification(notification.method, notification.params)
  }

  private childThreadForLaunch(launchId: string): string | undefined {
    for (const [threadId, candidate] of this.childLaunchIds) if (candidate === launchId) return threadId
    return undefined
  }

  private interruptChild(threadId: string, turnId: string): void {
    this.rpc('turn/interrupt', { threadId, turnId }).catch((err) =>
      log.warn('codex', 'child interrupt failed', err instanceof Error ? err.message : err),
    )
  }

  // ── Server-initiated requests (native approvals + acks) → the gate ────────────
  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const decision = await this.gateDecision('Bash', { command: p.command }, String(p.itemId ?? id))
          this.reply(id, { decision })
          break
        }
        case 'item/fileChange/requestApproval': {
          const itemId = String(p.itemId ?? id)
          const file_paths = this.itemPaths.get(itemId) ?? []
          const file_path = file_paths[0]
          const decision = await this.gateDecision('Write', { file_path, file_paths }, itemId)
          this.reply(id, { decision })
          break
        }
        case 'item/permissions/requestApproval': {
          // A command wants to escalate beyond the sandbox (network / broader write). Route through the
          // gate as a Bash-class decision; on accept grant exactly what was requested (turn scope), on
          // decline grant nothing. v1-conservative — the common path is the two approvals above.
          //
          // Plan mode is the exception, and it belongs HERE rather than in the gate: Codex reports an
          // escalation as an opaque permissions blob with no command in it, so the gate cannot tell it
          // apart from an ordinary command. Read-only commands are what makes exploration possible in
          // Plan mode; widening this session's own sandbox is what the turn's steering block promises
          // Koda will refuse. Grant nothing and never raise a card the mode says can't be answered.
          if ((this.steeredTurnMode ?? this.approvalMode) === 'plan') {
            this.reply(id, { permissions: {}, scope: 'turn' })
            break
          }
          const decision = await this.gateDecision('Bash', p, String(p.itemId ?? id))
          if (decision === 'accept') this.reply(id, { permissions: p.permissions ?? {}, scope: 'turn' })
          else this.reply(id, { permissions: {}, scope: 'turn' })
          break
        }
        case 'item/tool/requestUserInput': {
          await this.handleUserInput(id, p)
          break
        }
        case 'mcpServer/elicitation/request': {
          const elicitation = parseMcpToolElicitation(p)
          if (!elicitation) {
            this.reply(id, mcpElicitationResponse(false))
            break
          }
          const decision = await this.gateDecision(elicitation.toolName, elicitation.input, String(id))
          this.reply(id, mcpElicitationResponse(decision === 'accept'))
          break
        }
        // An UNRECOGNIZED approval method (the protocol is versioned/evolving) must fail SAFE — deny,
        // never ack — so a future approval type can't slip a mutation past the gate's checkpoint. Other
        // server requests (currentTime/read, attestation/generate, chatgptAuthTokens/refresh, …) are
        // best-effort acked so the engine never wedges. (Acks proven sufficient in turn-capture.)
        default:
          if (method.endsWith('requestApproval')) this.reply(id, { decision: 'decline' })
          else this.reply(id, {})
          // A denied-by-default approval is exactly the case worth having on record: it is the
          // engine asking for something Koda's gate can't yet describe to the user.
          this.unmapped(`request/${method}`, params, codexIds(params))
          break
      }
    } catch (err) {
      log.warn('codex', `server request ${method} failed`, err instanceof Error ? err.message : err)
      // Fail safe: deny an unanswered approval rather than leave the engine hanging.
      if (method.endsWith('requestApproval')) this.reply(id, { decision: 'decline' })
      else this.reply(id, {})
    }
  }

  /** Run a tool through the engine-neutral gate and map its decision to a Codex ReviewDecision. The gate
   *  takes the checkpoint-before-allow + applies the session's posture — identical to the Claude path. */
  private async gateDecision(
    toolName: string,
    input: unknown,
    toolUseId: string,
  ): Promise<'accept' | 'decline'> {
    const req: ApproveRequest = { toolName, input, toolUseId }
    const decision: ToolDecision = await this.opts.decide(this.id, req)
    return decision.kind === 'deny' ? 'decline' : 'accept'
  }

  /**
   * AskUserQuestion, the Codex way (`item/tool/requestUserInput`). Translate Codex's questions into the
   * Claude AskUserQuestion input shape so the EXISTING desktop+mobile QuestionCard renders them
   * unchanged; route through the gate (its `isUserQuestion` path always asks the user, even in Auto);
   * then translate the picks back into Codex's dedicated `{answers:{[id]:{answers:[…]}}}` channel.
   */
  private async handleUserInput(id: number, p: Record<string, unknown>): Promise<void> {
    const questions = (p.questions as CodexUserInputQuestion[]) ?? []
    const claudeInput = {
      questions: questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: false,
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      })),
    }
    const req: ApproveRequest = { toolName: 'AskUserQuestion', input: claudeInput, toolUseId: String(p.itemId ?? id) }
    const decision = await this.opts.decide(this.id, req)
    // The QuestionCard resolves the gate with allow-with-edit carrying answers keyed by question TEXT
    // (Record<questionText, "label, label">), the Claude updatedInput shape. Map back to Codex by id.
    const picks =
      decision.kind === 'allow-with-edit'
        ? ((decision.input as { answers?: Record<string, string> })?.answers ?? {})
        : {}
    const answers: Record<string, { answers: string[] }> = {}
    for (const q of questions) {
      const raw = picks[q.question]
      answers[q.id] = { answers: raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [] }
    }
    this.reply(id, { answers })
  }

  // ── Usage mapping ─────────────────────────────────────────────────────────────
  /** The latest thread token usage → ContextUsage for the meter. `last` = the most recent turn's
   *  request (what currently sits in the window); cached input is called out, creation isn't split. */
  private contextUsage(): import('@shared/ipc').ContextUsage | undefined {
    const u = this.lastTokenUsage?.last
    if (!u) return undefined
    return {
      contextTokens: u.inputTokens,
      contextWindow: this.lastTokenUsage?.modelContextWindow ?? undefined,
      inputTokens: Math.max(0, u.inputTokens - u.cachedInputTokens),
      cacheReadTokens: u.cachedInputTokens,
      cacheCreationTokens: 0,
      outputTokens: u.outputTokens,
    }
  }

  /** Actively pull the current account rate-limit snapshot. Codex's `account/rateLimits/updated` push is
   *  a *sparse rolling* update — the backend only forwards it when a response happens to carry fresh
   *  rate-limit headers, which in practice isn't every turn. Relying on it alone leaves the status-bar
   *  gauge pinned to whatever value was last seen (often the boot-seeded one), so we read the full
   *  snapshot at session start and after each turn to keep the windows honest. A `read` is AUTHORITATIVE
   *  (the complete current window set), so its emit prunes any stale slot the plan no longer reports.
   *  Fail-soft: a plan that doesn't support the read just leaves the last-known window in place. */
  private refreshRateLimits(): void {
    if (this.disposed) return
    this.rpc('account/rateLimits/read', null).then(
      (res) => this.emitRateLimits((res as { rateLimits?: CodexRateLimitSnapshot } | null)?.rateLimits, true),
      (err) => log.warn('codex', 'rate-limit read failed', err instanceof Error ? err.message : err),
    )
  }

  /** Codex rate-limit snapshot → the status-bar windows. Maps the rolling primary/secondary windows
   *  onto Koda's five_hour/weekly slots (the renderer keys on those). Codex's primary/secondary order
   *  is NOT guaranteed short-then-long, so key each window onto its slot by its real duration (a day
   *  cleanly splits the ~5h window from the weekly one); positional order is only the fallback when
   *  the duration is absent. Codex reports an exact `usedPercent` (the OpenAI account's real window
   *  fill) — pass it through as a measured fact and derive the coarse band from it for the dot color.
   *  (Claude gives no percent, so its windows stay band-only; the renderer shows a real bar only where
   *  `usedPercent` is present.) When `authoritative` (a full `read`, not the sparse push), each emit
   *  carries the complete type list so receivers prune stale slots. */
  private emitRateLimits(snap: CodexRateLimitSnapshot | undefined, authoritative = false): void {
    if (!snap) return
    // Ground-truth breadcrumb: a window once surfaced as "five hour" while resetting 5+ days out, and
    // the mapped store can't show whether Codex sent a duration or the fallback guessed. One line per
    // snapshot so the next mislabel is diagnosable from the log.
    log.info('codex', 'rate-limit snapshot', snap)
    const raw: Array<[string, CodexRateLimitWindow | null | undefined]> = [
      ['five_hour', snap.primary],
      ['weekly', snap.secondary],
    ]
    const mapped: Array<{ type: string; w: CodexRateLimitWindow }> = []
    for (const [fallbackType, w] of raw) {
      if (!w || w.resetsAt == null) continue
      // Duration-keyed when Codex reports one. Without a duration, the positional guess is only trusted
      // when the reset could plausibly belong to a 5-hour window — a window resetting >6h out cannot be
      // one, so it files as 'weekly' (if both windows land there, newest-wins keeps the real weekly one:
      // one truthful row beats two with a fabricated label).
      const horizonMs = w.resetsAt * 1000 - Date.now()
      const type =
        w.windowDurationMins != null
          ? w.windowDurationMins > 1440
            ? 'weekly'
            : 'five_hour'
          : horizonMs > 6 * 3_600_000
            ? 'weekly'
            : fallbackType
      mapped.push({ type, w })
    }
    // The complete truth for this snapshot — attached to every emit so receivers drop any other slot.
    const authoritativeTypes = authoritative ? mapped.map((m) => m.type) : undefined
    const observedAt = Date.now()
    for (const { type, w } of mapped) {
      this.emit({
        type: 'RateLimitUpdate',
        sessionId: this.id,
        engine: 'codex',
        info: {
          rateLimitType: type,
          resetsAt: w.resetsAt!,
          status: rateLimitBand(w.usedPercent),
          usedPercent: w.usedPercent,
          observedAt,
          source: authoritative ? 'snapshot' : 'stream',
        },
        ...(authoritativeTypes ? { authoritativeTypes } : {}),
      })
    }
  }

  private emit(event: EngineEvent): void {
    if (this.disposed) return
    // The native notification being translated rides along (the lossless envelope). Events Koda mints
    // itself — the resume cursor, a spawn failure — carry none, which is how a reader tells them apart.
    this.onEvent(this.nativeRaw ? { ...event, raw: this.nativeRaw } : event)
  }

  /** A JSON-RPC message this driver has no mapping for. Logged, never dropped. */
  private unmapped(method: string, payload: unknown, ids?: Record<string, string>): void {
    if (DELIBERATELY_IGNORED.has(method)) return
    logUnmappedEvent(this.id, { source: 'codex', method, ids, payload })
  }

  private emitResumeCursor(): void {
    if (!this.threadId) return
    this.emit({
      type: 'ResumeCursorUpdated',
      sessionId: this.id,
      cursor: codexResumeCursor(this.threadId, this.turns),
    })
  }

  private emitCompaction(): void {
    if (this.compactionNotifiedThisTurn) return
    this.compactionNotifiedThisTurn = true
    this.awaitingCompactionUsage = true
    // A compacted turn may complete before Codex publishes its replacement token snapshot. Keeping
    // the pre-compaction value would immediately refill the meter we just cleared; absence is the
    // honest state until thread/tokenUsage/updated reports the summarized context.
    this.lastTokenUsage = null
    this.emit({ type: 'ContextCompacted', sessionId: this.id })
  }
}

// ── Codex protocol shapes we read (a pared subset of the generated bindings) ────
interface CodexTokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}
interface CodexThreadTokenUsage {
  total: CodexTokenBreakdown
  last: CodexTokenBreakdown
  modelContextWindow: number | null
}
interface CodexUserInputQuestion {
  id: string
  header: string
  question: string
  options: Array<{ label: string; description: string }> | null
}
interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
interface CodexRateLimitSnapshot {
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
}

function normalizePlanStatus(status: string): string {
  return status === 'inProgress' ? 'in_progress' : status
}

export function codexPlanSteps(plan: Array<Record<string, unknown>>): Array<{ id: string; subject: string; status: string }> {
  return plan.map((step, index) => ({
    id: String(index + 1),
    subject: String(step.step ?? step.text ?? ''),
    status: normalizePlanStatus(String(step.status ?? 'pending')),
  }))
}
