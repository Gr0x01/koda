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
import type { EngineEvent, ToolDecision } from '@shared/ipc'
import type { EngineSession, EventSink, TurnImage } from './adapter'
import { resolveEnginePath } from './binary'
import { buildEngineEnv, type EngineEnvOptions } from './env'
import { looksLikeProviderDown } from './status-watch'
import type { ApproveRequest, DecideFn } from '../broker/types'
import { BROKER_TOKEN_ENV, SERVER_NAME as BROKER_SERVER_NAME } from '../broker/server'
import type { McpStdioServer } from '../playwright/manager'
import { log } from '../logger'

export interface CodexSessionOpts {
  sessionId: string
  cwd: string
  /** The gate — Codex calls it directly from its approval callbacks (no broker on the Codex path). */
  decide: DecideFn
  /** Guardrail text → Codex's `developerInstructions` (ADDITIVE; never `baseInstructions`, which would
   *  REPLACE Codex's own agent prompt). Undefined until the Codex ruleset is authored (needs RB's go). */
  developerInstructions?: string
  /** Preferred model id; ignored if the account's `model/list` doesn't include it (we fall back to the
   *  account default — a ChatGPT subscription rejects the `-codex` thread/start default). */
  model?: string
  /** Reasoning effort, passed through to the first turn (engine's own terms). */
  effort?: string
  /** Resume an existing Codex thread by id (loaded from disk — proven cross-process in
   *  spike/codex/verify-resume.mjs) instead of starting fresh. This is the engine's own thread id
   *  (≠ Koda's sessionId), captured from `SessionStarted.engineNativeId` and persisted. Used on a
   *  restart-reattach AND a mid-conversation model/effort change (resume takes a model override, so
   *  the context is preserved across the respawn). Absent ⇒ a fresh `thread/start`. */
  resumeThreadId?: string
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

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

interface McpToolElicitation {
  toolName: string
  input: unknown
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

class CodexSession implements EngineSession {
  readonly id: string
  private readonly cwd: string
  private readonly child: ChildProcessWithoutNullStreams
  private readonly onEvent: EventSink
  private readonly opts: CodexSessionOpts

  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private threadId: string | null = null
  private currentTurnId: string | null = null
  private ready = false
  private disposed = false
  /** Resolves dispose()'s await once the child's 'close' actually fires (so a respawn-with-same-id
   *  doesn't create the replacement before this one's teardown ran — mirrors the Claude adapter). */
  private closeResolve?: () => void
  /** Turns sent before the thread handshake finished — flushed in order once ready. */
  private readonly turnQueue: { text: string; images?: TurnImage[] }[] = []
  /** itemId → file path, captured from `item/started` (fileChange) so the file-change approval — whose
   *  params DON'T carry the path — can label the gate request + checkpoint with the real file. */
  private readonly itemPaths = new Map<string, string>()
  /** Cumulative reasoning chars this turn → a rough ThinkingDelta token estimate (reset each turn). */
  private reasoningChars = 0
  /** Latest thread token-usage snapshot — turned into ContextUsage on turn completion (the meter). */
  private lastTokenUsage: CodexThreadTokenUsage | null = null

