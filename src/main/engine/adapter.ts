/**
 * The engine adapter — the ONE seam where Claude is named. Everything above it
 * (session manager, IPC, renderer, output view) speaks only the normalized
 * EngineEvent vocabulary, so a future Codex adapter slots in beside this file
 * without the rest of the app caring (engine-adapter-and-output-view.md §2).
 *
 * One session = one long-lived `claude -p` process driven over plain pipes
 * (Route B1, validated in spike/layer-a + spike/control-plane). The human
 * triggers each turn via sendTurn; the process stays alive between turns and
 * holds conversation context in-process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { EngineEvent } from '@shared/ipc'
import { resolveEnginePath } from './binary'
import { buildEngineEnv, type EngineEnvOptions } from './env'
import { looksLikeProviderDown } from './status-watch'
import { assembleGuardrailText, resolvePack } from './pack'
import { disabledToolTokens, readDisabledSet } from '../guardrails-config'

export interface SessionOpts {
  cwd?: string
  /** Session id, supplied by the owner so the broker can be wired BEFORE spawn. Falls back to a uuid. */
  sessionId?: string
  /** process.resourcesPath in the packaged app; omit in dev. */
  resourcesPath?: string
  /**
   * Override the engine binary with an explicit path. Production paths leave this unset (the bundled
   * pinned copy resolves via resolveEnginePath); only the engine-contract smoke test sets it, to drive
   * a candidate CLI build through this exact driver. The env chokepoint (buildEngineEnv) still applies.
   */
  binaryPath?: string
  /** Auth/secrets passed through to buildEngineEnv (apiMode, apiKey, inject). */
  env?: EngineEnvOptions
  /**
   * Inline `--mcp-config` JSON wiring the permission broker. When present, the engine consults
   * the broker for every tool (`--permission-prompt-tool`) and `bypassPermissions` is dropped.
   * When absent, falls back to `bypassPermissions` (standalone/dev — no gate).
   */
  mcpConfigJson?: string
  /**
   * Reattach the prior conversation for `sessionId` (spawns `claude --resume <id>` instead of
   * `--session-id <id>`). The engine restores full context and keeps the same id — verified in
   * spike/resume. Must launch from the same cwd the session was created in (resume is cwd-scoped).
   */
  resume?: boolean
  /**
   * Launch in plan mode (`--permission-mode plan`): the engine stays read-only and the agent must
   * call ExitPlanMode (always-confirmed by the gate) to get the go-ahead, after which the SAME
   * process transitions out of plan mode and implements (spike/capture). Honored only alongside the
   * broker — plan mode without an approver would dead-end (no one to allow ExitPlanMode).
   */
  planMode?: boolean
  /**
   * Run a specific model (`--model <X>`) — an engine alias or a full id the user typed. Omitted ⇒ the
   * engine's plan default. The engine can't switch model live on a -p process, so a model change is a
   * respawn (the manager reattaches with --resume --model). Pass-through only — never inspected here.
   */
  model?: string
  /**
   * Reasoning effort (`--effort <low|medium|high|xhigh|max>`) — the engine's own terms, passed
   * through verbatim. Omitted ⇒ engine default (adaptive). Spawn-time like --model, so a change is a
   * respawn (manager reattaches with --resume --effort). Never inspected here.
   */
  effort?: string
  /** Fired once when the child exits (any cause) so the owner can drop its handle. */
  onClose?: (sessionId: string) => void
  /**
   * Extra `--disallowedTools` tokens computed by the Electron layer from runtime state the adapter
   * can't see (e.g. the Playwright capability isn't wired this session → deny `Skill(browser-verify)`
   * so it doesn't dangle guidance for absent tools). Appended to the static + project-disabled denials.
   */
  extraDisallowedTools?: string[]
  /**
   * Extra plugin dirs to load alongside the bundled pack (each `--plugin-dir`, repeatable). The
   * Electron layer resolves these — today the Koda-managed global skills plugin (the user's
   * gallery-activated skills), kept out of `~/.claude`. Already-validated absolute paths; the
   * resolver only passes a dir that's a live plugin, so the engine never errors on an empty one.
   */
  extraPluginDirs?: string[]
}

/** Keep only the tail of stderr — we only ever surface the last slice on error. */
const STDERR_CAP = 8192

