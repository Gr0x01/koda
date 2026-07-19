/**
 * Owns the live engine sessions and routes their normalized events to the
 * renderer. The adapter stays Electron-free (testable); this is the thin
 * Electron-coupled layer that pushes events over `webContents.send` and
 * Zod-validates them at the boundary (locked IPC pattern).
 *
 * It also wires the permission broker (spine #5): an in-process HTTP MCP server
 * (broker/server.ts) the engine consults before every tool, and the approval gate
 * (broker/gate.ts) that decides — tripwire → Auto-approve/Ask-me → per-tool safety
 * checkpoint. The manager is where the gate's deps (safety-git checkpoint, renderer
 * push) are injected, and where the broker's lifecycle is tied to a session's.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { app } from 'electron'
import { IpcChannels } from '@shared/channels'
import {
  EngineEventSchema,
  ApprovalRequestSchema,
  ApprovalCancelledSchema,
  ApprovalResolvedSchema,
  AsideEventSchema,
  type EngineEvent,
  type ApprovalMode,
  type ApprovalRequest,
  type ToolDecision,
  type PersistedSessions,
  type EngineId,
  type CodexModel,
  type CodexAuthStatus,
  type AdoptedHeadlessSession,
  type ReplayEntry,
  type RateLimitInfo,
  type RemoteUsageSnapshot,
  IMAGE_DETAIL_CAPS,
  attachedFilesNote,
} from '@shared/ipc'
import { startClaudeSession, type EngineSession, type SessionOpts, type TurnImage } from './adapter'
import { startCodexSession } from './codex-driver'
import { ensureCodexHome, reconcileCodexAuth } from './codex-home'
import { assembleGuardrailText, resolveStagingPack } from './pack'
import { getCodexAuthStatus, listCodexModels } from './codex-auth'
import { askCodexSideQuestion, askSideQuestion, type SideQuestionHandle } from './side-question'
import { WorkflowWatcher } from './workflow-watch'
import { loadRateLimits, loadUsageHistory, recordRateLimit, recordTurnUsage } from './usage-history'
import {
  commitPaths,
  detectRepo,
  diffTextOf,
  getStatus,
  getSyncState,
  getVersionList,
  pushToRemote,
  restoreVersion,
  UserGitError,
} from '../user-git'
import { browseDir, containedReal, docExcerpt, listProjectDocs, readProjectFile, readProjectImage, writeProjectFile } from '../fs-browse'
import { installApp, startApp, stopApp, appStatus } from '../mini-apps'
import { encodeWebp } from '../backup/webp'
import { noteRateLimit } from './usage-reset-notifier'
import { noteProviderError, noteTurnOk } from './status-watch'
import { friendlyEngineError } from '@shared/engine-error'
import { track } from '../telemetry'
import { resolveGlobalSkillsPlugin } from './skills-catalog'
import { noteMomentCheckpoint } from '../backup'
import { ensureRepo } from '../safety-git/repo'
import { checkpoint, checkpointKind, headSha, listCheckpoints, type Checkpoint } from '../safety-git/checkpoint'
import { restore } from '../safety-git/restore'
import { maintainStore } from '../safety-git/prune'
import { humanizeCheckpointLabel, applyHumanizedLabels } from '../assist/labels'
import { assistTitle } from '../assist'
import { PermissionBroker, BROKER_TOKEN_ENV, SERVER_NAME as BROKER_NAME } from '../broker/server'
import { ApprovalGate } from '../broker/gate'
import { ensureTool } from '../runtime/provision'
import {
  loadApprovalMode,
  loadPreviewAutoStart,
  loadImageDetail,
  loadSettings,
  loadRecentModels,
  loadLastPosture,
  saveLastPosture,
  loadMiniAppsEnabled,
  loadScratchRetentionDays,
} from '../settings'
import { saveScratchImage } from '../scratch'
import { getApiKey } from '../api-key'
import {
  applyPlaywrightToMcpConfig,
  playwrightDisallowedTools,
  playwrightMcpServerForCodex,
  playwrightWired,
} from '../playwright'
import { startDevServer, captureWindowPreview, showStaticPreview, getSessionPreview, clearSessionPreview } from '../preview'
import { showTerminal } from '../terminal'
import { stopLanForward, stopAllLanForwards } from '../lan-forward'
import {
  claudeConversationExists,
  claudeConversationMtime,
  ingestFullArchives,
  readClaudeConversationReplay,
  loadProjectSessions,
  readPersistedSession,
  saveProjectSessions,
  loadAppState,
} from '../session-store'
import { addSessionToWindow, contextForSession, projectPathForWindow, removeSessionFromWindow, windowForProject } from '../window-registry'
import { log } from '../logger'

/** The engine's structured error prefix when our in-process MCP server is unreachable, e.g.
 *  `MCP server "koda_broker" is not connected` or `… transport dropped mid-call; response for tool
 *  "approve" was lost`. Matching this exact prefix (not the bare name) both covers every drop phrasing
 *  AND avoids a false positive when a Bash command greps Koda's own source (which has the name, never
 *  this quoted engine-error phrase). `%s` is filled with the broker name. */
const BROKER_UNREACHABLE_PREFIX = (name: string): string => `MCP server "${name}"`
/** The drop signatures that follow that prefix — belt-and-suspenders so a hypothetical non-drop error
 *  carrying the prefix can't trigger a respawn. */
const BROKER_DROP_SIGNATURE = /is not connected|transport dropped|was lost/
/** After a broker reconnect, ignore further drop errors for this long — absorbs late "not connected"
 *  results still draining from the disposed old child, and stops us thrashing. */
/** A phone doc-edit write with a longer gap than this since the last one starts a new "editing burst" and
 *  gets a fresh safety-git checkpoint; the rapid autosaves within a burst just write (see remoteWriteFile). */
const REMOTE_WRITE_BURST_MS = 20_000
const BROKER_RECOVERY_COOLDOWN_MS = 30_000
/** Give up (surface a fatal "please restart") after this many recoveries inside the window below — a
 *  broker that flaps this hard is a persistent fault, not a transient idle drop, so looping won't help. */
const BROKER_RECOVERY_MAX = 3
const BROKER_RECOVERY_WINDOW_MS = 5 * 60_000
/** Sent automatically as the user's next turn after a broker reconnect, so an interrupted turn just
 *  continues — the user didn't pause it, Koda's tool connection blipped and recovered. Framed so the
 *  agent treats the "not connected" errors above as the transient glitch they were, not real failures.
 *  --resume keeps the original request in context, so "continue" is enough to pick it back up. */
const BROKER_RESUME_NUDGE =
  "Koda's connection to its tools dropped for a moment and is now restored — any tool errors just above were from that, not real failures. Please pick up where you left off and finish what I was asking."

export class EngineSessionManager {
  private readonly sessions = new Map<string, EngineSession>()
  /** sessionId → project dir. Outlives the session handle (kept until dispose) so
   *  recovery works even after the engine crashes — exactly when it's needed most. */
  private readonly projectDirs = new Map<string, string>()
  /** Project dirs whose safety store is already initialized (ensureRepo is idempotent but
   *  not free; run it once per dir, not once per turn). */
  private readonly ensured = new Set<string>()
  /** Per-project-dir serialization tail: checkpoints on one safety.git MUST NOT run concurrently
   *  (git's index.lock would collide) — and a per-tool snapshot must capture a settled tree. */
  private readonly checkpointChains = new Map<string, Promise<unknown>>()
  /** Last phone-write time per project dir — drives autosave checkpoint coalescing in remoteWriteFile. */
  private readonly lastRemoteWriteAt = new Map<string, number>()
  /** Live background-workflow journal watchers, keyed by runId (a session may launch several). */
  private readonly workflowWatchers = new Map<string, { sessionId: string; watcher: WorkflowWatcher }>()
  /** Completed background-workflow results waiting to ride a session's NEXT human turn back into the
   *  agent's context (a workflow the agent launched returns async, after its turn already ended). Keyed
   *  by sessionId; drained in sendTurn. Human-steered by design — no unprompted machine turn. */
  private readonly pendingWorkflowResults = new Map<string, string[]>()
  /** In-flight side questions (btw/aside), keyed `${sessionId}:${asideId}` — so a dismiss can cancel
   *  the throwaway fork, and a session dispose can tear down any aside still streaming. */
  private readonly sideQuestions = new Map<string, SideQuestionHandle>()
  /** sessionId → the safety-git SHA captured at the current turn's start. The live-edits diff uses it
   *  as a PINNED baseline so each edited file shows its cumulative change *this turn* — reading live
   *  HEAD instead would drift forward as later whole-tree checkpoints land (see fs-browse diffFile). */
  private readonly diffBaselines = new Map<string, string>()
  /** sessionId → which engine drives it, so the daily usage rollup can attribute each turn to the right
   *  subscription (Anthropic vs OpenAI). Set at start, cleared on dispose. */
  private readonly sessionEngines = new Map<string, EngineId>()
  /** sessionId → engine-native conversation id. Codex uses a thread id distinct from Koda's session id;
   *  storing it main-side lets session-adjacent features such as aside fork the live Codex thread
   *  without asking the renderer to echo private routing state back over IPC. */
  private readonly engineNativeIds = new Map<string, string>()
  /** A posture/engine pick made before the first turn needs a FRESH same-id respawn, never --resume:
   *  there is no conversation yet on either engine to resume. */
  private readonly freshPostureStale = new Set<string>()
  /** sessionId → tools the engine advertised at session start (system/init). An aside fork denies exactly
   *  this set (by bare name) so it inherits no tool it could attempt or execute — version-proof, unlike a
   *  hand-maintained denylist that rots on an engine bump. */
  private readonly advertisedTools = new Map<string, string[]>()
  private readonly resourcesPath?: string

  /** 'auto' billing only: API-key fallback is effective until this unix-second timestamp (the rejected
   *  plan window's resetsAt). Runtime, not persisted — a restart while still rate-limited just re-prompts
   *  on the next rejection. Past `now`, 'auto' reverts to subscription on its own (effectiveApiKey). */
  private apiFallbackUntil = 0

  private readonly broker: PermissionBroker
  private readonly gate: ApprovalGate

  /** Remote Control: transport sinks (the LAN server and/or the cloud relay) that each fan every engine
   *  event + approval request out to their subscribed remote clients, in addition to the owning window.
   *  Empty until a transport is enabled — `send()` skips the loop then (zero overhead). Multiple may
   *  coexist (LAN + cloud at once); each `addRemoteSink` returns its own disposer. */
  private readonly remoteSinks = new Set<(channel: string, sessionId: string, payload: unknown) => void>()
  /** Sessions a remote client has attached to. The ONLY thing this controls: a remote-attached session
   *  keeps running headless when its desktop window closes (instead of being torn down) — the spec's
   *  "session outlives the window". Sticky for Phase 0 (attach once → survives until app quit or the
   *  remote tier is disabled); refcounting/auto-teardown-on-disconnect is a later refinement. */
  private readonly remoteAttached = new Set<string>()
  /** Live event log per remote-attached session — the transcript source when the Mac desktop ADOPTS a
   *  session that was started/run headless from the phone (a windowless session is invisible to the
   *  desktop otherwise). Main sees every event via `forward()`, and the app is always alive while a
   *  phone session runs (its child dies with the app), so this in-memory log is the complete, race-free
   *  history to replay into a desktop window — no engine-JSONL parsing, no adapter changes. High-churn
   *  streaming deltas are skipped (the finalized AssistantBlock re-carries the text). Kept for the
   *  session's whole life (so re-adopt after a window close/reopen still has full history); cleared on
   *  dispose. Only remote-attached sessions are logged, so a purely-local session costs nothing. */
  private readonly remoteEventLog = new Map<string, ReplayEntry[]>()
  /** new (live) session id → the original past-session id it was resumed from, so the phone can load
   *  that original's persisted transcript by the id it now holds (`remoteTranscript`). */
  private readonly resumedFrom = new Map<string, string>()
  /** Latest account rate-limit windows, per engine (keyed by rateLimitType). The stream only reports
   *  windows as turns run, so a phone joining mid-session would otherwise show nothing until its next
   *  turn — this snapshot rides the transcript reply instead. Seeded from disk (unexpired windows
   *  survive a restart) and persisted on every update. */
  private readonly lastRateLimits = new Map<EngineId, Record<string, RateLimitInfo>>(
    Object.entries(loadRateLimits()) as [EngineId, Record<string, RateLimitInfo>][],
  )
  /** Headless (phone-started) sessions we've already run first-turn auto-titling for, so a session is
   *  titled once and later turns don't reconsider it. Cleared on dispose. See `titleRemoteSession`. */
  private readonly remoteTitled = new Set<string>()
  /** A session's INTENDED model/effort — the pair the next turn should run on. The renderer is
   *  authoritative for a windowed session; a headless remote head has no live renderer, so the manager
   *  remembers the pair to (a) show it on the phone and (b) re-apply BOTH on a remote model-OR-effort
   *  change (the engine can't switch either live, so a change is a --resume respawn; passing only one
   *  would reset the other to engine-default). Set in start() (a spawn = the intent at that moment) and
   *  in setSessionModelEffort() (a later pick, WITHOUT respawning). Diverges from `spawnedWith` exactly
   *  when a pick has landed but no respawn has happened yet — sendTurn reconciles the two. */
  private readonly sessionModelEffort = new Map<string, { model?: string; effort?: string }>()
  /** A session's ACTUAL live child — the exact (model, effort, engine) triple it was spawned with. Set
   *  only where the child is really launched (start()), so it can't drift from the process. Compared
   *  against the intent (sessionModelEffort + sessionEngines) in sendTurn: any mismatch means the live
   *  engine is on the wrong model, so respawn before the turn goes out. This is "verify, don't trust" —
   *  it replaces a hand-set stale flag, so no spawn path can forget to mark a change (or a wrong first
   *  spawn) as needing reconciliation. Cleared in dispose(). */
  private readonly spawnedWith = new Map<string, { model?: string; effort?: string; engineId: EngineId }>()
  /** The model each session's engine REPORTED running (SessionStarted) — ground truth for showing what
   *  a "Default" pick resolved to. Cleared on engine switch (the old engine's model isn't the new
   *  engine's default); the desktop store keeps its own copy (activeModel), this one feeds the phone. */
  private readonly resolvedModels = new Map<string, string>()
  /** sessionId → epoch ms of the last human interaction (spawn or a user turn), so the phone's launcher
   *  can float the session you most recently touched to the top of "Active now" instead of freezing in
   *  start order. In-memory only (running sessions); past sessions order by their conversation mtime. */
  private readonly lastActivityAt = new Map<string, number>()
  /** sessionId → a turn is in flight right now. Remote heads with no event stream of their own (the phone
   *  launcher polls, it doesn't subscribe) read this to show a live working/idle glyph per session. Kept
   *  in lockstep with the client-side `busy` reducer: set on a turn's send, cleared when the turn ends. */
  private readonly working = new Set<string>()
  /** sessionId → the first line of the agent's latest reply, so the phone's project screen can show
   *  what a live session is doing ("Wiring the date picker…") without an event stream at browse level.
   *  In-memory, live sessions only — decoration, never persisted. */
  private readonly lastLines = new Map<string, string>()
  /** Broker auto-recovery: sessions with a reconnect respawn in flight — so a burst of "koda_broker is
   *  not connected" tool errors (the engine keeps trying every queued tool) triggers ONE respawn, not
   *  one per failed tool. Added when recovery starts, removed when the respawn settles. */
  private readonly recoveringBroker = new Set<string>()
  /** sessionId → recovery streak: how many reconnects we've done and when the last one settled. Rate-
   *  limits repeats (cooldown) and caps a flapping broker at BROKER_RECOVERY_MAX before giving up. */
  private readonly brokerRecovery = new Map<string, { count: number; at: number }>()
  /** Sessions awaiting an auto-resume turn after a broker reconnect. The nudge is sent when the fresh
   *  session's SessionStarted lands (engine initialized), so the interrupted turn continues on its own. */
  private readonly resumeAfterReconnect = new Set<string>()

