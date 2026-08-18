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
import { z } from 'zod'
import type {
  ApprovalMode,
  EngineEvent,
  RawEngineEvent,
  ResumeCursor,
  SessionCapabilitySnapshot,
  SessionMcpServer,
} from '@shared/ipc'
import { rateLimitBand } from '@shared/rate-limits'
import { buildSessionCapabilitySnapshot, capabilitySnapshotFingerprint } from '@shared/session-capabilities'
import { logUnmappedEvent } from './unmapped-log'
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
  /** Whether this spawn was configured with Koda's optional Playwright MCP server. Runtime evidence
   * still decides ready vs degraded; this flag only distinguishes expected from intentionally off. */
  browserWired?: boolean
  /** At least one Koda playbook is intentionally enabled for this project. Defaults true for direct
   * driver callers; the session manager derives it from the project's guardrail switches. */
  playbooksExpected?: boolean
  /**
   * This session's last resume cursor, handed back verbatim by the shared layer. THIS driver owns the
   * shape (see `claudeResumeCursor`): a valid cursor with turns > 0 spawns `claude --resume <id>`,
   * anything else spawns fresh (`--session-id <id>`). Must launch from the same cwd the session was
   * created in (resume is cwd-scoped).
   */
  resumeCursor?: ResumeCursor
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
   * This project owns a registered mini app — computed by the Electron layer (the registry lives
   * there, like extraDisallowedTools' runtime state). Gates the pack's summon-pill rule so a session
   * in a faced project knows Koda's "Ask or fix this app" pill is claimable, not immovable.
   */
  miniAppProject?: boolean
  /**
   * The mini-apps dogfood flag is on (the staging create-mini-app skill rides extraPluginDirs) —
   * computed by the Electron layer like the above. Gates the pack's app-ask routing rule so it never
   * names a skill that isn't loaded.
   */
  miniAppsWired?: boolean
  /** The user explicitly enabled the fresh-review pass (Settings → General → Finishing work).
   * Reviewer capabilities remain available for an explicit user request when this is false. */
  critiqueOn?: boolean
  /** This install starts sessions as parent orchestrators, so prompt assembly adds the compact route
   * to the existing fan-out playbook. Snapshotted at spawn; a setting change affects the next session. */
  orchestratorSession?: boolean
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
 * Engine messages this driver ignores ON PURPOSE, so the unmapped log stays signal. Everything not in
 * this list and not translated below gets logged — that is the "never silently swallowed" contract.
 *  - `control_response` / `control_cancel_request`: acks to control requests Koda itself sent.
 *  - `stream_event` framing (message_start, content_block_*, message_delta, message_stop): envelope
 *    only; the content arrives as deltas and again as the finalized message.
 *  - a subagent's copy of a delta Koda maps at top level: children render as finalized blocks under
 *    their card, so their live deltas are a deliberate skip.
 *  - the engine echoing back the turn Koda just sent (`user` text/image blocks).
 *  - `assistant/block/thinking` (+ redacted): reasoning text is redacted on subscription `-p`
 *    (engine-adapter-and-output-view.md §8) — presence is all there is, and ThinkingDelta carries it.
 *  - `system/task_updated`: carries only a task_id + patch, with no tool_use_id to join a card on.
 */
const DELIBERATELY_IGNORED = new Set([
  'control_response',
  'control_cancel_request',
  'stream_event/message_start',
  'stream_event/content_block_start',
  'stream_event/content_block_delta',
  'stream_event/content_block_stop',
  'stream_event/message_delta',
  'stream_event/message_stop',
  'stream_event/text_delta',
  'stream_event/thinking_delta',
  'user/block/text',
  'user/block/image',
  'assistant/block/thinking',
  'assistant/block/redacted_thinking',
  'system/task_updated',
])

/**
 * Claude's resume cursor — the shape THIS driver owns inside the opaque `ResumeCursor.data`. The engine
 * reattaches by its own session id, which for Claude is Koda's session id (`--resume <id>` keeps it;
 * spike/resume). `turns` is how many turns this conversation has actually completed: a conversation the
 * engine has never written has nothing to reattach to, so 0 means "spawn fresh", which is what keeps a
 * pre-first-turn posture respawn from racing the engine's own init.
 */
const ClaudeResumeDataSchema = z.object({
  sessionId: z.string().min(1),
  turns: z.number().int().nonnegative(),
  /** Reserved for A5's coupled rewind (resume the conversation at a specific message). Nothing sets it
   *  yet; it is validated and carried across respawns so the seam exists where the driver owns it. */
  resumeAt: z.string().min(1).optional(),
})
type ClaudeResumeData = z.infer<typeof ClaudeResumeDataSchema>

/** The engine's own words when `--resume` names a conversation it no longer holds (it exits code 1).
 *  There is no way to ask ahead of time — `claudeConversationExists` only proves a file exists, not that
 *  it holds a resumable conversation — so the engine's answer IS the check. */
const RESUME_MISS = /No conversation found with session ID/i

/** Build this driver's cursor. Exported so the session manager can hand one back without knowing the shape. */
export function claudeResumeCursor(sessionId: string, turns: number, resumeAt?: string): ResumeCursor {
  return {
    engine: 'claude',
    resumable: turns > 0,
    data: { sessionId, turns, ...(resumeAt ? { resumeAt } : {}) },
  }
}

/** Validate a cursor as OURS, for THIS session. A Codex blob, a hand-edited file, or a cursor minted for
 *  another conversation is not resumable here — the caller starts clean rather than guessing. */
export function parseClaudeResumeCursor(
  cursor: ResumeCursor | undefined,
  sessionId: string,
): ClaudeResumeData | null {
  if (!cursor || cursor.engine !== 'claude') return null
  const parsed = ClaudeResumeDataSchema.safeParse(cursor.data)
  if (!parsed.success || parsed.data.sessionId !== sessionId) return null
  return parsed.data
}

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
  /** Returns whether the turn was accepted for delivery; callers holding must-arrive
   *  content (e.g. a restore notice) re-queue it on false. */
  sendTurn(text: string, images?: TurnImage[]): boolean
  interrupt(): void
  /** A targeted stop for an engine-owned delegated child; absent without a task protocol. */
  stopTask?(taskId: string): boolean
  /** Tell a live session its posture changed. Present only on drivers whose capabilities declare
   *  `planMode: 'turnText'` — they carry the mode in each turn's text, so no respawn is needed. A
   *  driver with a native mode (Claude) has no such setter and the caller respawns instead. */
  setApprovalMode?(mode: ApprovalMode): void
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
  /** Repeated system/init messages carry MCP connection changes. Keep one content fingerprint so the
   * normalized stream updates only when the engine's evidence really changed. */
  private capabilityFingerprint = ''
  /** Claude may first report an expected MCP server as pending, then re-emit init once connected. Give
   * that native transition one bounded grace period instead of flashing a false degradation. */
  private capabilityGraceTimer?: ReturnType<typeof setTimeout>
  private pendingCapabilitySnapshot?: SessionCapabilitySnapshot
  private readonly expectedKodaTools: boolean
  private readonly expectedPlaybooks: boolean
  private readonly expectedBrowserTesting: boolean
  /** Skill names Koda denied for this spawn. Claude's init inventory reports loaded skills but does
   * not label their effective deny state, so filter that native list through the policy we applied. */
  private readonly disabledSkillNames: Set<string>
  private disposed = false
  private closed = false
  /** Completed turns in THIS conversation, carried forward from the cursor we resumed with. Drives the
   *  cursor's `resumable` answer, so nothing above the driver has to guess whether a conversation exists. */
  private turns = 0
  /** The A5 rewind anchor, carried through untouched (see ClaudeResumeDataSchema). */
  private readonly resumeAt?: string
  /** This spawn asked the engine to reattach — so a "no conversation" exit is a resume miss to recover
   *  from, not an unexplained fatal. */
  private readonly resuming: boolean
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
  /** Agent/Task launch tool_use ids — lets us route the top-level Agent tool_result to the
   *  subagent lifecycle rather than a stray ToolResult. */
  private readonly subagentLaunchIds = new Set<string>()
  /** Background Agent launch ids. Their immediate tool result is only a receipt; their actual
   *  result arrives later in task_notification. Foreground agents still finish via tool_result. */
  private readonly backgroundSubagentIds = new Set<string>()
  /** Top-level SendMessage calls. A call can wake a finished agent back up in the background; its
   *  ordinary tool card still closes on the receipt while the resumed work gets its own live card. */
  private readonly sendMessageInputs = new Map<string, Record<string, any>>()
  /** Launch ids of NESTED subagents (an Agent launched by another subagent). The engine doesn't
   *  stream their inner transcript (spike/capture), so we render them as a tool-child under their
   *  parent and SUPPRESS their top-level task_* lifecycle (which would else show a stuck card). */
  private readonly nestedSubagentIds = new Set<string>()
  /** Workflow tool_use ids — the launch returns a run id + on-disk run dir in its tool_result;
   *  we suppress the generic tool card and open a WorkflowCard from the parsed result instead. */
  private readonly workflowLaunchIds = new Set<string>()
  /** The native message being translated right now. Every event emitted during that translation carries
   *  it (the lossless envelope); events Koda mints on its own leave it undefined. */
  private nativeRaw: RawEngineEvent | undefined

  constructor(onEvent: EventSink, opts: SessionOpts) {
    this.onEvent = onEvent
    this.onClose = opts.onClose
    this.id = opts.sessionId ?? randomUUID()
    this.cwd = opts.cwd ?? process.cwd()
    // The driver reads its own cursor and decides reattach-vs-fresh here, once.
    const cursor = parseClaudeResumeCursor(opts.resumeCursor, this.id)
    this.turns = cursor?.turns ?? 0
    this.resumeAt = cursor?.resumeAt
    this.resuming = this.turns > 0

    const enginePath = opts.binaryPath ?? resolveEnginePath({ resourcesPath: opts.resourcesPath }).path
    const env = buildEngineEnv(process.env, opts.env)
    // The Koda behavior-layer pack: skills + subagents load via --plugin-dir (below); its always-on
    // judgment rules ride the system prompt here (spike/plugin-load — plugin CLAUDE.md isn't
    // auto-injected). Null when no pack is present (additive — sessions still start without it).
    const pack = resolvePack({ resourcesPath: opts.resourcesPath })
    this.expectedKodaTools = !!opts.mcpConfigJson
    this.expectedPlaybooks = opts.playbooksExpected ?? true
    this.expectedBrowserTesting = opts.browserWired === true
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
      miniAppProject: opts.miniAppProject,
      miniAppsWired: opts.miniAppsWired,
      critiqueOn: opts.critiqueOn,
      orchestratorSession: opts.orchestratorSession,
      engine: 'claude',
    })

    // Deep-research stays off always; a project's disabled skills/subagents add their denials; the
    // Electron layer adds any runtime-conditional denials (e.g. browser-verify when Playwright is off).
    const disallowedTools = [
      DISALLOWED_DEEP_RESEARCH,
      ...disabledToolTokens(disabled),
      ...(opts.extraDisallowedTools ?? []),
    ]
    this.disabledSkillNames = new Set(
      disallowedTools.flatMap((token) => {
        const name = /^Skill\((.+)\)$/.exec(token)?.[1]
        return name ? [name] : []
      }),
    )

    this.child = spawn(
      enginePath,
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose', // required for stream-json output (spike/layer-a)
        '--include-partial-messages', // emit text_delta for live paint
        '--forward-subagent-text', // keep each child's prose + tool steps inspectable under its card
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
        ...(this.resuming ? ['--resume', this.id] : ['--session-id', this.id]),
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

  sendTurn(text: string, images?: TurnImage[]): boolean {
    if (this.disposed || this.closed || !this.child.stdin.writable) {
      this.emitError('cannot send turn: engine session is not running', false)
      return false
    }
    // Image blocks first, then text — the order Anthropic recommends for image+question turns.
    const content: Array<Record<string, unknown>> = []
    for (const img of images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } })
    }
    if (text) content.push({ type: 'text', text })
    const msg = { type: 'user', message: { role: 'user', content } }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
    return true
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

  /** Stop one background child while the parent process and sibling children keep running. */
  stopTask(taskId: string): boolean {
    if (!taskId || this.disposed || this.closed || !this.child.stdin.writable) return false
    const msg = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'stop_task', task_id: taskId },
      uuid: randomUUID(),
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.capabilityGraceTimer) clearTimeout(this.capabilityGraceTimer)
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
      const ev = raw as Record<string, any>
      // Stamp the native message onto everything this line produces, then clear it so a later
      // Koda-minted event can't inherit someone else's envelope.
      this.nativeRaw = { source: 'claude', method: claudeMethod(ev), ids: claudeIds(ev), payload: ev }
      try {
        this.translate(ev)
      } finally {
        this.nativeRaw = undefined
      }
    }
  }

  /** Attach the native envelope (when this event came off the wire) and hand the event up. */
  private emit(event: EngineEvent): void {
    this.onEvent(this.nativeRaw ? { ...event, raw: this.nativeRaw } : event)
  }

  /** An engine message this driver has no mapping for. Logged, never dropped. */
  private unmapped(method: string, payload: unknown, ids?: Record<string, string>): void {
    if (DELIBERATELY_IGNORED.has(method)) return
    logUnmappedEvent(this.id, { source: 'claude', method, ids, payload })
  }

  /** Turn Claude's repeated native init inventory into one effective session snapshot. The first init
   * can arrive while MCP servers are still pending; a later init normally resolves it. A bounded grace
   * timer is a deadline only — it performs no probe and consumes no model turn. */
  private observeCapabilities(ev: Record<string, any>): void {
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    const mcpServers: SessionMcpServer[] = Array.isArray(ev.mcp_servers)
      ? ev.mcp_servers.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return []
          const server = entry as Record<string, unknown>
          if (typeof server.name !== 'string') return []
          const rawTools = server.tools
          const tools = Array.isArray(rawTools)
            ? rawTools.filter((tool): tool is string => typeof tool === 'string')
            : rawTools && typeof rawTools === 'object'
              ? Object.keys(rawTools)
              : []
          return [{
            name: server.name,
            status: typeof server.status === 'string' ? server.status : tools.length > 0 ? 'connected' : 'unknown',
            tools,
          }]
        })
      : []
    const plugins = Array.isArray(ev.plugins)
      ? ev.plugins.flatMap((entry: unknown) => {
          if (typeof entry === 'string') return [entry]
          if (!entry || typeof entry !== 'object') return []
          const name = (entry as { name?: unknown }).name
          return typeof name === 'string' ? [name] : []
        })
      : []
    const snapshot = buildSessionCapabilitySnapshot({
      engine: 'claude',
      cwd: typeof ev.cwd === 'string' ? ev.cwd : this.cwd,
      source: 'engine-init',
      tools: strings(ev.tools),
      skills: strings(ev.skills).filter((name) => {
        const localName = name.slice(name.lastIndexOf(':') + 1)
        return !this.disabledSkillNames.has(name) && !this.disabledSkillNames.has(localName)
      }),
      agents: strings(ev.agents),
      plugins,
      mcpServers,
      expected: {
        kodaTools: this.expectedKodaTools,
        playbooks: this.expectedPlaybooks,
        browserTesting: this.expectedBrowserTesting,
      },
    })
    const degraded = snapshot.capabilities.some((entry) => entry.status === 'degraded')
    const degradedIds = new Set(
      snapshot.capabilities.filter((entry) => entry.status === 'degraded').map((entry) => entry.id),
    )
    // A failed inherited/user MCP is not evidence that Koda's own pending broker or Playwright will
    // fail. Only cancel the grace period when the explicitly failed server owns a degraded group.
    const explicitFailure = mcpServers.some((server) => {
      if (!/failed|error|disconnected|unreachable/i.test(server.status)) return false
      return (
        (server.name === 'koda_broker' && degradedIds.has('koda-tools')) ||
        (server.name === 'playwright' && degradedIds.has('browser-testing'))
      )
    })
    if (degraded && !explicitFailure && !this.capabilityFingerprint) {
      this.pendingCapabilitySnapshot = snapshot
      if (!this.capabilityGraceTimer) {
        this.capabilityGraceTimer = setTimeout(() => {
          this.capabilityGraceTimer = undefined
          const pending = this.pendingCapabilitySnapshot
          this.pendingCapabilitySnapshot = undefined
          if (pending && !this.disposed) this.publishCapabilities(pending)
        }, 2_500)
        this.capabilityGraceTimer.unref?.()
      }
      return
    }
    if (this.capabilityGraceTimer) clearTimeout(this.capabilityGraceTimer)
    this.capabilityGraceTimer = undefined
    this.pendingCapabilitySnapshot = undefined
    this.publishCapabilities(snapshot)
  }

  private publishCapabilities(snapshot: SessionCapabilitySnapshot): void {
    const fingerprint = capabilitySnapshotFingerprint(snapshot)
    if (fingerprint === this.capabilityFingerprint) return
    this.capabilityFingerprint = fingerprint
    this.emit({ type: 'SessionCapabilitiesUpdated', sessionId: this.id, snapshot })
  }

  /** Claude stream-json → normalized EngineEvents. The translation table. */
  private translate(ev: Record<string, any>): void {
    // Inner subagent events carry the launch id here; top-level events don't.
    const parentToolUseId: string | undefined =
      typeof ev?.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined

    switch (ev?.type) {
      case 'system':
        if (ev.subtype === 'init') {
          if (!this.started) {
            this.started = true
            this.model = typeof ev.model === 'string' ? ev.model : ''
            this.emit({
              type: 'SessionStarted',
              sessionId: this.id,
              model: this.model,
              tools: Array.isArray(ev.tools) ? ev.tools : [],
              cwd: typeof ev.cwd === 'string' ? ev.cwd : this.cwd,
            })
            // Publish the cursor as soon as the engine is up: a session that dies before its first turn
            // still leaves the owner holding an honest "nothing to reattach to yet" answer.
            this.emitResumeCursor()
          }
          this.observeCapabilities(ev)
        } else {
          this.translateTask(ev) // system/task_* — agents and ordinary background jobs share this wire
        }
        break

      case 'stream_event': {
        const delta = ev?.event?.delta
        // Only top-level deltas drive live UI; subagent internals show as finalized
        // blocks under its card (no live subagent streaming in v0).
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && !parentToolUseId) {
          this.emit({ type: 'AssistantDelta', sessionId: this.id, text: delta.text })
        } else if (delta?.type === 'thinking_delta' && !parentToolUseId) {
          // Reasoning text is redacted on subscription (delta.thinking is ''); the only
          // usable signal is the cumulative token estimate — surfaces a "Thinking…" state.
          this.emit({
            type: 'ThinkingDelta',
            sessionId: this.id,
            estimatedTokens: typeof delta.estimated_tokens === 'number' ? delta.estimated_tokens : undefined,
          })
        } else if (delta) {
          // Anything new arrives here first (the §8 seam: every delta that isn't text or thinking used
          // to fall out of the stream unnoticed).
          this.unmapped(`stream_event/${String(delta.type ?? 'unknown')}`, ev, claudeIds(ev))
        } else {
          this.unmapped(`stream_event/${String(ev?.event?.type ?? 'unknown')}`, ev, claudeIds(ev))
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
            // text; a signed-out engine instead prints a terse "Not logged in · Please run /login". Lift
            // either out of the transcript into a typed EngineError so the UI shows a calm, actionable
            // banner (auth → a Sign in button) instead of raw prose a non-engineer can't act on.
            if (!parentToolUseId && (isApiErrorText(block.text) || isAuthRequiredText(block.text))) {
              this.emitApiError(block.text)
            } else {
              this.emit({ type: 'AssistantBlock', sessionId: this.id, markdown: block.text, parentToolUseId })
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
              if (!parentToolUseId && isSendMessageTool(block.name))
                this.sendMessageInputs.set(blockId, (block.input ?? {}) as Record<string, any>)
              this.emit({
                type: 'ToolRequested',
                sessionId: this.id,
                id: blockId,
                name: String(block.name ?? ''),
                input: block.input,
                parentToolUseId,
              })
            }
          } else {
            // A content block Koda has no card for (a new block type, or a finalized thinking block).
            this.unmapped(`assistant/block/${String(block?.type ?? 'unknown')}`, block, claudeIds(ev))
          }
        }
        break

      case 'user':
        for (const block of asArray(ev?.message?.content)) {
          if (block?.type !== 'tool_result') {
            this.unmapped(`user/block/${String(block?.type ?? 'unknown')}`, block, claudeIds(ev))
          } else {
            const id = String(block.tool_use_id ?? '')
            const resultText = toolResultText(block.content)
            const sendMessageInput = !parentToolUseId ? this.sendMessageInputs.get(id) : undefined
            if (sendMessageInput) {
              this.sendMessageInputs.delete(id)
              // SendMessage is still an ordinary visible tool action; close that card on its receipt.
              this.emit({
                type: 'ToolResult',
                sessionId: this.id,
                id,
                output: resultText,
                isError: block.is_error === true,
              })
              // A message to an idle agent can resume it in the background. The JSON receipt is not
              // the agent's answer; keep the delegated card live until task_notification arrives.
              if (isBackgroundSubagentLaunchResult(resultText)) {
                const taskId = resumedAgentId(resultText)
                this.backgroundSubagentIds.add(id)
                this.emitSubagentStarted(id, {
                  task_id: taskId,
                  subagent_type: 'subagent',
                  description:
                    typeof sendMessageInput.summary === 'string'
                      ? sendMessageInput.summary
                      : 'Agent follow-up',
                  prompt:
                    typeof sendMessageInput.message === 'string'
                      ? sendMessageInput.message
                      : undefined,
                })
                this.emit({
                  type: 'SubagentProgress',
                  sessionId: this.id,
                  toolUseId: id,
                  taskId,
                  description: 'Working in background',
                })
              }
            // Foreground Agent results close the card; background Agents return a launch receipt here.
            } else if (!parentToolUseId && this.subagentLaunchIds.has(id)) {
              // A background Agent returns an immediate launch receipt through the SAME tool_result
              // slot a foreground Agent uses for its final answer. The receipt is not evidence and
              // must not close the card; task_notification carries the real result later.
              if (isBackgroundSubagentLaunchResult(resultText)) {
                this.backgroundSubagentIds.add(id)
                this.emit({
                  type: 'SubagentProgress',
                  sessionId: this.id,
                  toolUseId: id,
                  description: 'Working in background',
                })
              } else {
                this.emit({
                  type: 'SubagentCompleted',
                  sessionId: this.id,
                  toolUseId: id,
                  resultText: cleanSubagentResult(resultText),
                  isError: block.is_error === true,
                })
              }
            } else if (!parentToolUseId && this.workflowLaunchIds.has(id)) {
              // The Workflow launch returned its run id + on-disk dir → open the WorkflowCard and
              // let main watch the journal. The actual result never streams back (spike/capture).
              this.workflowLaunchIds.delete(id)
              this.emitWorkflowStarted(toolResultText(block.content))
            } else {
              this.emit({
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
        // A completed turn is what makes this conversation reattachable, so the cursor moves with it.
        this.turns += 1
        this.emitResumeCursor()
        this.emit({
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
        // The account-level subscription window (5-hour / seven_day), emitted per turn — surfaces
        // the reset time + status band in the status bar. Since ~2026-07 the event also carries a
        // precise `utilization` (0–1), and the server may report only the windows it deems
        // newsworthy (observed 07-22: seven_day past its 75% threshold, five_hour silent) — so an
        // absent window means "nothing to report", not "gone". Status gained an `allowed_warning`
        // variant; normalized to the `warning` band every surface already keys on.
        const info = ev.rate_limit_info
        if (info && typeof info.rateLimitType === 'string' && typeof info.resetsAt === 'number') {
          const status = typeof info.status === 'string' ? info.status : 'allowed'
          this.emit({
            type: 'RateLimitUpdate',
            sessionId: this.id,
            engine: 'claude',
            info: {
              rateLimitType: info.rateLimitType,
              resetsAt: info.resetsAt,
              status:
                typeof info.utilization === 'number'
                  ? rateLimitBand(info.utilization * 100)
                  : status === 'allowed_warning'
                    ? 'warning'
                    : status,
              isUsingOverage: info.isUsingOverage === true,
              usedPercent:
                typeof info.utilization === 'number'
                  ? Math.round(info.utilization * 100)
                  : undefined,
              observedAt: Date.now(),
              source: 'stream',
            },
          })
        } else {
          this.unmapped('rate_limit_event/unrecognized', ev)
        }
        break
      }

      // A message type this driver has never seen — an engine bump's new event, or an old one that
      // changed shape. It lands in the session's unmapped log so the next mapping question has
      // evidence instead of needing a fresh wire spike.
      default:
        this.unmapped(claudeMethod(ev), ev, claudeIds(ev))
    }
  }

  /** Open a SubagentCard (idempotent per launch id — both the Agent tool_use and
   *  system/task_started describe the same launch; whichever lands first wins). */
  private emitSubagentStarted(id: string, input: Record<string, any>): void {
    if (!id) return
    const taskId = typeof input.task_id === 'string' ? input.task_id : undefined
    if (this.subagentLaunchIds.has(id)) {
      if (taskId)
        this.emit({ type: 'SubagentProgress', sessionId: this.id, toolUseId: id, taskId })
      return
    }
    this.subagentLaunchIds.add(id)
    this.emit({
      type: 'SubagentStarted',
      sessionId: this.id,
      toolUseId: id,
      taskId,
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
    this.emit({ type: 'WorkflowStarted', sessionId: this.id, runId, name: name || 'Workflow', dir })
  }

  /** The engine's shared task lifecycle stream. Delegated agents identify themselves with
   *  `task_type: "local_agent"`; commands running inside those agents use this same wire and already
   *  render from their parent-tagged ToolRequested/ToolResult events, so they must not open siblings. */
  private translateTask(ev: Record<string, any>): void {
    const toolUseId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : undefined
    const taskId = typeof ev.task_id === 'string' ? ev.task_id : undefined
    const parentToolUseId = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined
    // A nested tool already belongs under its parent's card. Nested Agent launches additionally stay
    // in nestedSubagentIds for engine versions that omit the parent marker on their lifecycle rows.
    if (parentToolUseId || (toolUseId && this.nestedSubagentIds.has(toolUseId))) return
    // Claude also emits task_* for ordinary shell jobs. Only a declared local agent (or a launch the
    // preceding Agent tool_use already registered) owns Koda's delegated-task lifecycle.
    if (!toolUseId || (ev.task_type !== 'local_agent' && !this.subagentLaunchIds.has(toolUseId))) return
    switch (ev.subtype) {
      case 'task_started':
        this.emitSubagentStarted(toolUseId, ev)
        break
      case 'task_progress':
        this.emit({
          type: 'SubagentProgress',
          sessionId: this.id,
          toolUseId,
          taskId,
          description: typeof ev.description === 'string' ? ev.description : undefined,
          lastToolName: typeof ev.last_tool_name === 'string' ? ev.last_tool_name : undefined,
          usage: normalizeUsage(ev.usage),
        })
        break
      case 'task_notification':
        this.emitSubagentStarted(toolUseId, ev)
        if (this.backgroundSubagentIds.has(toolUseId)) {
          this.emit(taskNotificationToCompletion(this.id, toolUseId, ev))
        } else {
          // Foreground agents also announce their task status here, but their full answer follows
          // in the Agent tool_result. Keep the card live until that evidence-bearing result lands.
          this.emit({
            type: 'SubagentProgress',
            sessionId: this.id,
            toolUseId,
            taskId,
            description: typeof ev.status === 'string' ? ev.status : undefined,
            usage: normalizeUsage(ev.usage),
          })
        }
        break
      // task_updated carries only task_id + patch (no tool_use_id to join on). The joinable foreground
      // tool_result / background task_notification paths above carry the lifecycle Koda can render.
      default:
        this.unmapped(claudeMethod(ev), ev, claudeIds(ev))
    }
  }

  private emitResumeCursor(): void {
    this.emit({
      type: 'ResumeCursorUpdated',
      sessionId: this.id,
      cursor: claudeResumeCursor(this.id, this.turns, this.resumeAt),
    })
  }

  private emitError(message: string, fatal: boolean): void {
    this.emit({
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
    this.emit({
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
    if (this.capabilityGraceTimer) clearTimeout(this.capabilityGraceTimer)
    // We asked to reattach and the engine says it has no such conversation. That is recoverable, not
    // fatal: report it as a resume miss and let the owner restart this session clean.
    if (!this.disposed && this.resuming && RESUME_MISS.test(this.stderr)) {
      this.emit({
        type: 'EngineError',
        sessionId: this.id,
        message: 'the engine no longer holds this conversation',
        fatal: false,
        category: 'resumeMiss',
      })
      this.disposed = true
      this.onClose?.(this.id)
      return
    }
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

/** The engine's own name for a message: its `type`, qualified by `subtype` where one exists
 *  (`system/init`, `system/task_progress`). This is the key the unmapped log groups by, and the
 *  `method` on the raw envelope. */
export function claudeMethod(ev: Record<string, any>): string {
  const type = typeof ev?.type === 'string' ? ev.type : 'unknown'
  // `result.subtype` is the stop reason ('success'), not a message kind — qualifying it would mint a
  // new method name per outcome.
  const subtype = typeof ev?.subtype === 'string' && type !== 'result' ? ev.subtype : ''
  return subtype ? `${type}/${subtype}` : type
}

/** The engine's own ids for a message, flattened so a consumer can join a child to its parent without
 *  re-reading the payload. Only keys the message actually carries appear. */
export function claudeIds(ev: Record<string, any>): Record<string, string> | undefined {
  const ids: Record<string, string> = {}
  const put = (key: string, value: unknown) => {
    if (typeof value === 'string' && value) ids[key] = value
  }
  put('uuid', ev?.uuid)
  put('sessionId', ev?.session_id)
  put('parentToolUseId', ev?.parent_tool_use_id)
  put('toolUseId', ev?.tool_use_id)
  put('taskId', ev?.task_id)
  put('messageId', ev?.message?.id)
  return Object.keys(ids).length ? ids : undefined
}

/** The CLI prints an unrecoverable API failure as an assistant text block prefixed "API Error:" (its
 *  stable format across versions). That's our signal to lift it into the composer error banner rather
 *  than render it as conversation text. Anchored to the start so it can't match a message ABOUT errors. */
function isApiErrorText(text: string): boolean {
  return /^\s*api error:/i.test(text)
}

/** The bundled CLI's terse "not signed in" notice (e.g. "Not logged in · Please run /login"). Length-
 *  capped so a real answer that merely mentions logging in isn't mistaken for the CLI's own notice. */
function isAuthRequiredText(text: string): boolean {
  const t = text.trim()
  if (t.length > 120) return false
  return /^not logged in\b/i.test(t) || /please run\s*\/?login/i.test(t)
}

/** The subagent-launch tool — "Agent" on 2.1.x, legacy "Task" (spike/subagent §Q1). */
function isSubagentTool(name: unknown): boolean {
  return name === 'Agent' || name === 'Task'
}

function isSendMessageTool(name: unknown): boolean {
  return name === 'SendMessage'
}

/** The exact metadata receipt Claude 2.1.x returns immediately for an async Agent launch. It is not
 *  the child's answer; treating it as one is the empty/premature-card bug the background spike found. */
export function isBackgroundSubagentLaunchResult(text: string): boolean {
  if (/^Async agent launched successfully\./.test(text) && text.includes('working in the background'))
    return true
  const taskId = resumedAgentId(text)
  if (!taskId) return false
  try {
    const receipt = JSON.parse(text) as Record<string, unknown>
    return typeof receipt.message === 'string' && receipt.message.includes('in the background')
  } catch {
    return false
  }
}

function resumedAgentId(text: string): string | undefined {
  try {
    const receipt = JSON.parse(text) as Record<string, unknown>
    return typeof receipt.resumedAgentId === 'string' ? receipt.resumedAgentId : undefined
  } catch {
    return undefined
  }
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

/** Background children finish through system/task_notification, not an Agent tool_result. Kept pure
 *  so the normal unit lane can pin this version-sensitive wire translation. */
export function taskNotificationToCompletion(
  sessionId: string,
  toolUseId: string,
  ev: Record<string, any>,
): Extract<EngineEvent, { type: 'SubagentCompleted' }> {
  const status = typeof ev.status === 'string' ? ev.status : ''
  const interrupted = status === 'stopped' || status === 'interrupted' || status === 'cancelled'
  return {
    type: 'SubagentCompleted',
    sessionId,
    toolUseId,
    taskId: typeof ev.task_id === 'string' ? ev.task_id : undefined,
    resultText: typeof ev.summary === 'string' ? ev.summary : undefined,
    outcome: interrupted ? 'interrupted' : 'completed',
    isError: !interrupted && status !== '' && status !== 'completed',
    usage: normalizeUsage(ev.usage),
  }
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
 *
 * Exported because the one-shot turns Koda spawns outside a session (the Library's ask) read the same
 * `--output-format json` envelope on their way into the same daily rollup. One reader, so a second
 * copy cannot drift from the shape the driver actually receives.
 */
export function extractModelUsage(modelUsage: unknown): import('@shared/ipc').ModelTurnUsage[] | undefined {
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