/**
 * Koda is a guardrailed distribution for non-engineers. The bundled `deep-research` skill auto-fires
 * a heavy (~6 min, >1M-token, quota-burning) background Workflow fleet for ordinary research questions,
 * which then dead-ends under `-p` (no `/workflows` monitor, no notify loop — spike/workflow-result).
 * Block the skill here; the paired "research live in-turn" steering now lives in the pack
 * (rules.json `research-live`), alongside the preview + ensure-tool steering (`preview-through-koda` /
 * `ask-koda-for-tools`, broker-gated). The Workflow tool itself stays available for explicit/parallel
 * use; only the auto-research recipe is gone. (`disable-model-invocation` would need a per-project
 * skill file; the deny matcher is verified to block it cleanly — spike/workflow-result/test-disable.ts.)
 */
const DISALLOWED_DEEP_RESEARCH = 'Skill(deep-research)'

/**
 * Engine-neutral session handle. The design sketches `events` as an
 * AsyncIterable; we take the equivalent push-callback (`onEvent`) instead — it
 * maps directly onto Electron's `webContents.send` with no buffering layer.
 */
/** An inline image for a turn (base64 + media type) — sent as an Anthropic image content block. */
export interface TurnImage {
  mediaType: string
  dataBase64: string
}

export interface EngineSession {
  readonly id: string
  sendTurn(text: string, images?: TurnImage[]): void
  interrupt(): void
  dispose(): Promise<void>
}

export type EventSink = (event: EngineEvent) => void

/**
 * Launch a long-lived Claude session. Spawns immediately so the engine's
 * `system/init` event (→ SessionStarted) is in flight before the first turn.
 */
export function startClaudeSession(onEvent: EventSink, opts: SessionOpts = {}): EngineSession {
  return new ClaudeSession(onEvent, opts)
}

class ClaudeSession implements EngineSession {
  readonly id: string
  private readonly cwd: string
  private readonly child: ChildProcessWithoutNullStreams
  private readonly onEvent: EventSink

  /** NDJSON line-assembly buffer for the continuous stdout drain. */
  private buf = ''
  private stderr = ''
  private started = false
  private disposed = false
  private closed = false
  /** Session model id from system/init — used to pick the right context window out of
   *  `result.modelUsage` (which also lists aux models like the haiku titler). */
  private model = ''
  /** Usage of the LAST top-level assistant message this turn — the size of the prompt actually
   *  sent on the final step, i.e. what currently sits in the context window. The `result` event's
   *  own `usage` is CUMULATIVE across every step in the turn (re-counts cached tokens each step),
   *  so it massively over-reports window fill (a 17-step turn read ~400k when 61k was in the
   *  window). Feed the gauge from this instead. Subagent messages excluded (`!parentToolUseId`). */
  private lastAssistantUsage: unknown = undefined
  private readonly onClose?: (sessionId: string) => void
  /** Agent/Task launch tool_use ids — lets us route the top-level Agent tool_result
   *  to SubagentCompleted (its text IS the subagent's final output), not a stray ToolResult. */
  private readonly subagentLaunchIds = new Set<string>()
  /** Launch ids of NESTED subagents (an Agent launched by another subagent). The engine doesn't
   *  stream their inner transcript (spike/capture), so we render them as a tool-child under their
   *  parent and SUPPRESS their top-level task_* lifecycle (which would else show a stuck card). */
  private readonly nestedSubagentIds = new Set<string>()
  /** Workflow tool_use ids — the launch returns a run id + on-disk run dir in its tool_result;
   *  we suppress the generic tool card and open a WorkflowCard from the parsed result instead. */
  private readonly workflowLaunchIds = new Set<string>()