  constructor(resourcesPath?: string) {
    this.resourcesPath = resourcesPath
    this.gate = new ApprovalGate(
      (sessionId, label) => this.checkpointForSession(sessionId, label),
      (req) => this.pushApprovalRequest(req),
      (sessionId) => this.pushApprovalCancelled(sessionId),
      (sessionId, requestId) => this.pushApprovalResolved(sessionId, requestId),
      (sessionId, message) => this.forward({ type: 'EngineError', sessionId, message, fatal: false }),
    )
    this.broker = new PermissionBroker(
      (sessionId, req) => this.gate.decide(sessionId, req),
      (sessionId, message) => this.forward({ type: 'EngineError', sessionId, message, fatal: false }),
      // Agent-driven recovery (dual-git.md §2): the broker exposes list/restore capability tools, the
      // manager executes them via safety-git (driver/implementer split). Restore runs through
      // runExclusive (see restoreCheckpoint), so the agent path can't interleave with a checkpoint.
      (sessionId) => this.getCheckpoints(sessionId),
      (sessionId, checkpointId) => this.restoreCheckpoint(sessionId, checkpointId),
      (sessionId, command, cwd) => this.startPreview(sessionId, command, cwd),
      (sessionId) => this.capturePreview(sessionId),
      (sessionId, relPath) => this.previewFile(sessionId, relPath),
      // Just-in-time tool provisioning: install a curated tool the agent asks for — a runtime or a CLI
      // (global, so the sessionId is unused). ensureTool routes + validates + de-dups installs.
      (_sessionId, toolId) => ensureTool(toolId),
      // Pop the terminal shelf for the user (open_terminal) — the "advanced: the human can" escape hatch
      // for the rare command the agent can't run itself (sudo, an interactive login). Staged, never run.
      (sessionId, command) => this.openTerminal(sessionId, command),
      // Mini-app lifecycle verbs (mini-apps-plan.md): session → project → contained app dir here; the
      // supervisor (mini-apps.ts) is session-unaware and owns the processes. Only advertised when the
      // mini-apps dogfood flag is on (register() below reads it).
      {
        install: async (sessionId, path) => {
          const { dir, projectPath } = this.appTarget(sessionId, path)
          return installApp(dir, projectPath)
        },
        start: async (sessionId, path) => {
          const { dir, projectPath } = this.appTarget(sessionId, path)
          return { started: true, ...(await startApp(dir, projectPath)) }
        },
        stop: async (sessionId, path) => {
          const { dir } = this.appTarget(sessionId, path)
          await stopApp(dir)
          return { stopped: true }
        },
        status: async (sessionId) => appStatus(this.projectPathFor(sessionId)),
      },
    )
    // Seed the DEFAULT posture new sessions start at (per-session overrides come from the renderer).
    this.gate.setDefaultMode(loadApprovalMode())
    // Seed whether the agent may start the preview server without a confirm (Settings → previewAutoStart).
    this.gate.setPreviewAutoStart(loadPreviewAutoStart())
    // projectDirs are repopulated lazily per window when it loads its project's sessions
    // (loadProjectSessions) — there's no global blob to read at construction time anymore (v2).
  }

  /**
   * Start a session. Async because the broker's HTTP listener must be UP (its port baked into the
   * engine's mcp-config) before we spawn — a missing broker means tools silently bypass the gate
   * (backend-architect #3). A bind failure rejects here, so session start fails loudly.
   */
  async start(
    opts: {
      cwd?: string
      resumeSessionId?: string
      sessionId?: string
      planMode?: boolean
      model?: string
      effort?: string
      engineId?: EngineId
      engineNativeId?: string
      ownerWindowId?: number
    } = {},
  ): Promise<{ sessionId: string; cwd: string }> {
    const requestedSessionId = opts.resumeSessionId ?? opts.sessionId
    const engineId = opts.engineId ?? (requestedSessionId ? this.sessionEngines.get(requestedSessionId) : undefined) ?? 'claude'
    // A fresh session runs in its OWNING window's project (one-project-per-window); a resumed session
    // passes its stored cwd explicitly. Fall back to process.cwd() only if neither is known.
    const cwd =
      opts.cwd ?? (opts.ownerWindowId != null ? projectPathForWindow(opts.ownerWindowId) : undefined) ?? process.cwd()

    // Broker up + this session registered (token minted) BEFORE spawn. For Claude it's the permission
    // transport (`--permission-prompt-tool` → in-process MCP) AND the capability tools; for Codex,
    // approvals are native (the gate is wired directly) but the broker still serves Koda's capability
    // tools (preview/recovery/ensure_tool) over its streamable-HTTP MCP endpoint — minus `approve`.
    // A resumed session keeps its original id (`--resume`; spike/resume) so renderer routing + the
    // recovery dir map stay aligned across the restart.
    await this.broker.ensureListening()
    // resumeSessionId → reattach (--resume); sessionId → fresh spawn with a caller-chosen id
    // (--session-id); neither → a fresh minted id. resume is keyed off resumeSessionId only.
    const sessionId = requestedSessionId ?? randomUUID()
    // A respawn tears down the old process before starting the replacement. Preserve the native
    // conversation id first: Codex resumes by its own thread id, not Koda's session id, and dispose()
    // clears the cache as part of normal teardown.
    const priorEngineNativeId = this.engineNativeIds.get(sessionId)
    // Respawn safety: if a child for this id is still alive (a Plan-mode/engine/model switch drops the
    // engine and reattaches on the next turn without disposing), tear it down BEFORE re-registering.
    // Otherwise the old child's late 'close' would unregister the NEW child's broker route — two
    // children, one id, one broken /mcp/<id>. dispose() awaits the old child's exit, so register() is clean.
    if (this.sessions.has(sessionId)) await this.dispose(sessionId)
    // Remember what this session runs with, so a later remote model/effort change can re-apply both
    // (dispose above cleared any prior entry; set the current intent now).
    this.sessionModelEffort.set(sessionId, { model: opts.model, effort: opts.effort })
    this.sessionEngines.set(sessionId, engineId)
    // Ground truth for reconciliation: this is exactly what the child is about to launch with, so a later
    // turn can tell whether the live engine still matches the (possibly since-changed) intent above.
    this.spawnedWith.set(sessionId, { model: opts.model, effort: opts.effort, engineId })
    // A resumed session (restart-reattach or the phone's resume-old) is never on its first turn — its
    // title, if any, belongs to the original conversation. Mark it so headless first-turn titling never
    // recomputes a label from a mid-conversation follow-up. (Fresh sessions title on their first turn.)
    if (opts.resumeSessionId) this.remoteTitled.add(sessionId)
    // Codex omits the `approve` tool (native approvals); both get the capability tools. The mini-app
    // lifecycle verbs ride the dogfood flag (read per session start — seam ② of the release gate).
    await this.broker.register(sessionId, {
      includeApprove: engineId === 'claude',
      includeMiniApps: loadMiniAppsEnabled(),
    })
    // Register window ownership BEFORE spawn so the very first event (system/init → SessionStarted,
    // or a fatal spawn 'error') routes to the owning window instead of falling into a gap and being
    // dropped (adapter emits these as soon as the child starts).
    if (opts.ownerWindowId != null) addSessionToWindow(opts.ownerWindowId, sessionId)

    // Codex: native per-tool approvals (so the gate is wired directly, no `approve` tool), but the
    // broker still serves Koda's capability tools over MCP. Same engine-neutral gate.decide → same
    // checkpoint-before-mutation + per-cwd mutex + the 3-tier posture. v1 ships subscription-only (no
    // API-key inject) and no Codex guardrail ruleset yet (see [[codex-engine-selection-ux]]).
    if (engineId === 'codex') {
      const token = this.broker.tokenFor(sessionId)
      // One-time (per app version) setup of Codex's isolated home: seed the login + install Koda's
      // bundled skills/subagents plugin. Single-flight + fail-soft — a setup failure never blocks the
      // session (skills are additive). CODEX_HOME itself is applied per-spawn in buildEngineEnv.
      const pwWired = playwrightWired()
      await ensureCodexHome({
        appVersion: app.getVersion(),
        resourcesPath: this.resourcesPath,
        playwrightWired: pwWired,
      })
      // Billing: in API mode, write the OpenAI key into the isolated home (Codex ignores the env key for
      // auth); in subscription mode, restore the ChatGPT login. Read live so a mode change applies next
      // session. Runs after ensureCodexHome (which seeds the login) and before the spawn's auth probes.
      const codexApiKey = this.effectiveApiKey('codex')
      await reconcileCodexAuth({ resourcesPath: this.resourcesPath, apiKey: codexApiKey })
      try {
        const session = startCodexSession((e) => this.forward(e), {
          sessionId,
          cwd,
          decide: (sid, req) => this.gate.decide(sid, req),
          // The SAME guardrail rules Claude gets (memory discipline, hygiene, docs, recovery, code
          // style) as additive developerInstructions. brokerWired: true — the Codex path always
          // attaches the broker (brokerUrl below), so the broker-gated preview/ensure-tool rules apply.
          // '' (no pack) ⇒ undefined so the driver omits the field. See assembleGuardrailText.
          developerInstructions:
            assembleGuardrailText({
              cwd,
              resourcesPath: this.resourcesPath,
              brokerWired: true,
              engine: 'codex',
            }) || undefined,
          model: opts.model,
          effort: opts.effort,
          // Reattaching an existing conversation → resume the persisted Codex thread by id (context
          // preserved); a fresh session has no native id, so the driver starts a new thread.
          resumeThreadId: opts.resumeSessionId ? (opts.engineNativeId ?? priorEngineNativeId) : undefined,
          resourcesPath: this.resourcesPath,
          // Token rides the env (referenced by name in the mcp_servers bearer_token_env_var), not argv.
          // apiMode/apiKey re-add the OpenAI credential only in API billing mode (the isolated home was
          // already logged in with it above); subscription mode passes neither and bills the ChatGPT plan.
          env: {
            engineId: 'codex',
            ...(codexApiKey ? { apiMode: true, apiKey: codexApiKey } : {}),
            ...(token ? { inject: { [BROKER_TOKEN_ENV]: token } } : {}),
          },
          brokerUrl: this.broker.mcpHttpUrl(sessionId),
          // Browser-verify tools when the optional capability is wired (the Codex analog of Claude's
          // applyPlaywrightToMcpConfig). Skill materialization is gated on the same flag in ensureCodexHome.
          playwrightServer: pwWired ? playwrightMcpServerForCodex() ?? undefined : undefined,
          onClose: (id) => this.handleClose(id),
        })
        this.sessions.set(session.id, session)
        this.projectDirs.set(session.id, cwd)
        this.lastActivityAt.set(session.id, Date.now())
        return { sessionId: session.id, cwd }
      } catch (err) {
        // Spawn failed before onClose could wire — unregister the broker route we just minted.
        await this.broker.unregister(sessionId)
        removeSessionFromWindow(sessionId)
        throw err
      }
    }

    try {
      const token = this.broker.tokenFor(sessionId)
      // Billing: inject the API key only when it's the effective credential for this spawn (always in
      // 'api' mode; in 'auto' only while a plan-limit fallback window is live). buildEngineEnv otherwise
      // re-adds nothing and the engine bills the subscription. Read live so a mode/fallback change
      // applies to the next session/reattach without a restart.
      const apiKey = this.effectiveApiKey()
      const inject = token ? { [BROKER_TOKEN_ENV]: token } : undefined
      const sessionOpts: SessionOpts = {
        sessionId,
        cwd,
        resume: !!opts.resumeSessionId,
        resourcesPath: this.resourcesPath,
        // Broker MCP config + (when the optional browser-testing capability is wired) the Playwright
        // server merged in. Its tools still route through `--permission-prompt-tool` → our gate.
        mcpConfigJson: applyPlaywrightToMcpConfig(this.broker.mcpConfig(sessionId)),
        // Deny the browser-verify skill unless Playwright is wired (no guidance for absent tools).
        extraDisallowedTools: playwrightDisallowedTools(),
        // Koda-managed global skills the user turned on in the gallery (null when none active), plus
        // the staging pack (built-but-unshipped skills like create-mini-app) only when the mini-apps
        // dogfood flag is on — that's how a normal release ships without the half-built skill.
        extraPluginDirs: [
          resolveGlobalSkillsPlugin(app.getPath('userData')),
          loadMiniAppsEnabled() ? resolveStagingPack({ resourcesPath: this.resourcesPath })?.dir ?? null : null,
        ].filter((d): d is string => d !== null),
        planMode: opts.planMode,
        model: opts.model,
        effort: opts.effort,
        // Token rides the env (not argv) — referenced as ${KODA_BROKER_TOKEN} in the mcp-config.
        // apiMode/apiKey re-add the API credential only when the user chose API billing (env.ts gate).
        env:
          apiKey || inject
            ? { ...(apiKey ? { apiMode: true, apiKey } : {}), ...(inject ? { inject } : {}) }
            : undefined,
        // Drop the live handle + tear the broker down when the child exits (any cause). projectDirs
        // is NOT cleared here — recovery must survive a crash (cleared only on explicit dispose).
        onClose: (id) => this.handleClose(id),
      }
      const session = startClaudeSession((e) => this.forward(e), sessionOpts)
      this.sessions.set(session.id, session)
      this.projectDirs.set(session.id, cwd)
      this.lastActivityAt.set(session.id, Date.now())
      return { sessionId: session.id, cwd }
    } catch (err) {
      // Spawn failed after register — no child means onClose never fires, so the broker transport
      // would leak (and keep a live /mcp/<id> route). Undo both registrations explicitly.
      await this.broker.unregister(sessionId)
      removeSessionFromWindow(sessionId)
      throw err
    }
  }

