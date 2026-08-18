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
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/channels'
import {
  EngineEventSchema,
  TaskCompletionStateSchema,
  ApprovalRequestSchema,
  ApprovalCancelledSchema,
  ApprovalResolvedSchema,
  AsideEventSchema,
  type EngineEvent,
  type TaskCompletionState,
  type ApprovalMode,
  type ApprovalRequest,
  type ToolDecision,
  type PersistedSessions,
  type EngineId,
  type ResumeCursor,
  type CodexModel,
  type CodexAuthStatus,
  type ProviderModelCatalogs,
  type AdoptedHeadlessSession,
  type SessionCapabilitySnapshot,
  type ReplayEntry,
  type RateLimitInfo,
  type RemoteTerminalAttention,
  type RemoteUsageSnapshot,
  type RemoteTurnReceipt,
  type AttachmentProvenance,
  IMAGE_DETAIL_CAPS,
  MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS,
  TURN_REJECTED_STOP_REASON,
  attachedFilesNote,
  stripRawEnvelope,
} from '@shared/ipc'
import { engineCapabilities } from '@shared/engine-capabilities'
import { providerModelCatalogs } from '@shared/model-catalog'
import { engineProfile } from './profile'
import { startClaudeSession, type EngineSession, type SessionOpts, type TurnImage } from './adapter'
import { codexThreadId, startCodexSession } from './codex-driver'
import { codexSkillConfig, ensureCodexHome, reconcileCodexAuth } from './codex-home'
import { assembleGuardrailText, kodaPlaybooksExpected, resolveDeepReviewPlugin, resolveStagingPack } from './pack'
import { getCodexAuthStatus, listCodexModels } from './codex-auth'
import { askCodexSideQuestion, askSideQuestion, type SideQuestionHandle } from './side-question'
import { WorkflowWatcher } from './workflow-watch'
import { loadRateLimits, loadUsageHistory, recordTurnUsage, replaceRateLimits } from './usage-history'
import {
  commitPaths,
  detectRepo,
  diffTextOf,
  getStatus,
  type ChangeEvidence,
  type StatusResult,
  getSyncState,
  getVersionList,
  pushToRemote,
  restoreVersion,
  UserGitError,
  completionGitSnapshot,
} from '../user-git'
import {
  reconcileCompletionState,
  type CompletionTurnBoundary,
  type CompletionUncertainty,
} from '../completion-state'
import { browseDir, containedReal, docExcerpt, listProjectDocs, readProjectFile, readProjectImage, writeProjectFile } from '../fs-browse'
import { installApp, startApp, stopApp, appStatus, projectHasMiniApp } from '../mini-apps'
import { keepDocument } from '../keep-document'
import { encodeWebp } from '../backup/webp'
import { noteRateLimit } from './usage-reset-notifier'
import { authoritativeUsageTypes, pollAccountUsage } from './usage-poll'
import { isE2EProfile, isHermeticE2EProfile, requireRealAccountAccess } from '../runtime-profile'
import { noteProviderError, noteTurnOk } from './status-watch'
import { friendlyEngineError } from '@shared/engine-error'
import { compactTranscriptToolOutput } from '@shared/tool-output'
import {
  isTopLevelTurnActivity,
  mergeReplayIntoTranscript,
  normalizeReplaySequence,
  settleRestoredDelegationReplay,
  settleRestoredTranscriptItems,
  terminalAttentionKind,
  terminalAttentionRevision,
  transcriptFromReplay,
} from '@shared/delegation'
import { reconcileRateLimitWindows } from '@shared/rate-limits'
import { track } from '../telemetry'
import { resolveGlobalSkillsPlugin } from './skills-catalog'
import { projectSkillCollisionNames } from '../project-skills'
import { noteMomentCheckpoint } from '../backup'
import { publishNeuralEvent } from '../neural-view'
import { ensureRepo } from '../safety-git/repo'
import {
  checkpoint,
  checkpointKind,
  listCheckpoints,
  readCheckpoint,
  type Checkpoint,
  type CheckpointResult,
  type RequiredCheckpointFile,
} from '../safety-git/checkpoint'
import { restore } from '../safety-git/restore'
import { restoreNotice } from '../safety-git/restore-notice'
import { maintainStore } from '../safety-git/prune'
import { humanizeCheckpointLabel, applyHumanizedLabels } from '../assist/labels'
import { assistTitle, assistVersionMessage } from '../assist'
import { deterministic, disambiguate } from '../assist/engine'
import { generateSessionName, type GeneratedName, type NamingKind } from './naming'
import { buildVersionMessagePrompt, generateVersionMessage, type VersionMessage } from './version-message'
import { fallbackVersionMessage } from '@shared/version-message'
import { isProvisionalSessionTitle, titleFromPrompt } from '@shared/session-title'
import { engineAskRunner, type AskRunner } from '../library-ask'
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
  loadCritiquePass,
  loadMiniAppsEnabled,
  loadSessionAgentRole,
  loadSuggestVersionMessage,
  loadTextGenerationModel,
} from '../settings'
import { saveScratchWithRetention } from '../scratch-retention'
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
import { governProbe, type GovernedProbe } from '../probe-governor'
import {
  archiveSession,
  engineConversationExists,
  engineConversationHasContent,
  engineConversationMtime,
  readEngineConversationReplay,
  loadProjectSessions,
  readPersistedSession,
  saveProjectSessions,
  knownProjectPaths,
  type StoreReadReport,
} from '../session-store'
import { addSessionToWindow, contextForSession, projectPathForWindow, removeSessionFromWindow, windowForProject } from '../window-registry'
import { log } from '../logger'
import { appendRemoteReplay, loadRemoteReplay, replaceRemoteReplay } from '../remote-replay-store'

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
/** Account usage poll (usage-poll.ts): a first read once the app has settled, then a heartbeat. A turn
 *  ending also triggers one, no more often than the min gap — the poll spawns a short-lived process, so
 *  it's cheap but not free. */
const USAGE_POLL_STARTUP_MS = 3_000
const USAGE_POLL_INTERVAL_MS = 5 * 60_000
const USAGE_POLL_MIN_GAP_MS = 60_000
/** Interrupt discipline: stop delegated children before the parent turn, but never let one hold the
 *  user's stop button. A child gets this long to confirm it ended… */
const CHILD_STOP_TIMEOUT_MS = 3_000
/** …and the whole sweep gets this long, however many children are live, before the parent is
 *  interrupted anyway. Bounds carried from the T3 pattern (research doc, harness verdict). */
const CHILD_STOP_TOTAL_MS = 10_000
const REMOTE_ATTEMPT_HISTORY_PER_SESSION = 64
const REMOTE_ATTACHMENT_PAYLOAD_SESSIONS = 16
/** Stand-in session id on a poll-derived RateLimitUpdate. The windows are an ACCOUNT fact with no
 *  owning session; receivers key them by `rateLimitType` + the stamped engine, never by this id. */
const ACCOUNT_USAGE_SESSION_ID = 'account-usage'
/** A remote caller may NAME the session it's starting (startNewRemote's idempotency key). The engine
 *  takes --session-id as a UUID, so anything else is discarded in favour of a minted one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Sent automatically as the user's next turn after a broker reconnect, so an interrupted turn just
 *  continues — the user didn't pause it, Koda's tool connection blipped and recovered. Framed so the
 *  agent treats the "not connected" errors above as the transient glitch they were, not real failures.
 *  --resume keeps the original request in context, so "continue" is enough to pick it back up. */
const BROKER_RESUME_NUDGE =
  "Koda's connection to its tools dropped for a moment and is now restored — any tool errors just above were from that, not real failures. Please pick up where you left off and finish what I was asking."

/** Hash exact remote send material incrementally. The accepted-attempt ledger retains only this fixed
 * digest, never a second text/base64 copy, while still making field boundaries and attachment order
 * unambiguous. */
function remoteTurnFingerprint(
  text: string,
  attachments?: readonly (TurnImage & { name?: string })[],
): string {
  const hash = createHash('sha256')
  const update = (value: string): void => {
    hash.update(String(Buffer.byteLength(value, 'utf8')))
    hash.update(':')
    hash.update(value, 'utf8')
  }
  update(text)
  update(String(attachments?.length ?? 0))
  for (const attachment of attachments ?? []) {
    update(attachment.mediaType)
    update(attachment.name === undefined ? '0' : '1')
    if (attachment.name !== undefined) update(attachment.name)
    update(attachment.dataBase64)
  }
  return hash.digest('hex')
}

/** Delegation lifecycle events mutate the persisted transcript independently of the parent turn. */
function isDelegationLifecycleEvent(event: EngineEvent): boolean {
  return (
    event.type === 'SubagentStarted' ||
    event.type === 'SubagentProgress' ||
    event.type === 'SubagentCompleted' ||
    event.type === 'WorkflowStarted' ||
    event.type === 'WorkflowAgent' ||
    event.type === 'WorkflowCompleted' ||
    event.type === 'WorkflowObservationEnded'
  )
}

/** Opaque scheduler finalization boundary. It keeps the tidy's completion turn open through its
 * digest write and records Koda-observed overlap; it never authorizes destructive tree cleanup. */
export interface ProjectMutationScope {
  readonly cwd: string
  readonly sessionId: string
  readonly checkpointId: string
}

interface LiveProjectMutationScope extends ProjectMutationScope {
  ambiguous: boolean
  turnStarted: boolean
}

interface TurnAdmission {
  /** Monotonic identity prevents a stopped predecessor from cancelling or releasing its successor. */
  generation: number
  cancelled: boolean
}

interface AcceptedTurn {
  /** The admission generation that actually crossed the driver's synchronous acceptance boundary. */
  generation: number
  /** Stop belongs to the logical turn, not to whichever process incarnation currently carries it. */
  cancelled: boolean
  /** The exact warm process that accepted it; a respawn must never inherit an old Stop. */
  session: EngineSession
}

type TurnAttachment = TurnImage & { name?: string }

/** The human-owned half of a turn held across infrastructure recovery. `engineText` below may contain
 * workflow context or scratch-file notes, so retry/replay identity must never be reconstructed from it. */
interface PendingVisibleTurn {
  text: string
  attachments?: TurnAttachment[]
  origin: 'local' | 'remote'
  attemptId?: string
  clientTurnId?: string
}

interface PendingTurn {
  /** Exact text handed to the engine after workflow-result and document-path expansion. */
  engineText: string
  /** Only image/* attachments ride inline after document material has become scratch paths. */
  inlineImages?: TurnAttachment[]
  /** Untouched user payload and transport identity for replay/failure ownership. */
  visible: PendingVisibleTurn
}

interface ProcessReplacementClaim {
  /** One owner across every await from replacement intent through child installation. */
  generation: number
}

interface AcceptedRemoteAttempt {
  clientTurnId?: string
  /** Fixed-size proof of immutable text + ordered exact attachment payload. */
  fingerprint: string
  state: 'running' | 'complete'
}

interface RemoteTurnPayload {
  replaySeq?: number
  attemptId?: string
  clientTurnId?: string
  attachments?: (TurnImage & { name?: string })[]
  failed: boolean
}