  constructor(onEvent: EventSink, opts: SessionOpts) {
    this.onEvent = onEvent
    this.onClose = opts.onClose
    this.id = opts.sessionId ?? randomUUID()
    this.cwd = opts.cwd ?? process.cwd()

    const enginePath = opts.binaryPath ?? resolveEnginePath({ resourcesPath: opts.resourcesPath }).path
    const env = buildEngineEnv(process.env, opts.env)
    // The Koda behavior-layer pack: skills + subagents load via --plugin-dir (below); its always-on
    // judgment rules ride the system prompt here (spike/plugin-load — plugin CLAUDE.md isn't
    // auto-injected). Null when no pack is present (additive — sessions still start without it).
    const pack = resolvePack({ resourcesPath: opts.resourcesPath })
    // Which bundled defaults this project switched off (Settings → Guardrails). Disabled rules drop
    // from the assembled prompt; disabled skills/subagents become --disallowedTools denials below.
    const disabled = readDisabledSet(this.cwd)
    // The pack rules (this project's disabled defaults dropped) followed by any edited-principle
    // overrides. Broker-gated rules (preview, ensure-tool) assemble only when the broker is wired —
    // they name `mcp__koda_broker__*` tools that don't exist otherwise. The Codex driver shares this
    // exact assembly via `developerInstructions` (assembleGuardrailText in pack.ts).
    const appendedSystemPrompt = assembleGuardrailText({
      cwd: this.cwd,
      resourcesPath: opts.resourcesPath,
      brokerWired: !!opts.mcpConfigJson,
    })

    // Deep-research stays off always; a project's disabled skills/subagents add their denials; the
    // Electron layer adds any runtime-conditional denials (e.g. browser-verify when Playwright is off).
    const disallowedTools = [
      DISALLOWED_DEEP_RESEARCH,
      ...disabledToolTokens(disabled),
      ...(opts.extraDisallowedTools ?? []),
    ]

    this.child = spawn(
      enginePath,
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose', // required for stream-json output (spike/layer-a)
        '--include-partial-messages', // emit text_delta for live paint
        // Guardrail: no auto deep-research fleets — research live in-turn (see consts above) — plus
        // any default skills/subagents this project switched off. Repeated flag = one token each.
        ...disallowedTools.flatMap((t) => ['--disallowedTools', t]),
        '--append-system-prompt', appendedSystemPrompt,
        // Koda behavior-layer pack: delivers the bundled skills + specialist subagents
        // (spike/plugin-load). Order-independent; omitted when no pack resolves. The pack's
        // always-on rules already rode --append-system-prompt above.
        ...(pack ? ['--plugin-dir', pack.dir] : []),
        // Koda-managed global skills plugin (the user's gallery-activated skills). Same repeatable
        // flag; resolved + validated by the Electron layer, omitted when nothing's active.
        ...(opts.extraPluginDirs ?? []).flatMap((dir) => ['--plugin-dir', dir]),
        // User-chosen model (alias or full id). Omitted ⇒ engine default. Passed through verbatim;
        // the engine validates + falls back if the id is retired (no Koda-side model list).
        ...(opts.model ? ['--model', opts.model] : []),
        // Reasoning effort (low|medium|high|xhigh|max). Omitted ⇒ engine default. Verbatim pass-through.
        ...(opts.effort ? ['--effort', opts.effort] : []),
        // Permission transport: with the broker wired (spine #5) the engine asks our in-process
        // MCP server (`approve`) before every tool. Default mode lets the prompt tool fire — do
        // NOT pass bypassPermissions here, it would skip the broker (spike/broker). Without a
        // broker config, fall back to bypassPermissions (standalone/dev — no gate, no prompt hang).
        ...(opts.mcpConfigJson
          ? [
              '--permission-prompt-tool', 'mcp__koda_broker__approve', '--mcp-config', opts.mcpConfigJson,
              // Plan mode rides ALONGSIDE the broker — the gate always-confirms ExitPlanMode, and
              // approving it transitions this same process out of plan mode (spike/capture).
              ...(opts.planMode ? ['--permission-mode', 'plan'] : []),
            ]
          : ['--permission-mode', 'bypassPermissions']),
        // Resume reattaches a prior conversation by id (keeps the same id); a fresh session mints it
        // deterministically so renderer routing works from the first event. Never pass both (spike/resume).
        ...(opts.resume ? ['--resume', this.id] : ['--session-id', this.id]),
      ],
      { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams

    // Continuous drain — NEVER pause stdout. If we stalled the drain on an
    // approval round-trip the OS pipe buffer would fill and deadlock the engine
    // (engine-adapter-and-output-view.md §2 backpressure rule).
    this.child.stdout.on('data', (d: Buffer) => this.ingest(d.toString()))
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-STDERR_CAP)
    })
    this.child.on('error', (err) => this.emitError(`engine spawn failed: ${err.message}`, true))
    this.child.on('close', (code) => this.handleClose(code))
    // A write to a half-dead pipe emits EPIPE here; without a listener that's an
    // uncaught exception that takes down the main process. Keep it non-fatal —
    // the imminent 'close' carries the real cause.
    this.child.stdin.on('error', (err) => this.emitError(`engine stdin: ${err.message}`, false))
  }

  sendTurn(text: string, images?: TurnImage[]): void {
    if (this.disposed || this.closed || !this.child.stdin.writable) {
      this.emitError('cannot send turn: engine session is not running', false)
      return
    }
    // Image blocks first, then text — the order Anthropic recommends for image+question turns.
    const content: Array<Record<string, unknown>> = []
    for (const img of images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } })
    }
    if (text) content.push({ type: 'text', text })
    const msg = { type: 'user', message: { role: 'user', content } }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /**
   * The user's stop button — a graceful, mid-turn interrupt. `claude -p` stream-json accepts a
   * `control_request` on stdin that aborts the CURRENT turn but keeps the long-lived process alive
   * (verified in the bundled binary's repl-bridge ingress: `subtype:"interrupt"` → abortController.abort,
   * then a control_response ack), so the user can immediately send a correction and continue the SAME
   * session — vs the old SIGINT, which killed the whole session. The control_response is ignored
   * (unknown event type, falls through the parse switch). SIGINT stays the hard teardown in dispose().
   */
  interrupt(): void {
    if (this.disposed || this.closed || !this.child.stdin.writable) return
    const msg = { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' }, uuid: randomUUID() }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.closed) return // already exited — no signals, no 3s timer
    if (this.child.stdin.writable) this.child.stdin.end()
    this.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 3000)
      this.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private ingest(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue // partial/garbage line — skip (spike-proven pattern)
      }
      this.translate(raw as Record<string, unknown>)
    }
  }

  /** Claude stream-json → normalized EngineEvents. The translation table. */
  private translate(ev: Record<string, any>): void {
    // Inner subagent events carry the launch id here; top-level events don't.
    const parentToolUseId: string | undefined =
      typeof ev?.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined

    switch (ev?.type) {
      case 'system':
        if (ev.subtype === 'init' && !this.started) {
          this.started = true
          this.model = typeof ev.model === 'string' ? ev.model : ''
          this.onEvent({
            type: 'SessionStarted',
            sessionId: this.id,
            model: this.model,
            tools: Array.isArray(ev.tools) ? ev.tools : [],
            cwd: typeof ev.cwd === 'string' ? ev.cwd : this.cwd,
          })
        } else {
          this.translateTask(ev) // system/task_* — subagent lifecycle (spike/subagent)
        }
        break

      case 'stream_event': {
        const delta = ev?.event?.delta
        // Only top-level deltas drive live UI; subagent internals show as finalized
        // blocks under its card (no live subagent streaming in v0).
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && !parentToolUseId) {
          this.onEvent({ type: 'AssistantDelta', sessionId: this.id, text: delta.text })
        } else if (delta?.type === 'thinking_delta' && !parentToolUseId) {
          // Reasoning text is redacted on subscription (delta.thinking is ''); the only
          // usable signal is the cumulative token estimate — surfaces a "Thinking…" state.
          this.onEvent({
            type: 'ThinkingDelta',
            sessionId: this.id,
            estimatedTokens: typeof delta.estimated_tokens === 'number' ? delta.estimated_tokens : undefined,
          })
        }
        break
      }

      case 'assistant':
        // Capture this step's prompt size (top-level only) — the true window fill, used by the
        // gauge at `result` time instead of the result event's cumulative-per-turn usage.
        if (!parentToolUseId && ev?.message?.usage) this.lastAssistantUsage = ev.message.usage
        for (const block of asArray(ev?.message?.content)) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            // A top-level API failure (5xx/429/auth) arrives as the CLI's own "API Error: …" assistant
            // text. Lift it out of the transcript into a typed EngineError so the UI can show a calm,
            // retryable composer banner instead of raw error prose with a bare status link.
            if (!parentToolUseId && isApiErrorText(block.text)) {
              this.emitApiError(block.text)
            } else {
              this.onEvent({ type: 'AssistantBlock', sessionId: this.id, markdown: block.text, parentToolUseId })
            }
          } else if (block?.type === 'tool_use') {
            const blockId = String(block.id ?? '')
            // A top-level Agent/Task launch becomes a SubagentCard, not a generic tool card.
            if (!parentToolUseId && isSubagentTool(block.name)) {
              this.emitSubagentStarted(blockId, (block.input ?? {}) as Record<string, any>)
            } else if (!parentToolUseId && isWorkflowTool(block.name)) {
              // A workflow launches in the background; its card opens when the tool_result
              // returns the run id + dir. Suppress the generic tool card until then.
              this.workflowLaunchIds.add(blockId)
            } else {
              // A NESTED subagent launch (Agent tool_use inside another subagent's stream): the
              // engine streams the launch + lifecycle but NOT the sub-subagent's inner transcript
              // (spike/capture — one level deep). Render it as an informative tool-child under its
              // parent (the input carries subagent_type/description/prompt; the result is its output)
              // and remember its id so its top-level task_* lifecycle is suppressed — otherwise it
              // double-renders as a stuck-"running" sibling card that never completes.
              if (isSubagentTool(block.name)) this.nestedSubagentIds.add(blockId)
              this.onEvent({
                type: 'ToolRequested',
                sessionId: this.id,
                id: blockId,
                name: String(block.name ?? ''),
                input: block.input,
                parentToolUseId,
              })
            }
          }
        }
        break

      case 'user':
        for (const block of asArray(ev?.message?.content)) {
          if (block?.type === 'tool_result') {
            const id = String(block.tool_use_id ?? '')
            // The Agent tool's result IS the subagent's final output → close the card.
            if (!parentToolUseId && this.subagentLaunchIds.has(id)) {
              this.onEvent({
                type: 'SubagentCompleted',
                sessionId: this.id,
                toolUseId: id,
                resultText: cleanSubagentResult(toolResultText(block.content)),
                isError: block.is_error === true,
              })
            } else if (!parentToolUseId && this.workflowLaunchIds.has(id)) {
              // The Workflow launch returned its run id + on-disk dir → open the WorkflowCard and
              // let main watch the journal. The actual result never streams back (spike/capture).
              this.workflowLaunchIds.delete(id)
              this.emitWorkflowStarted(toolResultText(block.content))
            } else {
              this.onEvent({
                type: 'ToolResult',
                sessionId: this.id,
                id,
                output: toolResultText(block.content),
                isError: block.is_error === true,
                parentToolUseId,
              })
            }
          }
        }
        break

      case 'result':
        this.onEvent({
          type: 'TurnComplete',
          sessionId: this.id,
          // Window fill = the LAST assistant step's prompt size (lastAssistantUsage), NOT the
          // result event's cumulative-per-turn usage. modelUsage still supplies the window LIMIT.
          context: extractContextUsage(this.lastAssistantUsage ?? ev.usage, ev.modelUsage, this.model),
          costEstimate: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          models: extractModelUsage(ev.modelUsage),
          stopReason: typeof ev.subtype === 'string' ? ev.subtype : undefined,
        })
        break

      case 'rate_limit_event': {
        // The account-level subscription window (5-hour / weekly), emitted each turn — surfaces
        // the reset time + status band in the status bar. The stream carries no precise "% used"
        // (only what's here); that lives behind a separate authenticated call. spike confirmed shape.
        const info = ev.rate_limit_info
        if (info && typeof info.rateLimitType === 'string' && typeof info.resetsAt === 'number') {
          this.onEvent({
            type: 'RateLimitUpdate',
            sessionId: this.id,
            info: {
              rateLimitType: info.rateLimitType,
              resetsAt: info.resetsAt,
              status: typeof info.status === 'string' ? info.status : 'allowed',
              isUsingOverage: info.isUsingOverage === true,
            },
          })
        }
        break
      }
    }
  }

  /** Open a SubagentCard (idempotent per launch id — both the Agent tool_use and
   *  system/task_started describe the same launch; whichever lands first wins). */
  private emitSubagentStarted(id: string, input: Record<string, any>): void {
    if (!id || this.subagentLaunchIds.has(id)) return
    this.subagentLaunchIds.add(id)
    this.onEvent({
      type: 'SubagentStarted',
      sessionId: this.id,
      toolUseId: id,
      subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent',
      description: typeof input.description === 'string' ? input.description : '',
      prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
    })
  }

  /** Parse a Workflow launch tool_result for its run id, label, and on-disk dir, then open the
   *  card. The result text is a fixed template (spike/capture): "Run ID: wf_…", "Summary: …",
   *  "Transcript dir: …". If the run id can't be parsed, surface a non-fatal notice rather than
   *  silently dropping the workflow. */
  private emitWorkflowStarted(resultText: string): void {
    const runId = /Run ID:\s*(\S+)/.exec(resultText)?.[1]
    const dir = /Transcript dir:\s*(\S+)/.exec(resultText)?.[1]
    const name = /Summary:\s*(.+)/.exec(resultText)?.[1]?.trim()
    if (!runId) {
      this.emitError('a workflow launched but Koda could not track it (unrecognized launch output)', false)
      return
    }
    this.onEvent({ type: 'WorkflowStarted', sessionId: this.id, runId, name: name || 'Workflow', dir })
  }

  /** The engine's purpose-built subagent lifecycle stream (system/task_*), keyed by
   *  `tool_use_id` = the Agent launch id. Drives the card's live status + usage. */
  private translateTask(ev: Record<string, any>): void {
    const toolUseId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : undefined
    // Nested subagents render as a tool-child under their parent (their inner transcript isn't
    // streamed) — drop their top-level lifecycle so they don't double-render as a stuck card.
    if (toolUseId && this.nestedSubagentIds.has(toolUseId)) return
    switch (ev.subtype) {
      case 'task_started':
        if (toolUseId) this.emitSubagentStarted(toolUseId, ev)
        break
      case 'task_progress':
        if (toolUseId)
          this.onEvent({
            type: 'SubagentProgress',
            sessionId: this.id,
            toolUseId,
            description: typeof ev.description === 'string' ? ev.description : undefined,
            lastToolName: typeof ev.last_tool_name === 'string' ? ev.last_tool_name : undefined,
            usage: normalizeUsage(ev.usage),
          })
        break
      case 'task_notification':
        if (toolUseId)
          this.onEvent({
            type: 'SubagentProgress',
            sessionId: this.id,
            toolUseId,
            status: typeof ev.status === 'string' ? ev.status : undefined,
            usage: normalizeUsage(ev.usage),
          })
        break
      // task_updated carries only task_id + patch (no tool_use_id to join on); completion
      // is covered by the Agent tool_result → SubagentCompleted. Ignored.
    }
  }

  private emitError(message: string, fatal: boolean): void {
    this.onEvent({
      type: 'EngineError',
      sessionId: this.id,
      message,
      fatal,
      ...(looksLikeProviderDown(message) ? { providerStatus: 'down' as const } : {}),
    })
  }

  /** A turn-level API failure the CLI printed as assistant text. Non-fatal (the process stays alive for
   *  the next turn); `category: 'apiError'` flags it for the composer error banner. */
  private emitApiError(message: string): void {
    this.onEvent({
      type: 'EngineError',
      sessionId: this.id,
      message,
      fatal: false,
      category: 'apiError',
      ...(looksLikeProviderDown(message) ? { providerStatus: 'down' as const } : {}),
    })
  }

  private handleClose(code: number | null): void {
    if (this.closed) return
    this.closed = true
    // A non-zero exit we didn't initiate (and didn't interrupt) is fatal; an
    // interrupt or our own dispose is an expected, non-fatal end.
    if (!this.disposed && code !== 0 && code !== null) {
      this.emitError(`engine exited (code ${code})${this.stderr ? `: ${this.stderr.slice(-400)}` : ''}`, true)
    }
    this.disposed = true
    this.onClose?.(this.id)
  }
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}