  /** The API key to inject for a spawn, or null to bill the subscription. 'api' → always the key;
   *  'auto' → the key only while a confirmed plan-limit fallback window is still open; 'subscription' →
   *  never. A missing key always degrades to subscription (never fails the spawn). */
  private effectiveApiKey(engine: EngineId = 'claude'): string | null {
    if (engine === 'codex') {
      // Codex is a simple subscription↔api choice (no plan-limit auto-fallback in v1); its own key slot.
      return loadSettings().codexBillingMode === 'api' ? getApiKey('codex') : null
    }
    const mode = loadSettings().billingMode
    if (mode === 'subscription') return null
    if (mode === 'auto' && Date.now() / 1000 >= this.apiFallbackUntil) return null
    return getApiKey('claude')
  }

  /** Whether the API key is the effective credential for the next spawn right now (for the renderer's
   *  status chip + spend label). Per-engine — each bills a distinct provider account. */
  apiActive(engine: EngineId = 'claude'): boolean {
    return this.effectiveApiKey(engine) != null
  }

  /** 'auto' mode: the user confirmed continuing on the API key after hitting the plan limit. Mark the
   *  key effective until the rejected window resets. Sessions pick it up when they reattach next turn
   *  (the renderer drops them so the switch is immediate). */
  activateApiFallback(until: number): void {
    this.apiFallbackUntil = Math.max(this.apiFallbackUntil, until)
  }