export class EngineSessionManager {
  private readonly sessions = new Map<string, EngineSession>()
  /** Exact process incarnation behind each installed session id. A bounded driver dispose can return
   *  before its child emits `close`; the token keeps that stale callback from deleting a successor
   *  process or unregistering the successor's freshly minted broker route. */
  private readonly sessionGenerations = new Map<string, symbol>()
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
  /** sessionId → the notice a safety-git restore left for that session's NEXT turn. A restore moves the
   *  working tree under a live conversation, which otherwise keeps editing files as it last read them.
   *  Latest restore wins: only the last one describes what is actually on disk. Drained in sendTurn. */
  private readonly pendingRestoreNotices = new Map<string, string>()
  /** The exact notice text the running turn carried, set when the engine accepts a send. Delivery is
   *  at-least-once by construction: the notice stays in `pendingRestoreNotices` — so every send and
   *  every recovery resend re-injects it — and is discharged only by a genuine TurnComplete whose
   *  armed text still matches pending. Failed turns need no handling; nothing was removed. A
   *  duplicate re-read instruction is harmless; a silently lost one is the A1 bug. */
  private readonly armedRestoreNotices = new Map<string, string>()
  /** In-flight side questions (btw/aside), keyed `${sessionId}:${asideId}` — so a dismiss can cancel
   *  the throwaway fork, and a session dispose can tear down any aside still streaming. */
  private readonly sideQuestions = new Map<string, SideQuestionHandle>()
  /** sessionId → the safety-git SHA captured at the current turn's start. The live-edits diff uses it
   *  as a PINNED baseline so each edited file shows its cumulative change *this turn* — reading live
   *  HEAD instead would drift forward as later whole-tree checkpoints land (see fs-browse diffFile). */
  private readonly diffBaselines = new Map<string, string>()
  /** One live turn's completion boundary. Safety-git owns the exact pre-turn tree; user-git records
   *  which paths were already loose so a same-file edit can be labelled mixed instead of claimed. */
  private readonly completionTurns = new Map<string, CompletionTurnBoundary>()
  /** Sessions whose turn-boundary checkpoints overlapped before both CompletionTurn records existed.
   *  This closes the small sendTurn race between `working.add` and the serialized baseline result. */
  private readonly completionOverlaps = new Set<string>()
  /** Session → paths a completed turn positively changed and that may still need task-specific
   *  attention. Reconciled against user Git after every turn; unrelated aggregate dirt never enters. */
  private readonly completionPaths = new Map<string, Map<string, { mixed: boolean }>>()
  /** An evidence failure cannot evaporate on the next read-only turn. It stays attached to the session
   * until a whole-project Git probe proves there is no loose work left to attribute. */
  private readonly completionUncertainty = new Map<string, CompletionUncertainty>()
  private readonly completionStates = new Map<string, TaskCompletionState>()
  /** Scheduler-owned project passes that span an engine turn. They never hold checkpointChains while
   *  the engine runs; noteProjectMutation + sendTurn turn-start detection mark competing ownership. */
  private readonly projectMutationScopes = new Set<LiveProjectMutationScope>()
  /** sessionId → which engine drives it, so the daily usage rollup can attribute each turn to the right
   *  subscription (Anthropic vs OpenAI). Set at start, cleared on dispose. */
  private readonly sessionEngines = new Map<string, EngineId>()
  /** sessionId → the driver's own resume blob, stored verbatim (see `ResumeCursorSchema`). This layer
   *  never reads `data`: it hands the blob back on a respawn and reads only the envelope's `resumable`
   *  flag, which is the driver's own answer to "is there a conversation here yet". */
  private readonly resumeCursors = new Map<string, ResumeCursor>()
  /** Sessions whose engine lost the conversation we asked it to reattach, with a clean restart in
   *  flight. Single-flight: a second miss for the same session must not spawn a second replacement. */
  private readonly resumeMissRecovery = new Set<string>()
  /** The turn a resume miss swallowed, replayed once the clean session is up so the user's message is
   * answered instead of vanishing. The engine-expanded send material and untouched visible payload live
   * side by side: recovery may resend the former, but durable replay/failure identity always owns the latter. */
  private readonly pendingTurns = new Map<string, PendingTurn>()
  /** sessionId → tools the engine advertised at session start (system/init). An aside fork denies exactly
   *  this set (by bare name) so it inherits no tool it could attempt or execute — version-proof, unlike a
   *  hand-maintained denylist that rots on an engine bump. */
  private readonly advertisedTools = new Map<string, string[]>()
  /** Latest live capability truth for renderer adoption/reload. Deliberately memory-only: this is
   *  runtime evidence, not transcript or durable replay state. */
  private readonly sessionCapabilities = new Map<string, SessionCapabilitySnapshot>()
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
  /** Sessions whose live engine was actually started or resumed from the phone. Kept separate from
   *  `remoteAttached`: a phone may join a desktop-origin session, and Dreams also use remote-style
   *  headless survival, but neither should ever receive the “From your phone” fallback title. */
  private readonly startedFromRemote = new Set<string>()
  /** In-flight startNewRemote calls, keyed by the caller's chosen session id. A re-send that arrives
   *  while the first start is still spawning rides the same promise instead of racing it — the id isn't
   *  remote-attached yet at that point, so the ownership check alone would let it start a second one. */
  private readonly remoteStarts = new Map<string, Promise<{ sessionId: string }>>()
  /** Replayable event log: the full non-streaming transcript for remote-attached sessions, and the
   *  delegated-task sidechain for ordinary desktop sessions. The latter is deliberately durable too:
   *  a renderer reload must be able to rejoin a live child, and an app crash must preserve the child's
   *  last observable result. Cleared only when the live engine session is truly disposed. */
  private readonly remoteEventLog = new Map<string, ReplayEntry[]>()
  /** Last stable replay identity issued per live session. Loaded from the durable sidecar on attach so
   *  a window close/reopen never reuses an id that is already stamped into a persisted transcript. */
  private readonly remoteReplaySeq = new Map<string, number>()
  /** Accepted phone transport attempts. A lost ack may resend the exact id; answering it from this
   * bounded session-scoped ledger must never run the engine twice. Cleared only at true session end. */
  private readonly acceptedRemoteAttempts = new Map<string, Map<string, AcceptedRemoteAttempt>>()
  /** The accepted attempt currently owning this session's logical terminal. Kept independent from
   * attachment retry bytes so global payload eviction can never strand an `already-running` receipt. */
  private readonly activeRemoteAttemptIds = new Map<string, string>()
  /** Exact attachment bytes for at most one currently active remote attempt per bounded set of sessions.
   * Successful replay rows keep provenance only; a retryable failure promotes these bytes into that
   * unresolved row when the whole payload fits the shared cap. */
  private readonly remoteTurnPayloads = new Map<string, RemoteTurnPayload>()
  /** Live delegated leaves owned by each engine process. This is main-process authority for the one
   *  operation that can destroy them: replacing that process. Keyed by launch id, with task id added
   *  once Claude reports it so targeted Stop can reject stale/non-running cards. */
  private readonly activeSubagents = new Map<
    string,
    Map<string, Extract<EngineEvent, { type: 'SubagentStarted' }>>
  >()
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
  /** First prompt (+ project dir) and latest reply for a headless session awaiting its one-shot
   *  substance retitle at first TurnComplete (mirrors the renderer's). Both cleared when it fires. */
  private readonly remoteFirstPrompt = new Map<string, { prompt: string; cwd: string }>()
  private readonly remoteLastReply = new Map<string, string>()
  /** First accepted human prompt for each live session. Unlike remote replay, this covers Mac-created
   *  sessions before the phone ever opens them, so the launcher never has to identify every row by the
   *  same project-folder placeholder while renderer persistence catches up. Cleared only at true end. */
  private readonly sessionFirstPrompts = new Map<string, string>()
  /** Titling epoch per headless session — a newer titling call invalidates any still-in-flight
   *  predecessor, so a slow birth-title can't resolve late and overwrite the settled substance name. */
  private readonly remoteTitleGen = new Map<string, number>()
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
  /** Latest noteworthy terminal edge for each live session. Main owns only the event fact; a phone keeps
   *  its own seen-completion revision so opening work on one head cannot clear another head's attention. */
  private readonly terminalAttention = new Map<string, RemoteTerminalAttention>()
  /** Same-session admission claims that span model realignment and every awaited pre-send step. Without
   *  this seam, two heads could both pass `working`, or Stop could hit an idle child during checkpointing
   *  only for the prepared turn to start afterward. Process teardown preserves the exact generation;
   *  the admitting send, Stop, or a true session end releases it. */
  private readonly turnAdmissions = new Map<string, TurnAdmission>()
  private nextTurnAdmissionGeneration = 0
  /** Accepted turns retain their admission identity until a genuine terminal event. Stop can therefore
   *  wait for delegated children without accidentally interrupting a successor on the same warm child. */
  private readonly acceptedTurns = new Map<string, AcceptedTurn>()
  /** Session-scoped process replacement ownership. A posture respawn and a turn-driven reattach are both
   *  destructive to the old child, so they serialize with sends and with each other across every await. */
  private readonly processReplacements = new Map<string, ProcessReplacementClaim>()
  private nextProcessReplacementGeneration = 0
  /** sessionId → the first line of the agent's latest reply, so the phone's project screen can show
   *  what a live session is doing ("Wiring the date picker…") without an event stream at browse level.
   *  In-memory, live sessions only — decoration, never persisted. */
  private readonly lastLines = new Map<string, string>()
  /** sessionId → epoch ms of the last transcript-bearing engine activity. It lets unattended work
   *  distinguish a busy turn from a silent stall, and prevents corpus certification from accepting a
   *  renderer snapshot that predates a delegated lifecycle change. */
  private readonly engineEventAt = new Map<string, number>()
  /** sessionId → the current turn's top-level reply, ACCUMULATED across blocks (same reason the loop
   *  driver accumulates: a final message can arrive as several AssistantBlocks, and last-write-wins
   *  would let a "did work" + quiet-token pair read as a quiet night). Reset on each turn's send,
   *  capped, read by the dream's digest after the turn ends. In-memory, live sessions only. */
  private readonly turnReplies = new Map<string, string>()
  /** Broker auto-recovery: sessions with a reconnect respawn in flight — so a burst of "koda_broker is
   *  not connected" tool errors (the engine keeps trying every queued tool) triggers ONE respawn, not
   *  one per failed tool. Added when recovery starts, removed when the respawn settles. */
  private readonly recoveringBroker = new Set<string>()
  /** sessionId → recovery streak: how many reconnects we've done and when the last one settled. Rate-
   *  limits repeats (cooldown) and caps a flapping broker at BROKER_RECOVERY_MAX before giving up. */
  private readonly brokerRecovery = new Map<string, { count: number; at: number }>()
  /** Session → logical admission generation awaiting an auto-resume turn after a broker reconnect.
   *  The generation keeps a delayed recovery signal from ever nudging a successor turn that reused the
   *  same public session id. `undefined` covers legacy/internal turns with no admitted human boundary. */
  private readonly resumeAfterReconnect = new Map<string, number | undefined>()
  /** sessionId → resolver for `awaitTurnEnd`, the overnight dream's event-driven "did the turn really
   *  end" signal (W3). Fired only by a genuine TurnComplete or a truly fatal EngineError — NOT by
   *  `working` flipping false, which a benign broker-recovery respawn does too (see `forward`). Must
   *  survive a respawn's `dispose()` for the same reason `resumeAfterReconnect`/`pendingWorkflowResults`
   *  do (dispose() is also the respawn teardown path); cleared on a true end by `forgetSession`. */
  private readonly turnEndWaiters = new Map<string, () => void>()
  /** `${sessionId}:${toolUseId}` → every stop sweep currently parked on that child. A SET, not one
   *  resolver: two overlapping stops (the user pressing Stop twice, or a window close racing a remote
   *  stop) both wait on the same child, and one terminal event has to release both. Each sweep also
   *  removes only its OWN entry when its bound expires, so a stale timeout can't strand a newer sweep. */
  private readonly childEndWaiters = new Map<string, Set<() => void>>()
  /** Heartbeat for the account usage poll (see `pollUsage`), and the last poll's start time — the
   *  turn-end trigger debounces against it so a burst of short turns can't spawn a poll per turn. */
  private usageTimer: ReturnType<typeof setInterval> | null = null
  /** The heartbeat's power-aware gate (probe-governor.ts): the gauge is worth a subprocess when someone
   *  can see it, not while the Mac is locked or has been in the background all afternoon. The turn-end
   *  trigger below is deliberately NOT gated — that's real activity, including a phone-driven turn. */
  private usageProbe: GovernedProbe | null = null
  private lastUsagePoll = 0

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
          // Deliberately NOT returning the port: a number in the transcript is a copy of the port the
          // agent can never invalidate, and a later restart moves it silently. The url is valid now;
          // app_status re-reads it.
          const { url } = await startApp(dir, projectPath)
          return { started: true, url }
        },
        stop: async (sessionId, path) => {
          const { dir } = this.appTarget(sessionId, path)
          await stopApp(dir)
          return { stopped: true }
        },
        status: async (sessionId) => appStatus(this.projectPathFor(sessionId)),
      },
      // "Keep this as a document" (document-workspace.md, the magic layer §1) — the user asked for the
      // conversation to become a document, so the agent writes it through Koda's own creation path.
      // The sessionId is the point: it becomes the document's `source:` provenance, and it is the one
      // field the agent could never supply itself. No window required — a phone-driven session may keep
      // a document too, so this resolves the root the same way the mini-app verbs do.
      (sessionId, args) => keepDocument(this.projectPathFor(sessionId), args, sessionId),
    )
    // Seed the DEFAULT posture new sessions start at (per-session overrides come from the renderer).
    this.gate.setDefaultMode(loadApprovalMode())
    // Seed whether the agent may start the preview server without a confirm (Settings → previewAutoStart).
    this.gate.setPreviewAutoStart(loadPreviewAutoStart())
    // projectDirs are repopulated lazily per window when it loads its project's sessions
    // (loadProjectSessions) — there's no global blob to read at construction time anymore (v2).

    // Plan gauge: seed it shortly after boot (the disk-restored windows show meanwhile), then keep it
    // fresh on a heartbeat. Independent of whether any session is running — the windows are an account
    // fact, and the gauge should read true the moment a window opens.
    if (!isE2EProfile()) {
      setTimeout(() => void this.pollUsage(), USAGE_POLL_STARTUP_MS)
      this.usageProbe = governProbe('account-usage', USAGE_POLL_INTERVAL_MS, {
        wake: () => void this.pollUsage(), // sitting back down shows a current gauge, not a five-minute-old one
        // What this writes is not only the desktop gauge: the phone's usage readout reads the same
        // snapshot back (remote/ops.ts), and the overnight dream refuses to run when it's above 80%.
        // A locked screen therefore only STRETCHES this poll. Pausing it would pin both of those to
        // whatever the number happened to be when the lid closed.
        pauseOnLock: false,
      })
      this.usageTimer = setInterval(() => {
        if (this.usageProbe?.due()) void this.pollUsage()
      }, USAGE_POLL_INTERVAL_MS)
    }
  }

  /**
   * Start a session. Async because the broker's HTTP listener must be UP (its port baked into the
   * engine's mcp-config) before we spawn — a missing broker means tools silently bypass the gate
   * (backend-architect #3). A bind failure rejects here, so session start fails loudly.
   */
  async start(
    opts: {
      cwd?: string
      /** Spawn under this exact id; omitted ⇒ a fresh one is minted. */
      sessionId?: string
      /** The driver's own resume blob, passed straight through. Present ⇒ the driver reattaches its
       *  conversation if IT judges the blob resumable; absent ⇒ a clean conversation under this id. */
      resumeCursor?: ResumeCursor
      planMode?: boolean
      model?: string
      effort?: string
      engineId?: EngineId
      replaySeq?: number
      ownerWindowId?: number
      /** An infrastructure recovery has no live engine it can preserve. Mark all delegated work unknown
       *  before replacing it; ordinary posture/model respawns omit this and are refused while it runs. */
      abandonActiveDelegation?: boolean
      /** Internal ownership proofs. A turn-driven realignment carries its admission; an eager posture
       *  respawn reserves replacement ownership before its first await. */
      turnAdmissionClaim?: TurnAdmission
      processReplacementClaim?: ProcessReplacementClaim
    } = {},
  ): Promise<{ sessionId: string; cwd: string }> {
    requireRealAccountAccess()
    const requestedSessionId = opts.sessionId
    const engineId = opts.engineId ?? (requestedSessionId ? this.sessionEngines.get(requestedSessionId) : undefined) ?? 'claude'
    // A fresh session runs in its OWNING window's project (one-project-per-window); a resumed session
    // passes its stored cwd explicitly. Fall back to process.cwd() only if neither is known.
    const cwd =
      opts.cwd ?? (opts.ownerWindowId != null ? projectPathForWindow(opts.ownerWindowId) : undefined) ?? process.cwd()
    const sessionId = requestedSessionId ?? randomUUID()
    let replacementClaim = opts.processReplacementClaim
    let ownsReplacementClaim = false
    let processGeneration: symbol | undefined
    if (requestedSessionId && this.sessions.has(sessionId)) {
      if (replacementClaim) {
        if (this.processReplacements.get(sessionId) !== replacementClaim)
          throw new Error('That session replacement is no longer current.')
      } else {
        const admission = this.turnAdmissions.get(sessionId)
        if (admission && admission !== opts.turnAdmissionClaim)
          throw new Error('A turn is already starting. Let it finish before replacing this session.')
        if (this.working.has(sessionId) && !opts.abandonActiveDelegation)
          throw new Error('A turn is still running. Let it finish or stop it before replacing this session.')
        replacementClaim = this.reserveProcessReplacement(sessionId)
        ownsReplacementClaim = true
      }
    }
    const assertReplacementCurrent = (): void => {
      if (replacementClaim && this.processReplacements.get(sessionId) !== replacementClaim)
        throw new Error('That session replacement is no longer current.')
      if (
        opts.turnAdmissionClaim &&
        this.turnAdmissions.get(sessionId) !== opts.turnAdmissionClaim
      )
        throw new Error('That turn is no longer allowed to replace this session.')
      if (
        processGeneration &&
        this.sessionGenerations.get(sessionId) !== processGeneration
      )
        throw new Error('That session process is no longer current.')
    }
    // Per-install preference, snapshotted for this engine process so Claude and Codex have the same
    // contract: changing it affects the next session/reattach, never one live conversation mid-turn.
    // Dream/REM sessions are unattended system work. They are reserved in dreamSessions before start()
    // enters, so do not inject human-session delegation pressure or even read that preference here.
    const orchestratorSession =
      !this.dreamSessions.has(sessionId) && loadSessionAgentRole() === 'orchestrator'

    // Broker up + this session registered (token minted) BEFORE spawn. For Claude it's the permission
    // transport (`--permission-prompt-tool` → in-process MCP) AND the capability tools; for Codex,
    // approvals are native (the gate is wired directly) but the broker still serves Koda's capability
    // tools (preview/recovery/ensure_tool) over its streamable-HTTP MCP endpoint — minus `approve`.
    // A resumed session keeps its original id (`--resume`; spike/resume) so renderer routing + the
    // recovery dir map stay aligned across the restart.
    try {
      await this.broker.ensureListening()
      assertReplacementCurrent()
    // sessionId → spawn under that id; omitted ⇒ mint one. Whether the engine reattaches is entirely
    // `resumeCursor`'s business, and the driver's judgment call.
    if (this.sessions.has(sessionId) && this.hasOwnedDelegation(sessionId)) {
      if (!opts.abandonActiveDelegation)
        throw new Error('Delegated work is still running. Let it finish or stop it before changing this session.')
      this.markActiveDelegationUnknown(sessionId)
    }
    // A respawn tears down the old process before starting the replacement, and dispose() drops the
    // cursor as normal teardown — so take the caller's blob, or the live one, before that happens.
    const resumeCursor = opts.resumeCursor ?? this.resumeCursors.get(sessionId)
    // Respawn safety: if a child for this id is still alive (a Plan-mode/engine/model switch drops the
    // engine and reattaches on the next turn without disposing), tear it down BEFORE re-registering.
    // Otherwise the old child's late 'close' could unregister the NEW child's broker route — two
    // children, one id, one broken /mcp/<id>. Disposal is bounded; the generation claim immediately
    // below makes a post-timeout callback stale before the replacement registers its route.
    if (this.sessions.has(sessionId)) await this.dispose(sessionId)
    assertReplacementCurrent()
    // Claim this id before any further await. If the old driver's bounded dispose timed out, its late
    // close now carries the previous token and is ignored even during the replacement's broker setup.
    processGeneration = Symbol(sessionId)
    this.sessionGenerations.set(sessionId, processGeneration)
    if (opts.replaySeq !== undefined)
      this.remoteReplaySeq.set(
        sessionId,
        Math.max(this.remoteReplaySeq.get(sessionId) ?? 0, opts.replaySeq),
      )
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
    if (resumeCursor?.resumable) this.remoteTitled.add(sessionId)
    // Codex omits the `approve` tool (native approvals); both get the capability tools. The mini-app
    // lifecycle verbs ride the dogfood flag (read per session start — seam ② of the release gate).
    const miniAppsWired = loadMiniAppsEnabled()
    const pwWired = playwrightWired()
    const bundledPlaybooksExpected = kodaPlaybooksExpected(cwd, {
      includeBrowser: pwWired,
      includeGated: miniAppsWired,
    })
    // Resolve Claude's optional gallery delivery once and use that same answer for both argv and the
    // expected-vs-observed attestation. Codex always gets its Koda plugin's code-review playbook when
    // isolated-home setup succeeds; a setup failure should therefore read degraded, never disabled.
    const globalSkillsPlugin = resolveGlobalSkillsPlugin(app.getPath('userData'))
    const claudePlaybooksExpected = bundledPlaybooksExpected || globalSkillsPlugin !== null
    const codexPlaybooksExpected = true
    await this.broker.register(sessionId, {
      includeApprove: engineCapabilities(engineId).approvals === 'broker',
      includeMiniApps: miniAppsWired,
    })
    // An engine that carries Plan mode as turn text (Codex) has no read-only mode of its own, so the
    // gate becomes the fence for it. Set from the capability, and cleared for an engine that enforces
    // its own — the same session id can be respawned onto the other engine.
    this.gate.setPlanFence(sessionId, engineCapabilities(engineId).planMode === 'turnText')
    // Register window ownership BEFORE spawn so the very first event (system/init → SessionStarted,
    // or a fatal spawn 'error') routes to the owning window instead of falling into a gap and being
    // dropped (adapter emits these as soon as the child starts).
    if (opts.ownerWindowId != null) addSessionToWindow(opts.ownerWindowId, sessionId)

    // DRIVER SELECTION — one of the two places in Koda that names an engine on purpose (the other is
    // askSideQuestion below). Choosing which driver to launch is what a registry does; every question
    // ABOUT an engine is answered by `engineCapabilities`/`engineProfile` instead.
    //
    // Codex: native per-tool approvals (so the gate is wired directly, no `approve` tool), but the
    // broker still serves Koda's capability tools over MCP. Same engine-neutral gate.decide → same
    // checkpoint-before-mutation + per-cwd mutex + the 3-tier posture. The shared behavior pack
    // reaches Codex through developerInstructions plus its isolated native skills plugin.
    if (engineId === 'codex') {
      const token = this.broker.tokenFor(sessionId)
      // One-time (per app version) setup of Codex's isolated home: seed the login + install Koda's
      // bundled skills/subagents plugin. Single-flight + fail-soft — a setup failure never blocks the
      // session (skills are additive). CODEX_HOME itself is applied per-spawn in buildEngineEnv.
      await ensureCodexHome({
        appVersion: app.getVersion(),
        resourcesPath: this.resourcesPath,
      })
      assertReplacementCurrent()
      // Billing: in API mode, write the OpenAI key into the isolated home (Codex ignores the env key for
      // auth); in subscription mode, restore the ChatGPT login. Read live so a mode change applies next
      // session. Runs after ensureCodexHome (which seeds the login) and before the spawn's auth probes.
      const codexApiKey = this.effectiveApiKey('codex')
      await reconcileCodexAuth({ resourcesPath: this.resourcesPath, apiKey: codexApiKey })
      assertReplacementCurrent()
      try {
        const session = startCodexSession(
          (e) => this.forwardProcessEvent(e, processGeneration),
          {
            sessionId,
            cwd,
            decide: (sid, req) => this.gate.decide(sid, req),
            // The SAME compact constitution, routes, and project card Claude gets, delivered as additive
            // developerInstructions. brokerWired: true — the Codex path always attaches the broker
            // (brokerUrl below), so any broker-gated routes apply.
            // '' (nothing to say at all) ⇒ undefined so the driver omits the field. See assembleGuardrailText.
            developerInstructions:
              assembleGuardrailText({
                cwd,
                resourcesPath: this.resourcesPath,
                brokerWired: true,
                miniAppProject: projectHasMiniApp(cwd),
                // Same condition ensureCodexHome used to materialize the staging skills into the
                // Codex plugin, so the app-ask routing rule never names a skill that isn't installed.
                miniAppsWired:
                  miniAppsWired && !!resolveStagingPack({ resourcesPath: this.resourcesPath }),
                critiqueOn: loadCritiquePass(),
                orchestratorSession,
                engine: 'codex',
              }) || undefined,
            // Posture is NOT baked in here — it seeds the driver's per-turn steering block, which is
            // rebuilt on every turn and updated in place by setSessionApprovalMode (no respawn).
            approvalMode: this.gate.getSessionMode(sessionId),
            // The gate judges a running turn by the mode that turn was steered with. Released at
            // TurnComplete in forward(), and on a process exit by the gate itself.
            onTurnSteered: (mode) => this.gate.pinTurnMode(sessionId, mode),
            skillConfig: codexSkillConfig(cwd, app.getVersion(), {
              playwrightWired: pwWired,
              miniAppsWired,
            }),
            playbooksExpected: codexPlaybooksExpected,
            model: opts.model,
            effort: opts.effort,
            // The driver's own blob, verbatim — it decides whether that thread is worth reattaching.
            resumeCursor,
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
            onClose: (id) => this.handleClose(id, processGeneration),
          },
        )
        try {
          assertReplacementCurrent()
        } catch (error) {
          await session.dispose()
          throw error
        }
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
      // The staging pack (built-but-unshipped skills like create-mini-app) rides only when the
      // mini-apps dogfood flag is on — that's how a normal release ships without the half-built
      // skill. Resolved once: the same answer wires the --plugin-dir AND the pack's app-ask routing
      // rule, so the rule can never name a skill that didn't load.
      const stagingPackDir = miniAppsWired
        ? (resolveStagingPack({ resourcesPath: this.resourcesPath })?.dir ?? null)
        : null
      const sessionOpts: SessionOpts = {
        sessionId,
        cwd,
        // The driver's own blob, verbatim — it decides whether there is a conversation to reattach.
        resumeCursor,
        resourcesPath: this.resourcesPath,
        // Broker MCP config + (when the optional browser-testing capability is wired) the Playwright
        // server merged in. Its tools still route through `--permission-prompt-tool` → our gate.
        mcpConfigJson: applyPlaywrightToMcpConfig(this.broker.mcpConfig(sessionId)),
        // Intent only. The adapter still waits for Claude's native init inventory before claiming the
        // browser capability is ready.
        browserWired: pwWired,
        playbooksExpected: claudePlaybooksExpected,
        // Deny the browser-verify skill unless Playwright is wired (no guidance for absent tools).
        extraDisallowedTools: [
          ...playwrightDisallowedTools(),
          ...projectSkillCollisionNames(cwd).map((name) => `Skill(${name})`),
        ],
        // Faced project → the pack's summon-pill rule assembles (the agent learns Koda's "Ask or fix
        // this app" pill is claimable over the face bridge instead of designing around it blind).
        miniAppProject: projectHasMiniApp(cwd),
        miniAppsWired: stagingPackDir !== null,
        critiqueOn: loadCritiquePass(),
        orchestratorSession,
        // Koda-managed global skills the user turned on in the gallery (null when none active), the
        // standalone Deep Review plugin, plus the staging pack when the dogfood flag is on.
        extraPluginDirs: [
          globalSkillsPlugin,
          resolveDeepReviewPlugin({ resourcesPath: this.resourcesPath })?.dir ?? null,
          stagingPackDir,
        ].filter(
          (d): d is string => d !== null,
        ),
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
        onClose: (id) => this.handleClose(id, processGeneration),
      }
      assertReplacementCurrent()
      const session = startClaudeSession(
        (e) => this.forwardProcessEvent(e, processGeneration),
        sessionOpts,
      )
      try {
        assertReplacementCurrent()
      } catch (error) {
        await session.dispose()
        throw error
      }
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
    } finally {
      // A failed pre-spawn/setup path owns no driver that can reap this claim. Never clear a newer
      // start's token, and retain the token for a successfully installed child until its exact close.
      if (
        processGeneration &&
        this.sessionGenerations.get(sessionId) === processGeneration &&
        !this.sessions.has(sessionId)
      )
        this.sessionGenerations.delete(sessionId)
      if (ownsReplacementClaim && replacementClaim)
        this.releaseProcessReplacement(sessionId, replacementClaim)
    }
  }

  /** The API key to inject for a spawn, or null to bill the subscription. 'api' → always the key;
   *  'auto' → the key only while a confirmed plan-limit fallback window is still open; 'subscription' →
   *  never. A missing key always degrades to subscription (never fails the spawn). */
  private effectiveApiKey(engine: EngineId = 'claude'): string | null {
    // Each engine bills its own provider account, so its choice lives in its own setting (the profile
    // names it) and its key in its own slot. Only an engine whose capabilities claim the plan-limit
    // auto-fallback can be in 'auto' at all.
    const mode = loadSettings()[engineProfile(engine).billingModeSetting]
    if (mode === 'api') return getApiKey(engine)
    if (mode !== 'auto' || !engineCapabilities(engine).apiKeyFallback) return null
    return Date.now() / 1000 >= this.apiFallbackUntil ? null : getApiKey(engine)
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
    images?: TurnAttachment[],
    // Where the turn came from. A 'remote' turn (the phone) never ran through the owner window's
    // dispatchTurn, so its user bubble has to be echoed into that window (below); a 'local' turn already
    // pushed its own optimistic bubble there, so echoing it would duplicate the message.
    origin: 'local' | 'remote' = 'local',
    // Infrastructure recovery resumes the SAME logical human turn. It must not create a new safety/user
    // Git boundary, reset the reply, or consume results intended for the next real human message.
    internal: {
      logicalContinuation?: 'broker-recovery' | 'resume-miss'
      projectMutationScope?: ProjectMutationScope
      attemptId?: string
      clientTurnId?: string
    } = {},
  ): Promise<RemoteTurnReceipt> {
    requireRealAccountAccess()
    const newRemoteAttempt = origin === 'remote' && !internal.logicalContinuation
    const attemptFingerprint =
      newRemoteAttempt && internal.attemptId
        ? remoteTurnFingerprint(text, images)
        : undefined
    if (newRemoteAttempt && internal.attemptId) {
      const accepted = this.acceptedRemoteAttempts.get(sessionId)
      const prior = accepted?.get(internal.attemptId)
      if (prior) {
        if (
          prior.clientTurnId !== internal.clientTurnId ||
          prior.fingerprint !== attemptFingerprint
        )
          throw new Error('This turn attempt was already used for a different message or attachment payload.')
        return { status: prior.state === 'running' ? 'already-running' : 'already-complete' }
      }
    }
    // Main is the final admission boundary for every head. A cold phone can open before its local stream
    // catches up, and a reconnect drain can race launcher state; neither may inject a second top-level
    // turn into the same engine or skip an unanswered prompt. Delegation alone is deliberately absent:
    // once the parent ends, a human follow-up is supported while its background delegate settles.
    // Broker recovery is the same logical turn, so it is the sole admission bypass.
    const claimsAdmission = !internal.logicalContinuation
    let admission: TurnAdmission | undefined
    let workingClaimed = false
    if (claimsAdmission) {
      if (this.processReplacements.has(sessionId))
        throw new Error('This session is changing settings. Let that finish before sending another message.')
      if (this.working.has(sessionId) || this.turnAdmissions.has(sessionId))
        throw new Error('A turn is already running. Let it finish or stop it before sending another message.')
      if (this.gate.pendingRequests(sessionId).length > 0)
        throw new Error('This session is waiting for your answer. Resolve it before sending another message.')
      admission = { generation: ++this.nextTurnAdmissionGeneration, cancelled: false }
      this.turnAdmissions.set(sessionId, admission)
    }
    const releaseAdmission = (): boolean => {
      if (!admission || this.turnAdmissions.get(sessionId) !== admission) return false
      this.turnAdmissions.delete(sessionId)
      return true
    }
    const throwIfAdmissionCancelled = (): void => {
      if (!admission?.cancelled) return
      // Only this exact generation may release session-level liveness. A true end can retire it and a
      // later session can reuse the id before an old await resumes; that successor remains untouched.
      if (releaseAdmission() && workingClaimed) {
        this.working.delete(sessionId)
        this.pendingTurns.delete(sessionId)
        this.maybeFinishCompletionTurn(sessionId)
      }
      throw new Error('This turn was stopped before it reached the engine.')
    }
    // Invariant enforced here, at the one point every turn (local AND remote) funnels through: the live
    // engine must be running the session's INTENDED model/effort/engine before the turn goes out. The
    // engine can't switch these on a live -p process, so if what we actually spawned with has drifted from
    // the intent — a pick that landed after spawn (the desktop reattaches lazily; a phone turn arrives here
    // directly), or a first spawn that never carried the pick — respawn on the intent first. Comparison,
    // not a remembered flag: `spawnedWith` is set only where the child truly launches, so no spawn path can
    // forget to mark a change. The admission guard above runs before drift correction and `working`, so a
    // stale head cannot respawn away an in-flight turn or strand an approval.
    const cwd = this.projectDirs.get(sessionId)
    let session: EngineSession
    try {
      this.claimProjectMutationScopeTurn(sessionId, internal)
      if (cwd && this.sessions.has(sessionId) && this.spawnDrifted(sessionId)) {
        const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
        const engineId = this.sessionEngines.get(sessionId) ?? 'claude'
        // Keep actual spawn truth unchanged until start() launches the replacement. The admission claim
        // above survives that method's internal dispose and keeps another head out of the await gap.
        // Hand the live cursor back and let the driver decide: before the first turn there is nothing to
        // reattach to, so it spawns clean under the same id instead of racing the engine's own init.
        await this.start({
          sessionId,
          cwd,
          model,
          effort,
          engineId,
          planMode: this.gate.getSessionMode(sessionId) === 'plan',
          turnAdmissionClaim: admission,
        })
      }
      session = this.require(sessionId)
      // start() awaits broker/driver setup. Even though public posture mutations are locked out during
      // that gap, verify the replacement still matches current intent before converting the admission
      // claim into `working`; an internal or future intent writer must never send on the wrong child.
      if (this.spawnDrifted(sessionId))
        throw new Error('The session settings changed while its engine was starting. Try sending again.')
      throwIfAdmissionCancelled()
    } catch (error) {
      releaseAdmission()
      throw error
    }
    this.working.add(sessionId)
    workingClaimed = true
    const continuedBoundary = internal.logicalContinuation
      ? this.completionTurns.get(sessionId)
      : undefined
    const continuingLogicalTurn = !!continuedBoundary && continuedBoundary.cwd === cwd
    // A background delegate can keep turn A's completion boundary open after its parent ends. A
    // follow-up is a distinct engine/transcript turn, but the session's one completion slot must retain
    // A's earlier tree until every writer it owns settles; replacing it with turn B's checkpoint would
    // leave the delegate's earlier writes outside the eventual attribution window.
    const retainedDelegationBoundary =
      !continuingLogicalTurn && this.hasOwnedDelegation(sessionId)
        ? this.completionTurns.get(sessionId)
        : undefined
    // A scheduler scope spans a whole engine turn without holding checkpointChains. Starting any OTHER
    // turn in that tree marks the tidy's eventual completion attribution ambiguous before the new turn
    // reaches a tool. No live-tree rollback is ever authorized from this signal.
    if (cwd) {
      const root = realpathOrSelf(cwd)
      for (const scope of this.projectMutationScopes) {
        if (scope.sessionId !== sessionId && realpathOrSelf(scope.cwd) === root) scope.ambiguous = true
      }
    }
    // Concurrent turns in one working tree make path ownership ambiguous. Mark both sides now so the
    // scheduler can see it; neither side badges the user for it. Each turn still claims what changed
    // in its own window, so a shared file lands in both groups and Changes names the other toucher.
    let overlappingWriters = this.completionOverlaps.delete(sessionId)
    if (cwd) {
      for (const otherId of this.working) {
        if (otherId === sessionId || this.projectDirs.get(otherId) !== cwd) continue
        const turn = this.completionTurns.get(otherId)
        if (turn) turn.overlappingWriters = true
        else this.completionOverlaps.add(otherId)
        overlappingWriters = true
      }
    }
    const retainedCompletionBoundary = continuedBoundary ?? retainedDelegationBoundary
    if (retainedCompletionBoundary && overlappingWriters)
      retainedCompletionBoundary.overlappingWriters = true
    this.lastActivityAt.set(sessionId, Date.now()) // float this session to the top of the launcher
    if (!continuingLogicalTurn)
      this.turnReplies.delete(sessionId) // fresh turn, fresh reply accumulator (lastAssistantReply)
    this.noteEngineActivity(sessionId) // feeds the dream scheduler's quiet clock (dream turns excluded)
    // Split attachment provenance before recording the user turn. Exact bytes are live send material,
    // not ordinary transcript history: successful replay keeps only media type/name. A bounded copy is
    // promoted into replay solely when this attempt fails and the phone must be able to retry it.
    const docs = images?.filter((i) => !i.mediaType.startsWith('image/')) ?? []
    const inline = images?.filter((i) => i.mediaType.startsWith('image/'))
    const hadImages = !!inline?.length
    const hadAttachments = !!images?.length
    const attachmentProvenance: AttachmentProvenance[] | undefined = images?.length
      ? images.map(({ mediaType, name }) => ({ mediaType, ...(name ? { name } : {}) }))
      : undefined
    const logicalAlreadyRecorded =
      !!internal.clientTurnId &&
      this.remoteEventLog
        .get(sessionId)
        ?.some(
          (entry) =>
            entry.type === 'RemoteUserTurn' && entry.clientTurnId === internal.clientTurnId,
        ) === true
    const previousRemotePayload = this.remoteTurnPayloads.get(sessionId)
    let remoteReplaySeqForAttempt: number | undefined
    let userTurnPublished = false
    const publishUserTurn = (): void => {
      if (
        userTurnPublished ||
        internal.logicalContinuation ||
        continuingLogicalTurn ||
        !this.remoteAttached.has(sessionId)
      )
        return
      userTurnPublished = true
      // Engine events never echo the human prompt, so replay owns this row. Remote-origin rows wait
      // until the driver accepts the turn: a stopped/preflight-failed retry cannot supersede the prior
      // durable failure or leak an un-retractable user bubble to the desktop owner.
      const replayTurn = this.recordRemoteEntry({
        type: 'RemoteUserTurn',
        sessionId,
        // Keep the exact prompt. `(image)` is a legacy display sentinel, not safe retry text.
        text,
        ...(internal.clientTurnId ? { clientTurnId: internal.clientTurnId } : {}),
        hadAttachments,
        ...(attachmentProvenance?.length ? { attachments: attachmentProvenance } : {}),
        hadImages,
      })
      remoteReplaySeqForAttempt = replayTurn.replaySeq
      try {
        const owner = contextForSession(sessionId)
        if (owner) {
          // A remote turn needs its missing user bubble appended. A local turn already has an optimistic
          // bubble, but it still needs the replay identity stamped so a later adoption recognizes it as
          // the same turn. The renderer distinguishes those two cases with `append`.
          const win = owner.win
          if (win && !win.isDestroyed())
            win.webContents.send(IpcChannels.sessionRemoteUserTurn, {
              sessionId,
              text,
              ...(internal.clientTurnId ? { clientTurnId: internal.clientTurnId } : {}),
              hadAttachments,
              ...(attachmentProvenance?.length ? { attachments: attachmentProvenance } : {}),
              hadImages,
              ...(inline?.length ? { images: inline } : {}),
              replaySeq: replayTurn.replaySeq,
              append: origin === 'remote' && !logicalAlreadyRecorded,
            })
        } else if (origin === 'remote' && cwd) {
          // Still windowless — no renderer to name it. Title on the engine turn path (instant first-words
          // title, then the selected generated-text writer), persisted into the store the phone reads from.
          this.titleRemoteSession(sessionId, cwd, text)
        }
      } catch (error) {
        // The engine already owns this turn. A renderer-close race or best-effort title write must not
        // turn a successful driver acceptance into a rejected receipt or clear canonical liveness.
        log.warn(
          'remote',
          'accepted user turn could not be published to its owner',
          error instanceof Error ? error.message : error,
        )
      }
    }
    // Desktop already rendered its optimistic row. Preserve its existing early identity stamp; only a
    // remote-origin row must wait for the Mac's synchronous engine-acceptance boundary.
    if (origin !== 'remote') publishUserTurn()
    // Label the checkpoint with the prompt text; fall back when it's an image-only turn.
    if (cwd && !continuingLogicalTurn) {
      const baseline = await this.runExclusive(cwd, () => this.safeCheckpointResult(cwd, text || '(image)'))
      throwIfAdmissionCancelled()
      // Another turn or a human edit can begin while either pre-turn probe is in flight, before this
      // boundary exists. Consume that late marker at the last possible moment so the first of two
      // concurrent writers cannot incorrectly claim the shared delta.
      overlappingWriters ||= this.completionOverlaps.delete(sessionId)
      let userGit: Awaited<ReturnType<typeof completionGitSnapshot>> | undefined
      if (
        !retainedDelegationBoundary ||
        this.completionTurns.get(sessionId) !== retainedDelegationBoundary
      ) {
        userGit = await completionGitSnapshot(cwd)
        throwIfAdmissionCancelled()
      }
      // Use the exact checkpoint result atomically, after every pre-boundary await. Reading safety HEAD
      // in a second call could silently reuse an older turn after a failed checkpoint and attribute
      // someone else's delta to this task; publishing it before Stop settles creates a phantom turn.
      if (baseline) this.diffBaselines.set(sessionId, baseline.id)
      else this.diffBaselines.delete(sessionId)
      if (
        retainedDelegationBoundary &&
        this.completionTurns.get(sessionId) === retainedDelegationBoundary
      ) {
        retainedDelegationBoundary.overlappingWriters ||= overlappingWriters
      } else {
        this.completionTurns.set(sessionId, {
          cwd,
          safetyCommit: baseline?.id ?? null,
          userGit: userGit!,
          mutationSeen: false,
          overlappingWriters,
        })
      }
    }
    // Split document attachments out of a phone turn: save each to `.koda/scratch/` and hand the
    // engine the path (attachedFilesNote — the same note the desktop composer appends), leaving only
    // real images to go inline. Best-effort like the desktop: a failed save just drops off the list.
    let engineText = text
    if (docs.length && cwd) {
      const saved = await Promise.all(
        docs.map((d) =>
          saveScratchWithRetention(cwd, d.mediaType, d.dataBase64, d.name).catch(() => null),
        ),
      )
      throwIfAdmissionCancelled()
      const paths = saved.filter((p): p is string => p !== null)
      if (paths.length) engineText = `${engineText}\n\n${attachedFilesNote(paths)}`
    }
    throwIfAdmissionCancelled()
    // Phone turns only: mirror what the desktop composer already did renderer-side (store.send) — write
    // each real image to `.koda/scratch/` so a phone-dropped screenshot survives the turn and shows up in
    // the Recent images strip (which only scans that folder). It still goes inline to the engine below — a
    // path note is doc-only. Guarded to 'remote' so a desktop image (saved by the renderer) isn't written
    // twice. Best-effort; once a file lands, nudge the owning window to refresh the strip (this save races
    // the sync user-turn forward above, so the notify comes after the write, not on turn receipt).
    if (newRemoteAttempt && inline?.length && cwd) {
      void Promise.all(
        inline.map((i) =>
          saveScratchWithRetention(cwd, i.mediaType, i.dataBase64, i.name).catch(() => null),
        ),
      ).then((saved) => {
        if (!saved.some((p) => p)) return
        const win = contextForSession(sessionId)?.win
        if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.scratchChanged)
      })
    }
    // Ride any finished background-workflow results in ahead of the human's words, framed as context so
    // the agent picks up where it left off. Only what the ENGINE sees is augmented — the user's visible
    // bubble, replay entry, checkpoint label and titling above all use the untouched `text`.
    const pending = continuingLogicalTurn ? '' : this.drainWorkflowResults(sessionId)
    const withResults = pending ? (engineText ? `${pending}\n\n${engineText}` : pending) : engineText
    // A turn written to a child that is about to die on a resume miss goes nowhere, and the user would
    // watch their message sit unanswered. Hold it until the turn actually completes, so the recovery can
    // replay it into the clean session. Overwritten each turn, so it is never more than one message.
    // Held WITHOUT the restore notice: the replay re-enters this method, and each send injects the
    // currently pending notice exactly once.
    // A continuation is infrastructure, not a new human turn. Keep the first accepted turn's untouched
    // visible payload and original engine material authoritative across any number of broker/resume-miss
    // respawns; otherwise a later miss could replay a broker nudge or path-expanded text as the user's row.
    if (!internal.logicalContinuation || !this.pendingTurns.has(sessionId))
      this.pendingTurns.set(sessionId, {
        engineText: withResults,
        ...(inline?.length ? { inlineImages: inline } : {}),
        visible: {
          text,
          ...(images?.length ? { attachments: images } : {}),
          origin,
          ...(internal.attemptId ? { attemptId: internal.attemptId } : {}),
          ...(internal.clientTurnId ? { clientTurnId: internal.clientTurnId } : {}),
        },
      })
    // A restore notice rides even a logical continuation: the tree moved regardless of whose turn this
    // is, and an agent resuming mid-turn is exactly the one holding the stalest file contents.
    const notice = this.pendingRestoreNotices.get(sessionId) ?? ''
    throwIfAdmissionCancelled()
    let sent: boolean | void
    let acceptedAdmission: boolean
    try {
      sent = session.sendTurn(
        notice ? (withResults ? `${notice}\n\n${withResults}` : notice) : withResults,
        inline?.length ? inline : undefined,
      )
      acceptedAdmission =
        sent !== false && !!admission && this.turnAdmissions.get(sessionId) === admission
    } catch (error) {
      // A synchronous driver write failure is the throwing form of `false`: no engine turn exists to
      // publish a terminal event, so release every lifecycle claim here and preserve the driver error.
      this.working.delete(sessionId)
      this.pendingTurns.delete(sessionId)
      this.maybeFinishCompletionTurn(sessionId)
      throw error
    } finally {
      // No await exists between the final cancellation check and the engine call. Once the call returns,
      // Stop is once again a real engine interrupt rather than a prepared-turn cancellation.
      releaseAdmission()
    }
    if (sent === false) {
      // A dead/unwritable child refused the turn synchronously. Release canonical liveness and reject
      // the caller so a remote outbox keeps the exact bubble retryable instead of treating it as acked.
      this.working.delete(sessionId)
      this.pendingTurns.delete(sessionId)
      this.maybeFinishCompletionTurn(sessionId)
      throw new Error('The engine did not accept this turn. Try again.')
    }
    // The engine owns a fresh human turn now. It supersedes either a seen/unseen completion or an
    // unresolved terminal error; infrastructure continuations remain the same logical turn and retain it.
    if (!internal.logicalContinuation) this.terminalAttention.delete(sessionId)
    if (!internal.logicalContinuation) {
      const clean = text.trim()
      if (clean && clean !== '(image)' && !this.sessionFirstPrompts.has(sessionId))
        this.sessionFirstPrompts.set(sessionId, clean)
    }
    if (acceptedAdmission && admission) {
      this.acceptedTurns.set(sessionId, {
        generation: admission.generation,
        cancelled: false,
        session,
      })
    } else if (internal.logicalContinuation) {
      // Stop must follow the logical turn onto its replacement child. Keeping the old AcceptedTurn object
      // would make interrupt() correctly reject the dead process but then decline to stop the live resend.
      const accepted = this.acceptedTurns.get(sessionId)
      this.acceptedTurns.set(sessionId, {
        generation: accepted?.generation ?? ++this.nextTurnAdmissionGeneration,
        cancelled: accepted?.cancelled ?? false,
        session,
      })
    }
    if (newRemoteAttempt && internal.attemptId)
      this.rememberAcceptedRemoteAttempt(
        sessionId,
        internal.attemptId,
        attemptFingerprint!,
        internal.clientTurnId,
      )
    // Record accepted B before rewriting A. The replay append is fail-soft; the following strip's full
    // rewrite can therefore heal a failed append and persist both A-without-bytes and B together.
    if (newRemoteAttempt) publishUserTurn()
    // Any accepted human follow-up supersedes the prior retryable failure, regardless of which head
    // sent it. Until this boundary, Stop/preflight failure must leave the old exact bytes authoritative.
    if (!internal.logicalContinuation && previousRemotePayload?.failed) {
      this.stripRemoteTurnPayload(sessionId, previousRemotePayload)
      if (this.remoteTurnPayloads.get(sessionId) === previousRemotePayload)
        this.remoteTurnPayloads.delete(sessionId)
    }
    if (newRemoteAttempt) {
      if (internal.attemptId || internal.clientTurnId) {
        const exactAttachmentChars =
          images?.reduce((total, image) => total + image.dataBase64.length, 0) ?? 0
        this.setRemoteTurnPayload(sessionId, {
          replaySeq: remoteReplaySeqForAttempt,
          attemptId: internal.attemptId,
          clientTurnId: internal.clientTurnId,
          ...(images?.length && exactAttachmentChars <= MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS
            ? { attachments: images }
            : {}),
          failed: false,
        })
      }
    }
    // Acceptance is not delivery: the child can die mid-write, a Codex turn/start can still reject,
    // and broker recovery can respawn mid-turn. The notice therefore STAYS pending — armed only
    // records what this turn carried so forward() can discharge it at the genuine TurnComplete.
    if (notice) this.armedRestoreNotices.set(sessionId, notice)
    return { status: 'accepted' }
  }

  /** Only the scheduler holding the exact in-memory scope object may start its reserved turn. A
   * visible human/phone send has no token; broker recovery is the sole same-logical-turn exception. */
  private claimProjectMutationScopeTurn(
    sessionId: string,
    internal: {
      logicalContinuation?: 'broker-recovery' | 'resume-miss'
      projectMutationScope?: ProjectMutationScope
    },
  ): void {
    const live = [...this.projectMutationScopes].find((scope) => scope.sessionId === sessionId)
    if (!live) {
      if (internal.projectMutationScope) throw new Error('That overnight memory tidy is no longer active.')
      return
    }
    if (internal.logicalContinuation) {
      if (!live.turnStarted) throw new Error('The overnight memory tidy has not started yet.')
      return
    }
    if (internal.projectMutationScope !== live || live.turnStarted)
      throw new Error('The overnight memory tidy is still finishing. Wait for it to finish before continuing this chat.')
    live.turnStarted = true
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

  /** Reconcile one finished turn without forcing another engine exchange. Safety-git answers "what
   * changed since this turn began"; user Git answers whether only those paths remain loose. The result
   * is passive UI state, never a claim that the aggregate worktree is clean. */
  private finishCompletionTurn(sessionId: string): void {
    const turn = this.completionTurns.get(sessionId)
    if (!turn) return
    void this.runExclusive(turn.cwd, async () => {
      // A new turn for the same session cannot overtake this: sendTurn queues its boundary checkpoint
      // on the same cwd chain. Still guard deletion so a future caller outside that chain is harmless.
      const current = this.completionTurns.get(sessionId)
      if (current !== turn) return

      const result = await reconcileCompletionState(
        sessionId,
        turn,
        this.completionPaths.get(sessionId),
        undefined,
        this.completionUncertainty.get(sessionId),
      )
      this.completionPaths.set(sessionId, result.owned)
      if (result.unresolvedReason) this.completionUncertainty.set(sessionId, result.unresolvedReason)
      else this.completionUncertainty.delete(sessionId)
      if (this.completionTurns.get(sessionId) === turn) this.completionTurns.delete(sessionId)
      this.pushCompletionState(result.state)
    }).catch((err) => {
      log.warn('completion', 'turn reconciliation failed', err instanceof Error ? err.message : err)
      if (this.completionTurns.get(sessionId) === turn) this.completionTurns.delete(sessionId)
      this.completionUncertainty.set(sessionId, 'git-probe-failed')
      this.pushCompletionState({
        sessionId,
        state: 'needs-check',
        paths: [...(this.completionPaths.get(sessionId)?.keys() ?? [])],
        mixedPaths: [],
        reason: 'git-probe-failed',
      })
    })
  }

  /**
   * Reconcile a finished turn, but only once nothing is still expected to write under it. Three
   * writers outlive the engine's TurnComplete: a scheduler-owned mutation scope, a live turn that is
   * merely between events, and a delegate the engine backgrounded. Closing the boundary while any of
   * them is still going loses their edits: nothing attributes a write that lands with no open
   * boundary, so those files fall to the unowned Loose changes bucket forever.
   */
  private maybeFinishCompletionTurn(sessionId: string): void {
    if (this.working.has(sessionId)) return
    if (this.hasOwnedDelegation(sessionId)) return
    if ([...this.projectMutationScopes].some((scope) => scope.sessionId === sessionId)) return
    this.finishCompletionTurn(sessionId)
  }

  private pushCompletionState(candidate: TaskCompletionState): void {
    const parsed = TaskCompletionStateSchema.safeParse(candidate)
    if (!parsed.success) return
    const prior = this.completionStates.get(parsed.data.sessionId)
    if (prior && JSON.stringify(prior) === JSON.stringify(parsed.data)) return
    this.completionStates.set(parsed.data.sessionId, parsed.data)
    this.send(IpcChannels.completionState, parsed.data.sessionId, parsed.data)
  }

  /** Reconcile previously attributed paths against current user Git. This runs before in-app project
   * mutations and on every Git-status refresh, so a path that became clean is retired before a later
   * human edit can make an old session reclaim it. Must run inside the project's checkpoint chain. */
  private async refreshCompletionStatesLocked(projectPath: string): Promise<void> {
    const root = realpathOrSelf(projectPath)
    for (const [sessionId, cwd] of this.projectDirs) {
      if (realpathOrSelf(cwd) !== root) continue
      const priorOwned = this.completionPaths.get(sessionId)
      const priorUncertainty = this.completionUncertainty.get(sessionId)
      if (!priorOwned?.size && !priorUncertainty) continue
      const result = await reconcileCompletionState(
        sessionId,
        {
          cwd,
          safetyCommit: null,
          userGit: { kind: 'unknown' },
          mutationSeen: false,
          overlappingWriters: false,
        },
        priorOwned,
        undefined,
        priorUncertainty,
      )
      this.completionPaths.set(sessionId, result.owned)
      if (result.unresolvedReason) this.completionUncertainty.set(sessionId, result.unresolvedReason)
      else this.completionUncertainty.delete(sessionId)
      this.pushCompletionState(result.state)
    }
  }

  /** Main-owned refresh door used by desktop/phone Git surfaces and after user-Git mutations. */
  async refreshCompletionStatesForProject(projectPath: string): Promise<TaskCompletionState[]> {
    await this.runExclusive(projectPath, () => this.refreshCompletionStatesLocked(projectPath))
    const root = realpathOrSelf(projectPath)
    return [...this.completionStates.entries()].flatMap(([sessionId, state]) =>
      realpathOrSelf(this.projectDirs.get(sessionId) ?? '') === root ? [state] : [],
    )
  }

  /** In-process catch-up for a renderer reload. Completion evidence deliberately dies with the app;
   *  user Git remains the durable truth after restart, while a stale task attribution would not. */
  completionStatesForProject(projectPath: string): Promise<TaskCompletionState[]> {
    return this.refreshCompletionStatesForProject(projectPath)
  }

  /** The cwd a session runs in — its safety-git root, and the correct base for resolving/diffing the
   *  files it edits. A background session (or one launched in another folder) can differ from the
   *  window's project root, so a diff MUST resolve against this, not the sender window. */
  getSessionCwd(sessionId: string): string | undefined {
    return this.projectDirs.get(sessionId)
  }

  /** Mark every live turn sharing a project whenever one writer crosses the mutation boundary. The
   * owner gets mutation evidence; every other writer becomes uncertain. A human/UI write has no
   * session owner, so every active turn is marked as overlapping. */
  private noteProjectMutation(cwd: string, owner: string | 'external'): void {
    const root = realpathOrSelf(cwd)
    // A long-lived scheduler scope cannot hold the checkpoint mutex while its engine runs. Record the
    // same ownership fact here instead: any other writer makes a later rollback unsafe, even if that
    // writer finishes before the scope scan begins.
    for (const scope of this.projectMutationScopes) {
      if (realpathOrSelf(scope.cwd) !== root) continue
      if (owner === 'external' || owner !== scope.sessionId) scope.ambiguous = true
    }
    // Scheduler-owned writes can happen just after the engine's TurnComplete, while reconciliation is
    // queued behind the same project chain. Attribute those writes to the still-open logical boundary
    // even though `working` has already gone false.
    if (owner !== 'external') {
      const ownerTurn = this.completionTurns.get(owner)
      if (ownerTurn && realpathOrSelf(ownerTurn.cwd) === root) ownerTurn.mutationSeen = true
    }
    for (const sessionId of this.working) {
      if (realpathOrSelf(this.projectDirs.get(sessionId) ?? '') !== root) continue
      const turn = this.completionTurns.get(sessionId)
      if (owner !== 'external' && owner === sessionId) {
        continue
      }
      if (turn) turn.overlappingWriters = true
      else this.completionOverlaps.add(sessionId)
    }
  }

  /**
   * Run one USER/UI mutation inside the same project chain as turn baselines and safety checkpoints.
   * The chain stays held THROUGH the actual write: merely announcing an external writer before the
   * caller writes leaves a gap where a new turn can establish its boundary and later claim the human
   * edit. Existing task ownership is reconciled before the write, then every active agent turn is
   * marked uncertain. `checkpointLabel` is optional for additive/reversible writes; the callback sees
   * whether the requested recovery point succeeded and decides whether a destructive write may run.
   * Rapid coalesced writes may skip the ownership refresh after the first write in their burst, but
   * they still cross this serialized boundary and mark every live turn.
   */
  async withExternalProjectMutation<T>(
    cwd: string,
    options: {
      checkpointLabel?: string
      checkpointFile?: RequiredCheckpointFile
      refreshOwnership?: boolean
    },
    mutate: (checkpointed: boolean) => T | Promise<T>,
  ): Promise<T> {
    return this.runExclusive(cwd, async () => {
      if (options.refreshOwnership !== false) await this.refreshCompletionStatesLocked(cwd)
      this.noteProjectMutation(cwd, 'external')
      const checkpointed = options.checkpointLabel
        ? await this.safeCheckpoint(cwd, options.checkpointLabel, options.checkpointFile)
        : true
      return mutate(checkpointed)
    })
  }

  /** Start a scheduler-owned project pass with one exact safety baseline. The returned scope remains
   *  live across the engine turn, but does not hold checkpointChains (which would deadlock the gate's
   *  per-tool checkpoints). Competing turns/writes mark it ambiguous instead. */
  async beginProjectMutationScope(
    sessionId: string,
    checkpointLabel: string,
  ): Promise<ProjectMutationScope | null> {
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return null
    return this.runExclusive(cwd, async () => {
      const baseline = await this.safeCheckpointResult(cwd, checkpointLabel)
      if (!baseline) return null
      const root = realpathOrSelf(cwd)
      const ambiguous = [...this.working].some(
        (otherId) => otherId !== sessionId && realpathOrSelf(this.projectDirs.get(otherId) ?? '') === root,
      )
      const scope: LiveProjectMutationScope = {
        cwd,
        sessionId,
        checkpointId: baseline.id,
        ambiguous,
        turnStarted: false,
      }
      this.projectMutationScopes.add(scope)
      return scope
    })
  }

  /** Finish a scheduler scope inside the project chain. Completion reconciliation stays open until
   * the callback lands the digest, and any Koda-observed competing writer is recorded on the boundary.
   * This overlap signal is attribution evidence only — never permission to roll back the live tree,
   * and never a user-facing warning. */
  async finishProjectMutationScope<T>(
    scope: ProjectMutationScope,
    mutate: () => T | Promise<T>,
  ): Promise<{ overlapObserved: boolean; result: T }> {
    const live = [...this.projectMutationScopes].find((candidate) => candidate === scope)
    if (!live) throw new Error('project mutation scope is no longer active')
    let finished = false
    try {
      const output = await this.runExclusive(live.cwd, async () => {
        const root = realpathOrSelf(live.cwd)
        const anotherTurnIsActive = [...this.working].some(
          (otherId) =>
            otherId !== live.sessionId &&
            realpathOrSelf(this.projectDirs.get(otherId) ?? '') === root,
        )
        const boundary = this.completionTurns.get(live.sessionId)
        const overlapObserved =
          live.ambiguous || anotherTurnIsActive || boundary?.overlappingWriters === true
        if (overlapObserved) this.markCompletionOverlap(live.sessionId)
        this.noteProjectMutation(live.cwd, live.sessionId)
        const result = await mutate()
        return { overlapObserved, result }
      })
      finished = true
      return output
    } finally {
      this.projectMutationScopes.delete(live)
      // TurnComplete deliberately deferred reconciliation while this scope was active. Queue it only
      // after the scheduler's final write/containment decision has landed in the boundary.
      if (finished || this.completionTurns.has(live.sessionId))
        this.maybeFinishCompletionTurn(live.sessionId)
    }
  }

  /** Scheduler-owned checkpoint on the source project (REM later runs in a disposable clone). */
  async checkpointProjectForSession(
    sessionId: string,
    label: string,
  ): Promise<CheckpointResult | null> {
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return null
    return this.runExclusive(cwd, () => this.safeCheckpointResult(cwd, label))
  }

  /** Record that a competing writer was seen inside this session's still-open boundary. Evidence
   *  only — reconciliation still attributes what changed in this turn's own window. */
  private markCompletionOverlap(sessionId: string): void {
    const turn = this.completionTurns.get(sessionId)
    if (turn) turn.overlappingWriters = true
  }

  /** The gate's per-tool checkpoint (completes before an `allow` returns to the engine). */
  private async checkpointForSession(sessionId: string, label: string): Promise<boolean> {
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return false
    return this.runExclusive(cwd, async () => {
      this.noteProjectMutation(cwd, sessionId)
      return this.safeCheckpoint(cwd, label)
    })
  }

  /** Take one checkpoint, fail-soft. Returns false if it couldn't be taken (caller surfaces it). */
  private async safeCheckpoint(
    cwd: string,
    label: string,
    requiredFile?: RequiredCheckpointFile,
  ): Promise<boolean> {
    return (await this.safeCheckpointResult(cwd, label, requiredFile)) !== null
  }

  /** The exact checkpoint result for callers that need a pinned baseline. Failure stays explicit;
   *  never substitute a later HEAD, which may describe an older or concurrent tree. */
  private async safeCheckpointResult(
    cwd: string,
    label: string,
    requiredFile?: RequiredCheckpointFile,
  ): Promise<CheckpointResult | null> {
    try {
      if (!this.ensured.has(cwd)) {
        await ensureRepo(cwd)
        this.ensured.add(cwd)
        this.scheduleMaintenance(cwd)
      }
      const result = await checkpoint(cwd, label, { requiredFile })
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
      return result
    } catch (err) {
      log.error('safety-git', 'checkpoint failed (proceeding)', err instanceof Error ? err.message : err)
      return null
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
    const crossesPlan = (mode === 'plan') !== (prev === 'plan')
    if (crossesPlan) this.assertPostureMutationSafe(sessionId, 'switching Plan')
    // Always pin the explicit per-session entry (a same-value push still matters: the post-restart
    // re-push pins the session against later default-mode changes) — but only a real change broadcasts.
    this.gate.setSessionMode(sessionId, mode)
    if (prev === mode) return
    this.forward({ type: 'ApprovalModeChanged', sessionId, mode })
    // An engine that carries its mode as turn text (Codex) needs no respawn at all: hand the live
    // driver the new posture and the NEXT turn ships the new mode block, which supersedes the old
    // block still sitting in the thread. The conversation, the thread, and the warm process survive.
    const liveEngine = this.sessionEngines.get(sessionId) ?? 'claude'
    if (engineCapabilities(liveEngine).planMode === 'turnText') {
      this.sessions.get(sessionId)?.setApprovalMode?.(mode)
      return
    }
    // Crossing the plan boundary needs a respawn (`--permission-mode plan` is spawn-time). A windowed
    // session's renderer does that itself when the event lands; a WINDOWLESS one (phone-started, or its
    // window closed) has no renderer — respawn here, the same eager --resume the remote model change
    // uses. The phone blocks this while a turn runs (same client-side guard as model/effort).
    // Before the first turn there's no conversation to reattach, and a respawn would only throw away the
    // engine's warm start. The gate mode is already pinned above and sendTurn applies plan on the first
    // turn's spawn, so wait for the driver to report a resumable conversation.
    const conversationStarted =
      !!this.projectDirs.get(sessionId) && this.resumeCursors.get(sessionId)?.resumable === true
    if (crossesPlan && conversationStarted && !contextForSession(sessionId) && this.sessions.has(sessionId)) {
      const cwd = this.projectDirs.get(sessionId)
      if (!cwd) return
      const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
      const engineId = this.sessionEngines.get(sessionId) ?? 'claude'
      const replacement = this.reserveProcessReplacement(sessionId)
      void this
        .start({
          sessionId,
          cwd,
          planMode: mode === 'plan',
          model,
          effort,
          engineId,
          processReplacementClaim: replacement,
        })
        .catch((err) =>
          log.warn('engine', 'plan-mode respawn failed', err instanceof Error ? err.message : err),
        )
        .finally(() => this.releaseProcessReplacement(sessionId, replacement))
    }
  }
  /** Read ONE session's current posture — so a remote head can show + set the same control the local
   *  window has (remote-control-security.md §4 — remote inherits local policy exactly). */
  getSessionApprovalMode(sessionId: string): ApprovalMode {
    return this.gate.getSessionMode(sessionId)
  }

  /** The session ITSELF is over (not just its engine process) — forget its approval posture +
   *  unattended flag, since the only way `unattended` reactivates is a human resuming this exact
   *  conversation (session ids are randomUUID()s; a later, different session never reuses one). Call
   *  from true end sites only; never from a respawn path (ApprovalGate.forgetSession). Also drops any
   *  stray `awaitTurnEnd` waiter — a true end means no future TurnComplete will ever come for this id. */
  forgetSession(sessionId: string): void {
    this.gate.forgetSession(sessionId)
    this.sessionGenerations.delete(sessionId)
    const admission = this.turnAdmissions.get(sessionId)
    if (admission) admission.cancelled = true
    this.turnAdmissions.delete(sessionId)
    this.acceptedTurns.delete(sessionId)
    this.acceptedRemoteAttempts.delete(sessionId)
    this.activeRemoteAttemptIds.delete(sessionId)
    this.remoteTurnPayloads.delete(sessionId)
    this.terminalAttention.delete(sessionId)
    this.processReplacements.delete(sessionId)
    this.turnEndWaiters.delete(sessionId)
    this.pendingTurns.delete(sessionId)
    this.sessionFirstPrompts.delete(sessionId)
    this.resumeCursors.delete(sessionId)
    this.remoteAttached.delete(sessionId)
    this.startedFromRemote.delete(sessionId)
    // A true end owns every lingering workflow observer even when process disposal failed before
    // handleClose could reap it. Delete first so teardown is re-entrant/idempotent; stop() may emit one
    // final observation event synchronously, so clear replay only after every observer is stopped.
    for (const [runId, current] of this.workflowWatchers) {
      if (current.sessionId !== sessionId) continue
      this.workflowWatchers.delete(runId)
      current.watcher.stop()
    }
    this.remoteEventLog.delete(sessionId)
    this.remoteReplaySeq.delete(sessionId)
    this.activeSubagents.delete(sessionId)
    this.completionTurns.delete(sessionId)
    this.completionOverlaps.delete(sessionId)
    this.completionPaths.delete(sessionId)
    this.completionUncertainty.delete(sessionId)
    this.completionStates.delete(sessionId)
    this.pendingRestoreNotices.delete(sessionId)
    this.armedRestoreNotices.delete(sessionId)
    for (const scope of this.projectMutationScopes)
      if (scope.sessionId === sessionId) this.projectMutationScopes.delete(scope)
    this.deferredDreamVisibility.delete(sessionId)
    this.deferredDreamLabels.delete(sessionId)
  }

  /** Resolves the instant this session's turn genuinely ends — a real TurnComplete or a truly fatal
   *  EngineError, set by `forward` (W3). Used by the overnight dream to clear its unattended flag right
   *  away instead of waiting out the next `isWorking` poll tick; a benign broker-recovery blip never
   *  resolves it, so it can't be fooled into firing mid-turn (see the note above `waitForTurnEnd`). */
  awaitTurnEnd(sessionId: string): Promise<void> {
    return new Promise((resolve) => this.turnEndWaiters.set(sessionId, resolve))
  }

  /** Clear a tidy session's unattended + memory-only restrictions after its engine turn AND final
   * digest write. Every later turn is human-owned and must regain the project's normal gate posture. */
  clearUnattended(sessionId: string): void {
    this.gate.setUnattended(sessionId, false)
    this.gate.setMemoryTidyRoot(sessionId, null)
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

  /** Latest successful completion or noteworthy error for the phone launcher's per-head attention rule. */
  remoteTerminalAttention(sessionId: string): RemoteTerminalAttention | undefined {
    return this.terminalAttention.get(sessionId)
  }

  /** The full pending prompts for one session, so a phone opening a session the agent already blocked
   *  on can rebuild the approval/question card (the live push already fired before it connected). */
  remotePendingRequests(sessionId: string): ApprovalRequest[] {
    return this.gate.pendingRequests(sessionId)
  }

  /** Pending prompts owned by one project window. The renderer needs this catch-up read after a
   *  reload; project scoping keeps tool inputs from another window out of this renderer. */
  pendingRequestsForProject(projectPath: string): ApprovalRequest[] {
    const root = realpathOrSelf(projectPath)
    return Object.keys(this.gate.pendingBySession()).flatMap((sessionId) =>
      realpathOrSelf(this.projectDirs.get(sessionId) ?? '') === root ? this.gate.pendingRequests(sessionId) : [],
    )
  }

  /** Latest account rate-limit windows per engine — the phone sheet's usage readout at browse level
   *  (the same snapshot that seeds a joining chat's meters, without needing a session). */
  remoteRateLimits(): Record<string, Record<string, RateLimitInfo>> {
    return Object.fromEntries(this.lastRateLimits)
  }

  /**
   * Ask the engine for the account's plan windows and publish them (see usage-poll.ts for why we poll
   * rather than wait for the stream). Fail-soft in every direction: a poll that errors, times out, or
   * reports nothing leaves the last known windows standing — an empty read means "the engine had
   * nothing to say", never "your limits are clear".
   *
   * Skipped under API billing: an API key has no plan windows, and the poll would report none every
   * time, wrongly pruning the subscription windows the user will see again when they switch back.
   *
   * Also skipped under vitest: the poll spawns a REAL engine subprocess, and unit tests construct this
   * manager freely (sessions.test.ts alone builds ~25) — one test run's orphaned spawns piled up to
   * ~6.5GB of hung CLI processes and OOM'd the machine (2026-08-12). Guarded here, the single
   * chokepoint, so the constructor timers and both turn-end triggers are all covered.
   */
  private async pollUsage(): Promise<void> {
    if (process.env.VITEST || isE2EProfile()) return
    if (this.apiActive('claude')) return
    this.lastUsagePoll = Date.now()
    this.usageProbe?.ran() // a turn-end poll counts as this heartbeat's run, however it was triggered
    let result: Awaited<ReturnType<typeof pollAccountUsage>>
    try {
      result = await pollAccountUsage({ resourcesPath: this.resourcesPath })
    } catch (err) {
      log.warn('usage', 'account usage poll failed', err instanceof Error ? err.message : err)
      return
    }
    if (!result.windows.length) return
    // Ground-truth breadcrumb (same reason codex-driver logs its snapshot): the gauge can't show whether
    // a number came from the poll or a stale stream event, so one line per poll makes it diagnosable.
    log.info('usage', 'account usage poll', result)
    // The poll is an authoritative snapshot: it lists every window the plan currently has, so receivers
    // prune anything else (a stale window the plan stopped reporting) rather than pinning the gauge.
    const authoritativeTypes = authoritativeUsageTypes(
      result,
      this.lastRateLimits.get('claude') ?? {},
    )
    for (const info of result.windows) {
      const event: EngineEvent = {
        type: 'RateLimitUpdate',
        sessionId: ACCOUNT_USAGE_SESSION_ID,
        engine: 'claude',
        info,
        authoritativeTypes,
      }
      const reconciled = this.forward(event) // bookkeeping: notifier, reconciler, and on-disk mirror
      // …and the delivery forward() can't do: it routes to the window OWNING the session, and this
      // event belongs to no session. The plan windows are an account fact — every open window shows them.
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed() && reconciled) win.webContents.send(IpcChannels.engineEvent, reconciled)
    }
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
    const changed =
      prev.model !== model || prev.effort !== effort || (prevEngine ?? 'claude') !== (engineId ?? 'claude')
    if (changed) this.assertPostureMutationSafe(sessionId, 'changing the model or effort')
    this.sessionModelEffort.set(sessionId, { model, effort })
    if (opts.engineId) this.sessionEngines.set(sessionId, opts.engineId)
    // Crossing engines invalidates the reported model — the new engine's default is unknown until it
    // spawns and reports its own (mirrors the desktop store dropping activeModel on an engine switch).
    if (opts.engineId && prevEngine && opts.engineId !== prevEngine) this.resolvedModels.delete(sessionId)
    // Remember this pick as the app-wide last-used posture so the next NEW session (notably the phone's
    // headless start, which has no renderer copy) opens on it instead of the engine default.
    saveLastPosture({ model, effort, engineId: engineId ?? 'claude' })
    if (!changed) return
    // Intent now diverges from the live child's `spawnedWith`; sendTurn reconciles it before the next turn
    // (no flag to set — the comparison sees the difference on its own).
    // A WINDOWLESS session has no renderer to persist the new pair, so a Mac restart would resurrect
    // the old one — upsert it into the project store here (same reason + same window guard + same
    // resumed-id resolution as persistRemoteTitle; a windowed session's renderer owns the blob, and
    // writing would race it). The Codex thread id rides along so a post-restart resume finds its thread.
    const cwd = this.projectDirs.get(sessionId)
    // A null store = present but unreadable: skip the write (never rewrite it from a fresh empty one)
    // while the broadcast below still goes out.
    const store = cwd && !contextForSession(sessionId) ? this.projectStore(cwd) : null
    if (cwd && store) {
      const storeId = this.resumedFrom.get(sessionId) ?? sessionId
      let stored = store.sessions.find((s) => s.id === storeId)
      if (!stored) {
        stored = { id: storeId, label: this.sessionLabel(sessionId, cwd), cwd, userNamed: false, items: [] }
        store.sessions.push(stored)
      }
      stored.model = model
      stored.effort = effort
      if (opts.engineId) stored.engineId = opts.engineId
      const cursor = this.resumeCursors.get(sessionId)
      if (cursor) stored.resumeCursor = cursor
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
    if (isHermeticE2EProfile()) return Promise.resolve([])
    return listCodexModels({ resourcesPath: this.resourcesPath })
  }

  /** Codex sign-in state for the picker + Settings (chatgpt = active subscription). */
  codexAuthStatus(): Promise<CodexAuthStatus> {
    if (isHermeticE2EProfile()) {
      return Promise.resolve({ signedIn: false, authMethod: null, requiresOpenaiAuth: true, probeFailed: false })
    }
    return getCodexAuthStatus({ resourcesPath: this.resourcesPath })
  }

  /** Provider-neutral picker payload shared by desktop and phone. Keep provider probes here, next to
   *  the engine services, so clients never recreate auth/error semantics or provider-specific catalogs. */
  async modelProviderCatalogs(): Promise<ProviderModelCatalogs> {
    if (isHermeticE2EProfile()) {
      return providerModelCatalogs({
        codexAuthStatus: {
          signedIn: false,
          authMethod: null,
          requiresOpenaiAuth: true,
          probeFailed: false,
        },
      })
    }
    const [models, auth] = await Promise.allSettled([
      this.codexModels(),
      this.codexAuthStatus(),
    ])
    return providerModelCatalogs({
      codexModels: models.status === 'fulfilled' ? models.value : [],
      codexAuthStatus: auth.status === 'fulfilled' ? auth.value : null,
      codexProbeFailed: models.status === 'rejected' || auth.status === 'rejected',
    })
  }

  /** Change a session's model and/or effort from a remote head. The engine can't switch either on a
   *  live -p process, so this reattaches via --resume with the new pair (same as the local picker's
   *  respawn). Pass the FULL desired pair — both are applied, so neither resets to default. Caller
   *  should avoid this mid-turn (the respawn would drop an in-flight turn); the remote client gates it. */
  async changeSessionModelEffort(sessionId: string, opts: { model?: string; effort?: string; engineId?: EngineId }): Promise<void> {
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) throw new Error(`unknown session: ${sessionId}`)
    const engineId = opts.engineId ?? this.sessionEngines.get(sessionId) ?? 'claude'
    const previousIntent = this.sessionModelEffort.get(sessionId) ?? {}
    const previousEngine = this.sessionEngines.get(sessionId) ?? 'claude'
    const intentChanged =
      previousIntent.model !== (opts.model || undefined) ||
      previousIntent.effort !== (opts.effort || undefined) ||
      previousEngine !== engineId
    // A picker echo is a genuine no-op. In particular, never turn an unchanged selection into an eager
    // respawn that could discard a turn or prompt merely because the client repeated its current value.
    if (!intentChanged) return
    this.assertPostureMutationSafe(sessionId, 'changing the model or effort')
    // Engine is locked once the conversation starts (context lives in the engine's process/store —
    // switching would silently strand it). The desktop enforces this in its picker; enforce it here
    // for remote heads too, since main is the authority. Conversation-started = a Codex thread id
    // exists, or Claude has the conversation on disk.
    const prevEngine = previousEngine
    // A Codex thread id is NOT proof of a conversation: Codex creates the thread during fresh-session
    // initialization, before the first user turn. Treating that id as content locked every phone-started
    // Codex session to Codex before the user typed anything. Real content is a sent turn, a replayed phone
    // turn, persisted renderer items, or Claude's on-disk conversation.
    const storeId = this.resumedFrom.get(sessionId) ?? sessionId
    const stored = this.projectStore(cwd)?.sessions.find((s) => s.id === storeId)
    const conversationStarted =
      this.working.has(sessionId) ||
      this.remoteEventLog.get(sessionId)?.some((e) => e.type === 'RemoteUserTurn') === true ||
      Boolean(stored?.items?.length) ||
      // An engine that keeps a readable conversation on disk proves content that way; one that doesn't
      // returns false here and the signals above decide.
      engineConversationHasContent(prevEngine, cwd, storeId)
    if (engineId !== prevEngine && conversationStarted)
      throw new Error('the engine is locked once a conversation has started — start a new chat to switch')
    // Record + broadcast FIRST so the desktop's pill/persisted pick follows the phone's change (else its
    // next reattach would silently revert this respawn to the old pair). This updates the intent, so the
    // live child's spawnedWith now diverges — sendTurn reconciles it on the next turn.
    this.setSessionModelEffort(sessionId, { ...opts, engineId })
    // A brand-new session (picking a model before sending) has nothing to reattach to, and respawning it
    // would only throw away a warm engine. The intent update above makes its first turn spawn on this
    // pair, so just record and return.
    if (!conversationStarted) return
    const replacement = this.reserveProcessReplacement(sessionId)
    try {
      await this.start({
        sessionId,
        cwd,
        model: opts.model || undefined,
        effort: opts.effort || undefined,
        engineId,
        processReplacementClaim: replacement,
      })
    } finally {
      this.releaseProcessReplacement(sessionId, replacement)
    }
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
    if (this.remoteEventLog.has(sessionId)) {
      this.seedActiveSubagentsIntoRemoteReplay(sessionId)
      return
    }
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return
    const storedId = this.resumedFrom.get(sessionId) ?? sessionId
    const persistedSeq =
      this.projectStore(cwd)?.sessions.find((session) => session.id === storedId)?.replaySeq ?? 0
    const durable = normalizeReplaySequence(
      settleRestoredDelegationReplay(loadRemoteReplay(cwd, storedId, sessionId)),
    )
    this.remoteReplaySeq.set(
      sessionId,
      Math.max(this.remoteReplaySeq.get(sessionId) ?? 0, persistedSeq, durable.at(-1)?.replaySeq ?? 0),
    )
    if (durable.length) {
      this.remoteEventLog.set(sessionId, durable)
      replaceRemoteReplay(cwd, storedId, durable.map((entry) => ({ ...entry, sessionId: storedId })))
    }
    // A local child may already be running when the phone first attaches. Its original Start was sent
    // only to the renderer, so make it durable now before the window is allowed to close headlessly.
    this.seedActiveSubagentsIntoRemoteReplay(sessionId)
  }

  /** The dream scheduler's ear: called on every send and turn-end with the project dir (dream.ts).
   *  Dream sessions themselves are excluded — otherwise the dream's own turn re-arms the quiet clock
   *  and counts as "new material," and every project would re-dream every night forever. */
  private engineActivityListener: ((cwd: string) => void) | null = null
  private readonly dreamSessions = new Set<string>()
  /** REM's disposable snapshot session is digest-only: never adopt it or list it on the phone. */
  private readonly hiddenDreamSessions = new Set<string>()
  /** Tidy is not exposed until its turn, digest, and optional REM pass are all finished. */
  private readonly deferredDreamVisibility = new Set<string>()
  /** The dated title is persisted only at reveal. Persisting it earlier would let a newly opened
   * desktop hydrate the supposedly hidden session from disk and replace its reserved engine. */
  private readonly deferredDreamLabels = new Map<string, string>()
  setEngineActivityListener(fn: ((cwd: string) => void) | null): void {
    this.engineActivityListener = fn
  }
  private noteEngineActivity(sessionId: string): void {
    if (this.dreamSessions.has(sessionId)) return
    const cwd = this.projectDirs.get(sessionId)
    if (cwd) this.engineActivityListener?.(cwd)
  }

  /** Reap last night's dream sessions that nobody adopted: idle, windowless, safe to end. Their
   *  persisted titles stay in the project's session list; a claude transcript can still rebuild
   *  from the engine JSONL on resume. Called by the scheduler at the start of each new dream. */
  async reapDreamSessions(): Promise<void> {
    for (const id of [...this.dreamSessions]) {
      if (!this.working.has(id) && !contextForSession(id)) {
        this.dreamSessions.delete(id)
        await this.dispose(id).catch(() => {})
        this.forgetSession(id) // reaped = a true end, not a respawn
      }
    }
  }

  /** Start a windowless session for the overnight dream (dream.ts) — the phone-session machinery
   *  reused: headless start on the last posture, name-locked so nothing can rename it, and gate-marked
   *  unattended so anything needing a human is DENIED instead of hanging on a prompt no window shows.
   *  Tidy sessions can defer all discovery until finalization; REM stays permanently hidden because
   *  its disposable project snapshot is implementation detail, not a conversation to resume.
   *
   *  The lock is `userNamed` (the same flag a manual rename sets) — main's own titlers and BOTH renderer
   *  retitle paths already honor it. `remoteTitled` alone wasn't enough: a window open on the project
   *  adopts the dream live, and the renderer then re-derived a name from the prompt at the first turn
   *  (08-06's dreams landed as "Memory Edits" / "Memory Consolidation" instead of their dated names,
   *  which made a night's dreams unfindable). */
  async startDreamSession(
    projectPath: string,
    label: string,
    options: {
      visible?: boolean
      readOnly?: boolean
      memoryOnly?: boolean
      deferVisibility?: boolean
    } = {},
  ): Promise<{ sessionId: string }> {
    const last = loadLastPosture()
    const sessionId = randomUUID()
    // Reserve discovery state before start() can publish the live engine into `sessions`. Usually the
    // caller's await continuation runs first anyway, but an already-queued launcher/hydration poll must
    // not get even a one-tick view of an unattended session.
    const reserve = (): void => {
      this.dreamSessions.add(sessionId)
      if (options.visible === false) this.hiddenDreamSessions.add(sessionId)
      if (options.visible !== false && options.deferVisibility) {
        this.deferredDreamVisibility.add(sessionId)
        this.deferredDreamLabels.set(sessionId, label)
      }
      this.remoteTitled.add(sessionId)
    }
    const releaseReservation = (): void => {
      this.dreamSessions.delete(sessionId)
      this.hiddenDreamSessions.delete(sessionId)
      this.deferredDreamVisibility.delete(sessionId)
      this.deferredDreamLabels.delete(sessionId)
      this.remoteTitled.delete(sessionId)
    }
    reserve()
    let started: { sessionId: string }
    try {
      started = await this.start({
        cwd: projectPath,
        sessionId,
        model: last.model,
        effort: last.effort,
        engineId: last.engineId,
      })
    } catch (err) {
      log.warn('sessions', 'dream start with last posture failed; retrying bare', err instanceof Error ? err.message : err)
      // A partial failed start may have run disposal hygiene. Reassert the reservation before retry.
      reserve()
      try {
        started = await this.start({ cwd: projectPath, sessionId })
      } catch (retryErr) {
        // start() records engine/cwd intent before spawning. A double spawn failure has no live
        // conversation, so run normal disposal hygiene as well as dropping the discovery reservation.
        await this.dispose(sessionId).catch((disposeErr) =>
          log.warn(
            'sessions',
            'failed dream start cleanup failed',
            disposeErr instanceof Error ? disposeErr.message : disposeErr,
          ),
        )
        releaseReservation()
        this.forgetSession(sessionId)
        throw retryErr
      }
    }
    if (started.sessionId !== sessionId) {
      releaseReservation()
      throw new Error('dream session started under an unexpected identity')
    }
    // Attach a visible tidy to the replay buffer immediately, even while discovery stays deferred.
    // Its scheduler-owned prompt/reply would otherwise be lost before reveal because top-level events
    // are only buffered for remote-attached sessions. The deferred filters below remain the sole
    // publication gate; REM is permanently hidden and never attaches.
    if (options.visible !== false) this.attachRemote(sessionId)
    // A hidden REM session never earns a project-store row. A deferred tidy gets one only at reveal;
    // until then both the live launcher and restart hydration must be unable to discover it.
    if (options.visible !== false && !options.deferVisibility)
      this.persistRemoteTitle(projectPath, sessionId, label, true)
    this.gate.setUnattended(sessionId, true)
    if (options.readOnly) this.gate.setReadOnly(sessionId, true)
    if (options.memoryOnly) this.gate.setMemoryTidyRoot(sessionId, projectPath)
    if (options.visible !== false && !options.deferVisibility)
      this.notifyDesktopOfHeadless(projectPath) // a window open on this project can adopt it live
    return { sessionId }
  }

  /** Publish a deferred tidy only after all scheduler-owned work is done, so no window/phone turn can
   * race its reserved logical turn or receive a later digest under the same session id. */
  revealDreamSession(sessionId: string): void {
    if (!this.deferredDreamVisibility.delete(sessionId)) return
    const label = this.deferredDreamLabels.get(sessionId)
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd || !this.sessions.has(sessionId)) {
      this.deferredDreamLabels.delete(sessionId)
      return
    }
    // With no renderer, main owns the session store. With a live project window, carry the locked
    // label through adoption instead: its renderer owns the whole store blob and will persist the
    // adopted session without racing a second writer here.
    const win = windowForProject(realpathOrSelf(cwd))
    if (label && (!win || win.isDestroyed()) && this.persistRemoteTitle(cwd, sessionId, label, true))
      this.deferredDreamLabels.delete(sessionId)
    this.attachRemote(sessionId)
    this.notifyDesktopOfHeadless(cwd)
  }

  /** Live sessions a remote client can pick: id + project dir + the session's human title.
   *  `lastActivityAt` (epoch ms, 0 = no turn yet) rides along so the phone can show ages + day-group. */
  remoteSessionList(): { id: string; cwd: string; label: string; engineId: EngineId; lastActivityAt: number; lastLine?: string }[] {
    return [...this.sessions.keys()]
      .filter((id) => !this.hiddenDreamSessions.has(id))
      .filter((id) => !this.deferredDreamVisibility.has(id))
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

  /** Is parent or delegated work in flight for this session right now? Drives the remote launcher's
   *  live working glyph and unattended schedulers from the same main-owned runtime truth. */
  isWorking(sessionId: string): boolean {
    return this.working.has(sessionId) || this.hasActiveDelegation(sessionId)
  }

  /** Epoch ms of this session's last engine event (0 = none yet) — engine liveness for unattended
   *  supervisors: `working && old lastEngineEventAt` = a stalled turn worth interrupting early. */
  lastEngineEventAt(sessionId: string): number {
    return this.engineEventAt.get(sessionId) ?? 0
  }

  /** The current turn's accumulated top-level reply (capped at 4000 chars) — the dream digest reads
   *  a turn's closing message here after the turn ends. Undefined until a block lands; reset per turn. */
  lastAssistantReply(sessionId: string): string | undefined {
    return this.turnReplies.get(sessionId)
  }

  /** A live session's human title — normally the persisted store (the source `remoteHistory` trusts).
   *  A revealed Dream keeps its scheduler-owned dated label as a fallback until a durable userNamed row
   *  acknowledges renderer/windowless ownership; a later user rename then wins. While persistence is
   *  catching up, use the first known user turn instead of repeating the project folder for every live
   *  row. Remote resumes resolve through `resumedFrom`. */
  private sessionLabel(id: string, cwd: string): string {
    const storedId = this.resumedFrom.get(id) ?? id
    const stored = this.projectStore(cwd)?.sessions.find((s) => s.id === storedId)
    const label = stored?.label?.trim()
    // A persisted userNamed row is the renderer/windowless owner's acknowledgement. Until that
    // exists, retain the pending dated lock across adoption/reload; afterward a real user rename wins.
    if (stored?.userNamed && label) {
      this.deferredDreamLabels.delete(id)
      return label
    }
    const meaningfulLabel = label && !isProvisionalSessionLabel(label, cwd) ? label : undefined
    const replayPrompt = this.remoteEventLog
      .get(id)
      ?.find(
        (entry) =>
          entry.type === 'RemoteUserTurn' &&
          entry.text.trim() &&
          entry.text.trim() !== '(image)',
      )
    const firstPrompt =
      firstPersistedUserPrompt(stored?.items) ||
      this.sessionFirstPrompts.get(id) ||
      (replayPrompt?.type === 'RemoteUserTurn' ? replayPrompt.text : undefined)
    return (
      this.deferredDreamLabels.get(id)?.trim() ||
      meaningfulLabel ||
      (firstPrompt ? titleFromPrompt(firstPrompt) : undefined) ||
      basename(cwd) ||
      'Session'
    )
  }

  /** First-turn auto-titling for a headless (phone-started) session. Titling normally lives in the
   *  renderer's dispatch path, but a phone session runs windowless — no renderer ever names it, so its
   *  label would stay the project-folder fallback. Mirror the desktop's two stages here on the engine
   *  turn path: the instant first-words title, then the selected generated-text writer. Both
   *  persist to the per-project store, which the phone's session list + history read from. Runs once per
   *  session (a resumed or already-named session is left alone); the caller only invokes it while the
   *  session is windowless, so the store writes can't race the renderer's whole-blob persistence. */
  private titleRemoteSession(sessionId: string, cwd: string, text: string): void {
    if (this.remoteTitled.has(sessionId)) return
    const clean = text.trim()
    if (!clean) return // image-only turn — let the next text turn name it
    const storedId = this.resumedFrom.get(sessionId) ?? sessionId
    const stored = this.projectStore(cwd)?.sessions.find((s) => s.id === storedId)
    const storedLabel = stored?.label?.trim()
    // Already meaningfully named (a resumed past session, or a restart-resume) — never re-title.
    // Folder names and creation placeholders are not titles; a pre-turn posture pick can persist one.
    if (stored?.userNamed || (storedLabel && !isProvisionalSessionLabel(storedLabel, cwd))) {
      this.remoteTitled.add(sessionId)
      return
    }
    this.remoteTitled.add(sessionId)
    this.remoteFirstPrompt.set(sessionId, { prompt: clean, cwd }) // feeds the substance retitle at first TurnComplete
    this.persistRemoteTitle(cwd, storedId, titleFromPrompt(clean))
    // Fire-and-forget generated-text naming; never blocks the turn, never throws. Skip once a window has
    // adopted the session (its renderer owns the label then) so the write can't race the renderer.
    const gen = (this.remoteTitleGen.get(sessionId) ?? 0) + 1
    this.remoteTitleGen.set(sessionId, gen)
    void this.nameSession({
      kind: 'initial',
      evidence: clean,
      avoid: this.takenRemoteTitles(cwd, storedId),
    })
      .then(({ title, overview }) => {
        if (this.remoteTitleGen.get(sessionId) !== gen) return // superseded by the substance retitle
        if (title.trim() && !contextForSession(sessionId))
          this.persistRemoteTitle(cwd, storedId, title.trim(), false, overview)
      })
      .catch(() => {})
  }

  /**
   * Name a session through the app-global writer chosen in Settings. Apple runs locally, plain uses the
   * deterministic floor, and a cloud model runs through the inert structured-generation seam. The picker is
   * the user's explicit billing choice, so it may differ from the conversation engine without Koda
   * silently choosing an account on their behalf.
   */
  async nameSession(req: {
    kind: NamingKind
    evidence: string
    currentTitle?: string
    avoid?: string[]
  }): Promise<GeneratedName> {
    const selected = loadTextGenerationModel()
    const floor = (text: string, avoid: string[]): Promise<string> =>
      selected.provider === 'plain'
        ? Promise.resolve(disambiguate(deterministic('title', text), avoid))
        : assistTitle(text, avoid)
    if (isHermeticE2EProfile()) {
      // Same split as a real miss (naming.ts rule 2): only an `initial` may take the floor, or E2E
      // would exercise a regenerate path that renames from the framed digest — which is the bug.
      return req.kind === 'initial'
        ? { title: await floor(req.evidence, req.avoid ?? []), overview: '' }
        : { title: '', overview: '' }
    }
    if (selected.provider === 'apple' || selected.provider === 'plain') {
      return req.kind === 'initial'
        ? { title: await floor(req.evidence, req.avoid ?? []), overview: '' }
        : { title: '', overview: '' }
    }
    const apiKey = this.effectiveApiKey(selected.provider)
    return generateSessionName(
      {
        ...req,
        engineId: selected.provider,
        model: selected.model,
        effort: selected.effort,
        resourcesPath: this.resourcesPath,
        env: apiKey ? { apiMode: true, apiKey } : undefined,
      },
      floor,
    )
  }

  /**
   * Describe a save before it happens with the app-global generated-text writer. Apple runs locally;
   * a cloud choice is an explicit account choice and re-adds that provider's API credential only when
   * API billing is active. `version-message.ts` owns the evidence prompt and deterministic floor.
   *
   * Never throws and never blocks a save: the deterministic floor answers whenever the toggle is off,
   * plain text is selected, or the chosen writer misses.
   */
  async proposeVersionMessage(req: {
    cwd: string
    /** The changed files, which is all the deterministic floor needs. */
    status: StatusResult
    /** The expensive half (diff + recent subjects), read only once a turn is actually going to run. */
    readEvidence: () => Promise<ChangeEvidence>
  }): Promise<VersionMessage> {
    const floor: VersionMessage = {
      message: fallbackVersionMessage(req.status.files, req.status.truncated),
      source: 'fallback',
    }
    // E2E must never spend a real turn describing a fixture repo; the floor is what it asserts on.
    if (isHermeticE2EProfile() || !loadSuggestVersionMessage()) return floor
    const selected = loadTextGenerationModel()
    // Plain is a complete answer, not a failed generation, and needs no expensive diff read.
    if (selected.provider === 'plain') return floor
    const evidence = await req.readEvidence()
    // Without a diff, the file-list floor is the complete honest answer.
    if (!evidence.diff.trim()) return floor
    if (selected.provider === 'apple') {
      const written = await assistVersionMessage(buildVersionMessagePrompt(evidence))
      return written ? { message: written, source: 'on-device' } : floor
    }
    const apiKey = this.effectiveApiKey(selected.provider)
    return generateVersionMessage({
      ...evidence,
      engineId: selected.provider,
      model: selected.model,
      effort: selected.effort,
      resourcesPath: this.resourcesPath,
      env: apiKey ? { apiMode: true, apiKey } : undefined,
    })
  }

  /**
   * The engine a session actually runs on: the live choice for a session that has started this run,
   * else the one persisted with the chat. A renderer that knows which chat it is asking from names the
   * SESSION, never an engine — main reads the engine off the session itself, so no surface can pick a
   * billing path on the user's behalf. Undefined when the id names nothing Koda can see.
   */
  sessionEngine(cwd: string, sessionId: string): EngineId | undefined {
    const live = this.sessionEngines.get(sessionId)
    if (live) return live
    const storedId = this.resumedFrom.get(sessionId) ?? sessionId
    const persisted = readPersistedSession(cwd, storedId)
    return persisted ? (persisted.engineId ?? 'claude') : undefined
  }

  /** Whether a renderer hot-store snapshot still includes every finalized session turn. A turn or
   *  delegated writer that main still owns is incomplete by definition; a transcript event after the
   *  acknowledged save proves the file is stale even if the renderer's next write has not fired yet. */
  hotSessionSnapshotComplete(projectPath: string, savedAt: number | undefined): boolean {
    if (savedAt === undefined) return false
    const root = realpathOrSelf(projectPath)
    for (const [sessionId, cwd] of this.projectDirs) {
      if (realpathOrSelf(cwd) !== root) continue
      if (this.working.has(sessionId) || this.hasOwnedDelegation(sessionId)) return false
      // `savedAt` is the renderer's snapshot START, so same-millisecond events are conservatively
      // considered newer too; wall-clock resolution must never certify an omitted turn as complete.
      if ((this.engineEventAt.get(sessionId) ?? 0) >= savedAt) return false
    }
    return true
  }

  /**
   * The engine runner the Library's "Ask Koda" answers through (`library-ask.ts` owns the prompt, the
   * evidence and the citation mapping). Here for one reason only, the same one `nameSession` is here
   * for: billing parity is decided in exactly ONE place. An ask re-adds the API credential only when
   * that engine is actually in API billing mode, exactly like the session's own turns, so a question
   * asked from the document surface bills the path the user chose and lands in the usage they already
   * see. `effectiveApiKey` stays private; callers get a configured runner, never a key.
   *
   * WHICH engine is decided here too, and it is not a default. An ask is launched from a chat, so it
   * runs on THAT chat's engine (`sessionEngine`, resolved by the IPC caller from the asking window):
   * app-wide resolution refused an ask launched from a Claude chat because some other session had been
   * switched to Codex, and ran Claude for an ask launched from a Codex chat — in both directions the
   * refusal copy names an engine the user is not looking at. Only an ask with no chat behind it at all
   * falls back to the engine they last explicitly ran on, which is main's own copy of that choice and
   * the same source a phone-side new session opens on. Hard-coding Claude here spawned Claude for a
   * Codex user: an ask billed to an Anthropic account they never chose for it, with nothing on screen
   * saying so, and for a Codex-only user a permanent "could not be answered" with no way to learn why.
   */
  libraryAskRunner(engineId?: EngineId): AskRunner {
    const engine = engineId ?? loadLastPosture().engineId ?? 'claude'
    const apiKey = this.effectiveApiKey(engine)
    return engineAskRunner({
      engineId: engine,
      resourcesPath: this.resourcesPath,
      env: apiKey ? { apiMode: true, apiKey } : undefined,
    })
  }

  /** Sibling-session names in this project the auto-titler must avoid — same list the renderer builds
   *  from its store; here it comes from the persisted per-project store (the phone reads from there). */
  private takenRemoteTitles(cwd: string, excludeId: string): string[] {
    return (this.projectStore(cwd)?.sessions ?? [])
      .filter((s) => s.id !== excludeId)
      .map((s) => s.label?.trim())
      .filter((l): l is string => !isProvisionalSessionTitle(l))
      .slice(-12)
  }

  /** Write a headless session's auto-title into its project store — the source the phone's session list
   *  and history read labels from. Upserts a minimal entry when the renderer hasn't persisted this
   *  (windowless) session, updates the label in place otherwise. Never clobbers a user rename.
   *  `lock` marks the label userNamed — for a name Koda itself chose deliberately (the dream's dated
   *  title) that no auto-titler on either side of the IPC boundary may overwrite. Returns whether a
   *  durable userNamed row already existed or the requested write landed. */
  private persistRemoteTitle(
    cwd: string,
    storedId: string,
    label: string,
    lock = false,
    /** The generated one-line overview, when there is one — the sessions map's second line. */
    overview?: string,
  ): boolean {
    const store = this.projectStore(cwd)
    if (!store) return false // unreadable store — a title isn't worth rewriting it from an empty one
    const existing = store.sessions.find((s) => s.id === storedId)
    if (existing?.userNamed) return true
    if (existing) {
      existing.label = label
      if (overview?.trim()) existing.overview = overview.trim()
      if (lock) existing.userNamed = true
    } else
      store.sessions.push({
        id: storedId,
        label,
        cwd,
        userNamed: lock,
        items: [],
        ...(overview?.trim() ? { overview: overview.trim() } : {}),
      })
    saveProjectSessions(cwd, store)
    return true
  }

  // ── Remote launcher: start-new / resume-old from the phone (no desktop window) ────────────────────
  // The phone is a full control head, not an attach-only viewer (otherwise it's strictly worse than
  // Anthropic's /remote-control). These wrap the SAME windowless `start()` path the desktop uses; the
  // only new trust rule is that a phone-supplied path/id must match a project already known on this Mac —
  // the phone can never name an arbitrary directory to spawn an agent in.

  /** Every project the phone may act in (start / resume / browse) — the full known-projects registry,
   *  most-recent-first, existing dirs only. NOT just recents: the phone Home lists all of them, so all of
   *  them are reachable (the user chose full access over a view-only tail). */
  remoteProjectList(): { path: string; name: string }[] {
    return knownProjectPaths().map((p) => ({ path: p, name: basename(p) || p }))
  }

  /** Resumable past sessions across ALL known projects — id + human label + which project. Spans the
   *  full registry (not just recents) so every project the phone Home now lists shows its real chats and
   *  is resumable. Excludes any session that's already live (those appear in the running list, not as a
   *  resume target) and any whose engine-side conversation is gone — Koda's store outlives the engine's
   *  (cleanup, sessions that died before their first turn), and offering one produces `--resume` → "No
   *  conversation found" → a fatal engine error on the phone. */
  remoteHistory(): { id: string; label: string; projectPath: string; projectName: string; updatedAt: number }[] {
    const out: { id: string; label: string; projectPath: string; projectName: string; updatedAt: number }[] = []
    for (const p of knownProjectPaths()) {
      const stored = this.projectStore(p)
      if (!stored) continue
      for (const s of stored.sessions) {
        if (this.sessions.has(s.id)) continue // already running → shown under "running", not "resume"
        if (!engineConversationExists(s.engineId, s.cwd || p, s.id)) continue
        // Real last-activity: the conversation file's mtime (0 for an engine that keeps none, which
        // holds stored order). Kept in the payload — the phone day-groups its Sessions list by it.
        out.push({ id: s.id, label: s.label, projectPath: p, projectName: basename(p) || p, updatedAt: engineConversationMtime(s.engineId, s.cwd || p, s.id) })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Start a NEW headless session in a recent project and attach the remote head. Refuses any path
   *  that isn't a known recent project (the phone can't spawn an agent in an arbitrary directory).
   *
   *  IDEMPOTENT on the phone's chosen `sessionId`. A start is a WRITE whose reply can be lost in transit
   *  (a recycled relay socket, a cold Connect route) — the phone then reports "could not start" for a session
   *  that IS running, and a blind retry would spawn a second engine. So the phone names the id up front
   *  and re-sends the same one: an id that's already live under the remote head in this same project is
   *  simply handed back. A live id we DON'T own (a desktop session the phone named) is never touched —
   *  it falls through to a fresh id, because start() would otherwise dispose and respawn it. */
  async startNewRemote(projectPath: string, sessionId?: string): Promise<{ sessionId: string }> {
    if (!this.remoteProjectList().some((r) => r.path === projectPath)) throw new Error('unknown project')
    // The engine takes --session-id as a UUID; anything else is ignored rather than failing the start.
    const chosen = sessionId && UUID_RE.test(sessionId) ? sessionId : undefined
    if (chosen) {
      const inflight = this.remoteStarts.get(chosen)
      if (inflight) return inflight
      if (this.sessions.has(chosen))
        return this.startedFromRemote.has(chosen) && this.projectDirs.get(chosen) === projectPath
          ? { sessionId: chosen } // the re-send of a start that already landed
          : this.startNewRemote(projectPath) // live but not ours — mint a fresh id instead
      const p = this.spawnNewRemote(projectPath, chosen).finally(() => this.remoteStarts.delete(chosen))
      this.remoteStarts.set(chosen, p)
      return p
    }
    return this.spawnNewRemote(projectPath, undefined)
  }

  private async spawnNewRemote(projectPath: string, chosen: string | undefined): Promise<{ sessionId: string }> {
    // Open on the last-used model/effort/engine (the phone has no renderer to seed this the way the
    // desktop does), so a new session isn't stuck on the engine default. A fresh spawn — not a --resume —
    // so it carries the pair with no conversation to reattach to. Fail-soft: a stale posture (e.g. a
    // last-used Codex that's since signed out) must never block a new session, so fall back to a bare
    // default rather than surfacing "couldn't start" on the phone.
    const last = loadLastPosture()
    let started: { sessionId: string }
    try {
      started = await this.start({
        cwd: projectPath,
        sessionId: chosen,
        model: last.model,
        effort: last.effort,
        engineId: last.engineId,
      })
    } catch (err) {
      log.warn('sessions', 'seeded new-session start failed; retrying bare', err instanceof Error ? err.message : err)
      started = await this.start({ cwd: projectPath, sessionId: chosen })
    }
    const id = started.sessionId
    this.startedFromRemote.add(id)
    this.attachRemote(id)
    this.notifyDesktopOfHeadless(projectPath) // if this project is open on the Mac, let it adopt this live
    return { sessionId: id }
  }

  /** Resume a PAST session (--resume) headless and attach the remote head. Both id and project must
   *  match a known recent project's history. The phone won't have the prior transcript locally — the
   *  engine keeps the conversation context regardless; the next turn continues it. */
  async resumeRemote(sessionId: string, projectPath: string): Promise<{ sessionId: string }> {
    if (!this.remoteHistory().some((h) => h.id === sessionId && h.projectPath === projectPath))
      throw new Error('unknown session')
    // Resume with the pair the session was last running (persisted by the desktop) — without it the
    // respawn silently falls back to the account default model and clobbers the intent map.
    const stored = this.projectStore(projectPath)?.sessions.find((s) => s.id === sessionId)
    const { sessionId: id } = await this.start({
      sessionId,
      cwd: projectPath,
      model: stored?.model,
      effort: stored?.effort,
      engineId: stored?.engineId,
      // The blob the desktop persisted for this session — the engine's own reattach state.
      resumeCursor: stored?.resumeCursor,
      // A phone attachment is sticky, while a true session end clears the in-memory counter. Seed
      // the respawn before SessionStarted is buffered so restored rows cannot restart at 1 and be
      // mistaken for already-rendered history.
      replaySeq: stored?.replaySeq,
    })
    if (id !== sessionId) this.resumedFrom.set(id, sessionId) // so the phone can load the prior transcript
    this.startedFromRemote.add(id)
    this.attachRemote(id)
    // Seed the replay buffer with the prior history when the store holds no transcript (a headless
    // session's items are never persisted). Without this, the first turn after a resume makes the
    // buffer non-empty, so remoteTranscript's file fallback stops firing and a reopen would show ONLY
    // the new turn. Seeding happens before the resumed engine emits anything, so nothing can double.
    if (!stored?.items?.length && !this.remoteEventLog.get(id)?.length) {
      const seed = normalizeReplaySequence(
        readEngineConversationReplay(stored?.engineId, stored?.cwd || projectPath, sessionId, id),
      )
      if (seed.length) {
        this.remoteEventLog.set(id, seed)
        this.remoteReplaySeq.set(id, seed.at(-1)?.replaySeq ?? 0)
        replaceRemoteReplay(
          stored?.cwd || projectPath,
          sessionId,
          seed.map((entry) => ({ ...entry, sessionId })),
        )
      }
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
      // Read the store BEFORE disposing: a throw here must still find the session live and untouched
      // (W4) — disposing first and discovering the store unreadable afterward made "nothing was
      // changed" a lie (the session was already ended).
      const store = this.projectStore(cwd)
      if (!store) throw new Error('the session store for this project could not be read — nothing was changed')
      // A headless session may have no persisted entry yet (its transcript lives in the replay log) —
      // archive a minimal one so it still lands in Settings → Archived sessions.
      const session = store.sessions.find((s) => s.id === storedId) ?? { id: storedId, label, cwd, userNamed: false, items: [] }
      try {
        await this.dispose(sessionId)
      } finally {
        // A renderer-less archive has no transcript body of its own. The replay log survives dispose
        // specifically so the final unknown/completed child state can be folded into the cold body
        // before true-end cleanup clears the live maps.
        const replay =
          this.remoteEventLog.get(sessionId) ??
          normalizeReplaySequence(
            settleRestoredDelegationReplay(loadRemoteReplay(cwd, storedId, storedId)),
          )
        if (replay.length) {
          const tail = session.items.length
            ? replay.filter(
                (entry) => entry.replaySeq === undefined || entry.replaySeq > (session.replaySeq ?? 0),
              )
            : replay
          session.items = session.items.length
            ? mergeReplayIntoTranscript(session.items, tail)
            : transcriptFromReplay(replay)
          session.replaySeq = Math.max(
            session.replaySeq ?? 0,
            ...replay.map((entry) => entry.replaySeq ?? 0),
          )
        }
        // a true end — forget its approval posture too (dispose alone doesn't); in a finally so a
        // throwing dispose can't skip it (W5).
        this.forgetSession(sessionId)
      }
      // archiveSession writes the cold archive FIRST and only removes the hot-store row once that
      // write is durably confirmed (C2) — a throwing/failed archive must never delete the session from
      // both places.
      if (!archiveSession(cwd, store, session, storedId))
        throw new Error("could not archive the session — it was ended, but it's still in your session list")
      return
    }
    if (!this.remoteHistory().some((h) => h.id === sessionId && h.projectPath === projectPath))
      throw new Error('unknown session')
    const win = windowForProject(realpathOrSelf(projectPath))
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannels.sessionArchiveRequested, { sessionId })
      return
    }
    const store = this.projectStore(projectPath)
    const session = store?.sessions.find((s) => s.id === sessionId)
    if (!store || !session) throw new Error('unknown session')
    // Archives live in their own cold store now (metadata index + split-out body) — never in the hot
    // store above. archiveSession archives first, removing the hot-store row only once that write is
    // durably confirmed (C2).
    if (!archiveSession(projectPath, store, session, sessionId))
      throw new Error('could not archive the session — nothing was changed')
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
    const store = this.projectStore(cwd)
    if (!store) throw new Error('the session store for this project could not be read — nothing was changed')
    const existing = store.sessions.find((s) => s.id === storedId)
    if (existing) {
      existing.label = label
      existing.userNamed = true
    } else store.sessions.push({ id: storedId, label, cwd, userNamed: true, items: [] })
    saveProjectSessions(cwd, store)
    this.deferredDreamLabels.delete(sessionId)
  }

  // ── Desktop adoption of headless (phone-started) sessions ─────────────────────────────────────────
  // A session the phone starts runs windowless on the Mac (start() with no owning window), so the
  // desktop can't see it even though it's alive. Adoption closes that gap: the desktop lists these live
  // sessions and pulls one into a window — routing its future events there AND replaying its buffered
  // history so the conversation appears exactly as a local one would.

  /** Append full replay for remote-attached sessions and delegated-task replay for local sessions.
   *  Streaming deltas are ephemeral; finalized blocks re-carry any text worth restoring. */
  private bufferRemoteEvent(event: EngineEvent): EngineEvent {
    // Routing/runtime state, not transcript: cursor and capability updates would bloat the durable replay
    // sidecar and burn replay identities for rows that should be freshly observed on every engine start.
    if (
      event.type === 'AssistantDelta' ||
      event.type === 'ThinkingDelta' ||
      event.type === 'ResumeCursorUpdated' ||
      event.type === 'SessionCapabilitiesUpdated'
    )
      return event
    const delegated =
      isDelegationLifecycleEvent(event) ||
      ((event.type === 'AssistantBlock' || event.type === 'ToolRequested' || event.type === 'ToolResult') &&
        !!event.parentToolUseId)
    if (!this.remoteAttached.has(event.sessionId) && !delegated) return event
    return this.recordRemoteEntry(event) as EngineEvent
  }

  /** Keep the in-memory adoption log and its durable sidecar in the same order, returning the stamped
   *  row so a live renderer can persist the same identity it will later see during adoption. */
  private recordRemoteEntry(entry: ReplayEntry): ReplayEntry {
    const last = this.remoteReplaySeq.get(entry.sessionId) ?? 0
    const replaySeq = entry.replaySeq && entry.replaySeq > last ? entry.replaySeq : last + 1
    const recorded = { ...entry, replaySeq } as ReplayEntry
    this.remoteReplaySeq.set(entry.sessionId, replaySeq)
    const logArr = this.remoteEventLog.get(entry.sessionId)
    if (logArr) logArr.push(recorded)
    else this.remoteEventLog.set(entry.sessionId, [recorded])
    const cwd = this.projectDirs.get(entry.sessionId)
    if (!cwd) return recorded
    const storedId = this.resumedFrom.get(entry.sessionId) ?? entry.sessionId
    appendRemoteReplay(cwd, storedId, { ...recorded, sessionId: storedId })
    return recorded
  }

  private rememberAcceptedRemoteAttempt(
    sessionId: string,
    attemptId: string,
    fingerprint: string,
    clientTurnId?: string,
  ): void {
    let attempts = this.acceptedRemoteAttempts.get(sessionId)
    if (!attempts) {
      attempts = new Map()
      this.acceptedRemoteAttempts.set(sessionId, attempts)
    }
    // Map insertion order is our bounded LRU. Refreshing the same accepted id must not grow it.
    attempts.delete(attemptId)
    attempts.set(attemptId, { clientTurnId, fingerprint, state: 'running' })
    this.activeRemoteAttemptIds.set(sessionId, attemptId)
    while (attempts.size > REMOTE_ATTEMPT_HISTORY_PER_SESSION) {
      const oldest = attempts.keys().next().value
      if (oldest === undefined) break
      attempts.delete(oldest)
    }
  }

  private markAcceptedRemoteAttemptComplete(sessionId: string): void {
    const attemptId = this.activeRemoteAttemptIds.get(sessionId)
    if (!attemptId) return
    const accepted = this.acceptedRemoteAttempts.get(sessionId)?.get(attemptId)
    if (accepted) accepted.state = 'complete'
    this.activeRemoteAttemptIds.delete(sessionId)
  }

  /** Keep the exact unresolved payload set globally bounded. Eviction preserves provenance and removes
   * only retry bytes, turning that oldest failure into the explicit reattach path. */
  private setRemoteTurnPayload(sessionId: string, payload: RemoteTurnPayload): void {
    this.remoteTurnPayloads.delete(sessionId)
    this.remoteTurnPayloads.set(sessionId, payload)
    while (this.remoteTurnPayloads.size > REMOTE_ATTACHMENT_PAYLOAD_SESSIONS) {
      const oldestSessionId = this.remoteTurnPayloads.keys().next().value
      if (oldestSessionId === undefined) break
      const oldest = this.remoteTurnPayloads.get(oldestSessionId)
      this.remoteTurnPayloads.delete(oldestSessionId)
      if (oldest?.failed) this.stripRemoteTurnPayload(oldestSessionId, oldest)
    }
  }

  private rewriteRemoteReplay(sessionId: string): void {
    const entries = this.remoteEventLog.get(sessionId)
    const cwd = this.projectDirs.get(sessionId)
    if (!entries || !cwd) return
    const storedId = this.resumedFrom.get(sessionId) ?? sessionId
    replaceRemoteReplay(
      cwd,
      storedId,
      entries.map((entry) => ({ ...entry, sessionId: storedId })),
    )
  }

  private remotePayloadMatches(entry: ReplayEntry, payload: RemoteTurnPayload): boolean {
    if (entry.type !== 'RemoteUserTurn') return false
    if (payload.clientTurnId) return entry.clientTurnId === payload.clientTurnId
    return payload.replaySeq !== undefined && entry.replaySeq === payload.replaySeq
  }

  /** Remove exact bytes from every replay boundary for one logical turn. Engine retries intentionally
   * share clientTurnId, so a later success cleans the prior failure attempt as well. */
  private stripRemoteTurnPayload(sessionId: string, payload: RemoteTurnPayload): void {
    const entries = this.remoteEventLog.get(sessionId)
    if (!entries) return
    let changed = false
    const next = entries.map((entry) => {
      if (!this.remotePayloadMatches(entry, payload) || entry.type !== 'RemoteUserTurn' || !entry.images)
        return entry
      changed = true
      const { images: _images, ...provenanceOnly } = entry
      return provenanceOnly as ReplayEntry
    })
    if (!changed) return
    this.remoteEventLog.set(sessionId, next)
    this.rewriteRemoteReplay(sessionId)
  }

  /** A window that already owns a phone session saw the provenance-only user row live. When that
   * attempt fails, update that exact row with the bounded retry payload before the EngineError is
   * delivered, so its durable failure envelope cannot offer a text-only retry for a missing document. */
  private publishPromotedRemoteTurn(
    sessionId: string,
    entry: Extract<ReplayEntry, { type: 'RemoteUserTurn' }>,
  ): void {
    const win = contextForSession(sessionId)?.win
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send(IpcChannels.sessionRemoteUserTurn, {
        sessionId,
        text: entry.text,
        ...(entry.clientTurnId ? { clientTurnId: entry.clientTurnId } : {}),
        hadAttachments: entry.hadAttachments,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        hadImages: entry.hadImages,
        images: entry.images,
        replaySeq: entry.replaySeq,
        append: false,
      })
    } catch (error) {
      // The replay sidecar remains authoritative. A closing renderer can adopt that exact payload on
      // its next open; publication failure must not interfere with settling the engine attempt.
      log.warn(
        'remote',
        'failed turn payload could not be published to its owner',
        error instanceof Error ? error.message : error,
      )
    }
  }

  /** A failed engine attempt may need an exact manual retry after the phone reloads. Promote only the
   * pre-capped whole payload; a missing/oversize payload keeps provenance and requires reattachment. */
  private promoteRemoteTurnPayload(sessionId: string): void {
    const payload = this.remoteTurnPayloads.get(sessionId)
    if (!payload) return
    payload.failed = true
    if (!payload.attachments?.length || payload.replaySeq === undefined) return
    const entries = this.remoteEventLog.get(sessionId)
    if (!entries) return
    let changed = false
    let promoted: Extract<ReplayEntry, { type: 'RemoteUserTurn' }> | undefined
    const next = entries.map((entry) => {
      if (
        entry.type !== 'RemoteUserTurn' ||
        entry.replaySeq !== payload.replaySeq ||
        entry.images
      )
        return entry
      changed = true
      promoted = { ...entry, images: payload.attachments }
      return promoted
    })
    if (!changed) return
    this.remoteEventLog.set(sessionId, next)
    this.rewriteRemoteReplay(sessionId)
    if (promoted) this.publishPromotedRemoteTurn(sessionId, promoted)
  }

  private finishRemoteTurnPayload(sessionId: string, failed: boolean): void {
    const payload = this.remoteTurnPayloads.get(sessionId)
    if (!payload) return
    if (failed) this.promoteRemoteTurnPayload(sessionId)
    else this.stripRemoteTurnPayload(sessionId, payload)
    // Failed entries remain in this bounded map until retry/supersession/eviction so their durable bytes
    // count against the global cap. Success has no exact material left to retain.
    if (!failed) this.remoteTurnPayloads.delete(sessionId)
  }

  /** Track delegated leaves independently from the parent turn. Replacing the engine process while
   *  this map is non-empty would silently orphan work, so all posture/model respawn paths consult it. */
  private trackSubagentLifecycle(event: EngineEvent): void {
    if (event.type === 'SubagentStarted') {
      const active =
        this.activeSubagents.get(event.sessionId) ??
        new Map<string, Extract<EngineEvent, { type: 'SubagentStarted' }>>()
      const current = active.get(event.toolUseId)
      active.set(event.toolUseId, {
        ...event,
        taskId: event.taskId ?? current?.taskId,
        subagentType: event.subagentType === 'subagent' && current ? current.subagentType : event.subagentType,
        description: event.description || current?.description || '',
        prompt: event.prompt ?? current?.prompt,
      })
      this.activeSubagents.set(event.sessionId, active)
      return
    }
    if (event.type === 'SubagentProgress') {
      const active = this.activeSubagents.get(event.sessionId)
      const current = active?.get(event.toolUseId)
      // Progress refines an already-live child; it never opens one. Claude can deliver a final
      // task_notification after the evidence-bearing tool result already closed the card, and
      // synthesizing a new entry here resurrects finished work forever.
      if (!active || !current) return
      active.set(event.toolUseId, {
        ...current,
        taskId: event.taskId ?? current?.taskId,
      })
      return
    }
    if (event.type === 'SubagentCompleted') {
      // Every stop sweep waiting on this child (interrupt) is released here — the child's own terminal
      // event is the only honest proof it stopped, and it proves it for all of them at once.
      const waiting = this.childEndWaiters.get(`${event.sessionId}:${event.toolUseId}`)
      if (waiting) for (const release of [...waiting]) release()
      const active = this.activeSubagents.get(event.sessionId)
      if (!active) return
      active.delete(event.toolUseId)
      if (!active.size) {
        this.activeSubagents.delete(event.sessionId)
        // The last delegate is in. If its parent turn already ended, this is where that turn's real
        // file changes finally settle — TurnComplete deliberately left the boundary open for them.
        this.maybeFinishCompletionTurn(event.sessionId)
      }
    }
  }

  /** First phone attach can happen after a local child started. Backfill any live Starts missing from
   *  the replay log so later Progress/Completed rows always have a card to join after the window closes. */
  private seedActiveSubagentsIntoRemoteReplay(sessionId: string): void {
    const logEntries = this.remoteEventLog.get(sessionId) ?? []
    const started = new Set(
      logEntries.filter((entry) => entry.type === 'SubagentStarted').map((entry) => entry.toolUseId),
    )
    for (const event of this.activeSubagents.get(sessionId)?.values() ?? []) {
      if (!started.has(event.toolUseId)) this.recordRemoteEntry({ ...event, replaySeq: undefined })
    }
  }

  private activeWorkflowSnapshots(sessionId: string): { runId: string; runningAgentIds: string[] }[] {
    const snapshots: { runId: string; runningAgentIds: string[] }[] = []
    for (const [runId, current] of this.workflowWatchers) {
      if (current.sessionId === sessionId && current.watcher.isLive())
        snapshots.push({ runId, runningAgentIds: current.watcher.activeAgentIds() })
    }
    return snapshots
  }

  private hasActiveDelegation(sessionId: string): boolean {
    return (
      (this.activeSubagents.get(sessionId)?.size ?? 0) > 0 ||
      [...this.workflowWatchers.values()].some(
        (current) => current.sessionId === sessionId && current.watcher.isLive(),
      )
    )
  }

  /** Stronger than visible liveness: a workflow watcher lingers after quiet completion because a late
   *  wave can still write. Engine teardown and completion attribution must retain that process owner
   *  until observation really ends, even though the launcher correctly reads the session as settled. */
  private hasOwnedDelegation(sessionId: string): boolean {
    return (
      (this.activeSubagents.get(sessionId)?.size ?? 0) > 0 ||
      [...this.workflowWatchers.values()].some((current) => current.sessionId === sessionId)
    )
  }

  private reserveProcessReplacement(sessionId: string): ProcessReplacementClaim {
    if (this.processReplacements.has(sessionId))
      throw new Error('This session is already changing settings. Let that finish first.')
    const claim = { generation: ++this.nextProcessReplacementGeneration }
    this.processReplacements.set(sessionId, claim)
    return claim
  }

  private releaseProcessReplacement(sessionId: string, claim: ProcessReplacementClaim): void {
    if (this.processReplacements.get(sessionId) === claim) this.processReplacements.delete(sessionId)
  }

  /** Model/effort and Plan-boundary changes can replace the engine process. Main owns the final guard:
   *  a cold or lagging client must never cancel a live turn, strand a pending answer, or cut off a
   *  delegated writer by mutating posture before its local controls have caught up. */
  private assertPostureMutationSafe(sessionId: string, action: string): void {
    if (this.hasOwnedDelegation(sessionId))
      throw new Error(`Delegated work is still running. Let it finish or stop it before ${action}.`)
    if (this.processReplacements.has(sessionId))
      throw new Error(`This session is already changing settings. Let that finish before ${action}.`)
    if (this.turnAdmissions.has(sessionId))
      throw new Error(`A turn is already starting. Let it finish before ${action}.`)
    if (this.working.has(sessionId))
      throw new Error(`A turn is still running. Let it finish or stop it before ${action}.`)
    if (this.gate.pendingRequests(sessionId).length > 0)
      throw new Error(`This session is waiting for your answer. Resolve it before ${action}.`)
  }

  /** The owning process vanished, so success vs failure is unknowable. Emit the same terminal event
   *  live and into durable replay; callers can then replace the process without leaving a false Running. */
  private markActiveSubagentsUnknown(sessionId: string): void {
    const active = [...(this.activeSubagents.get(sessionId)?.entries() ?? [])]
    for (const [toolUseId, task] of active) {
      this.forward({
        type: 'SubagentCompleted',
        sessionId,
        toolUseId,
        ...(task.taskId ? { taskId: task.taskId } : {}),
        outcome: 'unknown',
      })
    }
  }

  /** Infrastructure teardown is the one authorized path that may abandon delegated work. Publish an
   *  honest terminal state for both protocols before dropping their runtime owners. */
  private markActiveDelegationUnknown(sessionId: string): void {
    this.markActiveSubagentsUnknown(sessionId)
    for (const [runId, current] of this.workflowWatchers) {
      if (current.sessionId !== sessionId) continue
      current.watcher.stop()
      this.workflowWatchers.delete(runId)
    }
  }

  /** Nudge the desktop window already open for `projectPath` (if any) to adopt this project's live
   *  headless sessions. Fire-and-forget: no window open ⇒ the session stays headless until the user
   *  opens the project, at which point the renderer adopts it via `adoptHeadlessForWindow`. */
  private notifyDesktopOfHeadless(projectPath: string): void {
    const win = windowForProject(realpathOrSelf(projectPath))
    if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.headlessAppeared, { projectPath })
  }

  /** Return live sessions this renderer can adopt. That includes remote/headless sessions with no
   *  owner, plus sessions this SAME BrowserWindow already owns after its renderer reloaded. Ownership
   *  and snapshotting happen in one synchronous pass, so no event can slip between them. A session
   *  owned by another window is never exposed. */
  adoptHeadlessForWindow(windowId: number, projectPath: string): AdoptedHeadlessSession[] {
    const root = realpathOrSelf(projectPath)
    const out: AdoptedHeadlessSession[] = []
    for (const id of this.sessions.keys()) {
      if (this.deferredDreamVisibility.has(id)) continue
      const owner = contextForSession(id)
      const ownedByRequester = owner?.win.id === windowId
      if (owner && !ownedByRequester) continue
      if (!owner && !this.remoteAttached.has(id)) continue
      if (realpathOrSelf(this.projectDirs.get(id) ?? '') !== root) continue
      if (!owner) addSessionToWindow(windowId, id)
      const cwd = this.projectDirs.get(id) ?? projectPath
      // Carry the label this session already settled on (auto-title, substance retitle, or a phone
      // rename) so the renderer adopts it verbatim instead of regenerating a name the user has seen.
      const storedId = this.resumedFrom.get(id) ?? id
      const stored = this.projectStore(cwd)?.sessions.find((x) => x.id === storedId)
      const storedLabel = stored?.label?.trim()
      const durableLockedLabel = stored?.userNamed && storedLabel ? storedLabel : undefined
      const pendingLabel = durableLockedLabel ? undefined : this.deferredDreamLabels.get(id)?.trim()
      // The gate's REAL posture, not the window's default — a phone (or the dream scheduler) may have
      // set this session's mode before any window existed to display it. Pin it as an explicit entry
      // too (setSessionApprovalMode's same-value push — no broadcast, no loop reset when unchanged):
      // without this, adoption is the one entry path that leaves the session on the fallback default,
      // so a LATER Settings default-mode change silently re-postures its enforcement while the tab
      // pill it already showed on adoption stays put — display-more-restrictive-than-enforced (W4).
      const approvalMode = this.gate.getSessionMode(id)
      this.setSessionApprovalMode(id, approvalMode)
      out.push({
        id,
        cwd,
        engineId: this.sessionEngines.get(id) ?? 'claude',
        model: this.sessionModelEffort.get(id)?.model,
        effort: this.sessionModelEffort.get(id)?.effort,
        label: durableLockedLabel || pendingLabel || storedLabel || undefined,
        userNamed: durableLockedLabel || pendingLabel ? true : stored?.userNamed || undefined,
        fromRemote: this.startedFromRemote.has(id),
        approvalMode,
        working: this.working.has(id),
        activeSubagentToolUseIds: [...(this.activeSubagents.get(id)?.keys() ?? [])],
        activeWorkflows: this.activeWorkflowSnapshots(id),
        capabilities: this.sessionCapabilities.get(id),
        events: [...(this.remoteEventLog.get(id) ?? [])],
      })
      if (durableLockedLabel) this.deferredDreamLabels.delete(id)
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
      for (const p of knownProjectPaths()) {
        found = readPersistedSession(p, storeId)
        if (found) break
      }
    }
    const engine = this.sessionEngines.get(sessionId) ?? found?.engineId ?? 'claude'
    let items = found?.items ?? []
    // A headless (phone-started, or Mac-adopted-then-window-closed) session is never persisted by a
    // renderer, so its `items` are empty even though it has a full history. Fall back to the live replay
    // buffer — the same per-session event log the Mac desktop adopts through — which the phone reduces
    // into a transcript exactly like the live stream. Keyed by the LIVE id (the log is never remapped).
    let events = this.remoteEventLog.get(sessionId)
    const fileCwd = this.projectDirs.get(sessionId) ?? found?.cwd ?? cwd
    if (!events?.length && fileCwd) {
      const durable = normalizeReplaySequence(
        settleRestoredDelegationReplay(loadRemoteReplay(fileCwd, storeId, sessionId)),
      )
      if (durable.length) events = durable
    }
    // A desktop renderer may have persisted the beginning of a task, then closed while the attached
    // engine kept working headless. Fold the durable tail over that snapshot before settling restart
    // state, so a completion/result wins over the older Running row instead of being discarded.
    if (items.length && events?.length) {
      const tail = events.filter(
        (entry) => entry.replaySeq === undefined || entry.replaySeq > (found?.replaySeq ?? 0),
      )
      items = mergeReplayIntoTranscript(items, tail)
    }
    items = settleRestoredTranscriptItems(
      items,
      new Set(this.activeSubagents.get(sessionId)?.keys() ?? []),
      new Map(
        this.activeWorkflowSnapshots(sessionId).map((workflow) => [
          workflow.runId,
          new Set(workflow.runningAgentIds),
        ]),
      ),
    )
    // The replay buffer is in-memory, so a Mac relaunch wipes it — a phone-driven session then opened
    // to a blank "Ready" screen with its whole history sitting in the engine's own conversation file.
    // Last resort: rebuild the events from that file (nothing to read for an engine that keeps none).
    if (!items.length && !events?.length) {
      if (fileCwd) {
        events = normalizeReplaySequence(readEngineConversationReplay(engine, fileCwd, storeId, sessionId))
        if (events.length)
          replaceRemoteReplay(fileCwd, storeId, events.map((entry) => ({ ...entry, sessionId: storeId })))
      }
    }
    // Normalize replay into ordinary transcript rows before it crosses the remote boundary. Relay pages
    // `items`, while raw events are hard-capped by frame budget; a verbose child could otherwise push
    // its Started event out of the retained suffix and make its surviving completion impossible to join.
    if (!items.length && events?.length) items = transcriptFromReplay(events)
    if (items.length) events = undefined
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
    await this.refreshCompletionStatesForProject(cwd)
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
    const cwd = this.remoteCwd(sessionId)
    try {
      const { sha } = await commitPaths(cwd, paths, message)
      await this.refreshCompletionStatesForProject(cwd)
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
    const cwd = this.remoteCwd(sessionId)
    try {
      const r = await this.withExternalProjectMutation(cwd, {}, () => restoreVersion(cwd, sha))
      await this.refreshCompletionStatesForProject(cwd)
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

  /** Resolve a phone-supplied browse target to a project root: a live session's cwd, or a known
   *  project's path directly — so the project screen can browse docs/files WITHOUT a session running.
   *  Same trust rule as startNewRemote: a phone-named path must match a known project; the phone can
   *  never browse an arbitrary directory. */
  private remoteRoot(ref: { sessionId?: string; projectPath?: string }): string {
    if (ref.sessionId) return this.remoteCwd(ref.sessionId)
    const p = ref.projectPath ?? ''
    if (!this.remoteProjectList().some((r) => r.path === p)) throw new Error('unknown project')
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
    return this.withExternalProjectMutation(
      cwd,
      {
        ...(startsNewBurst ? { checkpointLabel: `edit to ${basename(path)}` } : {}),
        refreshOwnership: startsNewBurst,
      },
      async () => ({ path: relative(cwd, await writeProjectFile(cwd, path, content)) }),
    )
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
      if (!contextForSession(id)) {
        try {
          await this.dispose(id)
        } finally {
          this.forgetSession(id) // a true end (the remote tier is off) — not a respawn; fail-safe (W5)
        }
      }
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
  /** The project store for the WINDOWLESS (phone-driven) paths, or `null` when the file is present but
   *  unreadable. `loadProjectSessions` throws in that case on purpose — a failed read handed back as
   *  "no sessions" is what let the store be saved back empty — but a phone turn must not crash over it
   *  either, so callers here degrade instead: a lookup finds nothing, and a WRITE path skips its write
   *  rather than upserting into a fresh empty store and clobbering the file it just failed to read. An
   *  ABSENT store is not a failure — it starts empty, which is how the first headless session lands. */
  private projectStore(projectPath: string): PersistedSessions | null {
    try {
      return loadProjectSessions(projectPath) ?? { version: 3 as const, activeId: null, sessions: [] }
    } catch (err) {
      log.warn('sessions', 'project store unreadable — skipping this read/write', err instanceof Error ? err.message : err)
      return null
    }
  }

  /** A project's persisted sessions for its window to rehydrate on boot (null when none). Backfills
   *  the recovery/resume dir map so a restored session's safety-git timeline resolves before its
   *  engine reattaches (recovery is sessionId-keyed and must work post-crash). Deliberately does NOT
   *  catch — a failed read must reach the renderer as a failure, not as an empty list it would save.
   *  `report` carries back how many rows a SUCCESSFUL read had to set aside, which the caller shows the
   *  user (that case keeps saving, so a shortened list is otherwise invisible). */
  loadSessionsForProject(projectPath: string, report?: StoreReadReport): PersistedSessions | null {
    const persisted = loadProjectSessions(projectPath, report)
    if (persisted)
      for (const s of persisted.sessions) {
        this.projectDirs.set(s.id, s.cwd)
        const liveReplay = this.remoteEventLog.get(s.id)
        const replay =
          liveReplay?.length
            ? liveReplay
            : normalizeReplaySequence(
                settleRestoredDelegationReplay(loadRemoteReplay(s.cwd, s.id, s.id)),
              )
        if (!replay.length) continue
        const tail = s.items.length
          ? replay.filter(
              (entry) => entry.replaySeq === undefined || entry.replaySeq > (s.replaySeq ?? 0),
            )
          : replay
        s.items = s.items.length
          ? mergeReplayIntoTranscript(s.items, tail)
          : transcriptFromReplay(replay)
        s.replaySeq = Math.max(
          s.replaySeq ?? 0,
          ...replay.map((entry) => entry.replaySeq ?? 0),
        )
      }
    const rateLimits = this.remoteRateLimits()
    if (persisted)
      return {
        ...persisted,
        // Old stores can predate persistence compaction, and durable replay can append a fresh verbose
        // result after the last renderer save. Bound every transcript at the final main -> renderer
        // handoff so one giant tool response cannot prevent the boot payload from arriving and healing.
        sessions: persisted.sessions.map((session) => ({
          ...session,
          items: compactTranscriptToolOutput(session.items),
        })),
        rateLimits,
      }
    // Account usage is global, not project-owned. A project with no chat file still needs main's
    // disk-restored snapshot so its footer is honest before the delayed live poll (or while offline).
    return Object.keys(rateLimits).length
      ? { version: 3, activeId: null, sessions: [], rateLimits }
      : null
  }

  /** Persist a project's open sessions + transcripts (keyed by the window's root, supplied by main). */
  persistProjectSessions(projectPath: string, data: PersistedSessions): boolean {
    const saved = saveProjectSessions(projectPath, data)
    for (const s of data.sessions) if (!this.projectDirs.has(s.id)) this.projectDirs.set(s.id, s.cwd)
    return saved
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
    return this.runExclusive(dir, () => {
      this.noteProjectMutation(dir, sessionId)
      // The caller learns of its own restore from the tool result (REREAD_AFTER_RESTORE), in the turn
      // it asked — so it is excluded here rather than told the same thing twice on its next turn.
      return this.restoreLocked(dir, checkpointId, sessionId)
    })
  }

  /**
   * The one restore body both doors share: rewind the tree, then leave every OTHER session running in
   * this project a notice for its next turn. Without it a restore is invisible to a live conversation,
   * which keeps editing files as it last read them (dual-git.md §2). Must run inside runExclusive.
   */
  private async restoreLocked(
    projectDir: string,
    checkpointId: string,
    initiatorSessionId?: string,
  ): Promise<Checkpoint> {
    // Read the target's subject BEFORE the restore records its own "recovered to …" tip, so the notice
    // names the point the user actually picked rather than the marker the recovery just wrote.
    const target = await readCheckpoint(projectDir, checkpointId)
    const restored = await restore(projectDir, checkpointId)
    const notice = restoreNotice(target ? applyHumanizedLabels([target])[0] : null)
    const root = realpathOrSelf(projectDir)
    for (const [sessionId, cwd] of this.projectDirs) {
      if (sessionId === initiatorSessionId || realpathOrSelf(cwd) !== root) continue
      this.pendingRestoreNotices.set(sessionId, notice)
    }
    return restored
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
    return this.runExclusive(projectDir, async () => {
      await this.refreshCompletionStatesLocked(projectDir)
      this.noteProjectMutation(projectDir, 'external')
      const restored = await this.restoreLocked(projectDir, checkpointId)
      await this.refreshCompletionStatesLocked(projectDir)
      return restored
    })
  }

  /**
   * The user's stop button. Delegated children are stopped FIRST, then the parent turn — an engine
   * child outlives the parent's interrupt on both engines (Claude's task keeps running after the
   * control_request; a Codex child is its own thread), so interrupting the parent first leaves work
   * running that the user believes they stopped, spending quota and touching files.
   *
   * Bounded in both directions (the T3 discipline): a child that never confirms cannot hold the stop
   * button hostage, so each gets `CHILD_STOP_TIMEOUT_MS` and the whole sweep `CHILD_STOP_TOTAL_MS`,
   * after which the parent is interrupted regardless. Returns a promise for tests and callers that
   * want the sweep; the void callers (IPC, remote ops) are unaffected.
   */
  async interrupt(sessionId: string): Promise<void> {
    // Cancel the exact prepared turn synchronously, before the child-stop await. The send owns cleanup
    // when its current preflight await resumes. Capturing the engine handle here also prevents a slow
    // child sweep from interrupting a later replacement process that reused the same session id.
    const admission = this.turnAdmissions.get(sessionId)
    if (admission) admission.cancelled = true
    const session = this.sessions.get(sessionId)
    const accepted = this.acceptedTurns.get(sessionId)
    if (accepted) accepted.cancelled = true
    await this.stopDelegatedChildren(sessionId, session)
    // A live admission has not crossed session.sendTurn yet. Its token is the stop; interrupting the
    // idle process after an awaited child sweep could instead hit a newer turn on that same process.
    if (!admission) {
      const current = this.acceptedTurns.get(sessionId)
      if (accepted) {
        // Infrastructure recovery may replace the process while the child sweep is waiting. Follow the
        // same logical generation onto that replacement, but never let an old Stop reach a successor.
        const live = this.sessions.get(sessionId)
        if (current?.generation === accepted.generation && live && current.session === live)
          live.interrupt()
      } else if (current === undefined && this.sessions.get(sessionId) === session) {
        session?.interrupt()
      }
    }
  }

  /** Stop every tracked child of `sessionId` and wait for each to actually end, within the bounds.
   *  Children whose stop the driver refuses (an untracked task, a driver with no task protocol) are
   *  not waited on — there is nothing coming for them. */
  private async stopDelegatedChildren(
    sessionId: string,
    session = this.sessions.get(sessionId),
  ): Promise<void> {
    if (!session?.stopTask) return
    const children = [...(this.activeSubagents.get(sessionId)?.values() ?? [])]
    const waits: Promise<void>[] = []
    for (const child of children) {
      if (!child.taskId) continue
      let accepted = false
      try {
        accepted = session.stopTask(child.taskId)
      } catch (err) {
        log.warn('engine', 'stop-child failed during interrupt', err instanceof Error ? err.message : err)
      }
      if (accepted) waits.push(this.awaitChildEnd(sessionId, child.toolUseId))
    }
    if (!waits.length) return
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((resolve) => setTimeout(resolve, CHILD_STOP_TOTAL_MS)),
    ])
  }

  /** Resolve when this child's terminal event lands, or when this sweep's own bound expires. */
  private awaitChildEnd(sessionId: string, toolUseId: string): Promise<void> {
    const key = `${sessionId}:${toolUseId}`
    return new Promise<void>((resolve) => {
      const waiters = this.childEndWaiters.get(key) ?? new Set<() => void>()
      this.childEndWaiters.set(key, waiters)
      // One resolver per sweep, removed by whichever arrives first (terminal event or bound).
      const release = (): void => {
        clearTimeout(timer)
        waiters.delete(release)
        if (!waiters.size) this.childEndWaiters.delete(key)
        resolve()
      }
      const timer = setTimeout(release, CHILD_STOP_TIMEOUT_MS)
      waiters.add(release)
    })
  }

  /** Stop one delegated child without aborting the parent turn/session or its siblings. */
  stopSubagent(sessionId: string, taskId: string): void {
    const task = [...(this.activeSubagents.get(sessionId)?.values() ?? [])].find((item) => item.taskId === taskId)
    if (!task) throw new Error('That delegated task is no longer running.')
    const session = this.sessions.get(sessionId)
    if (!session?.stopTask || !session.stopTask(taskId))
      throw new Error('Koda could not send the stop request to the running task.')
  }

  /**
   * Ask a side question ("btw" / aside) against `sessionId`'s live context — answered WITHOUT entering
   * the conversation (a `--fork-session` throwaway; see side-question.ts). Streams `delta`/`done`/`error`
   * to the owning window over `asideEvent`. No checkpoint (the fork denies every tool the engine
   * advertised, by bare name — the model has no tool it could attempt or execute, so nothing mutates).
   * Needs the session's cwd to resume; if it's gone (disposed), reports an error event.
   */
  askSideQuestion(sessionId: string, asideId: string, question: string): void {
    if (isHermeticE2EProfile()) {
      this.sendAside(sessionId, asideId, 'error', 'Side questions are disabled in hermetic Koda E2E.')
      return
    }
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
    // DRIVER SELECTION (see start): each driver forks its own live conversation its own way.
    if (engineId === 'codex') {
      // Forking the live Codex thread needs its id, and the cursor is where that lives — read through
      // the driver that owns the blob rather than reaching into it from here.
      const threadId = codexThreadId(this.resumeCursors.get(sessionId))
      if (!threadId) {
        this.sendAside(sessionId, asideId, 'error', 'that conversation is not ready for a side question yet')
        return
      }
      const handle = askCodexSideQuestion(
        {
          parentThreadId: threadId,
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
      const processGeneration = this.sessionGenerations.get(sessionId)
      this.sessions.delete(sessionId)
      try {
        await session.dispose() // → 'close' → handleClose() cancels approvals + unregisters the broker
      } finally {
        // Driver disposal is deliberately bounded. If its child never emitted close before that bound,
        // perform the exact generation's cleanup here; a later callback is then stale and harmless.
        if (
          processGeneration &&
          this.sessionGenerations.get(sessionId) === processGeneration
        ) {
          this.sessionGenerations.delete(sessionId)
          this.gate.cancelSession(sessionId)
          await this.broker.unregister(sessionId)
        }
      }
    }
    // Drop the project mapping only after teardown (a crash keeps it so recovery still works;
    // handleClose, which needs the dir to cancel approvals, has already run by here).
    this.projectDirs.delete(sessionId)
    // A broker recovery replaces only the engine transport under the same logical session. Preserve
    // Dream discovery state across that respawn: exposing a deferred tidy or a hidden REM snapshot
    // during the reconnect would reopen the exact human-handoff race those sets close.
    if (!this.recoveringBroker.has(sessionId)) {
      this.dreamSessions.delete(sessionId)
      this.hiddenDreamSessions.delete(sessionId)
      this.deferredDreamVisibility.delete(sessionId)
      this.deferredDreamLabels.delete(sessionId)
    }
    this.diffBaselines.delete(sessionId)
    this.sessionModelEffort.delete(sessionId)
    this.spawnedWith.delete(sessionId)
    this.resolvedModels.delete(sessionId)
    this.sessionEngines.delete(sessionId)
    // The replacement child republishes its cursor at SessionStarted; a resume-miss restart deliberately
    // clears it first so the fresh spawn can't be handed the dead blob back.
    this.resumeCursors.delete(sessionId)
    this.advertisedTools.delete(sessionId)
    this.sessionCapabilities.delete(sessionId)
    this.brokerRecovery.delete(sessionId)
    this.resumeAfterReconnect.delete(sessionId)
    this.remoteTitled.delete(sessionId)
    this.remoteFirstPrompt.delete(sessionId)
    this.remoteLastReply.delete(sessionId)
    this.remoteTitleGen.delete(sessionId)
    this.lastActivityAt.delete(sessionId)
    // Infrastructure recovery replaces only the transport process; its logical human turn stays active
    // until the replacement child's TurnComplete. Keeping `working` also preserves overlap detection and
    // prevents the completion boundary from closing in the respawn gap.
    if (!this.recoveringBroker.has(sessionId) && !this.resumeMissRecovery.has(sessionId)) {
      this.working.delete(sessionId)
      this.acceptedTurns.delete(sessionId)
    }
    this.lastLines.delete(sessionId)
    this.engineEventAt.delete(sessionId)
    // The reply accumulator belongs to the logical human turn, not the engine process. Broker
    // recovery tears that process down mid-turn and resumes it under the same completion boundary,
    // so keep every delta already received (including any that drain while dispose awaits exit).
    // A failed respawn with no replacement session is cleaned in recoverBroker's finally block.
    if (!this.recoveringBroker.has(sessionId) && !this.resumeMissRecovery.has(sessionId))
      this.turnReplies.delete(sessionId)
    this.activeSubagents.delete(sessionId)
    // Those delegates died with the process, so nothing is left to wait on. Close any boundary their
    // liveness was holding open, or a turn whose process vanished would never reconcile at all.
    // Broker recovery keeps `working`, so a respawn's teardown correctly falls through here.
    this.maybeFinishCompletionTurn(sessionId)
    // NB: pendingWorkflowResults is NOT cleared here — like recoveringBroker, it must SURVIVE a respawn
    // (dispose() is also the broker-recovery / model-effort teardown, and a workflow result stashed
    // before the respawn still needs to ride the next human turn). It's drained on delivery; a truly
    // abandoned entry is one small string that evaporates with the process — no unbounded growth.
    stopLanForward(sessionId) // reap any LAN preview forwarder + forget its (now dead) URL
    clearSessionPreview(sessionId)
    // NB: recoveringBroker is NOT cleared here — a broker recovery calls start()→dispose() on the old
    // child mid-flight, and its own finally removes the flag once the respawn settles. Clearing it here
    // would drop the guard during the respawn and let a racing error trigger a second recovery.
    // NB: turnEndWaiters is NOT cleared here either, for the same reason — a pending awaitTurnEnd must
    // survive the respawn's own dispose() and keep waiting for the NEW child's TurnComplete. Only a true
    // end (forgetSession) drops it.
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
    // Best-effort: stop the in-flight turn before teardown. The parent only — the dispose below kills
    // the engine process, which takes its children with it, so waiting out a child sweep here would
    // only delay a teardown whose window is already gone.
    this.sessions.get(sessionId)?.interrupt()
    try {
      await this.dispose(sessionId)
    } finally {
      this.forgetSession(sessionId) // the owning window is gone for good — a true end, not a respawn; fail-safe (W5)
    }
  }

  async disposeAll(): Promise<void> {
    if (this.usageTimer) {
      clearInterval(this.usageTimer)
      this.usageTimer = null
    }
    this.usageProbe?.release()
    this.usageProbe = null
    await Promise.all(
      [...this.projectDirs.keys()].map(async (id) => {
        try {
          await this.dispose(id)
        } finally {
          this.forgetSession(id) // app quitting — every session is a true end, not a respawn; fail-safe (W5)
        }
      }),
    )
    await this.broker.dispose()
  }

  /**
   * The child exited (crash, interrupt, or our own dispose). Drop the live handle, then tear down
   * the session's broker state: cancel any pending "Ask me" approvals (so their promises don't leak
   * and the renderer clears its prompts) and close the MCP transport. projectDirs is intact here,
   * so the gate can still resolve the dir while cancelling.
   */
  private handleClose(sessionId: string, processGeneration?: symbol): void {
    // A bounded dispose may have returned and installed a successor under this same public id before
    // the old child finally closes. Its callback owns nothing now — especially not the new broker route.
    if (
      processGeneration &&
      this.sessionGenerations.get(sessionId) !== processGeneration
    )
      return
    if (processGeneration) this.sessionGenerations.delete(sessionId)
    // dispose() removes the installed handle before asking the child to exit, while broker recovery
    // and resume-miss recovery mark their logical turns explicitly. A still-installed current child
    // disappearing with an accepted remote attempt is therefore a real crash: settle that attempt and
    // publish one durable retryable terminal before ordinary close cleanup erases liveness.
    const unexpectedAcceptedRemoteClose =
      this.sessions.has(sessionId) &&
      !this.recoveringBroker.has(sessionId) &&
      !this.resumeMissRecovery.has(sessionId) &&
      this.activeRemoteAttemptIds.has(sessionId)
    // The process is gone and any non-terminal child may have made side effects. Surface + persist the
    // honest state before clearing its handle; a later restart must never resurrect it as Running.
    this.markActiveDelegationUnknown(sessionId)
    if (unexpectedAcceptedRemoteClose)
      this.forward({
        type: 'EngineError',
        sessionId,
        message: 'The engine process stopped before this turn finished.',
        fatal: true,
      })
    this.sessions.delete(sessionId)
    this.sessionCapabilities.delete(sessionId)
    // Broker recovery replaces the transport process inside the same logical turn. Keep that writer
    // present through the respawn gap so another same-project turn cannot have its changes claimed by
    // the recovered boundary. A failed recovery's fatal EngineError clears it through forward().
    if (!this.recoveringBroker.has(sessionId) && !this.resumeMissRecovery.has(sessionId)) {
      this.working.delete(sessionId)
      this.acceptedTurns.delete(sessionId)
    }
    this.gate.cancelSession(sessionId)
    void this.broker.unregister(sessionId)
    // A crash (unlike dispose()) has no later teardown frame to close a boundary the dead process held.
    // Broker recovery deliberately keeps `working`, so this remains a no-op until its replacement ends.
    this.maybeFinishCompletionTurn(sessionId)
  }

  /**
   * The engine no longer holds a conversation the driver asked it to reattach. Everything the user can
   * see — the transcript, the project, the posture, the phone attachment — belongs to Koda, not to the
   * engine's memory of it, so the session continues under the same id with a clean engine conversation
   * and one plain line saying what happened. The turn the dead child swallowed is sent again, so a
   * resume miss costs the user the agent's memory of earlier turns and nothing else.
   *
   * Single-flight per session. Ordering note: this is called from inside the dying child's close
   * handling, and `start()` awaits the broker before it registers — so that child's own teardown
   * (broker unregister, gate cancel) always completes before the replacement registers.
   */
  private async recoverResumeMiss(sessionId: string): Promise<void> {
    if (this.resumeMissRecovery.has(sessionId)) return
    const cwd = this.projectDirs.get(sessionId)
    if (!cwd) return
    this.resumeMissRecovery.add(sessionId)
    // The blob is dead. Drop it so the replacement can't be handed it back.
    this.resumeCursors.delete(sessionId)
    log.warn('engine', 'resume miss — restarting this session on a clean conversation', { sessionId })
    const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
    const engineId = this.sessionEngines.get(sessionId) ?? 'claude'
    const planMode = this.gate.getSessionMode(sessionId) === 'plan'
    const replay = this.pendingTurns.get(sessionId)
    const accepted = this.acceptedTurns.get(sessionId)
    try {
      await this.start({ sessionId, cwd, model, effort, engineId, planMode, abandonActiveDelegation: true })
      // Stop is attached to the logical admission generation, which survives the no-process gap. If it
      // landed while start() was replacing the child, do not claim that Koda resent anything and do not
      // let the fresh process touch files for a turn the user already stopped.
      const currentAccepted = this.acceptedTurns.get(sessionId)
      if (
        accepted?.cancelled ||
        (accepted && currentAccepted?.generation !== accepted.generation)
      ) {
        if (currentAccepted?.generation === accepted.generation) {
          this.settleStoppedContinuation(sessionId)
        }
        return
      }
      this.forward({
        type: 'EngineError',
        sessionId,
        fatal: false,
        message: replay
          ? "The engine had no memory of this chat left, so Koda continued it on a fresh conversation and sent your last message again. Earlier messages are still here to read, but the agent can't see them."
          : "The engine had no memory of this chat left, so Koda continued it on a fresh conversation. Earlier messages are still here to read, but the agent can't see them.",
      })
      if (replay) {
        // The held copy stays authoritative while the continuation re-enters sendTurn; only the genuine
        // TurnComplete discharges it. Deleting first would lose the user's message if the clean replacement
        // dies before accepting the resend.
        await this.sendTurn(
          sessionId,
          replay.engineText,
          replay.inlineImages,
          replay.visible.origin,
          {
            logicalContinuation: 'resume-miss',
            ...(replay.visible.attemptId ? { attemptId: replay.visible.attemptId } : {}),
            ...(replay.visible.clientTurnId ? { clientTurnId: replay.visible.clientTurnId } : {}),
          },
        )
      } else this.working.delete(sessionId)
    } catch (err) {
      this.working.delete(sessionId)
      this.forward({
        type: 'EngineError',
        sessionId,
        fatal: true,
        message: `Koda couldn't restart this chat: ${err instanceof Error ? err.message : String(err)}. Start a new chat to keep going.`,
      })
      // The fatal terminal above performs normal turn cleanup. Restore the original held payload afterward
      // so a failed replacement remains diagnosable/retryable instead of silently erasing its send material.
      if (replay) this.pendingTurns.set(sessionId, replay)
    } finally {
      this.resumeMissRecovery.delete(sessionId)
    }
  }

  /** Settle a logical turn stopped while its replacement process had not accepted the continuation.
   *  The synthetic terminal closes liveness/receipts, but it must not claim the replacement read a
   *  restore notice. Disarm that delivery first so the next genuine human turn receives it again. */
  private settleStoppedContinuation(sessionId: string): void {
    this.armedRestoreNotices.delete(sessionId)
    // A broker transport TurnComplete is normally suppressed while recovery is in flight. This one is
    // the logical terminal created after the replacement exists, so retire that suppression first.
    this.recoveringBroker.delete(sessionId)
    this.forward({ type: 'TurnComplete', sessionId, stopReason: 'interrupted' })
  }

  /**
   * Reconnect the permission/capability broker for a session whose engine reported it "not connected".
   * The broker is an in-process MCP server and the engine's client can't re-handshake it live under -p,
   * so recovery = respawn the same session with --resume: dispose the child, mint a fresh broker route,
   * spawn again (the conversation is preserved by --resume). Single-flight per session (a burst of
   * failing tools triggers one respawn) and rate-limited (a broker that won't stay up can't spin us in a
   * loop). The interrupted turn resumes under the SAME logical completion boundary, so edits made
   * before the drop remain visible/attributed even if the resumed child performs no further write.
   * Reuses the model/effort/engine the session last ran with.
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
    const interruptedBoundary = this.completionTurns.get(sessionId)
    const interruptedDiffBaseline = this.diffBaselines.get(sessionId)
    const interruptedAccepted = this.acceptedTurns.get(sessionId)
    try {
      const { model, effort } = this.sessionModelEffort.get(sessionId) ?? {}
      // The gate's posture now survives this respawn (ApprovalGate.cancelSession no longer wipes it),
      // so read it BEFORE start()'s internal dispose — a session parked in Plan must come back unable
      // to write, not silently promoted to a fully-auto writing session (adapter.ts only passes
      // --permission-mode plan when planMode is set).
      const planMode = this.gate.getSessionMode(sessionId) === 'plan'
      // start() disposes the still-live child first (it sees the id in this.sessions), which unregisters
      // the stale broker route, then re-registers a fresh one before spawning with --resume.
      await this.start({
        sessionId,
        cwd,
        model,
        effort,
        planMode,
        abandonActiveDelegation: true,
      })
      // start()'s process teardown clears the live-diff baseline as normal disposal hygiene. A broker
      // respawn is not a new task, though: restore the interrupted task's exact pinned baseline unless
      // a genuinely newer turn raced in and installed its own.
      if (
        interruptedDiffBaseline &&
        this.completionTurns.get(sessionId) === interruptedBoundary &&
        !this.diffBaselines.has(sessionId)
      )
        this.diffBaselines.set(sessionId, interruptedDiffBaseline)
      // Stop belongs to the logical admission generation, including the gap where start() has removed
      // the old process but not yet published the replacement's SessionStarted. Never auto-resume a
      // cancelled turn, and never let this recovery nudge a successor generation that reused the id.
      const currentAccepted = this.acceptedTurns.get(sessionId)
      if (
        interruptedAccepted?.cancelled ||
        (interruptedAccepted && currentAccepted?.generation !== interruptedAccepted.generation)
      ) {
        if (currentAccepted?.generation === interruptedAccepted.generation)
          this.settleStoppedContinuation(sessionId)
        return
      }
      // Auto-resume: pick the interrupted turn back up on its own once the fresh session is initialized.
      // Added AFTER start() (its internal dispose of the old child already ran) and before the new
      // child's SessionStarted can fire (a later event-loop tick), so the flag is set in time.
      this.resumeAfterReconnect.set(sessionId, interruptedAccepted?.generation)
      this.forward({ type: 'EngineError', sessionId, fatal: false, message: 'Reconnected — resuming where you left off…' })
    } catch (err) {
      if (
        interruptedDiffBaseline &&
        this.completionTurns.get(sessionId) === interruptedBoundary &&
        !this.diffBaselines.has(sessionId)
      )
        this.diffBaselines.set(sessionId, interruptedDiffBaseline)
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
      else {
        this.brokerRecovery.delete(sessionId)
        this.turnReplies.delete(sessionId)
      }
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

  /** Only the exact process incarnation installed for this public session id may publish events. A
   *  bounded dispose can leave the old child alive briefly after its successor starts; its late
   *  TurnComplete/Error must not settle or clear the successor's turn state. */
  private forwardProcessEvent(
    event: EngineEvent,
    processGeneration?: symbol,
  ): EngineEvent | undefined {
    if (
      !processGeneration ||
      this.sessionGenerations.get(event.sessionId) !== processGeneration
    )
      return undefined
    return this.forward(event)
  }

  /**
   * One window per project for now, so every event goes to the sole window;
   * the renderer routes by the event's `sessionId`. Validate before crossing
   * the boundary — but contain a bad shape (safeParse), never throw out of the
   * stdout-drain callback chain that calls this.
   */
  private forward(event: EngineEvent): EngineEvent | undefined {
    // The driver asked its engine to reattach a conversation the engine no longer holds (a ghost store
    // entry, a cleared transcript, a thread deleted on the other side). Nothing on disk predicts this —
    // the engine is the only authority — so it is handled where it lands: restart the session clean and
    // say so once. The signal itself never reaches a surface; recoverResumeMiss posts the notice.
    if (event.type === 'EngineError' && event.category === 'resumeMiss') {
      void this.recoverResumeMiss(event.sessionId)
      return undefined
    }
    // Telemetry (opt-in): the classifier TONE only — the message can carry file paths, so it never
    // leaves. forward() is the one funnel both drivers' errors pass through.
    if (event.type === 'EngineError')
      track('engine_error', { tone: friendlyEngineError(event.message, event.fatal).tone, fatal: event.fatal })

    this.logEvent(event)
    this.trackSubagentLifecycle(event)
    // A broker-drop ToolResult starts recovery synchronously before the adapter can drain the next
    // stdout line. If that old child then emits TurnComplete, it ended only the failed transport
    // attempt—not the logical human turn that the replacement child is about to continue.
    const brokerTransportTurnComplete =
      event.type === 'TurnComplete' && this.recoveringBroker.has(event.sessionId)

    // Per-session turn-activity → the launcher's live working/idle glyph (remote heads poll the launcher;
    // they have no event stream at browse level). Driven off the SAME live events the client's `busy`
    // reducer uses, so ANY active session shows working regardless of how its turn started — a desktop IPC
    // turn, a phone turn, a resume, a broker-recovery nudge — not only turns routed through sendTurn (which
    // sets it too, for the instant before the first delta lands). Ends on TurnComplete, fatal process
    // loss, or an explicit turn rejection that happened before any work could start.
    if (isTopLevelTurnActivity(event)) {
      this.working.add(event.sessionId)
      this.engineEventAt.set(event.sessionId, Date.now())
    }
    // ToolResult and delegation lifecycle events refresh the evidence clock WITHOUT joining
    // working.add. Besides proving activity, delegated events mutate the saved transcript after the
    // parent turn can already be idle, so corpus certification must see their exact arrival time.
    else if (
      event.type === 'ToolResult' ||
      isDelegationLifecycleEvent(event)
    )
      this.engineEventAt.set(event.sessionId, Date.now())
    else if (
      !brokerTransportTurnComplete &&
      (event.type === 'TurnComplete' ||
        (event.type === 'EngineError' && (event.fatal || event.category === 'turnRejected')))
    ) {
      // A genuine TurnComplete proves the agent read the notice its turn carried — the one moment
      // the pending notice is discharged. The text must still match: a restore DURING the turn
      // queued a newer notice describing the current disk, which the finished turn never saw.
      if (event.type === 'TurnComplete') {
        const armed = this.armedRestoreNotices.get(event.sessionId)
        if (armed && this.pendingRestoreNotices.get(event.sessionId) === armed)
          this.pendingRestoreNotices.delete(event.sessionId)
      }
      this.armedRestoreNotices.delete(event.sessionId)
      this.working.delete(event.sessionId)
      this.acceptedTurns.delete(event.sessionId)
      // The turn reached its end, so there is nothing left for a resume-miss recovery to replay.
      this.pendingTurns.delete(event.sessionId)
      // A scheduler-owned scope and a backgrounded delegate both still have writes to land after the
      // engine stops. Keep the logical completion boundary open until the last of them is done.
      this.maybeFinishCompletionTurn(event.sessionId)
      // The genuine end-of-turn signal `awaitTurnEnd` waits for (W3) — resolved here, not off
      // `working`, so a benign respawn's transient false (fatal: false) never fires it.
      const waiter = this.turnEndWaiters.get(event.sessionId)
      if (waiter) {
        this.turnEndWaiters.delete(event.sessionId)
        waiter()
      }
    }

    // Keep the transport attempt's real usage/account activity, but do not expose a false logical
    // completion to the renderer/phone, consume first-turn titling, reconcile task ownership, or wake
    // an unattended supervisor. The resumed child's TurnComplete owns all of those effects.
    if (event.type === 'TurnComplete' && brokerTransportTurnComplete) {
      recordTurnUsage(event.models, event.costEstimate, this.sessionEngines.get(event.sessionId) ?? 'claude')
      this.noteEngineActivity(event.sessionId)
      if (Date.now() - this.lastUsagePoll >= USAGE_POLL_MIN_GAP_MS) void this.pollUsage()
      return undefined
    }

    // A retryable engine failure is the only point exact phone attachment bytes may enter durable
    // replay. A genuine terminal event also settles the accepted-attempt receipt used by app-kill
    // recovery; broker transport completions returned above are explicitly not logical terminals.
    if (
      event.type === 'EngineError' &&
      (event.fatal || event.category === 'apiError' || event.category === 'turnRejected')
    ) {
      this.promoteRemoteTurnPayload(event.sessionId)
      if (event.fatal || event.category === 'turnRejected') {
        this.finishRemoteTurnPayload(event.sessionId, true)
        this.markAcceptedRemoteAttemptComplete(event.sessionId)
      }
    } else if (event.type === 'TurnComplete') {
      const payload = this.remoteTurnPayloads.get(event.sessionId)
      this.finishRemoteTurnPayload(event.sessionId, payload?.failed === true)
      this.markAcceptedRemoteAttemptComplete(event.sessionId)
    }

    // The native envelope has done its job by here: the drivers stamped it and every main-side reader
    // above has seen it. Everything below this line serializes — the durable replay log, the relay
    // frame, the renderer send — so drop a payload no surface reads before it doubles disk and wire.
    event = this.bufferRemoteEvent(stripRawEnvelope(event))
    this.noteTerminalAttention(event)

    // The launcher's "what is it doing" line — the first non-empty line of the latest finalized reply.
    if (event.type === 'AssistantBlock') {
      // Top-level blocks only — a subagent's text isn't the agent's reply.
      if (!event.parentToolUseId) {
        const sofar = this.turnReplies.get(event.sessionId)
        this.turnReplies.set(
          event.sessionId,
          (sofar ? `${sofar}\n\n${event.markdown}` : event.markdown).slice(0, 4000),
        )
        const line = event.markdown.split('\n').find((l) => l.trim())
        if (line) this.lastLines.set(event.sessionId, line.trim().slice(0, 140))
        // Keep the latest full reply for a headless session still awaiting its substance retitle.
        if (this.remoteFirstPrompt.has(event.sessionId))
          this.remoteLastReply.set(event.sessionId, event.markdown.slice(0, 2000))
      }
    }

    // One-shot substance retitle for a headless (phone-started) session — mirrors the renderer's
    // TurnComplete retitle: once the FIRST turn finishes cleanly, rename from prompt + final reply so
    // repeat sessions on the same topic come apart. The maps only ever hold a session between its
    // first prompt and first TurnComplete, so this can't re-fire. persistRemoteTitle guards userNamed.
    if (
      event.type === 'TurnComplete' &&
      event.stopReason !== TURN_REJECTED_STOP_REASON &&
      this.remoteFirstPrompt.has(event.sessionId)
    ) {
      const sid = event.sessionId
      const { prompt, cwd } = this.remoteFirstPrompt.get(sid)!
      const reply = this.remoteLastReply.get(sid)
      this.remoteFirstPrompt.delete(sid)
      this.remoteLastReply.delete(sid)
      if (event.stopReason === 'success' && reply && !contextForSession(sid)) {
        const storedId = this.resumedFrom.get(sid) ?? sid
        const gen = (this.remoteTitleGen.get(sid) ?? 0) + 1
        this.remoteTitleGen.set(sid, gen) // invalidates a still-in-flight birth-title call
        void this.nameSession({
          kind: 'regenerate',
          evidence: `${prompt.slice(0, 1500)}\n\nWhat the agent did:\n${reply}`,
          currentTitle: this.projectStore(cwd)?.sessions.find((s) => s.id === storedId)?.label,
          avoid: this.takenRemoteTitles(cwd, storedId),
        })
          .then(({ title, overview }) => {
            if (this.remoteTitleGen.get(sid) !== gen) return
            if (title.trim() && !contextForSession(sid))
              this.persistRemoteTitle(cwd, storedId, title.trim(), false, overview)
          })
          .catch(() => {})
      }
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

    // The driver's own reattach state, stored verbatim. Read nothing but the envelope.
    if (event.type === 'ResumeCursorUpdated') this.resumeCursors.set(event.sessionId, event.cursor)

    if (event.type === 'SessionStarted') {
      if (event.tools.length) this.advertisedTools.set(event.sessionId, event.tools)
      // The model the engine actually resolved to — what a "Default" pick means, shown on the phone.
      if (event.model) this.resolvedModels.set(event.sessionId, event.model)
      // A fresh session from a broker reconnect: auto-send the continuation nudge now that the engine is
      // initialized, so the turn the drop interrupted resumes without the user resending anything.
      if (this.resumeAfterReconnect.has(event.sessionId)) {
        const recoveryGeneration = this.resumeAfterReconnect.get(event.sessionId)
        this.resumeAfterReconnect.delete(event.sessionId)
        const accepted = this.acceptedTurns.get(event.sessionId)
        if (
          recoveryGeneration !== undefined &&
          accepted?.generation !== recoveryGeneration
        ) {
          // A newer logical turn owns this public id. The delayed recovery signal owns nothing now.
        } else if (accepted?.cancelled) {
          this.settleStoppedContinuation(event.sessionId)
        } else {
          this.sendTurn(event.sessionId, BROKER_RESUME_NUDGE, undefined, 'local', {
            logicalContinuation: 'broker-recovery',
          }).catch((err) =>
            log.warn('broker', 'auto-resume turn failed', err instanceof Error ? err.message : err),
          )
        }
      }
    }
    if (event.type === 'SessionCapabilitiesUpdated') {
      this.advertisedTools.set(event.sessionId, event.snapshot.tools)
      this.sessionCapabilities.set(event.sessionId, event.snapshot)
    }

    // Fold each completed turn into the daily usage rollup (main-side, file-first). Asides ("btw")
    // run a separate throwaway process and never reach here — a small deliberate cost the history
    // doesn't capture (so it can read slightly under the real account total if asides get heavy).
    if (event.type === 'TurnComplete')
      recordTurnUsage(event.models, event.costEstimate, this.sessionEngines.get(event.sessionId) ?? 'claude')

    // Turn-end is engine activity too — the dream scheduler's quiet clock re-arms from the LAST
    // event of the day, not the last send (a long final turn shouldn't shorten the quiet window).
    if (event.type === 'TurnComplete') this.noteEngineActivity(event.sessionId)

    // The steered turn is over, so the live posture is the truth again. A posture the user changed
    // mid-turn takes effect from here — the same boundary the next turn's mode block announces.
    if (event.type === 'TurnComplete') this.gate.pinTurnMode(event.sessionId, null)

    // A turn just moved the needle — refresh the plan gauge instead of leaving it up to a minute stale.
    // Debounced, so a run of short turns doesn't spawn a poll each time.
    if (event.type === 'TurnComplete' && Date.now() - this.lastUsagePoll >= USAGE_POLL_MIN_GAP_MS)
      void this.pollUsage()

    // Watch the account-level 5-hour window so we can ping once when a MAXED window resets (not every window).
    if (event.type === 'RateLimitUpdate') {
      const engine = event.engine ?? this.sessionEngines.get(event.sessionId) ?? 'claude'
      const merged = reconcileRateLimitWindows(
        this.lastRateLimits.get(engine) ?? {},
        event.info,
        event.authoritativeTypes,
      )
      if (merged.accepted) {
        this.lastRateLimits.set(engine, merged.windows)
        replaceRateLimits(engine, merged.windows)
        noteRateLimit(engine, merged.windows[event.info.rateLimitType])
      }
      event = {
        ...event,
        engine,
        info: merged.windows[event.info.rateLimitType] ?? event.info,
        reconciledWindows: merged.windows,
      }
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
        (runId) => {
          this.workflowWatchers.delete(runId)
          // TurnComplete may already have arrived. The workflow watcher was the final possible writer,
          // so its observation boundary is the moment change attribution may honestly reconcile.
          this.maybeFinishCompletionTurn(event.sessionId)
        },
        // Stash the finished workflow's result for delivery on this session's next human turn.
        (resultText) => this.stashWorkflowResult(event.sessionId, resultText),
      )
      this.workflowWatchers.set(event.runId, { sessionId: event.sessionId, watcher })
      watcher.start()
    }

    const parsed = EngineEventSchema.safeParse(event)
    if (!parsed.success) {
      log.error('engine', 'dropped malformed event', { issues: parsed.error.issues, event })
      return undefined
    }
    publishNeuralEvent(
      this.projectDirs.get(parsed.data.sessionId),
      parsed.data,
      this.sessionEngines.get(parsed.data.sessionId),
    )
    this.send(IpcChannels.engineEvent, parsed.data.sessionId, parsed.data)
    return parsed.data
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

  /** Fold engine terminal edges into the small launcher fact. This deliberately mirrors the desktop's
   *  error-banner threshold. Once an error wins a logical turn, its compatibility TurnComplete cannot
   *  relabel that failed turn as done; only acceptance of a later human turn clears it. */
  private noteTerminalAttention(event: EngineEvent): void {
    const kind = terminalAttentionKind(event)
    if (!kind) return
    if (kind === 'done' && this.terminalAttention.get(event.sessionId)?.kind === 'error') return
    this.terminalAttention.set(event.sessionId, {
      kind,
      revision: terminalAttentionRevision(event) ?? randomUUID(),
    })
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

/** Main stores renderer transcript rows opaquely, but this tiny structural read is enough to give a
 *  launcher row its human subject after a restart when the saved label is still only a placeholder. */
function firstPersistedUserPrompt(items: readonly unknown[] | undefined): string | undefined {
  for (const raw of items ?? []) {
    const item = raw as { kind?: unknown; text?: unknown }
    if (item?.kind !== 'user' || typeof item.text !== 'string') continue
    const text = item.text.trim()
    if (text && text !== '(image)') return text
  }
  return undefined
}

/** Labels created before the conversation has a subject. A manual rename always bypasses this check. */
function isProvisionalSessionLabel(label: string, cwd: string): boolean {
  if (isProvisionalSessionTitle(label)) return true
  const normalized = label.trim().toLocaleLowerCase()
  const projectName = basename(cwd).trim().toLocaleLowerCase()
  return normalized === 'session' || (!!projectName && normalized === projectName)
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