/** The CLI prints an unrecoverable API failure as an assistant text block prefixed "API Error:" (its
 *  stable format across versions). That's our signal to lift it into the composer error banner rather
 *  than render it as conversation text. Anchored to the start so it can't match a message ABOUT errors. */
function isApiErrorText(text: string): boolean {
  return /^\s*api error:/i.test(text)
}

/** The subagent-launch tool — "Agent" on 2.1.x, legacy "Task" (spike/subagent §Q1). */
function isSubagentTool(name: unknown): boolean {
  return name === 'Agent' || name === 'Task'
}

/** The background multi-agent orchestration tool (spike/capture). */
function isWorkflowTool(name: unknown): boolean {
  return name === 'Workflow'
}

/** Engine usage `{total_tokens, tool_uses, duration_ms}` → the normalized camelCase shape. */
function normalizeUsage(u: unknown): { totalTokens?: number; toolUses?: number; durationMs?: number } | undefined {
  if (!u || typeof u !== 'object') return undefined
  const o = u as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  return { totalTokens: num(o.total_tokens), toolUses: num(o.tool_uses), durationMs: num(o.duration_ms) }
}

/**
 * Context-window occupancy (ui-workspace.md §7a). Fed the LAST top-level assistant step's usage (the
 * caller passes `lastAssistantUsage`, not the result event's cumulative usage). `contextTokens` = that
 * step's prompt size (input + cache read + cache creation) = what currently sits in the window.
 * `contextWindow` comes from `modelUsage[model].contextWindow` — the engine's own number for whatever
 * model it ran (never inferred from the name); falls back to the largest window listed (the main
 * model, vs. an aux titler), then undefined. Undefined `usage` ⇒ undefined (e.g. an error result).
 */