  /**
   * Send a turn, taking a turn-boundary safety checkpoint FIRST so the pre-turn state has a
   * restore point before the engine can touch any file. Fail-soft: a safety-git hiccup is
   * logged but never strands the user's turn. This is the COARSE baseline; the per-tool
   * checkpoint (finer, broker-driven) is in the gate.
   */
  async sendTurn(
    sessionId: string,
    text: string,
    // Phone attachments ride in here too: image entries go inline to the engine; document entries
    // (non-`image/*` mediaType, csv/pdf — carrying their original `name`) are written to the
    // project's scratch folder and reach the engine as a path, same contract as the desktop
    // composer (store.send).
    images?: (TurnImage & { name?: string })[],
    // Where the turn came from. A 'remote' turn (the phone) never ran through the owner window's
    // dispatchTurn, so its user bubble has to be echoed into that window (below); a 'local' turn already
    // pushed its own optimistic bubble there, so echoing it would duplicate the message.
    origin: 'local' | 'remote' = 'local',
  ): Promise<void> {
    // Invariant enforced here, at the one point every turn (local AND remote) funnels through: the live
    // engine must be running the session's INTENDED model/effort/engine before the turn goes out. The
    // engine can't switch these on a live -p process, so if what we actually spawned with has drifted from
    // the intent — a pick that landed after spawn (the desktop reattaches lazily; a phone turn arrives here
    // directly), or a first spawn that never carried the pick — respawn on the intent first. Comparison,
    // not a remembered flag: `spawnedWith` is set only where the child truly launches, so no spawn path can
    // forget to mark a change. A turn can't start mid-turn (both surfaces block send while busy) and this
    // runs before `working` is set, so the --resume can't drop an in-flight turn or strand an approval.
    const cwd = this.projectDirs.get(sessionId)
    if (cwd && this.sessions.has(sessionId) && this.spawnDrifted(sessionId)) {
      const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
      const engineId = this.sessionEngines.get(sessionId) ?? 'claude'
      // Realign the actuals to the intent up front so a second turn racing in during the respawn sees no
      // drift and can't kick off a concurrent start() for the same id (dispose/spawn interleave = two
      // children, one broker route). start() overwrites spawnedWith with the real launch triple anyway.
      this.spawnedWith.set(sessionId, { model, effort, engineId })
      // Before the first turn there is no conversation to --resume, so a posture pick respawns FRESH under
      // the same id (freshPostureStale); once a conversation exists, reattach with --resume.
      const fresh = this.freshPostureStale.delete(sessionId)
      await this.start({
        ...(fresh ? { sessionId } : { resumeSessionId: sessionId }),
        cwd,
        model,
        effort,
        engineId,
        planMode: this.gate.getSessionMode(sessionId) === 'plan',
      })
    }
    const session = this.require(sessionId)
    this.lastActivityAt.set(sessionId, Date.now()) // float this session to the top of the launcher
    this.working.add(sessionId) // live "working" glyph the instant the turn is sent, before the first delta
    // Capture the human's turn into the replay log (engine events never echo the user's own prompt, so
    // an adopted phone transcript would otherwise be missing this half). Recorded before the response
    // events that follow, keeping the conversation order intact. Remote-attached sessions only.
    if (this.remoteAttached.has(sessionId)) {
      const entry: ReplayEntry = { type: 'RemoteUserTurn', sessionId, text: text || '(image)' }
      const logArr = this.remoteEventLog.get(sessionId)
      if (logArr) logArr.push(entry)
      else this.remoteEventLog.set(sessionId, [entry])
      // Only a REMOTE-origin turn needs echoing here. A local turn was sent from the owning desktop
      // window, which already pushed its own optimistic bubble via dispatchTurn — forwarding it back
      // would render the message twice (on the Mac, and on the phone, which reads the Mac's persisted
      // transcript). The log entry above is still recorded for both, keeping replay/adopt complete.
      if (origin === 'remote') {
        const owner = contextForSession(sessionId)
        if (owner) {
          // A window already OWNS this phone session — it was open on the project when the phone started
          // the session, so it adopted it EMPTY (before this first turn). The engine stream never echoes
          // the human's prompt, so without this the Mac transcript would miss the user bubble and the tab
          // would keep its "From your phone" default (main-side titleRemoteSession is skipped once owned,
          // to avoid racing the renderer's store writes). Forward the turn to that window ONLY — not the
          // remote sinks, since the sending phone already shows its own optimistic bubble — and let the
          // renderer append it and run first-turn titling through its own persist path.
          const win = owner.win
          if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.sessionRemoteUserTurn, { sessionId, text })
        } else if (cwd) {
          // Still windowless — no renderer to name it. Title on the engine turn path (instant first-words
          // title, then the on-device refinement), persisted into the store the phone reads from.
          this.titleRemoteSession(sessionId, cwd, text)
        }
      }
    }
    // Label the checkpoint with the prompt text; fall back when it's an image-only turn.
    if (cwd) {
      await this.runExclusive(cwd, () => this.safeCheckpoint(cwd, text || '(image)'))
      // Pin the live-edits diff baseline to the pre-turn tree (HEAD right after the turn checkpoint).
      // Fail-soft: no baseline ⇒ diffFile falls back to live HEAD.
      const sha = await headSha(cwd).catch(() => null)
      if (sha) this.diffBaselines.set(sessionId, sha)
    }
    // Split document attachments out of a phone turn: save each to `.koda/scratch/` and hand the
    // engine the path (attachedFilesNote — the same note the desktop composer appends), leaving only
    // real images to go inline. Best-effort like the desktop: a failed save just drops off the list.
    const docs = images?.filter((i) => !i.mediaType.startsWith('image/')) ?? []
    const inline = docs.length ? images?.filter((i) => i.mediaType.startsWith('image/')) : images
    let engineText = text
    if (docs.length && cwd) {
      const saved = await Promise.all(
        docs.map((d) =>
          saveScratchImage(cwd, d.mediaType, d.dataBase64, loadScratchRetentionDays(), d.name).catch(() => null),
        ),
      )
      const paths = saved.filter((p): p is string => p !== null)
      if (paths.length) engineText = `${engineText}\n\n${attachedFilesNote(paths)}`
    }
    // Ride any finished background-workflow results in ahead of the human's words, framed as context so
    // the agent picks up where it left off. Only what the ENGINE sees is augmented — the user's visible
    // bubble, replay entry, checkpoint label and titling above all use the untouched `text`.
    const pending = this.drainWorkflowResults(sessionId)
    session.sendTurn(
      pending ? (engineText ? `${pending}\n\n${engineText}` : pending) : engineText,
      inline?.length ? inline : undefined,
    )
  }

  /** A finished workflow's result, stashed until this session's next human turn delivers it inline. */
  private stashWorkflowResult(sessionId: string, resultText: string): void {
    const arr = this.pendingWorkflowResults.get(sessionId)
    if (arr) arr.push(resultText)
    else this.pendingWorkflowResults.set(sessionId, [resultText])
  }

  /** Take and clear any pending workflow results for a session (joined newest-launched-last). */
  private drainWorkflowResults(sessionId: string): string {
    const arr = this.pendingWorkflowResults.get(sessionId)
    if (!arr || arr.length === 0) return ''
    this.pendingWorkflowResults.delete(sessionId)
    return arr.join('\n\n')
  }

  /** The pinned live-edits diff baseline for a session (safety-git SHA at the current turn's start),
   *  or undefined before the first turn / if the checkpoint couldn't be read. */
  getDiffBaseline(sessionId: string): string | undefined {
    return this.diffBaselines.get(sessionId)
  }

  /** The cwd a session runs in — its safety-git root, and the correct base for resolving/diffing the
   *  files it edits. A background session (or one launched in another folder) can differ from the
   *  window's project root, so a diff MUST resolve against this, not the sender window. */
  getSessionCwd(sessionId: string): string | undefined {
    return this.projectDirs.get(sessionId)
  }

  /**
   * Checkpoint the project tree before a USER edit (the Files editor's save), so a manual edit is
   * recoverable exactly like an engine tool write — and so an edit that clobbers a file Claude just
   * touched can still be undone (the dual-git safety net, ui-workspace.md §4 apply-handler). Keyed by
   * the project dir directly (a user edit isn't tied to a session — the Files browser works with
   * none); serialized through the same per-dir mutex as every other safety-git write.
   */
  async checkpointProjectEdit(cwd: string, label: string): Promise<boolean> {
    return this.runExclusive(cwd, () => this.safeCheckpoint(cwd, label))
  }

  /** The gate's per-tool checkpoint (completes before an `allow` returns to the engine). */
  private async checkpointForSession(sessionId: string, label: string): Promise<boolean> {
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return false
    return this.runExclusive(cwd, () => this.safeCheckpoint(cwd, label))
  }

  /** Take one checkpoint, fail-soft. Returns false if it couldn't be taken (caller surfaces it). */
  private async safeCheckpoint(cwd: string, label: string): Promise<boolean> {
    try {
      if (!this.ensured.has(cwd)) {
        await ensureRepo(cwd)
        this.ensured.add(cwd)
        this.scheduleMaintenance(cwd)
      }
      const result = await checkpoint(cwd, label)
      // Humanize this checkpoint's timeline label in the background (non-blocking), so it's ready
      // before anyone opens the timeline. Only 'moment' points (turn/edit — labelled from the user's
      // own words) are worth it and shown; per-tool 'step' snapshots are hidden, and their thin
      // "before Edit: …" text is exactly what the on-device model flattens to "Editing the file"
      // — so never spend a model call on them. Skip a no-op checkpoint too (its `id` is the
      // PRIOR commit, already humanized under its own prompt).
      if (checkpointKind(result.label) === 'moment') {
        if (!result.skipped) humanizeCheckpointLabel(result.id, result.label)
        // Cloud backup/replica ride the same turn boundary: debounced, flag-gated, fire-and-forget —
        // noteMomentCheckpoint only arms a timer, so the turn path never waits on the network.
        // Armed even when the checkpoint was a no-op: a doc save checkpoints the PRE-edit tree, so
        // "skipped" is exactly the hand-edit-right-after-a-turn case — the edit itself still needs
        // to reach the cloud copy.
        noteMomentCheckpoint(cwd)
      }
      return true
    } catch (err) {
      log.error('safety-git', 'checkpoint failed (proceeding)', err instanceof Error ? err.message : err)
      return false
    }
  }

  /**
   * Kick off background retention (one-time migrate + due-based prune) once per project per app run,
   * off the hot path and serialized through the same per-dir mutex so it can't race a checkpoint or
   * restore. Deferred a few seconds so the first turn's diff baseline settles first. maintainStore is
   * itself fail-safe; the extra catch guards the scheduling.
   *
   * A migrate/thin rewrite re-SHAs the master tip and gc's the old object — which would strand a live
   * session's `diffBaselines` SHA (pinned to that tip at turn start) and break its live-edits diff for
   * the rest of the turn. So re-pin those baselines through the rewrite's original→final remap: the
   * in-memory baseline is exactly the "SHA held across a rewrite" that prune.ts's contract says must
   * be re-resolved rather than trusted.
   */
  private scheduleMaintenance(cwd: string): void {
    setTimeout(() => {
      void this.runExclusive(cwd, async () => {
        const remap = await maintainStore(cwd)
        if (remap.size === 0) return
        for (const [sessionId, base] of this.diffBaselines) {
          const mapped = remap.get(base)
          if (mapped && this.projectDirs.get(sessionId) === cwd) {
            this.diffBaselines.set(sessionId, mapped)
          }
        }
      }).catch(() => {})
    }, 5_000)
  }

  /** Serialize work on one project dir (the safety.git index can't take concurrent writers). */
  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.checkpointChains.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn) // run regardless of the prior task's outcome
    this.checkpointChains.set(key, run.then(noop, noop))
    return run
  }

  // ── Approval gate surface (delegated from IPC) ──────────────────────────────
  resolveApproval(requestId: string, decision: ToolDecision): void {
    this.gate.resolve(requestId, decision)
  }
  /** Set ONE session's posture (per-session, ui-workspace.md §7a). The renderer owns persistence
   *  (it's saved in the session blob and re-pushed on reattach), so the gate just caches it. A real
   *  change is broadcast as ApprovalModeChanged so the OTHER surface follows (desktop pill ↔ phone
   *  sheet) — the echo back to the changer is a same-value no-op, which is also what stops the loop
   *  (renderer applies → re-pushes here → unchanged → no second event). */
  setSessionApprovalMode(sessionId: string, mode: ApprovalMode): void {
    const prev = this.gate.getSessionMode(sessionId)
    // Always pin the explicit per-session entry (a same-value push still matters: the post-restart
    // re-push pins the session against later default-mode changes) — but only a real change broadcasts.
    this.gate.setSessionMode(sessionId, mode)
    if (prev === mode) return
    this.forward({ type: 'ApprovalModeChanged', sessionId, mode })
    // Crossing the plan boundary needs a respawn (`--permission-mode plan` is spawn-time). A windowed
    // session's renderer does that itself when the event lands; a WINDOWLESS one (phone-started, or its
    // window closed) has no renderer — respawn here, the same eager --resume the remote model change
    // uses. The phone blocks this while a turn runs (same client-side guard as model/effort).
    const crossesPlan = (mode === 'plan') !== (prev === 'plan')
    // Before the first turn there's no conversation to --resume; the eager reattach would race the fresh
    // child's init and fatal. The gate mode is already pinned above, and sendTurn applies plan on the
    // first turn's spawn — so skip the respawn until a conversation exists.
    const conversationStarted =
      !!this.projectDirs.get(sessionId) &&
      (this.engineNativeIds.has(sessionId) || claudeConversationExists(this.projectDirs.get(sessionId)!, sessionId))
    if (crossesPlan && conversationStarted && !contextForSession(sessionId) && this.sessions.has(sessionId)) {
      const cwd = this.projectDirs.get(sessionId)
      if (!cwd) return
      const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
      const engineId = this.sessionEngines.get(sessionId) ?? 'claude'
      void this
        .start({ resumeSessionId: sessionId, cwd, planMode: mode === 'plan', model, effort, engineId })
        .catch((err) =>
          log.warn('engine', 'plan-mode respawn failed', err instanceof Error ? err.message : err),
        )
    }
  }
  /** Read ONE session's current posture — so a remote head can show + set the same control the local
   *  window has (remote-control-security.md §4 — remote inherits local policy exactly). */
  getSessionApprovalMode(sessionId: string): ApprovalMode {
    return this.gate.getSessionMode(sessionId)
  }

  /** The model/effort a session currently runs with (for the remote head's pickers). */
  getSessionModelEffort(sessionId: string): { model?: string; effort?: string; activeModel?: string } {
    return { ...this.sessionModelEffort.get(sessionId), activeModel: this.resolvedModels.get(sessionId) }
  }

  /** True when the live child's actual spawn triple no longer matches the session's intended one — i.e.
   *  a turn sent now would run on the wrong model/effort/engine. `undefined` spawnedWith (never spawned
   *  by us) can't drift. Normalises '' / undefined to one "engine default" so a Default pick doesn't read
   *  as a change, and defaults the engine to 'claude' on both sides. */
  private spawnDrifted(sessionId: string): boolean {
    const actual = this.spawnedWith.get(sessionId)
    if (!actual) return false
    const intent = this.sessionModelEffort.get(sessionId) ?? {}
    const intendedEngine = this.sessionEngines.get(sessionId) ?? 'claude'
    return (
      (actual.model || undefined) !== (intent.model || undefined) ||
      (actual.effort || undefined) !== (intent.effort || undefined) ||
      (actual.engineId || 'claude') !== intendedEngine
    )
  }

  /** Sessions blocked on a human answer right now — the phone launcher's "Needs you" triage. */
  remotePendingApprovals(): Record<string, { count: number; oldestAt: number }> {
    return this.gate.pendingBySession()
  }

  /** The full pending prompts for one session, so a phone opening a session the agent already blocked
   *  on can rebuild the approval/question card (the live push already fired before it connected). */
  remotePendingRequests(sessionId: string): ApprovalRequest[] {
    return this.gate.pendingRequests(sessionId)
  }

  /** Latest account rate-limit windows per engine — the phone sheet's usage readout at browse level
   *  (the same snapshot that seeds a joining chat's meters, without needing a session). */
  remoteRateLimits(): Record<string, Record<string, RateLimitInfo>> {
    return Object.fromEntries(this.lastRateLimits)
  }

  /** Record a session's model/effort intent — the chokepoint both surfaces' picks route through
   *  (mirrors setSessionApprovalMode). Updates the map remote heads hydrate from, and a REAL change
   *  broadcasts ModelEffortChanged so the other surface follows immediately; the echo back to the
   *  changer is a same-value no-op, which is also what stops the loop. Does NOT respawn — the desktop
   *  reattaches lazily on its next turn, and the remote path respawns itself (changeSessionModelEffort). */
  setSessionModelEffort(sessionId: string, opts: { model?: string; effort?: string; engineId?: EngineId }): void {
    const model = opts.model || undefined // '' from a picker means "engine default"
    const effort = opts.effort || undefined
    const prev = this.sessionModelEffort.get(sessionId) ?? {}
    const prevEngine = this.sessionEngines.get(sessionId)
    const engineId = opts.engineId ?? prevEngine
    this.sessionModelEffort.set(sessionId, { model, effort })
    if (opts.engineId) this.sessionEngines.set(sessionId, opts.engineId)
    // Crossing engines invalidates the reported model — the new engine's default is unknown until it
    // spawns and reports its own (mirrors the desktop store dropping activeModel on an engine switch).
    if (opts.engineId && prevEngine && opts.engineId !== prevEngine) this.resolvedModels.delete(sessionId)
    // Remember this pick as the app-wide last-used posture so the next NEW session (notably the phone's
    // headless start, which has no renderer copy) opens on it instead of the engine default.
    saveLastPosture({ model, effort, engineId: engineId ?? 'claude' })
    if (prev.model === model && prev.effort === effort && (prevEngine ?? 'claude') === (engineId ?? 'claude')) return
    // Intent now diverges from the live child's `spawnedWith`; sendTurn reconciles it before the next turn
    // (no flag to set — the comparison sees the difference on its own).
    // A WINDOWLESS session has no renderer to persist the new pair, so a Mac restart would resurrect
    // the old one — upsert it into the project store here (same reason + same window guard + same
    // resumed-id resolution as persistRemoteTitle; a windowed session's renderer owns the blob, and
    // writing would race it). The Codex thread id rides along so a post-restart resume finds its thread.
    const cwd = this.projectDirs.get(sessionId)
    if (cwd && !contextForSession(sessionId)) {
      const storeId = this.resumedFrom.get(sessionId) ?? sessionId
      const store = loadProjectSessions(cwd) ?? { version: 2 as const, activeId: null, sessions: [] }
      let stored = store.sessions.find((s) => s.id === storeId)
      if (!stored) {
        stored = { id: storeId, label: this.sessionLabel(sessionId, cwd), cwd, userNamed: false, items: [] }
        store.sessions.push(stored)
      }
      stored.model = model
      stored.effort = effort
      if (opts.engineId) stored.engineId = opts.engineId
      const nativeId = this.engineNativeIds.get(sessionId)
      if (nativeId) stored.engineNativeId = nativeId
      saveProjectSessions(cwd, store)
    }
    this.forward({
      type: 'ModelEffortChanged',
      sessionId,
      model,
      effort,
      ...(opts.engineId && opts.engineId !== prevEngine ? { engineId: opts.engineId } : {}),
    })
  }

  /** The user's recently-used model ids — the same source the local picker offers (no hardcoded list). */
  recentModels(): string[] {
    return loadRecentModels()
  }

  /** Codex models the account can use, for the model picker's OpenAI group (engine owns the list — no
   *  hardcoded models). Empty when not signed in / no codex binary. One-shot probe (codex-auth.ts). */
  codexModels(): Promise<CodexModel[]> {
    return listCodexModels({ resourcesPath: this.resourcesPath })
  }

  /** Codex sign-in state for the picker + Settings (chatgpt = active subscription). */
  codexAuthStatus(): Promise<CodexAuthStatus> {
    return getCodexAuthStatus({ resourcesPath: this.resourcesPath })
  }

  /** Change a session's model and/or effort from a remote head. The engine can't switch either on a
   *  live -p process, so this reattaches via --resume with the new pair (same as the local picker's
   *  respawn). Pass the FULL desired pair — both are applied, so neither resets to default. Caller
   *  should avoid this mid-turn (the respawn would drop an in-flight turn); the remote client gates it. */
  async changeSessionModelEffort(sessionId: string, opts: { model?: string; effort?: string; engineId?: EngineId }): Promise<void> {
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) throw new Error(`unknown session: ${sessionId}`)
    const engineId = opts.engineId ?? this.sessionEngines.get(sessionId) ?? 'claude'
    // Engine is locked once the conversation starts (context lives in the engine's process/store —
    // switching would silently strand it). The desktop enforces this in its picker; enforce it here
    // for remote heads too, since main is the authority. Conversation-started = a Codex thread id
    // exists, or Claude has the conversation on disk.
    const prevEngine = this.sessionEngines.get(sessionId) ?? 'claude'
    // A Codex thread id is NOT proof of a conversation: Codex creates the thread during fresh-session
    // initialization, before the first user turn. Treating that id as content locked every phone-started
    // Codex session to Codex before the user typed anything. Real content is a sent turn, a replayed phone
    // turn, persisted renderer items, or Claude's on-disk conversation.
    const storeId = this.resumedFrom.get(sessionId) ?? sessionId
    const stored = loadProjectSessions(cwd)?.sessions.find((s) => s.id === storeId)
    const conversationStarted =
      this.working.has(sessionId) ||
      this.remoteEventLog.get(sessionId)?.some((e) => e.type === 'RemoteUserTurn') === true ||
      Boolean(stored?.items?.length) ||
      (prevEngine === 'claude' && claudeConversationExists(cwd, storeId))
    if (engineId !== prevEngine && conversationStarted)
      throw new Error('the engine is locked once a conversation has started — start a new chat to switch')
    // Record + broadcast FIRST so the desktop's pill/persisted pick follows the phone's change (else its
    // next reattach would silently revert this respawn to the old pair). This updates the intent, so the
    // live child's spawnedWith now diverges — sendTurn reconciles it on the next turn.
    this.setSessionModelEffort(sessionId, { ...opts, engineId })
    // A brand-new session (picking a model before sending) has no conversation to reattach to — an eager
    // `--resume` would race the fresh child's init and fatal with "No conversation found", killing the
    // session. The intent update above makes the first turn spawn FRESH on this pair, so just record and return.
    if (!conversationStarted) {
      this.freshPostureStale.add(sessionId)
      return
    }
    await this.start({ resumeSessionId: sessionId, cwd, model: opts.model || undefined, effort: opts.effort || undefined, engineId })
  }
  /** The default posture new sessions start at (the renderer seeds its per-session default from this). */
  getApprovalMode(): ApprovalMode {
    return this.gate.getDefaultMode()
  }
  /** Change the live default posture (from the Settings pane). Persistence is the settings file's job
   *  (the IPC handler writes it); this just updates the gate so new sessions in already-open windows
   *  start in the new mode without a restart. */
  setDefaultApprovalMode(mode: ApprovalMode): void {
    this.gate.setDefaultMode(mode)
  }
  /** Update whether the preview server may auto-start without a confirm (from the Settings pane). */
  setPreviewAutoStart(on: boolean): void {
    this.gate.setPreviewAutoStart(on)
  }

  // ── Remote Control surface (remote-control-security.md, Phase 0) ──────────────
  /** Register (or clear, with null) the remote fan-out sink. The remote server owns subscription
   *  routing; this just forwards every event/approval to it. Setting it does NOT enable anything on
   *  its own — sessions stay window-bound until a remote client attaches. */
  /** Register a transport sink; returns a disposer that removes just this one. */
  addRemoteSink(sink: (channel: string, sessionId: string, payload: unknown) => void): () => void {
    this.remoteSinks.add(sink)
    return () => {
      this.remoteSinks.delete(sink)
    }
  }

  /** A remote client attached to this session → keep it alive headless past its window's close. */
  attachRemote(sessionId: string): void {
    this.remoteAttached.add(sessionId)
  }

  /** Live sessions a remote client can pick: id + project dir + the session's human title.
   *  `lastActivityAt` (epoch ms, 0 = no turn yet) rides along so the phone can show ages + day-group. */
  remoteSessionList(): { id: string; cwd: string; label: string; engineId: EngineId; lastActivityAt: number; lastLine?: string }[] {
    return [...this.sessions.keys()]
      .sort((a, b) => (this.lastActivityAt.get(b) ?? 0) - (this.lastActivityAt.get(a) ?? 0))
      .map((id) => {
        const cwd = this.projectDirs.get(id) ?? ''
        return {
          id,
          cwd,
          label: this.sessionLabel(id, cwd),
          engineId: this.sessionEngines.get(id) ?? 'claude',
          lastActivityAt: this.lastActivityAt.get(id) ?? 0,
          lastLine: this.lastLines.get(id),
        }
      })
  }

  /** Is a turn in flight for this session right now? Drives the remote launcher's live working glyph. */
  isWorking(sessionId: string): boolean {
    return this.working.has(sessionId)
  }

  /** A live session's human title — the on-device auto-title or the user's rename, from the persisted
   *  store (the same source `remoteHistory` trusts). Falls back to the project folder only when there's
   *  no title yet (a session before its first turn). A remote-resumed session's live id differs from the
   *  stored one, so fall back through `resumedFrom`. */
  private sessionLabel(id: string, cwd: string): string {
    const storedId = this.resumedFrom.get(id) ?? id
    const label = loadProjectSessions(cwd)?.sessions.find((s) => s.id === storedId)?.label?.trim()
    return label || basename(cwd) || 'Session'
  }

  /** First-turn auto-titling for a headless (phone-started) session. Titling normally lives in the
   *  renderer's dispatch path, but a phone session runs windowless — no renderer ever names it, so its
   *  label would stay the project-folder fallback. Mirror the desktop's two stages here on the engine
   *  turn path: the instant first-words title, then the on-device-model refinement ~300ms later. Both
   *  persist to the per-project store, which the phone's session list + history read from. Runs once per
   *  session (a resumed or already-named session is left alone); the caller only invokes it while the
   *  session is windowless, so the store writes can't race the renderer's whole-blob persistence. */
  private titleRemoteSession(sessionId: string, cwd: string, text: string): void {
    if (this.remoteTitled.has(sessionId)) return
    const clean = text.trim()
    if (!clean) return // image-only turn — let the next text turn name it
    const storedId = this.resumedFrom.get(sessionId) ?? sessionId
    const stored = loadProjectSessions(cwd)?.sessions.find((s) => s.id === storedId)
    // Already named (a resumed past session, or a restart-resume) — never re-title.
    if (stored?.label?.trim() || stored?.userNamed) {
      this.remoteTitled.add(sessionId)
      return
    }
    this.remoteTitled.add(sessionId)
    this.persistRemoteTitle(cwd, storedId, titleFromPrompt(clean))
    // Fire-and-forget on-device upgrade; never blocks the turn, never throws. Skip once a window has
    // adopted the session (its renderer owns the label then) so the write can't race the renderer.
    void assistTitle(clean)
      .then((title) => {
        if (title.trim() && !contextForSession(sessionId)) this.persistRemoteTitle(cwd, storedId, title.trim())
      })
      .catch(() => {})
  }

  /** Write a headless session's auto-title into its project store — the source the phone's session list
   *  and history read labels from. Upserts a minimal entry when the renderer hasn't persisted this
   *  (windowless) session, updates the label in place otherwise. Never clobbers a user rename. */
  private persistRemoteTitle(cwd: string, storedId: string, label: string): void {
    const store = loadProjectSessions(cwd) ?? { version: 2 as const, activeId: null, sessions: [] }
    const existing = store.sessions.find((s) => s.id === storedId)
    if (existing?.userNamed) return
    if (existing) existing.label = label
    else store.sessions.push({ id: storedId, label, cwd, userNamed: false, items: [] })
    saveProjectSessions(cwd, store)
  }

  // ── Remote launcher: start-new / resume-old from the phone (no desktop window) ────────────────────
  // The phone is a full control head, not an attach-only viewer (otherwise it's strictly worse than
  // Anthropic's /remote-control). These wrap the SAME windowless `start()` path the desktop uses; the
  // only new trust rule is that a phone-supplied path/id must match a known recent project — the phone
  // can never name an arbitrary directory to spawn an agent in.

  /** Recent projects the phone may start a new session in (most-recent-first, existing dirs only). */
  recentProjectsForRemote(): { path: string; name: string }[] {
    return loadAppState()
      .recentProjects.filter((p) => existsSync(p))
      .map((p) => ({ path: p, name: basename(p) || p }))
  }

  /** Resumable past sessions across recent projects — id + human label + which project. Excludes any
   *  session that's already live (those appear in the running list, not as a resume target) and any
   *  whose engine-side conversation is gone — Koda's store outlives the engine's (cleanup, sessions
   *  that died before their first turn), and offering one produces `--resume` → "No conversation
   *  found" → a fatal engine error on the phone. */
  remoteHistory(): { id: string; label: string; projectPath: string; projectName: string; updatedAt: number }[] {
    const out: { id: string; label: string; projectPath: string; projectName: string; updatedAt: number }[] = []
    for (const p of loadAppState().recentProjects) {
      const stored = loadProjectSessions(p)
      if (!stored) continue
      for (const s of stored.sessions) {
        if (this.sessions.has(s.id)) continue // already running → shown under "running", not "resume"
        if ((s.engineId ?? 'claude') === 'claude' && !claudeConversationExists(s.cwd || p, s.id)) continue
        // Real last-activity: the conversation file's mtime (0 for Codex, which keeps stored order).
        // Kept in the payload — the phone day-groups its Sessions list by it.
        out.push({ id: s.id, label: s.label, projectPath: p, projectName: basename(p) || p, updatedAt: claudeConversationMtime(s.cwd || p, s.id) })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Start a NEW headless session in a recent project and attach the remote head. Refuses any path
   *  that isn't a known recent project (the phone can't spawn an agent in an arbitrary directory). */
  async startNewRemote(projectPath: string): Promise<{ sessionId: string }> {
    if (!this.recentProjectsForRemote().some((r) => r.path === projectPath)) throw new Error('unknown project')
    // Open on the last-used model/effort/engine (the phone has no renderer to seed this the way the
    // desktop does), so a new session isn't stuck on the engine default. A fresh spawn — not a --resume —
    // so it carries the pair with no conversation to reattach to. Fail-soft: a stale posture (e.g. a
    // last-used Codex that's since signed out) must never block a new session, so fall back to a bare
    // default rather than surfacing "couldn't start" on the phone.
    const last = loadLastPosture()
    let started: { sessionId: string }
    try {
      started = await this.start({ cwd: projectPath, model: last.model, effort: last.effort, engineId: last.engineId })
    } catch (err) {
      log.warn('sessions', 'seeded new-session start failed; retrying bare', err instanceof Error ? err.message : err)
      started = await this.start({ cwd: projectPath })
    }
    const { sessionId } = started
    this.attachRemote(sessionId)
    this.notifyDesktopOfHeadless(projectPath) // if this project is open on the Mac, let it adopt this live
    return { sessionId }
  }

  /** Resume a PAST session (--resume) headless and attach the remote head. Both id and project must
   *  match a known recent project's history. The phone won't have the prior transcript locally — the
   *  engine keeps the conversation context regardless; the next turn continues it. */
  async resumeRemote(sessionId: string, projectPath: string): Promise<{ sessionId: string }> {
    if (!this.remoteHistory().some((h) => h.id === sessionId && h.projectPath === projectPath))
      throw new Error('unknown session')
    // Resume with the pair the session was last running (persisted by the desktop) — without it the
    // respawn silently falls back to the account default model and clobbers the intent map.
    const stored = loadProjectSessions(projectPath)?.sessions.find((s) => s.id === sessionId)
    const { sessionId: id } = await this.start({
      resumeSessionId: sessionId,
      cwd: projectPath,
      model: stored?.model,
      effort: stored?.effort,
      engineId: stored?.engineId,
      engineNativeId: stored?.engineNativeId,
    })
    this.attachRemote(id)
    if (id !== sessionId) this.resumedFrom.set(id, sessionId) // so the phone can load the prior transcript
    // Seed the replay buffer with the prior history when the store holds no transcript (a headless
    // session's items are never persisted). Without this, the first turn after a resume makes the
    // buffer non-empty, so remoteTranscript's file fallback stops firing and a reopen would show ONLY
    // the new turn. Seeding happens before the resumed engine emits anything, so nothing can double.
    if (!stored?.items?.length && (stored?.engineId ?? 'claude') === 'claude') {
      const seed = readClaudeConversationReplay(stored?.cwd || projectPath, sessionId, id)
      if (seed.length) this.remoteEventLog.set(id, seed)
    }
    this.notifyDesktopOfHeadless(projectPath) // if this project is open on the Mac, let it adopt this live
    return { sessionId: id }
  }

  /** Archive a PAST session from the phone — the same recoverable move the desktop's sidebar kebab makes
   *  (into the store's `archived` list, surfaced in Settings → Archived sessions). History-only by the
   *  same trust rule as resumeRemote: a live session never appears in remoteHistory, so it can't be
   *  archived out from under a running turn. Two write paths because the store has two owners: while a
   *  window has the project open its renderer holds the whole blob in memory and rewrites it constantly —
   *  a direct file write here would be clobbered — so we forward the request and let the renderer archive
   *  (which also closes the tab). Windowless projects are main's to write directly (persistRemoteTitle's
   *  rule). */
  async archiveRemote(sessionId: string, projectPath: string): Promise<void> {
    // A LIVE session (the ⋯ sheet's "Archive session"): end it, then archive its stored entry — the
    // desktop's same move (its sidebar archive also closes the tab). Windowed sessions forward to the
    // renderer, which owns the store AND the tab; headless ones are main's to end + write directly.
    if (this.sessions.has(sessionId)) {
      const cwd = this.remoteCwd(sessionId)
      if (projectPath && realpathOrSelf(projectPath) !== realpathOrSelf(cwd)) throw new Error('unknown session')
      const win = windowForProject(realpathOrSelf(cwd))
      if (win && !win.isDestroyed()) {
        win.webContents.send(IpcChannels.sessionArchiveRequested, { sessionId })
        return
      }
      const storedId = this.resumedFrom.get(sessionId) ?? sessionId
      const label = this.sessionLabel(sessionId, cwd) // read before dispose (it needs the live maps)
      await this.dispose(sessionId)
      const store = loadProjectSessions(cwd) ?? { version: 2 as const, activeId: null, sessions: [] }
      // A headless session may have no persisted entry yet (its transcript lives in the replay log) —
      // archive a minimal one so it still lands in Settings → Archived sessions.
      const session = store.sessions.find((s) => s.id === storedId) ?? { id: storedId, label, cwd, userNamed: false, items: [] }
      saveProjectSessions(cwd, {
        ...store,
        activeId: store.activeId === storedId ? null : store.activeId,
        sessions: store.sessions.filter((s) => s.id !== storedId),
      })
      ingestFullArchives(cwd, [{ ...session, archivedAt: Date.now() }])
      return
    }
    if (!this.remoteHistory().some((h) => h.id === sessionId && h.projectPath === projectPath))
      throw new Error('unknown session')
    const win = windowForProject(realpathOrSelf(projectPath))
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannels.sessionArchiveRequested, { sessionId })
      return
    }
    const store = loadProjectSessions(projectPath)
    const session = store?.sessions.find((s) => s.id === sessionId)
    if (!store || !session) throw new Error('unknown session')
    saveProjectSessions(projectPath, {
      ...store,
      activeId: store.activeId === sessionId ? null : store.activeId,
      sessions: store.sessions.filter((s) => s.id !== sessionId),
    })
    // Archives live in their own cold store now (metadata index + split-out body) — never in the hot
    // store above.
    ingestFullArchives(projectPath, [{ ...session, archivedAt: Date.now() }])
  }

  /** Rename a live session from the phone — the desktop right-click's same move. Two write paths (the
   *  store's two-owner rule, same as archiveRemote): a windowed project's renderer owns the blob, so
   *  main forwards and the renderer renames (by the LIVE id it knows the session as); a windowless
   *  session is main's to write directly under its stored id. `userNamed` locks the label against the
   *  auto-titler on both paths. */
  renameRemote(sessionId: string, name: string): void {
    const label = name.trim()
    if (!label) throw new Error('name required')
    const cwd = this.remoteCwd(sessionId) // throws on an unknown / not-live session
    const win = windowForProject(realpathOrSelf(cwd))
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannels.sessionRenameRequested, { sessionId, name: label })
      return
    }
    const storedId = this.resumedFrom.get(sessionId) ?? sessionId
    const store = loadProjectSessions(cwd) ?? { version: 2 as const, activeId: null, sessions: [] }
    const existing = store.sessions.find((s) => s.id === storedId)
    if (existing) {
      existing.label = label
      existing.userNamed = true
    } else store.sessions.push({ id: storedId, label, cwd, userNamed: true, items: [] })
    saveProjectSessions(cwd, store)
  }

  // ── Desktop adoption of headless (phone-started) sessions ─────────────────────────────────────────
  // A session the phone starts runs windowless on the Mac (start() with no owning window), so the
  // desktop can't see it even though it's alive. Adoption closes that gap: the desktop lists these live
  // sessions and pulls one into a window — routing its future events there AND replaying its buffered
  // history so the conversation appears exactly as a local one would.

  /** Append to a remote-attached session's replay log. Called for every forwarded event; a no-op for
   *  any session no phone has attached to (the common local case), so it costs nothing there. Streaming
   *  deltas are dropped — they're ephemeral and the finalized AssistantBlock re-carries the full text. */
  private bufferRemoteEvent(event: EngineEvent): void {
    if (!this.remoteAttached.has(event.sessionId)) return
    if (event.type === 'AssistantDelta' || event.type === 'ThinkingDelta') return
    const logArr = this.remoteEventLog.get(event.sessionId)
    if (logArr) logArr.push(event)
    else this.remoteEventLog.set(event.sessionId, [event])
  }

  /** Nudge the desktop window already open for `projectPath` (if any) to adopt this project's live
   *  headless sessions. Fire-and-forget: no window open ⇒ the session stays headless until the user
   *  opens the project, at which point the renderer adopts it via `adoptHeadlessForWindow`. */
  private notifyDesktopOfHeadless(projectPath: string): void {
    const win = windowForProject(realpathOrSelf(projectPath))
    if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.headlessAppeared, { projectPath })
  }

  /** Live headless (phone-started, windowless) sessions in `projectPath` that no window owns yet, and
   *  claim them for `windowId` so their future events route there. Returns each session's identity plus
   *  its full replayable event history — the renderer builds the transcript by feeding the events
   *  through its normal reducer. Registering ownership and snapshotting the log happen together in this
   *  one synchronous pass, so no event can slip into the gap: anything forwarded after this returns is
   *  sent to the window (now the owner) AFTER the renderer has the snapshot. Already-owned sessions are
   *  skipped (idempotent — safe to call on every boot + every `headlessAppeared`). */
  adoptHeadlessForWindow(windowId: number, projectPath: string): AdoptedHeadlessSession[] {
    const root = realpathOrSelf(projectPath)
    const out: AdoptedHeadlessSession[] = []
    for (const id of this.sessions.keys()) {
      if (!this.remoteAttached.has(id)) continue
      if (contextForSession(id)) continue // already owned by a window (this one or another)
      if (realpathOrSelf(this.projectDirs.get(id) ?? '') !== root) continue
      addSessionToWindow(windowId, id)
      out.push({
        id,
        cwd: this.projectDirs.get(id) ?? projectPath,
        engineId: this.sessionEngines.get(id) ?? 'claude',
        model: this.sessionModelEffort.get(id)?.model,
        events: [...(this.remoteEventLog.get(id) ?? [])],
      })
    }
    return out
  }

  /** The persisted rendered transcript (renderer Entry[], opaque to main) for a session the phone opened,
   *  so a resumed/joined chat shows its prior messages instead of starting blank. Resolves a resumed
   *  session's new id back to the original stored id. Also carries a usage snapshot (context fill, spend,
   *  account windows) so the phone's meters read correctly on join instead of blank-until-next-turn.
   *  Empty when nothing is on disk for it. */
  remoteTranscript(sessionId: string): { items: unknown[]; usage: RemoteUsageSnapshot; events?: ReplayEntry[] } {
    const storeId = this.resumedFrom.get(sessionId) ?? sessionId
    // Read only the OWNING project's store, not every recent project's. The phone can only open a session
    // that's attached/running, so its cwd is known — go straight there instead of parsing unrelated
    // (also multi-MB) stores. Fall back to a scan if it's somehow not in the live list. `readPersistedSession`
    // skips the whole-store Zod validation that made this ~2.6s per open (see its note).
    const cwd = this.remoteSessionList().find((s) => s.id === sessionId)?.cwd
    let found = cwd ? readPersistedSession(cwd, storeId) : null
    if (!found) {
      for (const p of loadAppState().recentProjects) {
        found = readPersistedSession(p, storeId)
        if (found) break
      }
    }
    const engine = this.sessionEngines.get(sessionId) ?? found?.engineId ?? 'claude'
    const items = found?.items ?? []
    // A headless (phone-started, or Mac-adopted-then-window-closed) session is never persisted by a
    // renderer, so its `items` are empty even though it has a full history. Fall back to the live replay
    // buffer — the same per-session event log the Mac desktop adopts through — which the phone reduces
    // into a transcript exactly like the live stream. Keyed by the LIVE id (the log is never remapped).
    let events = items.length ? undefined : this.remoteEventLog.get(sessionId)
    // The replay buffer is in-memory, so a Mac relaunch wipes it — a phone-driven session then opened
    // to a blank "Ready" screen with its whole history sitting in the engine's own conversation file.
    // Last resort: rebuild the events from that file (claude only; Codex keeps its own store).
    if (!items.length && !events?.length && engine === 'claude') {
      const fileCwd = this.projectDirs.get(sessionId) ?? found?.cwd ?? cwd
      if (fileCwd) events = readClaudeConversationReplay(fileCwd, storeId, sessionId)
    }
    return {
      items,
      usage: {
        spendUsd: found?.spendUsd ?? 0,
        byModel: found?.byModel ?? {},
        context: found?.context,
        // All engines' windows, not just this session's — the plan panel labels them per engine, and
        // binding to the session's engine tag misattributed windows when that tag was stale/wrong.
        rateLimits: this.remoteRateLimits(),
      },
      ...(events?.length ? { events: [...events] } : {}),
    }
  }

  /** The Mac's daily usage rollup for the phone's Usage view — the same store the desktop Settings
   *  reads (usage:getHistory). Read-only, account-level. */
  usageHistory(): unknown[] {
    return loadUsageHistory()
  }

  /** The project dir a live session runs in — the anchor for every remote git operation (the phone
   *  names a session, never a path, so it can only reach projects it's already inside). */
  private remoteCwd(sessionId: string): string {
    const cwd = this.remoteSessionList().find((s) => s.id === sessionId)?.cwd
    if (!cwd) throw new Error('unknown session')
    return cwd
  }

  /** Working-tree changes of the session's project — the phone's Stage list. */
  async remoteChanges(
    sessionId: string,
  ): Promise<{ repo: boolean; files: unknown[]; truncated: boolean; hasPreview: boolean }> {
    // The Stage bar's other surface rides along: is there a live preview to open? (dev server / static
    // page). Lets the phone hide the Preview chip when there's nothing to show — same beat as the changes.
    const hasPreview = getSessionPreview(sessionId) != null
    const cwd = this.remoteCwd(sessionId)
    const info = await detectRepo(cwd)
    if (!info.isRepo) return { repo: false, files: [], truncated: false, hasPreview }
    const { files, truncated } = await getStatus(cwd)
    return { repo: true, files, truncated, hasPreview }
  }

  /** Unified diff text for one changed file (path-contained inside the session's project). */
  async remoteFileDiff(sessionId: string, path: string): Promise<{ diff: string; truncated: boolean }> {
    return diffTextOf(this.remoteCwd(sessionId), path)
  }

  /** Commit exactly these paths from the phone — same pathspec-scoped save the desktop Stage uses,
   *  same tagged error shape (no_identity etc. surface as calm copy, not thrown noise). */
  async remoteCommitPaths(
    sessionId: string,
    message: string,
    paths: string[],
  ): Promise<{ ok: true; sha: string } | { ok: false; code: string; message: string }> {
    try {
      const { sha } = await commitPaths(this.remoteCwd(sessionId), paths, message)
      return { ok: true, sha }
    } catch (err) {
      if (err instanceof UserGitError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'git_failed', message: err instanceof Error ? err.message : 'git failed' }
    }
  }

  /** The phone's Versions list — recent versions on the session project's current branch, plus the
   *  branch / side-branch flags so the phone can warn "you're not on main". Local-only + fast; backup
   *  status (which verifies against the remote over the network) is a separate call. */
  async remoteVersions(sessionId: string): Promise<{
    repo: boolean
    branch: string | null
    defaultBranch: string | null
    onSideBranch: boolean
    versions: { sha: string; subject: string; relativeDate: string; authorName: string }[]
    truncated: boolean
  }> {
    const cwd = this.remoteCwd(sessionId)
    const info = await detectRepo(cwd)
    if (!info.isRepo)
      return { repo: false, branch: null, defaultBranch: null, onSideBranch: false, versions: [], truncated: false }
    const { versions, truncated } = await getVersionList(cwd)
    const onSideBranch =
      info.branch != null && info.defaultBranch != null && info.branch !== info.defaultBranch
    return { repo: true, branch: info.branch, defaultBranch: info.defaultBranch, onSideBranch, versions, truncated }
  }

  /** Roll the session project back to a version — saved as a NEW version on top (forward-only, nothing
   *  lost), clean-tree gated. Same tagged-error shape as the desktop restore so the phone shows calm
   *  copy. The sha is validated here (it comes from the phone, unlike the desktop's own-graph sha) so it
   *  can't smuggle a git flag into restoreVersion's argv. */
  async remoteRestoreVersion(
    sessionId: string,
    sha: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; code: string; message: string }> {
    if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(sha))
      return { ok: false, code: 'git_failed', message: 'invalid version id' }
    try {
      const r = await restoreVersion(this.remoteCwd(sessionId), sha)
      return { ok: true, sha: r.sha }
    } catch (err) {
      if (err instanceof UserGitError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'git_failed', message: err instanceof Error ? err.message : 'git failed' }
    }
  }

  /** Backup status of the session project — "is my work off this Mac, on GitHub?" getSyncState verifies
   *  against the real remote (a false "you're safe" is the one answer it refuses). A slim read for the
   *  phone; the desktop reads the full SyncState. */
  async remoteBackup(
    sessionId: string,
  ): Promise<{ hasRemote: boolean; ahead: number; behind: number; verified: boolean }> {
    const s = await getSyncState(this.remoteCwd(sessionId))
    return { hasRemote: s.hasRemote, ahead: s.ahead, behind: s.behind, verified: s.verified }
  }

  /** Push local versions to the remote — one-tap backup from the phone. Tagged errors: no_remote → the
   *  phone routes to "ask Claude to publish it"; push_rejected / push_auth → calm copy. */
  async remoteBackupPush(
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    try {
      await pushToRemote(this.remoteCwd(sessionId))
      return { ok: true }
    } catch (err) {
      if (err instanceof UserGitError) return { ok: false, code: err.code, message: err.message }
      return { ok: false, code: 'git_failed', message: err instanceof Error ? err.message : 'push failed' }
    }
  }

  /** Resolve a phone-supplied browse target to a project root: a live session's cwd, or a known recent
   *  project's path directly — so the project screen can browse docs/files WITHOUT a session running.
   *  Same trust rule as startNewRemote: a phone-named path must match a known recent project; the phone
   *  can never browse an arbitrary directory. */
  private remoteRoot(ref: { sessionId?: string; projectPath?: string }): string {
    if (ref.sessionId) return this.remoteCwd(ref.sessionId)
    const p = ref.projectPath ?? ''
    if (!this.recentProjectsForRemote().some((r) => r.path === p)) throw new Error('unknown project')
    return p
  }

  /** The phone's file browser — one directory's entries in the ref'd project (a live session's, or a
   *  known project by path). `path` is project-relative ('' = root); fs-browse contains every access to
   *  the project root (realpath + escape refusal), so the phone can't read elsewhere on disk. Returns
   *  relative paths (never leaks the Mac's absolute layout). Read-only by construction. */
  async remoteBrowse(
    ref: { sessionId?: string; projectPath?: string },
    path?: string,
  ): Promise<{ path: string; entries: { name: string; kind: 'file' | 'dir' }[] }> {
    const cwd = this.remoteRoot(ref)
    const r = await browseDir(cwd, path || undefined)
    return { path: relative(cwd, r.path), entries: r.entries }
  }

  /** Read one text file in the ref'd project (capped; binary refused). Path is project-relative,
   *  contained to the root by fs-browse. */
  async remoteReadFile(
    ref: { sessionId?: string; projectPath?: string },
    path: string,
  ): Promise<{ path: string; content: string; truncated: boolean; binary: boolean }> {
    const cwd = this.remoteRoot(ref)
    const r = await readProjectFile(cwd, path)
    return { path: relative(cwd, r.path), content: r.content, truncated: r.truncated, binary: r.binary }
  }

  /** Save one text file in the ref'd project from the phone. Like the desktop editor save, it checkpoints
   *  the pre-edit tree (recoverable like an engine write — the dual-git thesis) THEN writes, path-contained
   *  by fs-browse. But the phone autosaves as you type, so checkpointing every write would flood the undo
   *  timeline. Coalesce: only the FIRST write of an editing burst (a gap since the last write) checkpoints —
   *  it captures "before I started editing," and the rapid autosaves that follow just write. So one phone
   *  editing session is one recovery point, matching the desktop's one-save-one-checkpoint granularity. */
  async remoteWriteFile(
    ref: { sessionId?: string; projectPath?: string },
    path: string,
    content: string,
  ): Promise<{ path: string }> {
    const cwd = this.remoteRoot(ref)
    const now = Date.now()
    const startsNewBurst = now - (this.lastRemoteWriteAt.get(cwd) ?? 0) > REMOTE_WRITE_BURST_MS
    this.lastRemoteWriteAt.set(cwd, now)
    if (startsNewBurst) await this.checkpointProjectEdit(cwd, `edit to ${basename(path)}`)
    return { path: relative(cwd, await writeProjectFile(cwd, path, content)) }
  }

  /** One of a doc's local images, base64 + media type, so the phone's live doc viewer can inline it
   *  (a `data:` URL). Null for a non-image or oversized file. Contained to the project root. Downscaled
   *  + webp-encoded for the wire — the same `encodeWebp` the offline replica uses — so a full-res PNG
   *  photo doesn't cross the connection at full size; SVG (vector/text) and any encode failure fall
   *  back to the raw bytes. */
  async remoteReadImage(
    ref: { sessionId?: string; projectPath?: string },
    path: string,
  ): Promise<{ mediaType: string; dataBase64: string } | null> {
    const raw = await readProjectImage(this.remoteRoot(ref), path)
    if (!raw) return null
    if (raw.mediaType !== 'image/svg+xml') {
      const webp = await encodeWebp(raw.buf)
      if (webp) return { mediaType: 'image/webp', dataBase64: webp.toString('base64') }
    }
    return { mediaType: raw.mediaType, dataBase64: raw.buf.toString('base64') }
  }

  /** The project's Documents — the user's deliverable docs (Documents/ + loose .md), the phone's
   *  Notion-style read surface. Same list the desktop's doc-first sidebar shows. Each doc carries a
   *  short excerpt so the phone can render page-preview cards (recognize the content, not a filename);
   *  capped to the newest few so a huge project doesn't turn one listing into dozens of reads. */
  async remoteDocs(
    ref: { sessionId?: string; projectPath?: string },
  ): Promise<{ docs: { rel: string; name: string; mtimeMs: number; excerpt?: string }[] }> {
    const cwd = this.remoteRoot(ref)
    const list = await listProjectDocs(cwd)
    const EXCERPTS = 24
    return {
      docs: await Promise.all(
        list.map(async (d, i) => ({
          rel: d.rel,
          name: d.name,
          mtimeMs: d.mtimeMs,
          ...(i < EXCERPTS ? { excerpt: await docExcerpt(cwd, d.rel) } : {}),
        })),
      ),
    }
  }

  /** The remote tier was disabled: reap any headless session a remote client kept alive whose window is
   *  already gone (so its `claude` child doesn't linger unreachable), then forget all attachments. A
   *  session whose window is still open keeps running — it's still usable locally. */
  async disposeHeadlessRemote(): Promise<void> {
    stopAllLanForwards() // no phone can be watching once the tier is off
    for (const id of [...this.remoteAttached]) {
      if (!contextForSession(id)) await this.dispose(id)
    }
    this.remoteAttached.clear()
  }

  /**
   * Preview capability (preview-surface.md, Rung 2): start the dev server for the session's OWNING
   * window and return the URL the preview iframe will load. Koda owns the child (started here, killed
   * on window close, see index.ts). Throws if the session's window is gone (the agent surfaces it).
   */
  async startPreview(sessionId: string, command: string, cwd?: string): Promise<{ url: string }> {
    const ctx = contextForSession(sessionId)
    if (!ctx || !ctx.projectPath) throw new Error('no project window for this session')
    return startDevServer(ctx.win.id, ctx.projectPath, command, sessionId, cwd)
  }

  /**
   * Agent-sees-preview (preview-surface.md, Rung 3): screenshot the session window's live preview and
   * return it to the agent (broker → here → preview.ts capture). Downscaled to the current imageDetail
   * cap (token cost tracks area). Throws if the window is gone (the agent surfaces it).
   */
  async capturePreview(sessionId: string): Promise<{ data: string; mimeType: string }> {
    const ctx = contextForSession(sessionId)
    if (!ctx) throw new Error('no project window for this session')
    return captureWindowPreview(ctx.win, IMAGE_DETAIL_CAPS[loadImageDetail()])
  }

  /**
   * Static-preview capability (preview-surface.md, Rung 1): show a project `.html` file (a mock, a
   * generated page the agent wrote) in the session window's preview surface. Containment + existence
   * are enforced in preview.ts. Throws if the session's window/project is gone (the agent surfaces it).
   */
  async previewFile(sessionId: string, relPath: string): Promise<{ url: string }> {
    const ctx = contextForSession(sessionId)
    if (!ctx || !ctx.projectPath) throw new Error('no project window for this session')
    return showStaticPreview(ctx.win.id, ctx.projectPath, relPath, sessionId)
  }

  /** The session's project root for the mini-app verbs. Unlike preview, no window is required — a
   *  phone-started (windowless) session can run lifecycle verbs too; projectDirs has every session.
   *  Realpath'd: containedReal returns realpath'd app dirs, and status computes project-relative ids
   *  from this — a symlinked root (macOS loves these) would otherwise yield `../..`-shaped ids the
   *  other verbs reject. */
  private projectPathFor(sessionId: string): string {
    const path = contextForSession(sessionId)?.projectPath ?? this.projectDirs.get(sessionId)
    if (!path) throw new Error('no project for this session')
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }

  /** Resolve + contain a project-relative app folder for the mini-app verbs (mini-apps.ts stays
   *  session-unaware; this is the session → project → dir seam, like startPreview's window dance). */
  private appTarget(sessionId: string, relPath: string): { dir: string; projectPath: string } {
    const projectPath = this.projectPathFor(sessionId)
    const rel = relPath.replace(/^\/+/, '').trim()
    if (!rel) throw new Error('path is required — the project-relative app folder, e.g. "apps/fitness"')
    let dir: string
    try {
      dir = containedReal(projectPath, rel) // realpath: throws on escape OR missing — never leaks which
    } catch {
      throw new Error(`"${relPath}" is outside the project or doesn't exist`)
    }
    return { dir, projectPath }
  }

  /**
   * Pop the terminal shelf open in the session's window (the agent's open_terminal tool), optionally
   * staging a command at the prompt for the user to run. The raw shell is the "advanced: the human can"
   * tier — Koda never runs the command, it only puts it in front of the user. Throws if the window's
   * gone (the agent surfaces it).
   */
  async openTerminal(sessionId: string, command?: string): Promise<void> {
    const ctx = contextForSession(sessionId)
    if (!ctx) throw new Error('no project window for this session')
    showTerminal(ctx.win.id, sessionId, command)
  }

  // ── Per-project persistence (a project's sessions survive an app restart) ────
  /** A project's persisted sessions for its window to rehydrate on boot (null when none). Backfills
   *  the recovery/resume dir map so a restored session's safety-git timeline resolves before its
   *  engine reattaches (recovery is sessionId-keyed and must work post-crash). */
  loadSessionsForProject(projectPath: string): PersistedSessions | null {
    const persisted = loadProjectSessions(projectPath)
    if (persisted) for (const s of persisted.sessions) this.projectDirs.set(s.id, s.cwd)
    return persisted
  }

  /** Persist a project's open sessions + transcripts (keyed by the window's root, supplied by main). */
  persistProjectSessions(projectPath: string, data: PersistedSessions): void {
    saveProjectSessions(projectPath, data)
    for (const s of data.sessions) if (!this.projectDirs.has(s.id)) this.projectDirs.set(s.id, s.cwd)
  }

  /** The recovery timeline for a session's project, newest first. */
  async getCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    return applyHumanizedLabels(await listCheckpoints(this.requireDir(sessionId)))
  }

  /**
   * Rewind the project's working tree to a checkpoint (forward-only; see restore.ts). Serialized per
   * dir via runExclusive so restore can't interleave with a concurrent safety checkpoint (their git
   * index.lock would collide).
   *
   * KNOWN LIMITATION: this orders restore against Koda's OWN checkpoint chain only — it does NOT pause
   * the engine. An agent calling restore mid-turn while a Write/Edit is in flight is still a race (the
   * engine could write a stale buffer back over a just-restored file). The always-confirm on restore
   * (gate, isAlwaysConfirm) is the practical guard — the user sees it before forward work is discarded.
   * A real fix would interrupt the active turn before restoring; deferred (dual-git.md §6).
   */
  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<Checkpoint> {
    const dir = this.requireDir(sessionId)
    return this.runExclusive(dir, () => restore(dir, checkpointId))
  }

  // ── Project-scoped recovery (the Settings → Recovery surface) ─────────────────
  // Safety-git is per-PROJECT; the Settings pane is per-window/per-project, so recovery there is
  // resolved straight from the window's root (rootForSender), not a session. The session-scoped
  // methods above stay for the agent-driven recovery (the MCP capability tools).
  async getProjectCheckpoints(projectDir: string): Promise<Checkpoint[]> {
    return applyHumanizedLabels(await listCheckpoints(projectDir))
  }

  /** Forward-only restore of a project's working tree, serialized against its safety checkpoints. */
  async restoreProjectCheckpoint(projectDir: string, checkpointId: string): Promise<Checkpoint> {
    return this.runExclusive(projectDir, () => restore(projectDir, checkpointId))
  }

  interrupt(sessionId: string): void {
    this.sessions.get(sessionId)?.interrupt()
  }

  /**
   * Ask a side question ("btw" / aside) against `sessionId`'s live context — answered WITHOUT entering
   * the conversation (a `--fork-session` throwaway; see side-question.ts). Streams `delta`/`done`/`error`
   * to the owning window over `asideEvent`. No checkpoint (the fork denies every tool the engine
   * advertised, by bare name — the model has no tool it could attempt or execute, so nothing mutates).
   * Needs the session's cwd to resume; if it's gone (disposed), reports an error event.
   */
  askSideQuestion(sessionId: string, asideId: string, question: string): void {
    const key = `${sessionId}:${asideId}`
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) {
      this.sendAside(sessionId, asideId, 'error', 'that conversation is no longer available')
      return
    }
    // Billing parity with the parent: re-add the API credential only when API billing is in effect
    // (effectiveApiKey); otherwise buildEngineEnv keeps it subscription. No broker token — the fork
    // runs no tools.
    const apiKey = this.effectiveApiKey()
    const engineId = this.sessionEngines.get(sessionId) ?? 'claude'
    const modelEffort = this.sessionModelEffort.get(sessionId)
    const env = apiKey ? { apiMode: true as const, apiKey } : undefined
    const callbacks = {
      onDelta: (text: string) => this.sendAside(sessionId, asideId, 'delta', text),
      onDone: (full: string) => {
        this.sideQuestions.delete(key)
        this.sendAside(sessionId, asideId, 'done', full)
      },
      onError: (message: string) => {
        this.sideQuestions.delete(key)
        this.sendAside(sessionId, asideId, 'error', message)
      },
    }
    const nativeId = this.engineNativeIds.get(sessionId)
    if (engineId === 'codex') {
      if (!nativeId) {
        this.sendAside(sessionId, asideId, 'error', 'that conversation is not ready for a side question yet')
        return
      }
      const handle = askCodexSideQuestion(
        {
          parentThreadId: nativeId,
          cwd,
          question,
          model: modelEffort?.model,
          effort: modelEffort?.effort,
          resourcesPath: this.resourcesPath,
          env,
        },
        callbacks,
      )
      this.sideQuestions.set(key, handle)
      return
    }
    const handle = askSideQuestion(
      {
        parentSessionId: sessionId,
        cwd,
        question,
        advertisedTools: this.advertisedTools.get(sessionId),
        resourcesPath: this.resourcesPath,
        env,
      },
      callbacks,
    )
    this.sideQuestions.set(key, handle)
  }

  /** Cancel an in-flight side question (the user dismissed its answer before it finished). */
  cancelSideQuestion(sessionId: string, asideId: string): void {
    const key = `${sessionId}:${asideId}`
    this.sideQuestions.get(key)?.cancel()
    this.sideQuestions.delete(key)
  }

  private sendAside(sessionId: string, asideId: string, kind: 'delta' | 'done' | 'error', text: string): void {
    const parsed = AsideEventSchema.safeParse({ sessionId, asideId, kind, text })
    if (parsed.success) this.send(IpcChannels.asideEvent, sessionId, parsed.data)
  }

  async dispose(sessionId: string): Promise<void> {
    // Kill any side question still streaming for this session before its cwd mapping is dropped below.
    for (const [key, handle] of this.sideQuestions) {
      if (key.startsWith(`${sessionId}:`)) { handle.cancel(); this.sideQuestions.delete(key) }
    }
    const session = this.sessions.get(sessionId)
    if (session) {
      this.sessions.delete(sessionId)
      await session.dispose() // → 'close' → handleClose() cancels approvals + unregisters the broker
    }
    // Drop the project mapping only after teardown (a crash keeps it so recovery still works;
    // handleClose, which needs the dir to cancel approvals, has already run by here).
    this.projectDirs.delete(sessionId)
    this.remoteEventLog.delete(sessionId)
    this.diffBaselines.delete(sessionId)
    this.sessionModelEffort.delete(sessionId)
    this.spawnedWith.delete(sessionId)
    this.resolvedModels.delete(sessionId)
    this.freshPostureStale.delete(sessionId)
    this.sessionEngines.delete(sessionId)
    this.engineNativeIds.delete(sessionId)
    this.advertisedTools.delete(sessionId)
    this.brokerRecovery.delete(sessionId)
    this.resumeAfterReconnect.delete(sessionId)
    this.remoteTitled.delete(sessionId)
    this.lastActivityAt.delete(sessionId)
    this.working.delete(sessionId)
    this.lastLines.delete(sessionId)
    // NB: pendingWorkflowResults is NOT cleared here — like recoveringBroker, it must SURVIVE a respawn
    // (dispose() is also the broker-recovery / model-effort teardown, and a workflow result stashed
    // before the respawn still needs to ride the next human turn). It's drained on delivery; a truly
    // abandoned entry is one small string that evaporates with the process — no unbounded growth.
    stopLanForward(sessionId) // reap any LAN preview forwarder + forget its (now dead) URL
    clearSessionPreview(sessionId)
    // NB: recoveringBroker is NOT cleared here — a broker recovery calls start()→dispose() on the old
    // child mid-flight, and its own finally removes the flag once the respawn settles. Clearing it here
    // would drop the guard during the respawn and let a racing error trigger a second recovery.
  }

  /**
   * Tear down a session because its OWNING window closed (one-project-per-window). Interrupt the
   * engine child first (SIGINT) so an in-flight turn stops, then dispose. Fire-and-forget from
   * `win.on('closed')` — the window is already gone, so there's nothing to report back to.
   */
  async disposeForWindow(sessionId: string): Promise<void> {
    // Headless survival (remote-control-security.md, the one new main-process change): a session a
    // remote client attached to keeps running after its desktop window closes — its events now route
    // to the remote sink only (no window). It lives until app quit or the remote tier is disabled.
    if (this.remoteAttached.has(sessionId)) {
      log.info('remote', 'window closed; keeping session alive headless (remote-attached)', { sessionId })
      return
    }
    this.interrupt(sessionId) // best-effort: stop any in-flight turn before teardown
    await this.dispose(sessionId)
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.projectDirs.keys()].map((id) => this.dispose(id)))
    await this.broker.dispose()
  }

  /**
   * The child exited (crash, interrupt, or our own dispose). Drop the live handle, then tear down
   * the session's broker state: cancel any pending "Ask me" approvals (so their promises don't leak
   * and the renderer clears its prompts) and close the MCP transport. projectDirs is intact here,
   * so the gate can still resolve the dir while cancelling.
   */
  private handleClose(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.working.delete(sessionId) // the child is gone → no turn is running (a broker-recovery respawn re-sets it)
    this.gate.cancelSession(sessionId)
    void this.broker.unregister(sessionId)
    // The workflow process dies with its launching engine, so stop watching its journal too.
    for (const [runId, w] of this.workflowWatchers) {
      if (w.sessionId === sessionId) {
        w.watcher.stop()
        this.workflowWatchers.delete(runId)
      }
    }
  }

  /**
   * Reconnect the permission/capability broker for a session whose engine reported it "not connected".
   * The broker is an in-process MCP server and the engine's client can't re-handshake it live under -p,
   * so recovery = respawn the same session with --resume: dispose the child, mint a fresh broker route,
   * spawn again (the conversation is preserved by --resume). Single-flight per session (a burst of
   * failing tools triggers one respawn) and rate-limited (a broker that won't stay up can't spin us in a
   * loop). The interrupted turn is dropped — it was already failing every tool — so the user continues
   * with their next message. Reuses the model/effort/engine the session last ran with.
   */
  private async recoverBroker(sessionId: string): Promise<void> {
    if (this.recoveringBroker.has(sessionId)) return // a respawn is already in flight
    if (!this.sessions.has(sessionId)) return // already gone (disposed / window closed)
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return
    const prior = this.brokerRecovery.get(sessionId)
    const now = Date.now()
    // Within the cooldown of a just-completed recovery ⇒ ignore, quietly. This absorbs late drop errors
    // still draining from the disposed old child; a user-facing message here would false-alarm right
    // after a *successful* heal. Only actual respawns (below) count toward the give-up streak, so a
    // stray can't inflate it.
    if (prior && now - prior.at < BROKER_RECOVERY_COOLDOWN_MS) {
      log.warn('broker', 'skipping reconnect (within cooldown of a prior recovery)', { sessionId })
      return
    }
    // Count consecutive recoveries; an isolated drop long after the last one starts a fresh streak.
    const streak = prior && now - prior.at < BROKER_RECOVERY_WINDOW_MS ? prior.count : 0
    if (streak >= BROKER_RECOVERY_MAX) {
      this.forward({
        type: 'EngineError',
        sessionId,
        fatal: true,
        message: "Koda's safety net keeps dropping its connection. Please restart this session.",
      })
      return
    }
    this.recoveringBroker.add(sessionId)
    this.brokerRecovery.set(sessionId, { count: streak + 1, at: now })
    this.forward({ type: 'EngineError', sessionId, fatal: false, message: "Reconnecting Koda's safety net — one moment…" })
    try {
      const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
      // start() disposes the still-live child first (it sees the id in this.sessions), which unregisters
      // the stale broker route, then re-registers a fresh one before spawning with --resume.
      await this.start({ resumeSessionId: sessionId, cwd, model, effort })
      // Auto-resume: pick the interrupted turn back up on its own once the fresh session is initialized.
      // Added AFTER start() (its internal dispose of the old child already ran) and before the new
      // child's SessionStarted can fire (a later event-loop tick), so the flag is set in time.
      this.resumeAfterReconnect.add(sessionId)
      this.forward({ type: 'EngineError', sessionId, fatal: false, message: 'Reconnected — resuming where you left off…' })
    } catch (err) {
      this.resumeAfterReconnect.delete(sessionId)
      this.forward({
        type: 'EngineError',
        sessionId,
        fatal: true,
        message: `Couldn't reconnect Koda's safety net: ${err instanceof Error ? err.message : String(err)}. Please restart this session.`,
      })
    } finally {
      this.recoveringBroker.delete(sessionId)
      // Stamp completion time so the cooldown measures from when this recovery finished. Drop the entry
      // if the session is gone (a failed recovery already disposed it) so no stale streak lingers.
      if (this.sessions.has(sessionId)) this.brokerRecovery.set(sessionId, { count: streak + 1, at: Date.now() })
      else this.brokerRecovery.delete(sessionId)
    }
  }

  private require(sessionId: string): EngineSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    return session
  }

  /** Resolve a session's project dir for recovery — works post-crash, unlike require(). */
  private requireDir(sessionId: string): string {
    const dir = this.projectDirs.get(sessionId)
    if (!dir) throw new Error(`unknown session: ${sessionId}`)
    return dir
  }

  /**
   * One window per project for now, so every event goes to the sole window;
   * the renderer routes by the event's `sessionId`. Validate before crossing
   * the boundary — but contain a bad shape (safeParse), never throw out of the
   * stdout-drain callback chain that calls this.
   */
  private forward(event: EngineEvent): void {
    // A --resume whose conversation the engine no longer holds exits "No conversation found with
    // session ID: …" (a ghost store entry, a cleared/partial transcript, or an auto-recovery respawn of
    // a session that never completed its first turn). The filesystem can't reliably predict this — the
    // engine is the authority — so we can't gate every --resume ahead of time. Rewrite the raw engine
    // line into a plain reason before it reaches the log, the desktop, or the phone (where it read as a
    // wall of cryptic errors). Every --resume site funnels through forward(), so this one guard covers
    // resumeRemote, the model/effort respawn, and broker recovery alike.
    if (event.type === 'EngineError' && event.fatal && /No conversation found with session ID/i.test(event.message)) {
      log.warn('engine', 'resume-miss (engine has no conversation for this session)', { sessionId: event.sessionId })
      event = {
        ...event,
        message: "This chat's earlier history is no longer available, so it can't be reopened. Start a new chat to keep going.",
      }
    }
    // Telemetry (opt-in): the classifier TONE only — the message can carry file paths, so it never
    // leaves. forward() is the one funnel both drivers' errors pass through.
    if (event.type === 'EngineError')
      track('engine_error', { tone: friendlyEngineError(event.message, event.fatal).tone, fatal: event.fatal })

    this.logEvent(event)
    this.bufferRemoteEvent(event)

    // Per-session turn-activity → the launcher's live working/idle glyph (remote heads poll the launcher;
    // they have no event stream at browse level). Driven off the SAME live events the client's `busy`
    // reducer uses, so ANY active session shows working regardless of how its turn started — a desktop IPC
    // turn, a phone turn, a resume, a broker-recovery nudge — not only turns routed through sendTurn (which
    // sets it too, for the instant before the first delta lands). Ends on TurnComplete / fatal error.
    if (
      event.type === 'ThinkingDelta' ||
      event.type === 'AssistantDelta' ||
      event.type === 'AssistantBlock' ||
      event.type === 'ToolRequested' ||
      event.type === 'SubagentStarted' ||
      event.type === 'SubagentProgress'
    )
      this.working.add(event.sessionId)
    else if (event.type === 'TurnComplete' || (event.type === 'EngineError' && event.fatal))
      this.working.delete(event.sessionId)

    // The launcher's "what is it doing" line — the first non-empty line of the latest finalized reply.
    if (event.type === 'AssistantBlock') {
      const line = event.markdown.split('\n').find((l) => l.trim())
      if (line) this.lastLines.set(event.sessionId, line.trim().slice(0, 140))
    }

    // Broker self-heal: the engine's MCP client dropped our in-process permission/capability server
    // (typically a long-idle stream — the keepalive in broker/server.ts is the prevention). Once that
    // happens EVERY tool fails "koda_broker is not connected", the gate included, so the session is
    // bricked until reconnected. Catch the first such error and transparently respawn with --resume
    // (fresh broker handshake, conversation preserved) instead of leaving the user stuck.
    if (
      event.type === 'ToolResult' &&
      event.isError &&
      event.output.includes(BROKER_UNREACHABLE_PREFIX(BROKER_NAME)) &&
      BROKER_DROP_SIGNATURE.test(event.output)
    ) {
      void this.recoverBroker(event.sessionId)
    }

    if (event.type === 'SessionStarted') {
      if (event.engineNativeId) this.engineNativeIds.set(event.sessionId, event.engineNativeId)
      else this.engineNativeIds.delete(event.sessionId)
      if (event.tools.length) this.advertisedTools.set(event.sessionId, event.tools)
      // The model the engine actually resolved to — what a "Default" pick means, shown on the phone.
      if (event.model) this.resolvedModels.set(event.sessionId, event.model)
      // A fresh session from a broker reconnect: auto-send the continuation nudge now that the engine is
      // initialized, so the turn the drop interrupted resumes without the user resending anything.
      if (this.resumeAfterReconnect.delete(event.sessionId)) {
        this.sendTurn(event.sessionId, BROKER_RESUME_NUDGE).catch((err) =>
          log.warn('broker', 'auto-resume turn failed', err instanceof Error ? err.message : err),
        )
      }
    }

    // Fold each completed turn into the daily usage rollup (main-side, file-first). Asides ("btw")
    // run a separate throwaway process and never reach here — a small deliberate cost the history
    // doesn't capture (so it can read slightly under the real account total if asides get heavy).
    if (event.type === 'TurnComplete')
      recordTurnUsage(event.models, event.costEstimate, this.sessionEngines.get(event.sessionId) ?? 'claude')

    // Watch the account-level 5-hour window so we can ping once when a MAXED window resets (not every window).
    if (event.type === 'RateLimitUpdate') {
      const engine = this.sessionEngines.get(event.sessionId) ?? 'claude'
      noteRateLimit(engine, event.info)
      const windows = this.lastRateLimits.get(engine) ?? {}
      windows[event.info.rateLimitType] = event.info
      this.lastRateLimits.set(engine, windows)
      recordRateLimit(engine, event.info)
    }

    // Provider-outage watch: a provider-shaped turn failure triggers one status-feed check (only a
    // feed-confirmed incident starts the recovery watch); a clean turn while watching clears it silently.
    if (event.type === 'EngineError' && event.providerStatus === 'down')
      noteProviderError(this.sessionEngines.get(event.sessionId) ?? 'claude')
    if (event.type === 'TurnComplete' && event.stopReason === 'success')
      noteTurnOk(this.sessionEngines.get(event.sessionId) ?? 'claude')

    // A workflow launched: start watching its on-disk journal so its background progress + result
    // surface (it never streams back into -p). The dir is main-internal — the renderer renders the
    // card from runId + name. Idempotent per runId.
    if (event.type === 'WorkflowStarted' && event.dir && !this.workflowWatchers.has(event.runId)) {
      track('workflow_run', {})
      const watcher = new WorkflowWatcher(
        event.sessionId,
        event.runId,
        event.dir,
        (e) => this.forward(e), // the watcher's own WorkflowAgent/Completed events route back through here
        (runId) => this.workflowWatchers.delete(runId),
        // Stash the finished workflow's result for delivery on this session's next human turn.
        (resultText) => this.stashWorkflowResult(event.sessionId, resultText),
      )
      this.workflowWatchers.set(event.runId, { sessionId: event.sessionId, watcher })
      watcher.start()
    }

    const parsed = EngineEventSchema.safeParse(event)
    if (!parsed.success) {
      log.error('engine', 'dropped malformed event', { issues: parsed.error.issues, event })
      return
    }
    this.send(IpcChannels.engineEvent, parsed.data.sessionId, parsed.data)
  }

  private pushApprovalRequest(req: unknown): void {
    const parsed = ApprovalRequestSchema.safeParse(req)
    if (parsed.success) this.send(IpcChannels.approvalRequest, parsed.data.sessionId, parsed.data)
  }

  private pushApprovalCancelled(sessionId: string): void {
    const parsed = ApprovalCancelledSchema.safeParse({ sessionId })
    if (parsed.success) this.send(IpcChannels.approvalCancelled, sessionId, parsed.data)
  }

  private pushApprovalResolved(sessionId: string, requestId: string): void {
    const parsed = ApprovalResolvedSchema.safeParse({ sessionId, requestId })
    if (parsed.success) this.send(IpcChannels.approvalResolved, sessionId, parsed.data)
  }

  /**
   * Route to the window that OWNS this session (one-project-per-window). Ownership comes from the
   * window registry (the IPC layer registers a session under its window on start). A session whose
   * window has closed resolves to nothing and drops silently — its events have nowhere to land.
   */
  private send(channel: string, sessionId: string, payload: unknown): void {
    const win = contextForSession(sessionId)?.win
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    // Fan out to remote transports too — and crucially this runs even when there's NO window (a headless
    // remote-attached session), which the early-return above used to swallow. Each transport filters by
    // its own per-client subscription. A throwing sink must not break the others (or the local send).
    for (const sink of this.remoteSinks) {
      try {
        sink(channel, sessionId, payload)
      } catch (err) {
        log.warn('remote', 'remote sink threw', err instanceof Error ? err.message : err)
      }
    }
  }

  /**
   * Diagnostic trail, not a transcript: log failures fully, plus thin lifecycle
   * breadcrumbs (event type + a locating id — no payloads) so an error has context
   * for "what was happening when it broke". Claude's actual content (AssistantBlock /
   * AssistantDelta) and tool inputs are deliberately NOT logged.
   */
  private logEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'EngineError':
        log.error('engine', e.fatal ? 'fatal engine error' : 'engine error', {
          sessionId: e.sessionId,
          message: e.message,
        })
        break
      case 'ToolResult':
        // Only failures — a successful tool result is content we don't need.
        if (e.isError) log.warn('engine', 'tool failed', { sessionId: e.sessionId, id: e.id, output: e.output })
        break
      case 'SessionStarted':
        log.info('engine', 'session started', { sessionId: e.sessionId, cwd: e.cwd })
        break
      case 'ToolRequested':
        // Name only (which tool), never the input payload.
        log.info('engine', `tool: ${e.name}`, { sessionId: e.sessionId, id: e.id })
        break
      case 'SubagentStarted':
        // Subagent type + locating id; never the prompt (content).
        log.info('engine', `subagent: ${e.subagentType}`, { sessionId: e.sessionId, id: e.toolUseId })
        break
      case 'SubagentCompleted':
        log.info('engine', 'subagent complete', { sessionId: e.sessionId, id: e.toolUseId })
        break
      case 'TurnComplete':
        log.info('engine', 'turn complete', {
          sessionId: e.sessionId,
          stopReason: e.stopReason,
          costEstimate: e.costEstimate,
        })
        break
      // AssistantDelta / AssistantBlock: Claude's content — not logged.
    }
  }
}

function noop(): void {}

/** The instant provisional session title from the first words of a prompt — the on-device model
 *  (`assistTitle`) refines it moments later. Mirrors the renderer's `titleFromPrompt` so a phone-started
 *  session named here matches one named on the desktop. */
function titleFromPrompt(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length <= 40 ? clean : `${clean.slice(0, 40).trimEnd()}…`
}

/** Realpath a dir for stable comparison (symlinks, /tmp vs /private/tmp), falling back to the input
 *  when it can't be resolved (a gone dir) — so a match still works on the raw string. */
function realpathOrSelf(p: string): string {
  if (!p) return p
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