  constructor(onEvent: EventSink, opts: CodexSessionOpts) {
    this.onEvent = onEvent
    this.opts = opts
    this.id = opts.sessionId
    this.cwd = opts.cwd

    const loc = opts.binaryPath
      ? { path: opts.binaryPath, source: 'dev-fallback' as const }
      : resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' })
    const env = buildEngineEnv(process.env, { ...opts.env, engineId: 'codex' })
    // `-c check_for_update_on_startup=false`: suppress the startup version-check network call. Codex
    // never self-replaces (manual `codex update`), so the binary stays pinned without an env toggle.
    const args = ['app-server', '--stdio', '-c', 'check_for_update_on_startup=false']
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
      // reattaching an existing conversation — preserves context across a restart or a model/effort
      // change (resume takes the model override above). Fresh `thread/start` otherwise.
      const method = this.opts.resumeThreadId ? 'thread/resume' : 'thread/start'
      if (this.opts.resumeThreadId) params.threadId = this.opts.resumeThreadId
      const res = (await this.rpc(method, params)) as { thread?: { id?: string }; model?: string }
      this.threadId = res?.thread?.id ?? this.opts.resumeThreadId ?? null
      if (!this.threadId) throw new Error(`${method} returned no thread id`)
      this.ready = true
      // engineNativeId = Codex's own thread id (≠ Koda sessionId); persisted so a later reattach can
      // resume THIS thread by id.
      this.emit({
        type: 'SessionStarted',
        sessionId: this.id,
        model: res?.model ?? model ?? '',
        tools: [],
        cwd: this.cwd,
        engineNativeId: this.threadId,
      })
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

  sendTurn(text: string, images?: TurnImage[]): void {
    if (this.disposed) return
    if (!this.ready) {
      this.turnQueue.push({ text, images })
      return
    }
    this.doTurn(text, images)
  }

  private doTurn(text: string, images?: TurnImage[]): void {
    if (!this.threadId) return
    this.reasoningChars = 0
    const input: unknown[] = [{ type: 'text', text, text_elements: [] }]
    for (const img of images ?? []) {
      input.push({ type: 'image', url: `data:${img.mediaType};base64,${img.dataBase64}` })
    }
    this.rpc('turn/start', { threadId: this.threadId, input }).then(
      (res) => {
        const turnId = (res as { turn?: { id?: string } })?.turn?.id
        if (turnId) this.currentTurnId = turnId
      },
      (err) => {
        if (this.disposed) return
        const message = `turn failed: ${err.message}`
        this.emit({
          type: 'EngineError',
          sessionId: this.id,
          message,
          fatal: false,
          ...(looksLikeProviderDown(message) ? { providerStatus: 'down' as const } : {}),
        })
      },
    )
  }

  interrupt(): void {
    if (!this.threadId || !this.currentTurnId) return
    // Native graceful interrupt — no `control_request` workaround (Claude needed one). Fire-and-forget.
    this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId }).catch((err) =>
      log.warn('codex', 'interrupt failed', err instanceof Error ? err.message : err),
    )
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
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
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)))
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
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'item/agentMessage/delta':
        this.emit({ type: 'AssistantDelta', sessionId: this.id, text: String(p.delta ?? '') })
        break
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.reasoningChars += String(p.delta ?? '').length
        this.emit({ type: 'ThinkingDelta', sessionId: this.id, estimatedTokens: Math.ceil(this.reasoningChars / 4) })
        break
      case 'item/started':
        this.onItem(p.item, 'started')
        break
      case 'item/completed':
        this.onItem(p.item, 'completed')
        break
      case 'thread/tokenUsage/updated':
        this.lastTokenUsage = (p.tokenUsage as CodexThreadTokenUsage) ?? this.lastTokenUsage
        break
      case 'turn/started':
        this.currentTurnId = String((p.turn as { id?: string })?.id ?? p.turnId ?? this.currentTurnId ?? '')
        break
      case 'turn/completed': {
        const status = (p.turn as { status?: string })?.status
        this.emit({
          type: 'TurnComplete',
          sessionId: this.id,
          context: this.contextUsage(),
          stopReason: normalizeTurnStatus(status),
        })
        this.currentTurnId = null
        break
      }
      case 'error': {
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
      // Many other notifications (plan, diff, mcp progress, …) are not surfaced in v1.
      default:
        break
    }
  }

  /** An `item` lifecycle event (started/completed) → a tool/assistant EngineEvent. The item's `type`
   *  discriminates; command + file changes become Bash/Write tool cards, agent messages become blocks. */
  private onItem(itemRaw: unknown, phase: 'started' | 'completed'): void {
    const item = (itemRaw ?? {}) as Record<string, unknown>
    const type = String(item.type ?? '')
    const id = String(item.id ?? '')
    switch (type) {
      case 'commandExecution':
        if (phase === 'started') {
          this.emit({ type: 'ToolRequested', sessionId: this.id, id, name: 'Bash', input: { command: item.command } })
        } else {
          const exit = item.exitCode
          this.emit({
            type: 'ToolResult',
            sessionId: this.id,
            id,
            output: String(item.aggregatedOutput ?? ''),
            isError: item.status === 'failed' || (typeof exit === 'number' && exit !== 0),
          })
        }
        break
      case 'fileChange': {
        const changes = (item.changes as Array<{ path?: string }>) ?? []
        const path = changes[0]?.path
        if (phase === 'started') {
          if (path) this.itemPaths.set(id, path)
          this.emit({ type: 'ToolRequested', sessionId: this.id, id, name: 'Write', input: { file_path: path } })
        } else {
          const files = changes.map((c) => c.path).filter(Boolean)
          this.emit({
            type: 'ToolResult',
            sessionId: this.id,
            id,
            output: files.length ? `Updated ${files.join(', ')}` : 'Updated files',
            isError: item.status === 'failed',
          })
          this.itemPaths.delete(id)
        }
        break
      }
      case 'agentMessage':
        // Live deltas already painted the text; the completed item is the finalized markdown block.
        if (phase === 'completed') {
          this.emit({ type: 'AssistantBlock', sessionId: this.id, markdown: String(item.text ?? '') })
        }
        break
      // reasoning/userMessage/etc. are covered by deltas or are the user's own input — not surfaced.
      default:
        break
    }
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
          const file_path = this.itemPaths.get(itemId)
          const decision = await this.gateDecision('Write', { file_path }, itemId)
          this.reply(id, { decision })
          break
        }
        case 'item/permissions/requestApproval': {
          // A command wants to escalate beyond the sandbox (network / broader write). Route through the
          // gate as a Bash-class decision; on accept grant exactly what was requested (turn scope), on
          // decline grant nothing. v1-conservative — the common path is the two approvals above.
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

  /** Codex rate-limit snapshot → the status-bar windows. Maps the rolling primary/secondary windows
   *  onto Koda's five_hour/weekly slots (the renderer keys on those). Codex reports an exact
   *  `usedPercent` (the OpenAI account's real window fill) — pass it through as a measured fact and
   *  derive the coarse band from it for the dot color. (Claude gives no percent, so its windows stay
   *  band-only; the renderer shows a real bar only where `usedPercent` is present.) */
  private emitRateLimits(snap: CodexRateLimitSnapshot | undefined): void {
    if (!snap) return
    const band = (pct: number): string => (pct >= 100 ? 'rejected' : pct >= 80 ? 'warning' : 'allowed')
    const windows: Array<[string, CodexRateLimitWindow | null | undefined]> = [
      ['five_hour', snap.primary],
      ['weekly', snap.secondary],
    ]
    for (const [type, w] of windows) {
      if (!w || w.resetsAt == null) continue
      this.emit({
        type: 'RateLimitUpdate',
        sessionId: this.id,
        info: { rateLimitType: type, resetsAt: w.resetsAt, status: band(w.usedPercent), usedPercent: w.usedPercent },
      })
    }
  }

  private emit(event: EngineEvent): void {
    if (!this.disposed) this.onEvent(event)
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
  resetsAt: number | null
}
interface CodexRateLimitSnapshot {
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
}