function extractContextUsage(usage: unknown, modelUsage: unknown, model: string): import('@shared/ipc').ContextUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  const inputTokens = n(u.input_tokens)
  const cacheReadTokens = n(u.cache_read_input_tokens)
  const cacheCreationTokens = n(u.cache_creation_input_tokens)
  const outputTokens = n(u.output_tokens)
  let contextWindow: number | undefined
  if (modelUsage && typeof modelUsage === 'object') {
    const mu = modelUsage as Record<string, { contextWindow?: unknown }>
    const win = (m?: { contextWindow?: unknown }) =>
      typeof m?.contextWindow === 'number' ? m.contextWindow : undefined
    contextWindow =
      win(mu[model]) ??
      Object.values(mu)
        .map(win)
        .filter((w): w is number => typeof w === 'number')
        .reduce<number | undefined>((max, w) => (max === undefined || w > max ? w : max), undefined)
  }
  return {
    contextTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    contextWindow,
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
  }
}

/**
 * Per-model usage for the turn, from the engine's `result.modelUsage` (a Record keyed by model id).
 * Each entry carries its own cost + token split — flattened to an array the store folds into the
 * session's running by-model totals. Zero-usage entries (a model listed but never actually used this
 * turn) are dropped so they don't clutter the breakdown. Model ids pass through opaquely.
 */
function extractModelUsage(modelUsage: unknown): import('@shared/ipc').ModelTurnUsage[] | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  const out: import('@shared/ipc').ModelTurnUsage[] = []
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const entry = {
      model,
      costUsd: n(m.costUSD),
      inputTokens: n(m.inputTokens),
      outputTokens: n(m.outputTokens),
      cacheReadTokens: n(m.cacheReadInputTokens),
      cacheCreationTokens: n(m.cacheCreationInputTokens),
    }
    const touched =
      entry.costUsd > 0 ||
      entry.inputTokens > 0 ||
      entry.outputTokens > 0 ||
      entry.cacheReadTokens > 0 ||
      entry.cacheCreationTokens > 0
    if (touched) out.push(entry)
  }
  return out.length ? out : undefined
}

/** The Agent tool_result text trails an `agentId:` line + a `<usage>…</usage>` block
 *  (spike/subagent §Q5, engine 2.1.185) — internal plumbing, stripped so the card shows
 *  clean prose. Pinned to that trailer format; revisit if an engine bump changes it. */
function cleanSubagentResult(text: string): string {
  return text
    .replace(/\n?<usage>[\s\S]*?<\/usage>\s*$/, '')
    .replace(/agentId:\s*\S+\s*(?:\(use SendMessage[^)]*\))?\s*$/, '')
    .trim()
}

/** tool_result content is either a string or an array of text blocks. Flatten to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  return ''
}
