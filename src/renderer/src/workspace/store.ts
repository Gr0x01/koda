import { create } from 'zustand'
import {
  attachedFilesNote,
  clampLayout,
  DEFAULT_LAYOUT,
  faceTurnText,
  undoPointRefusal,
} from '@shared/ipc'
import { compactTranscriptToolOutput } from '@shared/tool-output'
import {
  appendLiveToolOutput,
  attachTurnFailureToTranscript,
  hasRunningDelegation,
  isTopLevelTurnActivity,
  latestTurnFailureOf,
  settleRestoredTranscriptItem,
  settleRestoredTranscriptItems,
  supersedeTurnFailure,
  terminalAttentionKind,
} from '@shared/delegation'
import {
  appSummonThread,
  faceDayKey,
  faceDayLabel,
  rememberAppSummonThread,
} from '@shared/face-thread'
import type {
  ApprovalMode,
  ApprovalRequest,
  ArchivedPreviewTurn,
  ArchivedSessionMeta,
  AsideEvent,
  BackupKept,
  BillingMode,
  MemoryWeight,
  ContextUsage,
  EngineEvent,
  EngineId,
  GitStatusFile,
  MiniAppInfo,
  LegacyKeptDocPathChange,
  ModelSpend,
  PreviewRestart,
  PersistedSession,
  PersistedSessions,
  ProviderKind,
  ProviderStatusEvent,
  RateLimitInfo,
  ResumeCursor,
  SessionCapabilitySnapshot,
  SessionNameKind,
  TaskCompletionState,
  StageReceipt,
  WorkspaceLayoutSizes,
} from '@shared/ipc'
import { expandDocMentionLabels, hasDocMention } from '../doc-mentions'
import { countWords } from '../transcript/CanvasEditChip'
import { flushFileWritersUnder } from './file-writer-registry'
import { namingEvidence, shouldRegenerateName, userMessages } from './session-naming'
import { isModelAlias, prettyModel } from './models'
import type {
  Entry,
  SubagentChild,
  SubagentChildData,
  SubagentItem,
  TurnItem,
} from '../transcript/Transcript'
import type { TaskRow } from '../transcript/TaskList'
import { engineCapabilities } from '@shared/engine-capabilities'
import {
  isProvisionalSessionTitle,
  isSessionNamingPrompt,
  NEW_SESSION_TITLE,
  PHONE_SESSION_TITLE,
  titleFromPrompt,
} from '@shared/session-title'

/** An attachment staged for the next turn (base64). Transient draft state — never persisted.
 *  Images go inline to the engine; document files (non-`image/*` mediaType, csv/pdf) carry their
 *  original `name` and reach the engine as a saved `.koda/scratch/` path instead (see send()). */
export type ImageDraft = { mediaType: string; dataBase64: string; name?: string; scratchPath?: string }
export type DeleteEntryResult = { ok: true } | { ok: false; error: string }
/** The workflow turn-item, narrowed from Entry — the journal watcher patches its agents/status. */
type WorkflowEntry = Extract<Entry, { kind: 'workflow' }>

/**
 * One live `claude -p` session's renderer state. Multi-session = N of these on one
 * project; the engine event stream is demuxed into the right record by `sessionId`
 * (every EngineEvent carries it — shared/ipc.ts). Status is DERIVED (see `statusOf`),
 * not stored, so there's one source of truth per signal: `busy` from turn lifecycle,
 * `errored` from a fatal engine error, "waiting" from the pending-approval queue.
 */
export interface SessionState {
  id: string
  label: string
  /** One plain sentence saying what this thread is about — the sessions map's second line, generated
   *  beside the title (see `nameSession`). Absent until a naming turn answers with one; a user rename
   *  clears it rather than leaving a sentence about the old subject. Persisted. */
  overview?: string
  /** Epoch ms of this session's last OBSERVED activity: a turn sent, a turn finished, an approval
   *  asked. The sidebar row reads its age off this stamp (`ageLabel`, session-map.ts), which is the
   *  only thing marking a dormant thread. Never set by a user action — merely opening a session must
   *  not make it look freshly worked in. Persisted, so a row's age survives a restart. */
  lastActivityAt?: number
  /** True once the user manually renamed this session. Locks the label: the generated title
   *  won't overwrite a name the user chose. Persisted. */
  userNamed: boolean
  /** The user-message count this thread was last re-named at — what makes the regeneration crossings
   *  an EDGE rather than a level (see the TurnComplete reducer). Persisted. */
  namedAtTurns?: number
  /** The project dir this session runs in — persisted so a restored session resumes in the same
   *  place (resume is cwd-scoped; spike/resume). */
  cwd: string
  items: Entry[]
  /** Highest durable remote/headless replay event applied to this rendered session. */
  replaySeq?: number
  streaming: string
  busy: boolean
  /** When the running turn was dispatched, for the live "Working for 1m 12s" readout. Cleared when the
   *  turn ends, which stamps the elapsed time onto that turn's user message. Not persisted: a turn
   *  cannot survive a restart, so a stale start would tick from a time that no longer means anything. */
  turnStartedAt?: number
  errored: boolean
  draft: string
  /** Pasted/dragged images staged for the next turn (base64); cleared on send. Not persisted. */
  attachments: ImageDraft[]
  /** True once the engine process is live this run. A session restored from disk starts false and
   *  reattaches (`claude --resume`) on its next turn — its history shows immediately regardless. */
  live: boolean
  /** A backgrounded session reached a notable state (done/error/needs-you) the user hasn't seen.
   *  Drives the card/sidebar marker + dock badge; cleared when the user selects it. */
  attention: boolean
  /** This session's approval posture (ask / acceptEdits / auto). Per-session — one agent can run
   *  unattended while another asks before every command. Pushed to the gate on start + reattach. */
  approvalMode: ApprovalMode
  /** The model the user chose for this session (`--model` on reattach) — an engine alias or a full
   *  id they typed; undefined ⇒ engine default. Persisted. The engine can't switch model live on a -p
   *  process, so changing it drops the engine and the next turn reattaches with --model (like plan). */
  model?: string
  /** The session's reasoning effort (`--effort` on reattach) — one of the engine's own terms
   *  (low/medium/high/xhigh/max); undefined ⇒ engine default (adaptive). Persisted. Spawn-time like
   *  the model, so changing it drops the engine and the next turn reattaches with --effort. */
  effort?: string
  /** Which engine drives this session (`claude` | `codex`). Set at creation (from the remembered
   *  last-used engine) and immutable once the conversation starts — switching engine respawns a fresh
   *  session, allowed by the UI only before the first turn. Persisted. */
  engineId: EngineId
  /** How this session's engine reattaches its own conversation — an opaque, driver-owned blob (see
   *  `ResumeCursorSchema`). Captured from `ResumeCursorUpdated` and persisted, so a reattach hands the
   *  engine back exactly what it needs. Never read here; passed through untouched. */
  resumeCursor?: ResumeCursor
  /** The model the engine ACTUALLY reported running (system/init) — ground truth for display, not
   *  persisted (refreshed every reattach). Differs from `model` only briefly before a switch lands,
   *  or if the engine fell back from a retired id. */
  activeModel?: string
  /** What this live engine actually loaded in this cwd. Ephemeral by design: a reattach must attest
   * again instead of restoring stale capability claims from disk. */
  capabilities?: SessionCapabilitySnapshot
  /** Context-window occupancy after the last turn — drives the meter (§7a). Undefined until the
   *  first turn completes; persisted so the gauge survives a restart, then refreshed next turn. */
  context?: ContextUsage
  /** Running estimated spend for this session (USD) — summed from each turn's `total_cost_usd`. On a
   *  subscription this is the API-EQUIVALENT estimate (covered by the plan); in API mode it's the real
   *  amount billed. Drives the Usage view (no precise plan % — that's ToS-barred). Persisted. */
  spendUsd: number
  /** Per-model accumulated totals (cost + token split, cache called out), keyed by the engine's model
   *  id — drives the Usage view's by-model breakdown. Summed from each turn's `models`. Persisted. */
  byModel: Record<string, ModelSpend>
  /** How to bring this session's preview back after it's torn down — the agent's last dev-server command
   *  or static file (from the `preview:show` push). Drives the "Restart preview" button on the empty
   *  stage. Persisted, so a preview is one click to recover after a window close / restart kills it. */
  lastPreview?: PreviewRestart
  /** An in-flight or just-answered side question ("btw" / aside) — a question answered from this
   *  session's context WITHOUT entering the conversation. Ephemeral: shown in a dismissible overlay,
   *  never persisted, never an Entry in `items`. At most one at a time (a new ask replaces it). */
  aside?: AsideState
  /** The current `draft` is a real message staged from an aside ("Add to chat"), not free-typed. Forces
   *  the composer OUT of aside-mode even while the agent is busy, so bringing a side answer back reaches
   *  the agent instead of looping into another aside. Cleared when the box empties or the message sends. */
  replyStaged?: boolean
  /** This session was started from the phone and adopted into this window (its transcript was replayed
   *  from the live event log, not rendered here from turn one). Drives the "from your phone" sidebar
   *  marker. Not persisted — on the next boot it restores as an ordinary local session. */
  fromRemote?: boolean
  /** A turn-level failure (an API error, or a fatal engine stop) shown as a banner just above the
   *  composer instead of raw text in the transcript. The UI classifies `message` into calm copy
   *  (shared/engine-error). Cleared on the next turn, on retry, or on dismiss. Not persisted. */
  error?: EngineErrorBanner
  /** Copy for a file the composer could not attach (an unsupported format dropped, pasted or picked),
   *  shown in the same fused row as `error`. A refused drop is transient, so it lives here and not as a
   *  transcript item — a mis-drag shouldn't sit in the conversation forever. Cleared on dismiss, on the
   *  next drop, and on the next turn. Not persisted. */
  attachNotice?: string
}

/** The raw material for the composer error banner — the UI derives the friendly copy from it. */
export interface EngineErrorBanner {
  message: string
  fatal: boolean
}

/** A side question's lifecycle in the renderer. `id` correlates the streamed answer from main. */
export interface AsideState {
  id: string
  question: string
  answer: string
  status: 'streaming' | 'done' | 'error'
}

export type SessionStatus = 'idle' | 'thinking' | 'waiting' | 'error'

/**
 * The layout seam (ui-workspace.md §7). v0 ships single-focus; `split`/`tile`/multi-window are
 * reserved-but-unbuilt arms added here later WITHOUT touching SessionState — that's the whole point
 * of keeping a flat session map + a layout union instead of a recursive pane tree. (The sidebar's
 * Sessions list IS the multi-session view; the old overview grid just duplicated it and was cut.)
 */
export type WorkspaceLayout =
  | { mode: 'focus' }
// DEFERRED, not built: | { mode: 'split'; ids: [string, string] } | { mode: 'tile'; ids: string[] }

/**
 * An open file in the artifact zone (ui-workspace.md §4 surface contract — the `file` surface type).
 * Surfaces are WORKSPACE-level, not per-session: a project's open files belong to the project (one
 * project per window, Slice B), and the Files browser opens them even with no active session. Keyed
 * by absolute path, so opening the same file twice just re-focuses its tab. Transient — not persisted
 * in v0 (the engine's files on disk are the source of truth; reopening is cheap).
 */
export type FileDiffSource =
  | { kind: 'working-tree' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'checkpoint'; sessionId: string; checkpointId: string; path: string }

export interface FileSurface {
  /** 'file' (default) = a file pane keyed by its path. Everything else is a SINGLETON surface with no
   *  real file path — the running app ('preview'), the project shell ('terminal'), and the working-tree
   *  review ('changes'). Each takes a reserved sentinel `path` so the whole tab machinery (dedup,
   *  select, close, the cap) works on it unchanged while never colliding with an absolute path. One
   *  method for everything that can take the stage: no shelf, no drawer, no sheet of its own. */
  kind?: 'file' | 'preview' | 'terminal' | 'changes' | 'turn-changes' | 'agents'
  /** Absolute path — also the stable tab identity (dedup on open). For a singleton surface this is its
   *  reserved sentinel id, not a filesystem path. */
  path: string
  /** Display label (basename; 'Preview' / 'Terminal' / 'Changes' for the singletons). */
  title: string
  /** How the pane renders this file. 'doc' = the WYSIWYG document (default for markdown — the
   *  everyday-user surface); 'file' = the editable Monaco editor (raw markdown / all other files);
   *  'diff' = the read-only before→after diff (auto-opened when the engine edits the file). */
  view: 'doc' | 'file' | 'diff'
  /** Bumped on each engine edit so an open diff re-fetches its before/after (live update). */
  rev: number
  /** For a preview surface: the URL the sandboxed iframe loads — `koda-preview://<token>/index.html`
   *  (Rung 1 static) or `http://localhost:<port>` (Rung 2 dev server). */
  previewUrl?: string
  /** For a preview surface: something is actually serving that URL right now. True from the moment main
   *  confirms the dev server responds (or for a static entry, which Koda serves itself), false once main
   *  says it stopped. The tab's mark is green only while this is true — the iframe keeps showing its
   *  last paint after a server dies, so "there is a preview tab" is not evidence of a running app. */
  live?: boolean
  /** A line to reveal when the file opens in the Monaco editor (1-based) — set when a search hit
   *  opens the file. Ignored by the doc/diff views. */
  gotoLine?: number
  /** Optional 1-based column paired with gotoLine. */
  gotoColumn?: number
  /** Bumped each time the file is (re-)opened at a line, so the editor re-reveals even when the tab
   *  was already open (an effect dep — see MonacoFileEditor). */
  gotoNonce?: number
  /** The session whose edit opened this as a diff — selects main's pinned turn-start baseline so the
   *  diff is cumulative-this-turn. Undefined for Files-browser opens (diff falls back to HEAD). */
  sessionId?: string
  /** One explicit owner for what a diff means. Checkpoint paths stay workspace-relative even though
   * the surface itself is keyed by an absolute path. */
  diffSource?: FileDiffSource
  /** Receipt identity makes live + catch-up delivery idempotent. */
  receiptId?: string
  /** Safety base carried by the This-turn list; each opened row adds its own relative path. */
  receiptCheckpointId?: string
  /** Exact completed-turn file evidence for the read-only "This turn" singleton. */
  receiptFiles?: Extract<StageReceipt, { kind: 'turn-changes' }>['files']
  receiptComplete?: boolean
  receiptOverlapObserved?: boolean
}

/**
 * How many surfaces stay co-open as tabs on one session's stage. Tabs are lightweight but not free:
 * past a handful the strip stops being scannable, and every open diff/doc holds a live Monaco or Crepe
 * instance. When a new surface arrives over the cap, the OLDEST-opened tab retires — never the one on
 * stage, never the one just added, and never the preview (it fronts a running dev server).
 */
export const STAGE_TAB_LIMIT = 6

/**
 * One session's editor workbench — the open file/preview surfaces plus which are focused/split. The
 * dock is the ACTIVE session's editor (`editors[activeId]`), so tabs follow the session in the sidebar
 * and clear when it's gone, instead of accumulating every file ever opened across every task. The
 * agent's own edits land in the editor of the session that made them (showEditDiff/Doc carry the
 * sessionId) — a background session's diffs pile up in ITS workbench without disturbing what you're
 * looking at. Files opened with no active session (pre-session Files browsing) live under a sentinel key.
 */
export interface EditorState {
  /** The co-open tabs on this session's stage, in open order (capped at STAGE_TAB_LIMIT). */
  surfaces: FileSurface[]
  /** Which tab is SELECTED (showing on stage); null ⇒ this session's stage is empty. */
  activeSurfaceId: string | null
  /** User pinned the stage: the agent's edits/preview pushes stop SELECTING their tab (the tab still
   *  appears in `surfaces` and its rev still bumps). User actions (open a file, click a tab) always
   *  override. */
  pinned: boolean
  /** The user's explicit show/hide of the stage panel for THIS session. Undefined = follow the stage's
   *  own contents (see `stageVisible`), which is what a fresh chat starts on: nothing open, nothing to
   *  show. Set true/false only by the session-header toggle and ⌘J. */
  stageShown?: boolean
}

const EMPTY_EDITOR: EditorState = { surfaces: [], activeSurfaceId: null, pinned: false }

/** Surfaces that are never retired to make room and are never a second copy: a live dev server, a live
 *  shell with its scrollback, the working-tree review. Only plain file tabs are expendable. */
function isSingleton(s: FileSurface): boolean {
  return (s.kind ?? 'file') !== 'file'
}

/** Append a newly opened surface to a session's tab strip, retiring the oldest expendable tab once the
 *  strip is over STAGE_TAB_LIMIT. Tab ORDER is open order (it never reshuffles under the pointer), so
 *  the leftmost expendable tab is also the oldest one. */
function addSurface(ed: EditorState, surface: FileSurface): FileSurface[] {
  const next = [...ed.surfaces, surface]
  if (next.length <= STAGE_TAB_LIMIT) return next
  const victim = next.findIndex(
    (s) => !isSingleton(s) && s.path !== surface.path && s.path !== ed.activeSurfaceId,
  )
  return victim === -1 ? next : next.filter((_, i) => i !== victim)
}

/** Whether the agent's edit pushes should stop stealing the stage. True when the user explicitly
 *  pinned it, OR — the "soft pin" — when a LIVE surface is what's currently on stage: someone iterating
 *  on a page with the agent, or typing into the shell, shouldn't get yanked back to a diff every time
 *  the agent touches a file. Soft because it needs no toggle and clears itself the moment the user
 *  picks another surface. */
function stageHeld(ed: EditorState): boolean {
  return (
    ed.pinned ||
    ed.activeSurfaceId === PREVIEW_SURFACE_ID ||
    ed.activeSurfaceId === TERMINAL_SURFACE_ID
  )
}

/** Editor key for files opened while no session is active (the pre-session Files browser). Not a valid
 *  session id (those are UUIDs), so it never collides. */
const NO_SESSION_EDITOR = '__no_session__'

/** The session id whose editor the dock currently shows. */
function editorKey(state: { activeId: string | null }): string {
  return state.activeId ?? NO_SESSION_EDITOR
}

/** The active session's editor workbench (or an empty one). The single read path the dock + browsers
 *  use, so switching sessions swaps the whole Editor tab set. Returns stable references (the stored
 *  object or the shared EMPTY_EDITOR), so it's safe as a zustand selector. */
export function activeEditor(state: { activeId: string | null; editors: Record<string, EditorState> }): EditorState {
  return state.editors[editorKey(state)] ?? EMPTY_EDITOR
}

/**
 * Whether the stage panel is showing beside the conversation. DERIVED from the active session's own
 * stage, not a window-level flag: a chat with nothing on stage shows no panel, so a new chat opens as
 * a full-width conversation instead of an empty picker nobody asked for. The user's explicit toggle
 * (`stageShown`) overrides it for that session, and any deliberate open clears the override back to
 * "follow the contents".
 */
export function stageVisible(state: { activeId: string | null; editors: Record<string, EditorState> }): boolean {
  const ed = activeEditor(state)
  return ed.stageShown ?? ed.surfaces.length > 0
}

/** Store patch that replaces one session's editor slice (leaving the rest of the map untouched). */
function withEditor(
  editors: Record<string, EditorState>,
  key: string,
  next: EditorState,
): { editors: Record<string, EditorState> } {
  return { editors: { ...editors, [key]: next } }
}

/** Apply the same transform to every session's editor — for project-wide events (a file rename/delete
 *  affects whichever sessions have that file open). */
function mapEditors(
  editors: Record<string, EditorState>,
  fn: (ed: EditorState) => EditorState,
): Record<string, EditorState> {
  const out: Record<string, EditorState> = {}
  for (const [k, ed] of Object.entries(editors)) out[k] = fn(ed)
  return out
}

/** Put a singleton surface (terminal, changes) on the active session's stage: add its tab if it isn't
 *  there, select it, and release both the pin and any explicit hide — it's a deliberate user or agent
 *  action either way. The same path the preview and file opens take, which is the point: everything on
 *  the stage arrives as a tab, nothing gets its own shelf or drawer. */
function stageSingleton(
  state: { activeId: string | null; editors: Record<string, EditorState> },
  surface: { kind: 'terminal' | 'changes' | 'agents'; path: string; title: string },
  sessionId?: string,
  respectHold = false,
): { editors: Record<string, EditorState> } {
  // Targets the REQUESTING session's editor when one is named (an agent push belongs to the session
  // that made it, not to whichever conversation happens to be in front), else the active one.
  const key = sessionId ?? editorKey(state)
  const ed = state.editors[key] ?? EMPTY_EDITOR
  const surfaces = ed.surfaces.some((s) => s.path === surface.path)
    ? ed.surfaces
    : addSurface(ed, { ...surface, view: 'file', rev: 0 })
  const isActive = key === editorKey(state)
  // Automatic surfaces obey the Stage's pin/live-surface hold, except when the user had hidden the
  // Stage entirely: a fresh delegation is important enough to bring it back with Agents in front.
  const takeStage = !respectHold || (isActive && ed.stageShown === false) || !stageHeld(ed)
  return withEditor(state.editors, key, {
    ...ed,
    surfaces,
    activeSurfaceId: takeStage ? surface.path : ed.activeSurfaceId,
    pinned: takeStage ? false : ed.pinned,
    // Same rule as openPreview: only release an explicit hide on the session in FRONT. A background
    // session's push stages itself in its own editor without reopening a stage the user closed there.
    ...(isActive ? { stageShown: undefined } : {}),
  })
}

/** Reserved tab identities for the singleton surfaces (the running app, the project shell, the
 *  working-tree review). A NUL prefix can never be a real absolute path, so each slots into the
 *  path-keyed `surfaces` array without colliding. Whether the stage is SHOWING is deliberately not
 *  remembered across launches any more: surfaces are transient, so a remembered "open" could only ever
 *  restore an empty panel (see `stageVisible`). */
export const PREVIEW_SURFACE_ID = '\u0000preview'
export const TERMINAL_SURFACE_ID = '\u0000terminal'
export const CHANGES_SURFACE_ID = '\u0000changes'
export const TURN_CHANGES_SURFACE_ID = '\u0000turn-changes'
const AGENTS_SURFACE_ID = '\u0000agents'

/** The renderer writes the shared persisted schema minus the retired inline archive field. Main keys
 *  it by project root, so the path stays outside the payload. Keeping this as a type projection rather
 *  than a handwritten mirror means a new durable session field cannot silently disappear here. */
export type PersistedBlob = Omit<PersistedSessions, 'archived'>

/** The one SessionState → durable-session seam, reused by hot saves and archive creation. */
function persistedSessionFromState(s: SessionState): PersistedSession & { items: Entry[] } {
  return {
    id: s.id,
    label: s.label,
    overview: s.overview,
    lastActivityAt: s.lastActivityAt,
    cwd: s.cwd,
    userNamed: s.userNamed,
    namedAtTurns: s.namedAtTurns,
    approvalMode: s.approvalMode,
    model: s.model,
    effort: s.effort,
    engineId: s.engineId,
    resumeCursor: s.resumeCursor,
    context: s.context,
    spendUsd: s.spendUsd,
    byModel: s.byModel,
    lastPreview: s.lastPreview,
    replaySeq: s.replaySeq,
    items: compactTranscriptToolOutput(s.items),
  }
}

/** The one durable-session → SessionState seam, reused by boot hydration and archive restore. */
function sessionStateFromPersisted(
  s: PersistedSession,
  defaultApprovalMode: ApprovalMode,
  opts: { freshActivity?: boolean; replaySeq?: number } = {},
): SessionState {
  const items = (s.items as Entry[]).map(settleRestoredTranscriptItem)
  const turnFailure = latestTurnFailureOf(items)
  const firstPrompt = items.find(
    (item): item is Extract<Entry, { kind: 'user' }> =>
      item.kind === 'user' && isSessionNamingPrompt(item.text),
  )
  // Older builds persisted the phone's waiting label as though it were a finished title. Repair every
  // readable hot/restored transcript at the hydration boundary, including an inactive session that
  // will never pass through live headless adoption. The selected writer can still refine a live one
  // when main hands it back below; this instant floor simply removes the stale literal now.
  const label =
    !s.userNamed && isProvisionalSessionTitle(s.label) && firstPrompt
      ? titleFromPrompt(firstPrompt.text)
      : s.label
  return {
    id: s.id,
    label,
    overview: s.overview,
    lastActivityAt: opts.freshActivity ? Date.now() : (s.lastActivityAt ?? Date.now()),
    userNamed: s.userNamed ?? false,
    namedAtTurns: s.namedAtTurns,
    cwd: s.cwd,
    items,
    replaySeq: opts.replaySeq ?? s.replaySeq,
    context: s.context,
    streaming: '',
    busy: false,
    errored: !!turnFailure?.error.fatal || turnFailure?.error.category === 'turnRejected',
    draft: '',
    attachments: [],
    live: false,
    attention: false,
    ...(turnFailure
      ? { error: { message: turnFailure.error.message, fatal: turnFailure.error.fatal } }
      : {}),
    approvalMode: s.approvalMode ?? defaultApprovalMode,
    model: s.model,
    effort: s.effort,
    engineId: s.engineId ?? 'claude',
    resumeCursor: s.resumeCursor,
    spendUsd: s.spendUsd ?? 0,
    byModel: s.byModel ?? {},
    lastPreview: s.lastPreview,
  }
}

// Monotonic counters + synchronous guards live module-level (as the old App.tsx refs did) — they
// must not trigger re-renders and must not be persisted. zustand `set` is synchronous, so a guard
// read here is as race-free as the ref it replaces.
let entryId = 0 // unique Entry ids across all sessions
// A reattach (--resume) re-emits SessionStarted; suppress its banner so a restored transcript
// doesn't grow a spurious "session started" notice mid-history.
const suppressStartNotice = new Set<string>()
// Sessions the user just stopped — the interrupted turn lands a `result: error_during_execution`, which
// must NOT surface as an error footer (the user chose to stop). One-shot: cleared at that TurnComplete.
const userInterrupted = new Set<string>()
// Sessions that just raised the composer error banner (API failure). The banner IS the report, so the
// abnormal `result` that immediately follows must not ALSO push a transcript footer. Cleared at that
// TurnComplete.
const bannerErrored = new Set<string>()
// Sessions whose engine reattach is in flight — guards a double `claude --resume <sameId>` when two
// sends fire in one tick before `busy` flushes.
const reattaching = new Set<string>()
// Composer sends have asynchronous document/scratch preflight before the engine turn can be claimed.
// Guard that gap synchronously so a double click cannot launch the same snapshot twice.
const sending = new Set<string>()
// Sessions being ADOPTED from the phone right now — their buffered history is being replayed through
// the normal reducer. While a session's id is here, per-event side-effects that only make sense for a
// LIVE turn (native "finished" notifications, the working-tree git refresh) are suppressed, so
// replaying old TurnCompletes doesn't ping the user or thrash git for history they're just catching up on.
const replayingSessions = new Set<string>()
// Sessions that just dispatched a "write a handoff" turn for the Keep-going-in-a-fresh-chat flow. When
// that turn completes, the summary it produced is carried into a brand-new session (see finishHandoff).
// Module-level like the sets above so it survives re-renders without living on SessionState.
const handoffPending = new Set<string>()
// The turn Koda sends the current agent to produce a handoff before opening a fresh chat. Engine-agnostic
// (Claude or Codex) — it only asks for text back; the continuity happens by seeding the new session with it.
const HANDOFF_PROMPT =
  'This conversation is getting long and we are about to continue in a fresh chat that starts with an empty ' +
  'context. Write a concise handoff — under ~200 words, plain prose — so a new session can pick up exactly ' +
  'where we are: what we are working on, the decisions already made, the current state, and the immediate ' +
  'next step. Write it addressed to that next session. Output only the handoff, no preamble.'
// Set by the bridge on mount once Notification permission is granted.
let notifyOk = false
export function setNotifyOk(v: boolean): void {
  notifyOk = v
}
// The user's notification preference (Settings → General; default on). Gates the native notification
// only — the in-app tab ring + dock badge always fire. Seeded by the bridge from main's settings.
let notifyEnabled = true
export function setNotifyEnabled(v: boolean): void {
  notifyEnabled = v
}
// TaskCreate tool_use id → its subject, held until the tool_result carries the engine's "Task #N"
// id (the key TaskUpdate later references). Module-level like the other synchronous guards.
const taskCreatePending = new Map<string, string>()

// File-edit tools whose successful result auto-opens a live diff (mirrors broker/policy.ts EDIT_TOOLS).
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// 'auto' billing: rejected-window resetsAt values we've already prompted (or acted) on, so a repeated
// 'rejected' event for the same window doesn't re-raise the banner. Module-level like the other guards.
const fallbackPromptedFor = new Set<number>()
// Sessions whose credential respawn was deferred because their parent turn, approval, or delegated
// child still owned the current engine process. Cleared at the first genuinely safe lifecycle edge.
const billingRespawnPending = new Set<string>()

/** A short clock time from unix seconds — for the "resets at 4:31 PM" fallback notice. */
function fmtClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Restore the full relative path behind `@`-mentions before the text reaches the engine, and hand back
 *  the doc list that resolution ran against. The composer inserts the pretty name
 *  (`@ship-checklist-iphone`) for readability; the agent needs an exact location to Read. We resolve
 *  each bare-name token (no slash) against the project's live doc list. Path-shaped tokens the user
 *  typed by hand, and names that match no doc, are left untouched.
 *
 *  Runs at most one listDocs round-trip, which main caches, and only when the draft holds an
 *  `@`-token at all. */
async function resolveDocMentions(text: string): Promise<string> {
  if (!hasDocMention(text)) return text
  const res = await window.koda.listDocs({}).catch(() => null)
  const docs = res?.docs ?? []
  if (!docs.length) return text
  // Docs arrive most-recent-first, so the shared resolver keeps the freshest name collision.
  return expandDocMentionLabels(text, docs)
}

/** Plain-language footer for an ABNORMAL turn end (the engine `result.subtype`). A clean 'success'
 *  (or absent) subtype returns null → no footer at all. Only the truncating/error cases surface, so a
 *  cut-off answer isn't left unexplained. No dollar figure — running spend lives in the Usage view. */
function abnormalStopNotice(stopReason?: string): string | null {
  if (!stopReason || stopReason === 'success') return null
  if (stopReason === 'error_max_turns') return 'turn ended early — hit the step limit'
  if (stopReason === 'error_during_execution') return 'turn ended with an error'
  return `turn ended early — ${stopReason}`
}

/** Add a turn's per-model usage into the session's running totals (immutable). Returns the prior map
 *  unchanged when the turn carried no model usage (e.g. an error result). */
function foldModelSpend(
  prev: Record<string, ModelSpend>,
  models?: import('@shared/ipc').ModelTurnUsage[],
): Record<string, ModelSpend> {
  if (!models || models.length === 0) return prev
  const next = { ...prev }
  for (const m of models) {
    const acc = next[m.model]
    next[m.model] = {
      costUsd: (acc?.costUsd ?? 0) + m.costUsd,
      inputTokens: (acc?.inputTokens ?? 0) + m.inputTokens,
      outputTokens: (acc?.outputTokens ?? 0) + m.outputTokens,
      cacheReadTokens: (acc?.cacheReadTokens ?? 0) + m.cacheReadTokens,
      cacheCreationTokens: (acc?.cacheCreationTokens ?? 0) + m.cacheCreationTokens,
    }
  }
  return next
}

/** What boot's two store reads found, in the terms the data-integrity banner speaks: which store could
 *  not be read, whether a copy of it was actually kept, and how many rows a readable-but-drifted store
 *  had to set aside. Fields documented on WorkspaceStore below. */
export interface StoreIntegrity {
  sessionsLoadFailed: boolean
  archiveLoadFailed: boolean
  sessionsBackupKept: BackupKept
  archiveBackupKept: BackupKept
  droppedSessions: number
  droppedArchives: number
  unreadableArchiveBodies: number
}

interface WorkspaceStore {
  sessions: Record<string, SessionState>
  order: string[] // stable display order (replaces the old array order)
  activeId: string | null
  /** Archived (closed-but-kept) session metadata, newest first — the light half (no transcript body,
   *  which is fetched on restore). Persisted to the cold archive index; surfaced in Settings → Archived
   *  sessions for restore. */
  archived: ArchivedSessionMeta[]
  /** Archive metadata whose body was unreadable while a live fallback still existed. Hidden from the
   *  Archived UI so it cannot tombstone that readable chat, but merged into every index rewrite until
   *  a successful archive of the same id replaces it. */
  protectedArchived: ArchivedSessionMeta[]
  /** Documents the user starred in this project, independent of whichever chat is open. Persisted in
   *  the project's hot store as relative paths only; Library metadata is always re-read from disk. */
  starredDocs: string[]
  /** One-way migration ledger for the retired session-scoped `keptDocs` field. A path remains here
   *  after it is unstarred so an old archive loaded later cannot silently add it back. */
  legacyKeptDocsImported: string[]
  /** Koda-observed path changes to replay over legacy star sources that were not readable at the time. */
  legacyKeptDocPathChanges: LegacyKeptDocPathChange[]
  /** Whether every readable archived legacy shelf has reached the same acknowledged hot-store blob. */
  legacyKeptDocsMigrationComplete: boolean
  pending: ApprovalRequest[]
  /** Account-level subscription rate-limit windows, keyed by ENGINE then window type
   *  (`claude`/`codex` → `five_hour`/`weekly`). Each engine is a separate subscription with its own
   *  caps, so they never share a map. Not per-session — within one engine the windows are an account
   *  fact. Main owns reconciliation and persistence; this is its live display mirror. */
  rateLimits: Record<string, Record<string, RateLimitInfo>>
  /** Engines mid provider-incident (feed-confirmed, main-watched), keyed by engine → the engine chip's
   *  health state (note + severity kind). Pushed over `providerStatus` + seeded on boot; not persisted
   *  (main re-seeds on reopen). */
  providerDown: Record<string, { note?: string; kind?: ProviderKind }>
  applyProviderStatus: (e: ProviderStatusEvent) => void
  /** Engines with no working sign-in right now, keyed by engine id → true. Read from the same signals
   *  Settings uses (Claude billing verdict + stored key; Codex auth status + stored key). Drives the
   *  status-bar dot's "sign in" state. Only the ACTIVE session's engine is ever surfaced from this, so a
   *  Codex-only user is never nagged to sign into Claude. Refreshed on mount + window focus, not polled. */
  engineSignedOut: Record<string, boolean>
  refreshEngineAuth: () => Promise<void>
  /** Billing mode, mirrored from main's settings (seeded on boot + onSettingsChanged). Drives the
   *  status-bar chip + the 'auto' fallback trigger in the RateLimitUpdate handler. */
  billingMode: BillingMode
  /** Whether the API key is what the next turn bills against right now (always true in 'api'; in 'auto'
   *  only while a confirmed fallback window is live). Mirrored from billing:getState. */
  apiActive: boolean
  /** 'auto' mode only: set when a plan-limit rejection lands and we haven't yet asked → renders the
   *  "continue on your API key?" banner. Carries the rejected window's resetsAt (the fallback expiry). */
  billingFallbackPrompt: { resetsAt: number } | null
  /** How heavy this project's memory navigation pair is (memory:weight). Null until the first
   *  fetch. Drives the status-bar tidy pill + Settings → Memory. */
  memoryWeight: MemoryWeight | null
  /** The posture new sessions start at (seeded on boot from main's persisted default). */
  defaultApprovalMode: ApprovalMode
  /** This window's project (one-project-per-window): null while resolving on boot, '' for a
   *  ProjectHome window (no folder picked → show the picker), else the absolute project path
   *  (display-only — main owns the real root for fs access). */
  projectPath: string | null
  /** Show the one-time intake empty-state: a project with no guidelines yet (New project, or an existing
   *  folder opened with no CLAUDE.md/AGENTS.md). The user describes the project → the agent authors its
   *  guidelines. In-memory + one-shot: cleared on skip (remembered per-project) / once intake starts. */
  intakePending: boolean
  /** Registered mini apps (ALL projects) + supervisor state, refreshed on workspace mount. [] when the
   *  mini-apps flag is off — the list IS the renderer's feature gate (no rail, no App/Workshop toggle).
   *  See mini-apps-plan.md "Desktop FACE model". */
  miniApps: MiniAppInfo[]
  /** The app fronting this window (its absolute dir); null = plain workspace, no face. */
  faceDir: string | null
  /** Figure-ground: 'app' = the face full-bleed over the chassis; 'workshop' = the normal workspace
   *  (the face keeps running behind it — same process the Preview surface shows). */
  faceView: 'app' | 'workshop'
  /** Set by ProjectHome's app rail right before swapping this window to the app's project: which face
   *  to land on. Consumed + cleared by the Chassis on mount (same one-shot pattern as intakePending). */
  pendingFaceDir: string | null
  layout: WorkspaceLayout
  /** Open file/preview surfaces, keyed by session — the dock shows the active session's editor. See
   *  EditorState; read via the `activeEditor(state)` selector, never indexed directly at call sites. */
  editors: Record<string, EditorState>
  /** Recently-opened files (absolute paths, most-recent first, capped). Powers the Find overlay's
   *  empty-query quick-open. In-memory only (resets on restart) — cheap, like `openDirs`. */
  recentFiles: string[]
  /** Expanded directories in the Files tree, by path. Lives here (not in DirNode local state) so the
   *  tree keeps its shape when the sidebar remounts. */
  openDirs: string[]
  /** Bumped when the Files tree's contents change (new doc/folder, rename, move, delete) so open
   *  directory rows re-read and reflect it. */
  filesRev: number
  /** A transient, human-readable error from a file-management action (rename clash, etc.), shown as a
   *  dismissable line in the Files browser; cleared on the next successful action or on dismiss. */
  treeError: string | null
  /** The Settings pane is summoned over the main area (rail gear / ⌘,). Independent of `layout` so
   *  closing it returns to whatever focus/overview the user was in. */
  settingsOpen: boolean
  /** The full "Versions" view (commit graph + branch review) summoned over the main area — the deep
   *  history surface, reached from the sidebar corner / the Changes dock tab (the rail is gone).
   *  Everyday per-session save+review lives in the Changes dock tab, not here. */
  versionsOpen: boolean
  setVersionsOpen: (open: boolean) => void
  /** When Settings is opened from a deep link (e.g. the title-bar Remote menu's "Open settings"), the
   *  category to land on. Consumed + cleared by the Settings pane on open; null otherwise. */
  settingsSection: string | null
  /** Left sidebar width in px (drag the divider against the main area). In-memory only (resets on
   *  restart), like `openDirs` — lives here so it survives a sidebar remount (settings/SCM toggle). */
  sidebarWidth: number
  /** Sessions section's share of the sidebar height (0–1); Files takes the rest. Drag the divider
   *  between them. In-memory only. */
  sessionsFrac: number
  /** Conversation column width in px when an artifact (file/preview) is open beside it. Drag the
   *  divider between the conversation and the artifact zone. In-memory only. */
  conversationWidth: number
  /** Legacy 2-up-split fraction — the split died with the Stage, but the persisted-layout schema still
   *  round-trips it, so it stays as inert state. */
  artifactSplitFrac: number
  /** A command the agent staged for the terminal (open_terminal): the TerminalSurfaceView types it at
   *  the prompt once the shell is ready, then clears it. Never auto-run. In-memory. */
  pendingTermCommand: string | null
  /** Put the terminal on stage (agent's open_terminal, or the picker), optionally staging a command at
   *  the prompt. One tab like everything else — the old shelf under the stage is gone. `sessionId` is
   *  the session that ASKED (an agent push carries one); its tab lands in that session's editor rather
   *  than in whichever conversation the user is reading. A user pick carries none ⇒ the active session. */
  openTerminal: (command?: string, sessionId?: string) => void
  /** Clear the staged command once the terminal view has consumed it. */
  clearPendingTermCommand: () => void
  /** Pin/unpin the ACTIVE session's stage (see EditorState.pinned). */
  setStagePinned: (pinned: boolean) => void
  /** Stage focus mode: hide the conversation so whatever tab is on stage uses the full main area.
   *  Any surface can expand, not just the preview. In-memory only; a transient viewing mode. */
  stageExpanded: boolean
  /** Whether the open project is a git repo (drives the Changes surface + dirty indicators). Refreshed
   *  by refreshGitStatus (after each turn / on focus). In-memory. */
  gitRepo: boolean
  /** The user-git working-tree changes, aggregate across the whole project (one tree, all sessions).
   *  Attributed per session by main-owned completion evidence, with transcript edits only as an
   *  in-flight/back-compat fallback. In-memory; refreshed, not persisted. */
  gitFiles: GitStatusFile[]
  /** Turn-scoped completion evidence from main. It deliberately is not persisted across app restarts:
   *  user Git survives; stale task attribution should not. */
  completionBySession: Record<string, TaskCompletionState>
  applyCompletionState: (state: TaskCompletionState) => void
  /** True when the changed count exceeded the status cap and gitFiles is clipped. */
  gitChangesTruncated: boolean
  /** True when side-line work is waiting: a clean unmerged branch, or ANOTHER worktree with loose
   *  work, unreadable status, or a missing folder. Drives the always-visible Versions cue. */
  gitSideLinesWaiting: boolean
  /** Re-read git repo state + working-tree status into gitRepo/gitFiles. Fire-and-forget; fails soft. */
  refreshGitStatus: () => Promise<void>
  /** Session whose change group the Changes surface should scroll to on open (set by openChanges,
   *  cleared by the surface once consumed). In-memory. */
  changesFocus: string | null
  /** Put Changes on stage, optionally scrolling to a session's change group. */
  openChanges: (focusSessionId?: string) => void
  /** Put the Agents roster on stage — the surface a fan-out's fleet row opens. Session-scoped like
   *  every other tab: it shows the delegates of the session whose editor it lands in. */
  openAgents: (sessionId?: string) => void
  /** The Find overlay (Spotlight-style centered search) — summoned over everything (⌘P / ⌘⇧F),
   *  dismissed on Esc / click-out / opening a result. Independent of sidebarView + settings. */
  searchOpen: boolean
  /** The one image lightbox — a full-screen preview opened by ANY image (composer staged thumbs, sent
   *  images in the transcript, the Recent images strip). Null = closed. Esc / click-out closes. */
  lightbox: ImageDraft | null
  setLightbox: (img: ImageDraft | null) => void
  /** Bumped each time a scratch image is persisted, so the Recent images strip refetches the folder. */
  scratchTick: number
  /** Recent images strip: collapsed = a one-row horizontal peek; expanded = a taller vertical grid that
   *  grows into (scrunches) the Files section. In-memory (resets on restart). */
  recentImagesExpanded: boolean
  toggleRecentImagesExpanded: () => void
  hydrated: boolean
  /** The hot sessions store exists but couldn't be read this run (schema drift, a torn write, an older
   *  Koda build reading a newer file). Main already refused to report it as empty — this only drives the
   *  visible warning; `hydrated` stays false so no chat in this window is saved over it. See
   *  useEngineBridge's boot load. */
  sessionsLoadFailed: boolean
  /** Same shape as `sessionsLoadFailed`, but for the cold archive index — sessions can still hydrate
   *  and save normally; only archiving (a two-writer op on this same index) is blocked while it's set,
   *  so a broken index can't be silently rewritten with the session mid-archive missing from both the
   *  hot list and the index (archiveSession's guard). */
  archiveLoadFailed: boolean
  /** Did main verifiably keep a `.corrupt-*.bak` copy of the file it couldn't read? The banner promises
   *  that copy, and the promise is false whenever the copy itself failed (an EACCES store whose re-read
   *  fails the same way, a `copyFileSync` that hit ENOSPC), so the banner branches on the real answer.
   *  `null` = nobody got to say, and the banner then claims nothing either way. */
  sessionsBackupKept: BackupKept
  archiveBackupKept: BackupKept
  /** Rows a load that otherwise SUCCEEDED had to set aside (one drifted chat costs only itself). Saving
   *  stays on in that case, so the shortened list IS written back — the count is the user's only notice
   *  that a chat left the list, which is why it's state and not just a log line. */
  droppedSessions: number
  droppedArchives: number
  /** Cold metadata overlapped a hot chat but its transcript body could not be read, so the live copy
   * was deliberately kept instead of being removed by the archive tombstone. */
  unreadableArchiveBodies: number
  /** One patch for all of the above: boot resolves them together, from one pair of loads. */
  setStoreIntegrity: (patch: Partial<StoreIntegrity>) => void
  /** The archive index could be READ this run, but a write to it came back refused — so the move the
   *  user just asked for (archive / reopen / delete) was declined rather than half-done. Not part of
   *  StoreIntegrity: that's what boot's two reads found, this only becomes knowable when someone acts.
   *  Cleared by the next write that does land, so a one-off failure stops nagging on its own. */
  archiveWriteFailed: boolean
  /** A reopen read the archived chat's transcript file and couldn't. Its own flag rather than a branch
   *  of `archiveWriteFailed`: the index is fine here, one chat's body isn't, and the user is left
   *  looking at a Settings panel that closed with nothing reopened. Cleared by the next reopen that
   *  works. */
  archiveRestoreFailed: boolean

  // engine + approvals
  applyEngineEvent: (e: EngineEvent) => void
  /** Apply a streamed side-question answer (delta/done/error) to the matching session's aside. */
  applyAsideEvent: (e: AsideEvent) => void
  addPending: (req: ApprovalRequest) => void
  cancelPending: (sessionId: string) => void
  resolvePending: (requestId: string) => void
  /** Resolve a pending approval. `postPlanMode` only applies to an ExitPlanMode allow — it's the tier
   *  the session builds in after the plan (Cursor-style "build / review each"); defaults to acceptEdits. */
  answerApproval: (requestId: string, kind: 'allow' | 'deny', postPlanMode?: ApprovalMode) => void
  /** Answer an AskUserQuestion: resolve its pending approval with the picks as the tool's `answers`
   *  input (allow-with-edit → updatedInput). `updatedInput` is the original tool input + the answers map. */
  answerQuestion: (requestId: string, updatedInput: unknown) => void
  /** Dismiss an AskUserQuestion to reply in your own words instead of picking: deny the tool with a
   *  reason that tells the engine to stop and wait for the next message (not fabricate a pick). */
  dismissQuestion: (requestId: string) => void
  /** Stop the active turn mid-stream — a graceful interrupt that keeps the session alive so the user can
   *  type a correction and continue (vs the old session-killing stop). Clears `busy` optimistically. */
  interrupt: (sessionId: string) => void
  /** Stop one background child without interrupting its parent conversation or sibling children. */
  stopSubagent: (sessionId: string, taskId: string) => void
  /** Retry the failed turn behind the error banner: re-send the session's last user prompt as a fresh
   *  turn (what the user would do by hand). Clears the banner. No-op if there's no last prompt. */
  retryLastTurn: (sessionId: string) => void

  // lifecycle (IPC-driven)
  startSession: (posture?: { engineId: EngineId; model?: string; effort?: string }) => Promise<void>
  /** Pull this window's project's live headless (phone-started) sessions into the window: create a tab
   *  for each and replay its buffered history so the conversation shows up. Idempotent — skips sessions
   *  already open. Called after boot-hydrate and whenever a phone starts a session in this project. */
  adoptHeadless: () => Promise<void>
  /** Reconcile a human turn with durable replay: phone turns append their missing bubble; local turns
   *  stamp the optimistic row with the replay identity main assigned. */
  applyRemoteUserTurn: (
    sessionId: string,
    text: string,
    replaySeq?: number,
    append?: boolean,
    hadImages?: boolean,
    images?: ImageDraft[],
    clientTurnId?: string,
    hadAttachments?: boolean,
    attachments?: { mediaType: string; name?: string }[],
  ) => void
  /** Refetch the Recent images strip — a scratch image was saved outside the composer (a phone turn). */
  bumpScratch: () => void
  /** Re-read every file-backed surface (Files tree, Library, starred documents) — the project changed on
   *  disk without going through one of this store's own mutations, which is the agent's normal path. */
  bumpFilesRev: () => void
  /** End a session's live agent and move it to the archive (keeps the whole conversation; restorable
   *  from Settings). Replaces the old hard close — nothing is deleted. */
  archiveSession: (id: string) => Promise<void>
  /** Reopen an archived session as a live tab (reattaches via --resume on its next turn). Async: the
   *  transcript body is fetched from its cold file on demand. */
  restoreArchived: (id: string) => Promise<void>
  /** Permanently drop an archived session (the one genuinely destructive session action). Async: the
   *  index write is acknowledged before the transcript file is deleted. */
  deleteArchived: (id: string) => Promise<void>
  send: () => Promise<void>
  /** Canvas edit: the user selected a passage in the doc surface and asked the active session's agent
   *  to change it. Composes a targeted-edit turn (the selection is the anchor) and dispatches it to the
   *  active session — the agent's normal Edit tool closes the loop (gate → checkpoint → live re-render). */
  sendCanvasEdit: (args: { path: string; selection: string; instruction: string }) => Promise<void>
  /** Agent-assisted authoring for the Guardrails surface: the user describes a new project rule/skill/
   *  subagent; this composes a turn telling the agent to create it (its gated Write closes the loop).
   *  Returns whether a turn was dispatched (false ⇒ no active session / busy — the caller hints why). */
  sendGuardrailAuthoring: (args: { kind: 'rule' | 'skill' | 'subagent'; description: string }) => Promise<boolean>
  /** "Ask Claude to handle it" from a branch Review: composes a turn telling the agent to review an
   *  unmerged branch and either bring it in or clean it up. Returns false if no active session / busy. */
  sendBranchAction: (args: { branch: string; headBranch: string | null }) => Promise<boolean>
  /** Backup handoffs from the Versions panel: 'publish' = set this project up on GitHub end-to-end
   *  (auth, repo, first push — a conversation, so the agent owns it); 'fixPush' = a push failed and
   *  the agent should diagnose from the error. Returns false if no active session / busy. */
  sendBackupAction: (args: { kind: 'publish' } | { kind: 'fixPush'; error: string }) => Promise<boolean>
  /** "Finish this branch" from the Versions side-branch banner: the user is ON a side branch; the
   *  agent reviews it vs the trunk, merges it in, and switches back. Merging is conversational
   *  (conflicts, unfinished work) — never a button-driven git op. Returns false if no session / busy. */
  sendFinishBranch: (args: { branch: string; into: string }) => Promise<boolean>
  /** "Tidy up" from the Versions timeline's side-line bundle: hand the whole pile over at once — the
   *  agent reviews each one, keeps what holds real work, and clears the rest, asking before it
   *  deletes anything. Returns false if no active session / busy. */
  sendTidySideLines: (args: { names: string[] }) => Promise<boolean>
  /** Re-read this project's memory weight from main (status-bar poll + Settings → Memory on open). */
  refreshMemoryWeight: () => Promise<void>
  /** "Tidy memory" from Settings → Memory: composes a turn telling the agent to distill the
   *  navigation pair per the memory skill's tidy recipe. Returns false if no session / busy. */
  sendMemoryTidy: () => Promise<boolean>
  /** "Keep going in a fresh chat" — shown when the active session's context is nearly full. Asks the
   *  current agent for a handoff summary, then (on that turn's completion) opens a new session with the
   *  summary staged in its composer so the user reviews and continues. Engine-agnostic. No-op if busy. */
  continueInFreshChat: () => void
  selectSession: (id: string) => void
  /** Ask a side question ("btw" / aside) on a session — answered from its context without entering the
   *  conversation. Clears the draft and opens the ephemeral answer overlay. */
  askAside: (sessionId: string, question: string) => void
  /** Close the aside overlay; cancels the throwaway fork if its answer is still streaming. */
  dismissAside: (sessionId: string) => void
  /** Promote a side question into a real message: drop it into the composer (and send now if the
   *  session is free), so an aside that turned out to matter becomes part of the conversation. */
  promoteAside: (sessionId: string) => void
  setDraft: (id: string, text: string) => void
  addAttachments: (id: string, imgs: ImageDraft[]) => void
  removeAttachment: (id: string, index: number) => void
  /** Say why a dropped/pasted/picked file could not be attached (null clears the row). */
  setAttachNotice: (id: string, message: string | null) => void
  /** Seed the default posture (boot, from main's persisted setting). */
  setDefaultApprovalMode: (mode: ApprovalMode) => void
  /** Mirror billing mode + whether the API key is currently effective (boot + onSettingsChanged). */
  setBilling: (mode: BillingMode, apiActive: boolean) => void
  /** 'auto' fallback: user confirmed continuing on the API key. Tells main to mark the key effective
   *  until the window resets, then drops live sessions so they reattach on API (switch-forward). */
  confirmApiFallback: () => Promise<void>
  /** 'auto' fallback: user chose to wait for the reset — dismiss the prompt (won't re-ask this window). */
  dismissApiFallback: () => void
  /** Change ONE session's posture. ask/acceptEdits/auto switch the gate live; switching into or out
   *  of `plan` drops the live engine so the next turn reattaches in the new --permission-mode. */
  setSessionApprovalMode: (id: string, mode: ApprovalMode) => void
  /** Change ONE session's model (`undefined` ⇒ engine default). The engine can't switch model live on
   *  a -p process, so this drops the engine and the next turn reattaches with --model (mirrors the
   *  plan-cross path). Blocked mid-turn / with a pending approval (a respawn would kill the turn). */
  setSessionModel: (id: string, model: string | undefined) => void
  /** Switch ONE session's engine (claude ↔ codex), optionally also setting the model for the new
   *  engine. Allowed only BEFORE the first turn (the conversation binds to its engine); a no-op once
   *  the session has any transcript. Respawns like a model change (drops live → next turn starts the
   *  new engine fresh). Remembers the choice as the new-session default. Blocked mid-turn. */
  setSessionEngine: (id: string, engineId: EngineId, model?: string) => void
  /** Change ONE session's reasoning effort (`undefined` ⇒ engine default). Spawn-time like the model,
   *  so it drops the engine and the next turn reattaches with --effort. Blocked mid-turn / pending. */
  setSessionEffort: (id: string, effort: string | undefined) => void
  /** User-driven rename (click-to-edit). Locks the label against the auto-title upgrade. */
  renameSession: (id: string, name: string) => void

  // project
  setProjectPath: (path: string) => void
  /** Flag this window's project to show the intake empty-state. Set by ProjectHome right after
   *  createProject (immediate, no flash); the open-time `maybeOfferIntake` covers existing folders. */
  setIntakePending: (pending: boolean) => void
  // Mini apps (the face)
  setPendingFaceDir: (dir: string | null) => void
  /** Re-read the registered-apps list from main (workspace mount / rail refresh). Fails soft. */
  refreshMiniApps: () => Promise<void>
  /** Front an app's face (figure-ground flip to 'app'). */
  openFace: (dir: string) => void
  /** Flip between the face and the workshop without dropping which app is fronted. */
  setFaceView: (view: 'app' | 'workshop') => void
  /** The face's summon: a quick data/build turn to this project's agent without leaving the app.
   *  Grounds the turn in which app the user is looking at; starts a session if none is live. Returns
   *  false if nothing was dispatched (blank text / busy session / no fronted app). */
  /** Dispatch an ask-or-fix turn into the app's summon thread. Resolves to the session id the turn
   *  landed in (so the face can pin its busy/reply/question watchers to THAT session, never whatever
   *  is active), or null when the thread is mid-turn / the app is gone. */
  sendFaceTurn: (args: { text: string }) => Promise<string | null>
  /** Offer intake when a project is opened with no guidelines yet — the common case (existing folders,
   *  not just New project). Skips if it has sessions, was skipped before (per-project), or already has a
   *  CLAUDE.md/AGENTS.md (never re-author existing guidelines). Called once on project mount. */
  maybeOfferIntake: (args: { hasSessions: boolean }) => Promise<void>
  /** Dismiss intake and remember it for this project (so reopening the folder doesn't re-nag). */
  skipIntake: () => void
  /** DEV retest affordance: clear this project's skip dismissal and re-run the offer check. Returns
   *  'offered' if the intake screen now shows, 'not-applicable' if the project doesn't qualify (has
   *  sessions or guidelines), or 'no-project' if no folder is open. */
  resetIntake: () => Promise<'offered' | 'not-applicable' | 'no-project'>
  /** Run project intake: start the project's first session and dispatch a visible turn asking the
   *  agent to author the project guidelines from the user's description. Returns false if the session
   *  couldn't be created (leaves `intakePending` set so the screen stays + the caller can retry). */
  startProjectIntake: (args: { description: string; notes: string }) => Promise<boolean>

  // layout
  setLayout: (layout: WorkspaceLayout) => void
  /** Open/close the Settings pane. */
  setSettingsOpen: (open: boolean) => void
  /** Open Settings on a specific category (deep link). Sets the section then opens the pane. */
  openSettingsTo: (section: string) => void
  /** Clear the pending deep-link section (Settings calls this once it has consumed it). */
  clearSettingsSection: () => void
  /** Switch the left sidebar between the explorer and Source Control. */
  /** Resize the sidebar (px) / the Sessions vs Files split (fraction); both clamped to sane bounds. */
  setSidebarWidth: (px: number) => void
  setSessionsFrac: (frac: number) => void
  /** Resize the conversation column (px); clamped. */
  setConversationWidth: (px: number) => void
  /** Seed pane sizes from persisted global settings (boot). */
  hydrateLayout: (layout: WorkspaceLayoutSizes) => void
  /** Write the current pane sizes back to global settings (call on drag-end, not per move). */
  persistLayout: () => void
  /** Restore every pane size to its default and persist (the Settings "Reset to default layout"). */
  resetLayout: () => void
  /** Open/close the Find overlay (⌘P / ⌘⇧F to open; Esc / click-out / opening a result to close). */
  setSearchOpen: (open: boolean) => void
  /** Expand the stage to the full window width (and back). Works for whichever tab is on stage. */
  setStageExpanded: (expanded: boolean) => void

  // surfaces (artifact zone)
  /** Open a file in the artifact zone (focuses its tab if already open). `gotoLine` (from a search
   *  hit) reveals that line in the Monaco editor view. `view` forces a starting view (e.g. open a
   *  `.md` skill/subagent as raw Markdown, not the WYSIWYG doc — those files are technical). */
  openFile: (path: string, gotoLine?: number, opts?: { view?: FileSurface['view']; gotoColumn?: number; diffSource?: FileDiffSource }) => void
  /** Apply main-owned presentation intent to the receipt's own session workbench. */
  applyStageReceipt: (receipt: StageReceipt, opts?: { catchup?: boolean }) => void
  /** Create a new empty document in Documents/, or in the selected Documents folder. */
  newDocument: (parent?: string) => Promise<void>
  /** Create a new folder — at the project root, or inside `parent` (which is then expanded), or in
   *  the user's Documents/ home when `home` (the doc-first view's New folder). */
  newFolder: (parent?: string, home?: boolean) => Promise<string | null>
  /** Rename a file/folder in place (new basename in the same folder). Rebases any open tab + the
   *  Files tree's expansion to the new path on success. */
  renameEntry: (path: string, newName: string) => Promise<void>
  /** Move a file/folder into another folder (drag-and-drop). Same rebasing as rename. No-op if it's
   *  already there, or if dropping a folder into itself/a descendant. */
  moveEntry: (from: string, toDir: string) => Promise<void>
  /** Delete a file/folder (recursive). Drains its live editor first, then closes tabs on success. */
  deleteEntry: (path: string, options?: { document?: true }) => Promise<DeleteEntryResult>
  /** Duplicate a file/folder as "<name> copy" alongside it. Checkpointed, so undoable. */
  duplicateEntry: (path: string) => Promise<void>
  /** Import Finder-dragged files into `destDir` (an existing folder) or, omitted, Documents/. Reads
   *  the dropped File bytes and hands them to main, which writes deduped, contained + checkpointed. */
  importFiles: (destDir: string | undefined, files: Iterable<File>) => Promise<void>
  /** Clear the transient Files-browser error line. */
  clearTreeError: () => void
  /** Rebase open tabs + tree expansion after a rename/move (carries folder descendants). */
  notePathMoved: (from: string, to: string) => void
  /** Close tabs + drop tree expansion under a deleted path. */
  notePathDeleted: (path: string) => void
  /** Auto-surface a file the engine just edited as a live diff (before→after), focused. Bumps the
   *  surface's `rev` so an already-open diff re-fetches on each successive edit. `sessionId` selects
   *  the pinned turn-start baseline (cumulative-this-turn diff). */
  showEditDiff: (path: string, sessionId: string) => void
  /** Auto-surface a markdown file the engine just created/edited as a live RENDERED document (the
   *  everyday-user "watch it build" view — the agent writes, the user sees the doc, not raw markdown),
   *  focused. Bumps `rev` so the open doc re-reads + replaces its content in place on each edit. */
  showEditDoc: (path: string, sessionId: string) => void
  /** Flip a surface between the live diff and the editable full file. */
  setSurfaceView: (path: string, view: 'doc' | 'file' | 'diff') => void
  setDirOpen: (path: string, open: boolean) => void
  closeSurface: (path: string) => void
  selectSurface: (path: string) => void
  /** Open (or re-point) a preview surface at `url` — a `koda-preview://` static entry or a
   *  `http://localhost:<port>` dev server. Targets `opts.sessionId`'s editor when given (an agent push
   *  belongs to the session that triggered it, not whichever tab is focused); otherwise the active
   *  session (a user click). Agent-pushed (`respectPin`) leaves a pinned stage alone; a user click
   *  always brings it on stage. */
  openPreview: (url: string, opts?: { respectPin?: boolean; sessionId?: string }) => void
  /** Remember how to bring a session's preview back (from the `preview:show` push), so the empty stage
   *  can offer a one-click "Restart preview" after the surface/dev-server is gone. Persisted. */
  rememberPreview: (sessionId: string, restart: PreviewRestart) => void

  // starred documents (project-wide)
  /** Star a document for this project. `rel` is a project-relative POSIX path and the only document
   *  data stored; everything else is re-read from the file. Works even when no chat is open. */
  starDoc: (rel: string) => void
  /** Remove a document from this project's starred list. */
  unstarDoc: (rel: string) => void
  /** One-time move of this project's localStorage doc pins — the retired Documents pane's own idea of
   *  "this one matters" — into the project-wide starred list. The legacy copy stays until
   *  `completeDocPinMigration` sees an acknowledged persisted blob. */
  migrateDocPins: () => void
  /** Remove the retired pane's keys only after main acknowledged a project blob that contains every
   *  adopted pin. The exact acknowledged blob is passed in so in-memory state cannot masquerade as
   *  durable state while the IPC write is still in flight. */
  completeDocPinMigration: (persisted: PersistedBlob) => void
  /** Close the preview surface. */
  closePreview: () => void
  /** Main says this preview URL stopped serving — drop the live mark wherever it's shown. */
  notePreviewStopped: (url: string) => void
  /** Bring the preview on stage (dock open + preview focused), if one exists. Used by the agent's
   *  view_preview capture — an explicit "look at it", so it overrides a pin. */
  bringPreviewToStage: () => void
  /** Show/hide the stage for the ACTIVE session (an explicit override of `stageVisible`'s default). */
  setDockOpen: (open: boolean) => void
  /** Flip the stage shown↔hidden (the session-header toggle, ⌘J). */
  toggleDock: () => void

  // persistence
  /** Boot restore. `archived` is the cold-store metadata (bodies fetched on restore), merged in by
   *  useEngineBridge — kept off PersistedBlob because persistBlob → saveSessions must never carry it. */
  hydrate: (blob: PersistedBlob & {
    archived?: ArchivedSessionMeta[]
    protectedArchived?: ArchivedSessionMeta[]
  }) => void
  persistBlob: () => PersistedBlob
  noteRestored: (label: string) => void
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  // ── internal helpers (mirror App.tsx; mutate one session by id) ──
  function patchSession(id: string, fn: (s: SessionState) => SessionState): void {
    set((state) => {
      const s = state.sessions[id]
      if (!s) return state
      return { sessions: { ...state.sessions, [id]: fn(s) } }
    })
  }

  function pushItem(id: string, item: TurnItem): void {
    const eid = ++entryId
    patchSession(id, (s) => ({ ...s, items: [...s.items, { ...item, id: eid }] }))
  }

  /** A deliberate agent surface is a handoff to the user, so its owning session comes forward. Passive
   *  edit auto-follow remains session-local and never calls this. Returns true only when the push moved
   *  the user to another live session, which lets the arriving surface override that session's stale
   *  pin/hide once. */
  function frontAgentSurface(sessionId: string | undefined): boolean {
    if (!sessionId || sessionId === get().activeId || !get().sessions[sessionId]) return false
    get().selectSession(sessionId)
    return true
  }

  /** A newly launched delegate makes the fleet visible without replaying old history into the Stage. */
  function followDelegation(id: string): void {
    if (replayingSessions.has(id)) return
    const fronted = frontAgentSurface(id)
    set((state) => {
      const editor = state.editors[id] ?? EMPTY_EDITOR
      // The first delegate opens the fleet. Later launches update that existing surface without
      // repeatedly pulling the user back after they deliberately selected another tab.
      if (editor.surfaces.some((surface) => surface.path === AGENTS_SURFACE_ID)) return {}
      return stageSingleton(
        state,
        { kind: 'agents', path: AGENTS_SURFACE_ID, title: 'Agents' },
        id,
        !fronted,
      )
    })
  }

  /**
   * A turn ended: stop the clock and stamp how long it ran onto the message that started it, which is
   * where the transcript's fold reads it from ("Worked for 2m 14s"). Every path that clears `busy` for
   * a real turn goes through here — completion, a user interrupt, a fatal error — so a turn that died
   * badly still gets a truthful duration instead of a stuck timer.
   */
  function endTurn(s: SessionState): SessionState {
    if (!s.turnStartedAt) return s.busy ? { ...s, busy: false } : s
    const elapsedMs = Date.now() - s.turnStartedAt
    let items = s.items
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind !== 'user') continue
      items = [...items.slice(0, i), { ...item, elapsedMs }, ...items.slice(i + 1)]
      break
    }
    return { ...s, busy: false, turnStartedAt: undefined, items }
  }

  function settleDeferredBillingRespawn(id: string): void {
    if (!billingRespawnPending.has(id)) return
    const state = get()
    const session = state.sessions[id]
    if (!session) {
      billingRespawnPending.delete(id)
      return
    }
    if (
      session.busy ||
      hasRunningDelegation(session.items) ||
      state.pending.some((request) => request.sessionId === id)
    )
      return
    billingRespawnPending.delete(id)
    if (session.live) patchSession(id, (current) => ({ ...current, live: false }))
  }

  // ── First-turn session naming ────────────────────────────────────────────────
  // Sibling names (live + archived) an auto-title must not collide with — an exact match gets a date
  // suffix (engine-side), so repeat sessions on one feature never share a name.
  function takenTitles(excludeId: string): string[] {
    const st = get()
    return [
      ...st.order.filter((sid) => sid !== excludeId).map((sid) => st.sessions[sid]?.label),
      ...st.archived.filter((a) => a.id !== excludeId).map((a) => a.label),
    ]
      .filter((l): l is string => !isProvisionalSessionTitle(l))
      .slice(0, 12)
  }

  // Per-session naming epoch: each nameSession call invalidates any still-in-flight predecessor, so a
  // slow birth-naming turn can never resolve late and revert a later regeneration. Entries are a number
  // per session ever named — no cleanup needed.
  const titleGen = new Map<string, number>()

  // Fire-and-forget naming through the app-global generated-text choice. Main owns the
  // initial/regenerate prompt split and every fallback, so this never blocks a turn or rejects.
  // A user rename (userNamed) always wins — including against an in-flight naming turn resolving late.
  function nameSession(id: string, kind: SessionNameKind, evidence: string): void {
    if (!evidence.trim()) return
    const session = get().sessions[id]
    if (!session || session.userNamed) return
    const gen = (titleGen.get(id) ?? 0) + 1
    titleGen.set(id, gen)
    void window.koda
      .nameSession({
        kind,
        evidence,
        currentTitle: kind === 'regenerate' ? session.label : undefined,
        avoid: takenTitles(id),
      })
      .then(({ title, overview }) => {
        if (titleGen.get(id) !== gen) return // superseded by a newer naming for this session
        if (!title.trim()) return
        patchSession(id, (s) =>
          s.userNamed
            ? s
            : { ...s, label: title, ...(overview.trim() ? { overview: overview.trim() } : {}) },
        )
      })
      .catch(() => {})
  }

  /** Reconcile the title when main hands a phone-started session to this renderer. Main's settled
   *  label wins, then a replayed/persisted first prompt repairs the old phone placeholder. This is
   *  shared by both adoption arms: on window reopen the session already exists because hydration
   *  necessarily runs before main transfers its live engine. */
  function repairAdoptedTitle(
    id: string,
    incomingLabel: string | undefined,
    incomingUserNamed: boolean | undefined,
  ): void {
    const current = get().sessions[id]
    if (!current || current.userNamed) return
    const settledIncoming = incomingLabel?.trim()
    if (incomingUserNamed) {
      patchSession(id, (session) => ({
        ...session,
        ...(settledIncoming ? { label: settledIncoming } : {}),
        userNamed: true,
      }))
      return
    }
    if (settledIncoming && !isProvisionalSessionTitle(settledIncoming)) {
      patchSession(id, (session) => ({ ...session, label: settledIncoming }))
      return
    }

    const first = current.items.find(
      (item): item is Extract<Entry, { kind: 'user' }> =>
        item.kind === 'user' && isSessionNamingPrompt(item.text),
    )
    if (!first) return
    const instant = titleFromPrompt(first.text)
    // Hydration may already have replaced the literal with this exact deterministic floor. It still
    // deserves the configured writer once the live session is adopted; any other settled renderer
    // title is left alone.
    if (!isProvisionalSessionTitle(current.label) && current.label !== instant) return
    if (isProvisionalSessionTitle(current.label))
      patchSession(id, (session) => ({ ...session, label: instant }))
    const reply = current.items
      .slice()
      .reverse()
      .find((item) => item.kind === 'assistant') as Extract<Entry, { kind: 'assistant' }> | undefined
    nameSession(
      id,
      reply ? 'regenerate' : 'initial',
      reply ? namingEvidence(get().sessions[id]?.items ?? []) : first.text,
    )
  }

  /** Older renderer builds could persist the phone fallback onto a desktop-origin session during a
   *  reload. Main's explicit false is authoritative enough to repair that row even before it has a
   *  text prompt; `undefined` preserves mixed-version behavior and a human rename always wins. */
  function originSafeAdoptedLabel(
    label: string | undefined,
    fromRemote: boolean | undefined,
    userNamed: boolean | undefined,
  ): string | undefined {
    return fromRemote === false && !userNamed && label?.trim() === PHONE_SESSION_TITLE
      ? NEW_SESSION_TITLE
      : label
  }

  // Every observed sign of life in a session: a turn sent, a turn finished, an approval asked. This is
  // the ONLY writer of `lastActivityAt`, which is what every sidebar row's age reads — so a thread
  // looks recent because it was worked in, never because it was marked.
  function markActivity(id: string): void {
    patchSession(id, (s) => ({ ...s, lastActivityAt: Date.now() }))
  }

  // Shared turn dispatch for every path that drives the engine (the composer + Canvas edits). Pushes an
  // optimistic transcript item, marks the session busy, lazily reattaches a restored session via
  // --resume, then sends. `sentText` is what the engine receives; `displayItem` is what the transcript
  // shows (they differ for a Canvas edit — a readable chip, but a fuller prompt to the agent).
  // `nameFromText` opts into first-turn session naming (composer only; a Canvas edit shouldn't rename).
  async function dispatchTurn(
    id: string,
    opts: { sentText: string; images?: ImageDraft[]; displayItem: TurnItem; nameFromText?: string },
  ): Promise<boolean> {
    const active = get().sessions[id]
    if (!active || active.busy) return false
    const needsReattach = !active.live
    const cwd = active.cwd
    // Synchronous guard: two dispatches in one tick (before `busy` flushes) could both spawn a second
    // `claude --resume` and orphan the first child.
    if (needsReattach && reattaching.has(id)) return false
    // "First turn" = no engine turn has ever been dispatched (drives spawn-vs-resume + first-prompt
    // naming). A Canvas edit dispatches a turn too (pushes a `canvas` item, not `user`), so it must
    // count here — otherwise a canvas-only session that later drops its engine would spawn fresh and
    // lose its conversation, and a later composer turn would spuriously rename the session.
    const firstTurn = !active.items.some((it) => it.kind === 'user' || it.kind === 'canvas')
    const name = opts.nameFromText?.trim()
    pushItem(id, opts.displayItem)
    patchSession(id, (s) => ({
      ...s,
      busy: true,
      turnStartedAt: Date.now(),
      errored: false,
      error: undefined, // a fresh turn clears any prior error banner
      attachNotice: undefined, // …and any leftover "couldn't attach that" row
      // userNamed guard: a session renamed BEFORE its first message keeps that name.
      label: firstTurn && name && !s.userNamed ? titleFromPrompt(name) : s.label,
    }))
    // Interacting with a session (sending a turn) bumps it to the top — newest activity first. Merely
    // selecting a session to glance at it does NOT reorder (that would yank the list under the user).
    set((state) =>
      state.order[0] === id
        ? {}
        : { order: [id, ...state.order.filter((sid) => sid !== id)] },
    )
    // A sent turn is the plainest activity there is — stamp it before anything can await (the map
    // un-settles this thread on the spot, even if the engine takes a while to answer).
    markActivity(id)
    if (firstTurn && name && !get().sessions[id]?.userNamed) nameSession(id, 'initial', name)
    if (needsReattach) {
      reattaching.add(id)
      suppressStartNotice.add(id)
      try {
        // Reattach in the session's chosen mode (see send()'s prior history): plan re-enters
        // --permission-mode plan; every other tier reattaches in default (the gate does the tiering).
        // A session whose engine was dropped before its first user turn has nothing to resume — spawn
        // fresh under the same id instead.
        const planMode = active.approvalMode === 'plan'
        const model = active.model
        const effort = active.effort
        const engineId = active.engineId
        const replaySeq = active.replaySeq
        // Hand the driver its own resume blob back and let it decide: it reattaches when the blob is
        // still good, starts clean when it isn't, and main recovers a session whose engine lost the
        // conversation outright. Nothing here has to reason about what a resumable conversation is.
        await window.koda.startSession({
          cwd,
          sessionId: id,
          planMode,
          model,
          effort,
          engineId,
          resumeCursor: firstTurn ? undefined : active.resumeCursor,
          replaySeq,
        })
        patchSession(id, (s) => ({ ...s, live: true }))
        // The gate's per-session posture map is empty after a restart — re-push this session's mode.
        window.koda
          .setApprovalMode({ sessionId: id, mode: active.approvalMode })
          .catch(console.error)
      } catch (err) {
        suppressStartNotice.delete(id)
        patchSession(id, (s) => ({ ...s, busy: false }))
        pushItem(id, { kind: 'notice', text: `⚠ couldn't reattach this session: ${String(err)}` })
        reattaching.delete(id)
        return true // the optimistic transcript item already owns this composer snapshot
      } finally {
        reattaching.delete(id)
      }
    }
    await window.koda.sendTurn({
      sessionId: id,
      text: opts.sentText,
      images: opts.images?.length ? opts.images : undefined,
    })
    return true
  }

  // If no card matches a subagent event, drop it (never leak to the main flow) — but warn so a
  // missing card surfaces in the dogfood log instead of vanishing.
  function warnNoCard(parentToolUseId: string): void {
    console.warn(`subagent event with no matching card (parent=${parentToolUseId})`)
  }

  function updateSubagent(id: string, toolUseId: string, patch: Partial<SubagentItem>): void {
    patchSession(id, (s) => {
      if (!s.items.some((it) => it.kind === 'subagent' && it.toolUseId === toolUseId)) {
        warnNoCard(toolUseId)
        return s
      }
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === 'subagent' && it.toolUseId === toolUseId ? { ...it, ...patch } : it,
        ),
      }
    })
  }

  function addChild(id: string, parentToolUseId: string, child: SubagentChildData): void {
    const childId = ++entryId
    patchSession(id, (s) => {
      if (!s.items.some((it) => it.kind === 'subagent' && it.toolUseId === parentToolUseId)) {
        warnNoCard(parentToolUseId)
        return s
      }
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === 'subagent' && it.toolUseId === parentToolUseId
            ? {
                ...it,
                lastActivityAt: Date.now(),
                children: [...it.children, { ...child, id: childId } as SubagentChild],
              }
            : it,
        ),
      }
    })
  }

  function foldChildResult(
    id: string,
    parentToolUseId: string,
    toolUseId: string,
    result: string,
    isError: boolean,
  ): void {
    patchSession(id, (s) => ({
      ...s,
      items: s.items.map((it) => {
        if (it.kind !== 'subagent' || it.toolUseId !== parentToolUseId) return it
        return {
          ...it,
          lastActivityAt: Date.now(),
          children: it.children.map((c) =>
            c.kind === 'tool' && c.toolUseId === toolUseId ? { ...c, result, isError } : c,
          ),
        }
      }),
    }))
  }

  // ── Extended thinking: a single live indicator per thinking burst ──
  // Reasoning text is redacted on subscription -p (spike/capture); we surface only that thinking is
  // happening + its token magnitude. The burst is the trailing item while active; the first real
  // output freezes it to "Thought · ~N".
  function thinkingTick(id: string, estimatedTokens?: number): void {
    const eid = ++entryId // pre-allocated; a gap if we only update
    patchSession(id, (s) => {
      const lastIdx = s.items.length - 1
      const last = s.items[lastIdx]
      if (last && last.kind === 'thinking' && last.active) {
        const items = s.items.slice()
        items[lastIdx] = { ...last, estimatedTokens: estimatedTokens ?? last.estimatedTokens }
        return { ...s, items }
      }
      return { ...s, items: [...s.items, { id: eid, kind: 'thinking', estimatedTokens, active: true }] }
    })
  }
  function finalizeThinking(id: string): void {
    patchSession(id, (s) => {
      const lastIdx = s.items.length - 1
      const last = s.items[lastIdx]
      if (last && last.kind === 'thinking' && last.active) {
        const items = s.items.slice()
        items[lastIdx] = { ...last, active: false }
        return { ...s, items }
      }
      return s
    })
  }

  // ── Task list (TaskCreate/TaskUpdate) → one evolving checklist panel per session ──
  function mutateTaskList(id: string, fn: (tasks: TaskRow[]) => TaskRow[]): void {
    const eid = ++entryId // pre-allocated; a gap if the panel already exists
    patchSession(id, (s) => {
      const idx = s.items.findIndex((it) => it.kind === 'tasklist')
      if (idx === -1) return { ...s, items: [...s.items, { id: eid, kind: 'tasklist', tasks: fn([]) }] }
      const items = s.items.slice()
      const cur = items[idx] as Extract<Entry, { kind: 'tasklist' }>
      items[idx] = { ...cur, tasks: fn(cur.tasks) }
      return { ...s, items }
    })
  }
  function upsertTask(id: string, row: TaskRow): void {
    mutateTaskList(id, (tasks) => {
      const i = tasks.findIndex((t) => t.id === row.id)
      if (i === -1) return [...tasks, row]
      // Keep the existing status — a late TaskCreate result (always 'pending') must not downgrade a
      // status an out-of-order TaskUpdate already advanced.
      const next = tasks.slice()
      next[i] = { ...next[i], subject: row.subject || next[i].subject }
      return next
    })
  }
  function updateTaskStatus(id: string, taskId: string, status: string): void {
    mutateTaskList(id, (tasks) => {
      const i = tasks.findIndex((t) => t.id === taskId)
      if (i === -1) return [...tasks, { id: taskId, subject: '', status }]
      const next = tasks.slice()
      next[i] = { ...next[i], status }
      return next
    })
  }

  // ── Workflows: patch the card matching runId (its agents/status come from the journal watcher) ──
  function mutateWorkflow(id: string, runId: string, fn: (w: WorkflowEntry) => WorkflowEntry): void {
    patchSession(id, (s) => {
      if (!s.items.some((it) => it.kind === 'workflow' && it.runId === runId)) {
        console.warn(`workflow event with no matching card (run=${runId})`)
        return s
      }
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'workflow' && it.runId === runId ? fn(it as WorkflowEntry) : it)),
      }
    })
  }

  // A session reached a notable state (done/error/needs-you). Mirrors App.tsx raiseAttention —
  // reads CURRENT state via get() (zustand is synchronous, so no stale-closure problem the refs
  // existed to solve).
  function raiseAttention(sid: string, kind: 'done' | 'error' | 'waiting'): void {
    const { sessions, activeId } = get()
    const s = sessions[sid]
    if (!s) return
    // Reaching a notable state is activity, whoever is watching: a thread that asked for an approval
    // last night is live work, and its row should not read a day old.
    if (!replayingSessions.has(sid)) markActivity(sid)
    // "Watching this" = its view is active AND the window is focused — the only case needing no
    // signal (the user is literally looking at it finish).
    const watchingThis = activeId === sid && document.hasFocus()
    if (watchingThis) return
    // Replaying an adopted phone session's history — its old "done" states aren't live news; mark the
    // session (so it still shows unseen in the sidebar) but never fire a native notification for them.
    if (replayingSessions.has(sid)) {
      if (activeId !== sid) patchSession(sid, (ss) => (ss.attention ? ss : { ...ss, attention: true }))
      return
    }
    // In-app marker for backgrounded sessions — the active one needs no marker (badging it would
    // never clear since the user is already on it).
    if (activeId !== sid) patchSession(sid, (ss) => (ss.attention ? ss : { ...ss, attention: true }))
    // Native notification unless watching this exact session, so a backgrounded session finishing
    // pops even while you're in Koda on another session. Gated by the user's preference.
    if (notifyOk && notifyEnabled) {
      const body =
        kind === 'done'
          ? `${s.label} finished`
          : kind === 'error'
            ? `${s.label} hit an error`
            : `${s.label} needs your approval`
      try {
        const n = new Notification('Koda', { body })
        n.onclick = () => get().selectSession(sid)
      } catch {
        /* notifications best-effort */
      }
    }
  }

  /** Write the archive index and WAIT for the answer. One file backs all three moves between the hot
   *  session store and the archive (archive / reopen / delete), and the hot half of every one of them
   *  lands on its own — so the caller must not commit its half until this returns true. A `false` that
   *  gets ignored is exactly how a chat leaves the sidebar with nothing left recording where it went.
   *
   *  Refuses outright while the index couldn't be READ this run: writing then would replace a file we
   *  never managed to parse. (Unreachable in practice — a failed read hydrates an empty archived list,
   *  so there is nothing to reopen or delete and archiveSession bails earlier — kept because this is the
   *  one function that touches the file.)
   *
   *  A preload predating the acknowledged channel resolves `undefined`, which reads as a refusal: the
   *  move is declined rather than completed on an unverified write. That's the dev hot-reload window
   *  only, and refusing is the safe side of it. */
  const persistArchived = async (next: ArchivedSessionMeta[]): Promise<boolean> => {
    if (get().archiveLoadFailed) return false
    // Rows whose bodies could not be read stay hidden from the archive UI, but they are still recovery
    // metadata and must survive unrelated archive/restore/delete writes. A new readable archive for the
    // same live fallback deliberately replaces its protected row.
    const nextIds = new Set(next.map((meta) => meta.id))
    const protectedArchived = get().protectedArchived.filter((meta) => !nextIds.has(meta.id))
    const durable = [...next, ...protectedArchived]
    let ok = false
    try {
      ok = (await window.koda.saveArchived?.(durable)) === true
    } catch (err) {
      console.error('archive index save failed', err)
    }
    if (ok && protectedArchived.length !== get().protectedArchived.length)
      set({ protectedArchived })
    // Cleared by the first write that lands, so a genuinely one-off failure stops warning on its own.
    if (get().archiveWriteFailed !== !ok) set({ archiveWriteFailed: !ok })
    return ok
  }

  /** Run one move between the hot store and the archive at a time.
   *
   *  Each of the three (archive / reopen / delete) is a read-modify-write of ONE list: read `archived`,
   *  derive the next list, await the file, commit that list. Two of them in flight at once — the phone
   *  forwarding an archive while ⌘W archives another session — both read the same base, so the second
   *  write lands over the first and the second commit overwrites it in memory too. One chat then leaves
   *  the sidebar without ever reaching the index, its transcript orphaned in `.bodies/`.
   *
   *  Zustand's setter composes updates for free, which is why the old fire-and-forget version survived
   *  this; waiting on the write is what put a gap between the read and the commit. Serializing closes
   *  the gap instead of choosing between the two properties: each move sees the previous one's
   *  committed result, so the list it persists and the list it commits are still the same list.
   *  (Re-deriving inside the setter would fix memory only — the loser's row would be live in the store
   *  and absent from the file it was just told about, which needs another unacknowledged write to
   *  reconcile.) */
  let archiveMoves: Promise<unknown> = Promise.resolve()
  const queueArchiveMove = <T,>(move: () => Promise<T>): Promise<T> => {
    const run = archiveMoves.then(move, move)
    archiveMoves = run.catch(() => {})
    return run
  }

  return {
    sessions: {},
    order: [],
    activeId: null,
    archived: [],
    protectedArchived: [],
    starredDocs: [],
    legacyKeptDocsImported: [],
    legacyKeptDocPathChanges: [],
    legacyKeptDocsMigrationComplete: false,
    pending: [],
    rateLimits: {},
    providerDown: {},
    applyProviderStatus: (e) =>
      set((state) => {
        const next = { ...state.providerDown }
        if (e.down) next[e.engine] = { note: e.note, kind: e.kind }
        else delete next[e.engine]
        return { providerDown: next }
      }),
    engineSignedOut: {},
    refreshEngineAuth: async () => {
      // Read each engine's sign-in the same way Settings does, so the dot and the Providers panel never
      // disagree. "Signed out" mirrors ProvidersSection's readiness: Claude is out when the subscription
      // verdict is logged-out AND no API key is stored; Codex is out when it isn't signed in AND has no
      // stored key. Fail-soft (treat an unreadable probe as signed-in) so a transient probe error never
      // raises a false "sign in" nag.
      const [billing, codex] = await Promise.all([
        window.koda.getBillingState().catch(() => null),
        window.koda.getCodexAuthStatus().catch(() => null),
      ])
      const next: Record<string, boolean> = {}
      if (billing) next.claude = billing.verdict.mode === 'logged-out' && !billing.hasKey
      if (codex && !codex.probeFailed) next.codex = !(codex.signedIn || (billing?.hasCodexKey ?? false))
      set({ engineSignedOut: next })
    },
    billingMode: 'subscription',
    apiActive: false,
    billingFallbackPrompt: null,
    memoryWeight: null,
    defaultApprovalMode: 'auto',
    projectPath: null,
    intakePending: false,
    miniApps: [],
    faceDir: null,
    faceView: 'workshop',
    pendingFaceDir: null,
    layout: { mode: 'focus' },
    editors: {},
    openDirs: [],
    filesRev: 0,
    treeError: null,
    settingsOpen: false,
    settingsSection: null,
    versionsOpen: false,
    sidebarWidth: DEFAULT_LAYOUT.sidebarWidth, // hydrated from persisted settings at boot
    sessionsFrac: DEFAULT_LAYOUT.sessionsFrac,

    conversationWidth: DEFAULT_LAYOUT.conversationWidth,
    artifactSplitFrac: DEFAULT_LAYOUT.artifactSplitFrac,
    pendingTermCommand: null,
    stageExpanded: false,
    gitRepo: false,
    gitFiles: [],
    completionBySession: {},
    gitChangesTruncated: false,
    gitSideLinesWaiting: false,
    changesFocus: null,
    searchOpen: false,
    lightbox: null,
    scratchTick: 0,
    recentImagesExpanded: false,
    recentFiles: [],
    hydrated: false,
    sessionsLoadFailed: false,
    archiveLoadFailed: false,
    sessionsBackupKept: null,
    archiveBackupKept: null,
    droppedSessions: 0,
    droppedArchives: 0,
    unreadableArchiveBodies: 0,
    archiveWriteFailed: false,
    archiveRestoreFailed: false,

    applyCompletionState: (completion) => {
      set((state) => ({
        completionBySession: { ...state.completionBySession, [completion.sessionId]: completion },
      }))
      // Reconcile the independent evidence streams together: completion names task-owned paths;
      // user Git decides which of them are still actually loose.
      void get().refreshGitStatus()
    },

    applyAsideEvent: (e) => {
      patchSession(e.sessionId, (s) => {
        // Ignore a late event for an aside the user already dismissed or replaced (id mismatch).
        if (!s.aside || s.aside.id !== e.asideId) return s
        if (e.kind === 'delta') return { ...s, aside: { ...s.aside, answer: s.aside.answer + e.text } }
        if (e.kind === 'error') return { ...s, aside: { ...s.aside, status: 'error', answer: e.text } }
        // done: the event carries the full accumulated text — prefer it, fall back to what streamed.
        return { ...s, aside: { ...s.aside, status: 'done', answer: e.text || s.aside.answer } }
      })
    },

    applyEngineEvent: (e) => {
      const sid = e.sessionId
      const replaySeq = e.replaySeq
      if (replaySeq !== undefined)
        patchSession(sid, (s) => ({ ...s, replaySeq: Math.max(s.replaySeq ?? 0, replaySeq) }))
      // Reconcile `busy` from the live stream so the sidebar follows the ACTUAL turn, including turns
      // started outside this renderer (phone/relay → backend.sendTurn, which never runs dispatchTurn).
      // Skip while a user interrupt is settling so a trailing event can't re-arm a turn just stopped.
      if (isTopLevelTurnActivity(e) && !userInterrupted.has(sid))
        patchSession(sid, (s) => (s.busy ? s : { ...s, busy: true }))
      switch (e.type) {
        case 'SessionStarted': {
          // Claude ≥2.1.221 emits init lazily — the FIRST SessionStarted lands after the user's first
          // message is already in items, so "items exist" no longer distinguishes a fresh session from
          // a respawn. A prior start having reported a model is the discriminator that still does.
          const previouslyStarted = get().sessions[sid]?.activeModel !== undefined
          // Record the model the engine actually reports running — ground truth for the model pill
          // (confirms a switch landed, or shows the engine default when the user picked nothing).
          // Capture the engine's native id (Codex thread id) so a later reattach can resume THAT thread.
          patchSession(sid, (s) => ({
            ...s,
            activeModel: e.model || undefined,
            // A phone-started session begins with no model pick, so its row would show blank and lose
            // the model on restart (activeModel isn't persisted). Adopt the engine's resolved model as
            // this session's model — but only on the FIRST SessionStarted (activeModel still unset): a
            // later respawn with no model is an explicit "Default" pick, which must stay unpinned.
            // Local sessions never inherit (undefined ⇒ "Default", which auto-upgrades).
            model: s.fromRemote && !s.model && !s.activeModel && e.model ? e.model : s.model,
          }))
          // A reattach (--resume) re-fires this; swallow its banner so restored history stays clean.
          if (suppressStartNotice.has(sid)) suppressStartNotice.delete(sid)
          // No banner in a fresh session — the composer's model pill owns model truth, and a spawn-time
          // readout can contradict it (the engine may boot on a default before the user's pick applies
          // at turn 1). A restart UNDER an existing conversation is the only start that's news.
          else if (previouslyStarted)
            pushItem(sid, {
              kind: 'notice',
              text: e.model ? `continuing on ${prettyModel(e.model)}` : 'session restarted',
            })
          break
        }
        case 'SessionCapabilitiesUpdated': {
          const degraded = e.snapshot.capabilities.filter((capability) => capability.status === 'degraded')
          const degradedKey = degraded.map((capability) => capability.id).sort().join('|')
          const warningPrefix = "Some Koda abilities didn't load:"
          const warningText = degradedKey
            ? `${warningPrefix} ${degraded.map((capability) => capability.label).join(', ')}. You can keep chatting; start a new session to retry them.`
            : undefined
          // Runtime truth can recover on a later Claude init. Keep at most the warning matching the
          // CURRENT degraded shape, and remove it entirely once everything is ready; a persisted old
          // warning after renderer reload must not instruct the user to restart a healthy session.
          patchSession(sid, (s) => ({
            ...s,
            capabilities: e.snapshot,
            items: s.items.filter(
              (item) =>
                item.kind !== 'notice' ||
                !item.text.startsWith(warningPrefix) ||
                item.text === warningText,
            ),
          }))
          if (
            !replayingSessions.has(sid) &&
            warningText &&
            !get().sessions[sid]?.items.some((item) => item.kind === 'notice' && item.text === warningText)
          )
            pushItem(sid, { kind: 'notice', text: warningText, replaySeq: e.replaySeq })
          break
        }
        case 'ResumeCursorUpdated':
          // The driver's own reattach state. Stored and persisted verbatim so the next start can hand it
          // straight back; the renderer never looks inside it.
          patchSession(sid, (s) => ({ ...s, resumeCursor: e.cursor }))
          break
        case 'ApprovalModeChanged':
          // A change made on another surface (the phone) — route through the full action so the pill
          // updates, persistence saves it, and a plan crossing respawns. The echo of this window's own
          // change arrives as a same-value no-op there.
          get().setSessionApprovalMode(sid, e.mode)
          break
        case 'ModelEffortChanged':
          // A change made on another surface (the phone) — adopt the new pair so the pill follows and
          // the next reattach doesn't revert it. Main already owns the app-wide next-chat posture. Patch
          // directly (NOT setSessionModel): main already respawned the engine with this pair, so the
          // session stays live — and no re-push, so this window's own echo can't loop. An engine flip drops the old
          // engine's ground-truth fields (activeModel, Codex thread id), exactly as setSessionEngine does
          // locally.
          patchSession(sid, (s) => ({
            ...s,
            model: e.model,
            effort: e.effort,
            ...(e.engineId && e.engineId !== s.engineId
              ? { engineId: e.engineId, activeModel: undefined, resumeCursor: undefined }
              : {}),
          }))
          break
        case 'ThinkingDelta':
          thinkingTick(sid, e.estimatedTokens)
          break
        case 'AssistantDelta':
          finalizeThinking(sid) // first real output ends the thinking burst
          // Subagent text isn't live-painted (adapter suppresses it); only top-level.
          patchSession(sid, (s) => ({ ...s, streaming: s.streaming + e.text }))
          break
        case 'AssistantBlock':
          if (e.parentToolUseId)
            addChild(sid, e.parentToolUseId, {
              kind: 'assistant',
              markdown: e.markdown,
              replaySeq: e.replaySeq,
            })
          else {
            finalizeThinking(sid)
            patchSession(sid, (s) => ({ ...s, streaming: '' }))
            pushItem(sid, { kind: 'assistant', markdown: e.markdown, replaySeq: e.replaySeq })
          }
          break
        case 'ToolRequested':
          if (e.parentToolUseId) {
            // Subagent's own task calls stay nested tool cards (its checklist isn't surfaced in v0).
            addChild(sid, e.parentToolUseId, {
              kind: 'tool',
              toolUseId: e.id,
              name: e.name,
              input: e.input,
              replaySeq: e.replaySeq,
            })
            break
          }
          finalizeThinking(sid)
          if (e.name === 'TaskCreate') {
            // Defer the row to the result, which carries the engine's authoritative "Task #N" id.
            const subject = (e.input as { subject?: string } | null)?.subject ?? ''
            taskCreatePending.set(e.id, subject)
          } else if (e.name === 'TaskUpdate') {
            const inp = e.input as { taskId?: string | number; status?: string } | null
            if (inp?.taskId != null) updateTaskStatus(sid, String(inp.taskId), String(inp.status ?? ''))
          } else {
            pushItem(sid, {
              kind: 'tool',
              toolUseId: e.id,
              name: e.name,
              input: e.input,
              replaySeq: e.replaySeq,
            })
          }
          break
        case 'ToolProgress':
          patchSession(sid, (s) => ({
            ...s,
            items: s.items.map((it) =>
              it.kind === 'tool' && it.toolUseId === e.id
                ? { ...it, liveOutput: appendLiveToolOutput(it.liveOutput, e.output) }
                : it,
            ),
          }))
          break
        case 'PlanUpdate':
          mutateTaskList(sid, () => e.steps)
          break
        case 'ContextCompacted':
          patchSession(sid, (s) => ({ ...s, context: undefined }))
          pushItem(sid, {
            kind: 'notice',
            text: 'Codex condensed the earlier conversation and continued with a summary.',
            replaySeq: e.replaySeq,
          })
          break
        case 'ContextUsageUpdate':
          patchSession(sid, (s) => ({ ...s, context: e.context }))
          break
        case 'ToolResult': {
          // Fold the result into its requesting tool card by the engine's tool id — nested child or
          // top-level card.
          if (e.parentToolUseId) {
            foldChildResult(sid, e.parentToolUseId, e.id, e.output, e.isError)
            break
          }
          const pendingSubject = taskCreatePending.get(e.id)
          if (pendingSubject !== undefined) {
            // TaskCreate result: "Task #N created successfully: <subject>" → the row's stable id.
            // The "#N" wording is pinned to engine 2.1.185's result text (spike/capture).
            taskCreatePending.delete(e.id)
            const taskId = /#(\d+)/.exec(e.output)?.[1]
            if (taskId) upsertTask(sid, { id: taskId, subject: pendingSubject, status: 'pending' })
            break
          }
          patchSession(sid, (s) => ({
            ...s,
            items: s.items.map((it) =>
              it.kind === 'tool' && it.toolUseId === e.id
                ? { ...it, liveOutput: undefined, result: e.output, isError: e.isError }
                : it,
            ),
          }))
          // Live edits: a successful file-edit tool auto-surfaces its before→after diff so the user
          // can watch (and catch) the change. Look the tool up by id for its name + file_path.
          if (!e.isError) {
            const tool = get().sessions[sid]?.items.find(
              (it) => it.kind === 'tool' && it.toolUseId === e.id,
            )
            if (tool?.kind === 'tool' && EDIT_TOOLS.has(tool.name)) {
              const filePath = (tool.input as { file_path?: string } | null)?.file_path
              // Markdown edits surface as a live rendered DOC (watch it build, Notion-style); code +
              // everything else surface as the before→after DIFF (watch the change, catch mistakes).
              // Only for edits inside THIS session's cwd — that's the safety-git root the diff resolves
              // against (see the fs:diffFile handler). An edit outside it (a global ~/.claude file) can't
              // be diffed, so surfacing it would just error and steal the Stage.
              if (filePath && withinDir(filePath, get().sessions[sid]?.cwd)) {
                if (isMarkdown(filePath)) get().showEditDoc(filePath, sid)
                else get().showEditDiff(filePath, sid)
              }
            }
          }
          break
        }
        case 'SubagentStarted':
          finalizeThinking(sid)
          pushItem(sid, {
            kind: 'subagent',
            toolUseId: e.toolUseId,
            taskId: e.taskId,
            subagentType: e.subagentType,
            description: e.description,
            prompt: e.prompt,
            status: 'running',
            lastActivityAt: Date.now(),
            replaySeq: e.replaySeq,
            children: [],
          })
          followDelegation(sid)
          break
        case 'WorkflowStarted':
          finalizeThinking(sid)
          pushItem(sid, {
            kind: 'workflow',
            runId: e.runId,
            name: e.name,
            status: 'running',
            agents: [],
            replaySeq: e.replaySeq,
          })
          followDelegation(sid)
          break
        case 'WorkflowAgent':
          mutateWorkflow(sid, e.runId, (w) => {
            const agents = w.agents.slice()
            const i = agents.findIndex((a) => a.agentId === e.agentId)
            if (i === -1) agents.push({ agentId: e.agentId, status: e.status, result: e.result })
            else agents[i] = { ...agents[i], status: e.status, ...(e.result ? { result: e.result } : {}) }
            return { ...w, agents }
          })
          break
        case 'WorkflowCompleted':
          {
            const attentionKind = terminalAttentionKind(e)
            const workflow = get().sessions[sid]?.items.find(
              (item) => item.kind === 'workflow' && item.runId === e.runId,
            )
            const stillRunning = workflow?.kind === 'workflow' && workflow.agents.some((agent) => agent.status === 'running')
            mutateWorkflow(sid, e.runId, (w) => ({ ...w, status: 'completed' }))
            if (!stillRunning && attentionKind) raiseAttention(sid, attentionKind)
          }
          break
        case 'WorkflowObservationEnded':
          mutateWorkflow(sid, e.runId, (w) => {
            const unresolved = new Set(e.unresolvedAgentIds)
            return {
              ...w,
              status: 'unknown',
              agents: w.agents.map((agent) =>
                unresolved.has(agent.agentId) ? { ...agent, status: 'unknown' as const } : agent,
              ),
            }
          })
          break
        case 'SubagentProgress': {
          const patch: Partial<SubagentItem> = { lastActivityAt: Date.now() }
          if (e.status === 'completed') {
            patch.status = 'completed'
            patch.stopRequested = undefined
          }
          if (e.taskId) patch.taskId = e.taskId
          if (e.description) patch.liveStatus = e.description // live one-liner, not task identity
          if (e.lastToolName) patch.lastToolName = e.lastToolName
          if (e.usage) patch.usage = e.usage
          updateSubagent(sid, e.toolUseId, patch)
          break
        }
        case 'SubagentCompleted':
          updateSubagent(sid, e.toolUseId, {
            status:
              e.outcome === 'interrupted'
                ? 'interrupted'
                : e.outcome === 'unknown'
                  ? 'unknown'
                  : 'completed',
            stopRequested: undefined,
            lastActivityAt: Date.now(),
            ...(e.taskId ? { taskId: e.taskId } : {}),
            isError: e.isError,
            ...(e.resultText ? { resultText: e.resultText } : {}),
            ...(e.usage ? { usage: e.usage } : {}),
          })
          settleDeferredBillingRespawn(sid)
          break
        case 'TurnComplete': {
          // Codex pairs a pre-start rejection with a compatibility completion so pre-category clients
          // release busy. The remote handshake has no version gate (those builds may still false-haptic),
          // so this renderer must read the reason: the EngineError owns attention and one-shot success
          // workflows must survive for Retry.
          const attentionKind = terminalAttentionKind(e)
          const rejectedBeforeStart = attentionKind === null
          finalizeThinking(sid) // covers a thinking-only turn that produced no text
          patchSession(sid, (s) => ({
            ...endTurn(s),
            streaming: '',
            context: e.context ?? s.context,
            // Accumulate spend regardless of whether a notice shows — feeds the Usage view.
            spendUsd: s.spendUsd + (e.costEstimate ?? 0),
            byModel: foldModelSpend(s.byModel, e.models),
          }))
          // Invariant: the engine blocks a turn synchronously on a pending approval, so a completed turn
          // means nothing is awaiting one. Any prompt still queued here is stale (e.g. the ~5min MCP
          // approve timeout drops the `approve` call and the agent re-asks, stranding the old requestId
          // with no cancel event) — clear it, else statusOf latches the session on "Needs your approval".
          get().cancelPending(sid)
          settleDeferredBillingRespawn(sid)
          // A finished turn is activity: it re-dates the session in the map (and un-settles it if the
          // work was picked back up after a quiet week). Replay is history, not activity.
          if (!replayingSessions.has(sid)) markActivity(sid)
          // Re-name the thread at the sparse regeneration crossings (session-naming.ts). The old
          // one-shot retitle named a thread from its opening turn and never looked again, so a thread
          // that moved research → build → review kept the name of whatever it opened with. The
          // regenerate prompt keeps the umbrella subject instead of chasing the latest stage.
          //
          // `namedAtTurns` is what makes a crossing an EDGE. `shouldRegenerateName` answers "is the
          // count AT a crossing", and plenty of turns finish without adding a user message — a doc
          // edit (a `canvas` item), the handoff prompt (a `notice` item), an image-only turn (whose
          // text `userMessages` drops). Without the stamp, every one of those re-fires naming for as
          // long as the thread sits on 2, 5, or a multiple of 10, and each re-fire is another chance
          // for the title to come back worded differently. Stamped BEFORE the call, so a second turn
          // completing while this naming is still in flight doesn't fire a duplicate either.
          if (!replayingSessions.has(sid) && e.stopReason === 'success') {
            const sess = get().sessions[sid]
            const turns = sess ? userMessages(sess.items).length : 0
            if (sess && !sess.userNamed && sess.namedAtTurns !== turns && shouldRegenerateName(turns)) {
              patchSession(sid, (s) => ({ ...s, namedAtTurns: turns }))
              nameSession(sid, 'regenerate', namingEvidence(sess.items))
            }
          }
          // A clean turn (subtype 'success') needs no footer — the next composer marks the boundary.
          // Surface a notice ONLY when the turn ended abnormally, so a truncated answer isn't silent.
          // (No cost here — running spend lives in the Usage view; fatal errors get their own notice.)
          // A user-initiated stop also ends abnormally (error_during_execution) — that's expected, not an
          // error to report, so swallow the notice once for an interrupted session.
          const stopped = userInterrupted.delete(sid)
          // A raised error banner already reports this turn's failure — don't double it with a footer.
          const banneredFailure = bannerErrored.delete(sid)
          const abnormal = stopped || banneredFailure ? null : abnormalStopNotice(e.stopReason)
          // A doomed session (e.g. a --resume the engine can't honour) can emit the same error turn several
          // times in a row; collapse consecutive identical notices so the transcript shows one, not a wall.
          const lastItem = get().sessions[sid]?.items.at(-1)
          const dupe = lastItem?.kind === 'notice' && lastItem.text === abnormal
          if (abnormal && !dupe) pushItem(sid, { kind: 'notice', text: abnormal })
          // A completed turn is the moment the working tree most likely changed — refresh the dirty
          // state that feeds the per-session chips + Changes surface (aggregate, so any session's turn
          // updates the shared picture). Fire-and-forget. Skipped while replaying an adopted session's
          // history — one refresh after the replay settles covers it (see adoptHeadless).
          if (!replayingSessions.has(sid)) void get().refreshGitStatus()
          // Keep-going-in-a-fresh-chat: this session requested a handoff summary — now that the turn is
          // done, carry it into a new session. A stopped or empty turn yields no usable summary → say so
          // and stay put rather than opening a blank chat.
          if (!rejectedBeforeStart && handoffPending.delete(sid)) {
            const items = get().sessions[sid]?.items ?? []
            const summary = [...items]
              .reverse()
              .flatMap((it) => (it.kind === 'assistant' && it.markdown?.trim() ? [it.markdown.trim()] : []))[0]
            if (stopped || !summary) {
              pushItem(sid, {
                kind: 'notice',
                text: "Couldn't prepare a handoff. When you're ready, start a fresh chat from the + button.",
              })
            } else {
              // The fresh chat should continue on the SAME engine/model as the one being handed off
              // (matters when it's Codex, not the global last-used), as a one-start override.
              const prev = get().sessions[sid]
              void (async () => {
                await get().startSession(
                  prev
                    ? { engineId: prev.engineId, model: prev.model, effort: prev.effort }
                    : undefined,
                ) // creates + activates the fresh session
                const newId = get().activeId
                if (!newId) return
                const note = `Continuing from a previous chat that was getting long. Here's the handoff:\n\n${summary}`
                // Stage as a real reply (replyStaged) so the composer shows it for review — the user reads
                // what carried over, optionally adds their next instruction, and sends. Nothing silent.
                patchSession(newId, (s) => ({ ...s, draft: note, replyStaged: true }))
              })()
            }
          }
          if (attentionKind) raiseAttention(sid, attentionKind)
          break
        }
        case 'RateLimitUpdate': {
          // Account-level window — attribute it to the EMITTING session's engine (each engine is its own
          // subscription), then store by type (five_hour/weekly), newest wins within that engine. The
          // driver's own stamp wins over the session lookup (authoritative at the source).
          const rlEngine = e.engine ?? get().sessions[sid]?.engineId ?? 'claude'
          set((state) => {
            const windows = e.reconciledWindows ?? {
              ...state.rateLimits[rlEngine],
              [e.info.rateLimitType]: e.info,
            }
            return {
              rateLimits: {
                ...state.rateLimits,
                [rlEngine]: windows,
              },
            }
          })
          // 'auto' billing: a 'rejected' window means the plan limit is hit (the engine guide confirms it
          // lands at the END of the crossing turn, so the NEXT turn is blocked → switch forward). Raise
          // the one-time "continue on your API key?" banner. We re-fetch live billing state rather than
          // trust the mirrored `apiActive` — that only refreshes on settings broadcasts, so after a prior
          // window's fallback EXPIRED in main, a stale `true` here would wrongly suppress the next prompt.
          const resetsAt = e.info.resetsAt
          if (
            !replayingSessions.has(sid) && // a replayed historical 'rejected' isn't live news — don't pop the banner
            engineCapabilities(rlEngine).apiKeyFallback && // only an engine with a Koda-held key to switch forward onto
            get().billingMode === 'auto' &&
            e.info.status === 'rejected' &&
            !get().billingFallbackPrompt &&
            !fallbackPromptedFor.has(resetsAt)
          ) {
            void window.koda
              .getBillingState()
              .then((bs) => {
                set({ billingMode: bs.mode, apiActive: bs.apiActive }) // heal the mirror
                if (
                  bs.mode === 'auto' &&
                  !bs.apiActive &&
                  !get().billingFallbackPrompt &&
                  !fallbackPromptedFor.has(resetsAt)
                )
                  set({ billingFallbackPrompt: { resetsAt } })
              })
              .catch(() => {})
          }
          break
        }
        case 'EngineError': {
          // A turn-level API failure (apiError) or a fatal engine stop becomes the composer error banner —
          // a calm, retryable surface. A recoverable non-fatal notice (broker/gate/preview hiccup, a stdin
          // blip, a reconnect message) stays a quiet transcript footer and leaves the live turn running.
          const turnRejected = e.category === 'turnRejected'
          const attentionKind = terminalAttentionKind(e)
          const banner = attentionKind === 'error'
          // Fatal process loss and an explicit pre-start rejection end the turn. An apiError is followed
          // by its own turn-ending `result`; other non-fatal notices can arrive while work is still live.
          patchSession(sid, (s) => {
            const terminal = e.fatal || turnRejected ? endTurn(s) : s
            return {
              ...terminal,
              // Persist the canonical error AND exact user payload before replaySeq advances past it.
              // Otherwise a renderer reload has neither the transient banner nor an eligible replay tail.
              items: banner ? attachTurnFailureToTranscript(terminal.items, e) : terminal.items,
              errored: e.fatal || turnRejected ? true : s.errored,
              ...(banner ? { error: { message: e.message, fatal: e.fatal } } : {}),
            }
          })
          // A terminal error drops any now-stale prompt so the session cannot die stuck on "Needs your
          // approval". Recoverable mid-turn notices leave the turn live.
          if (e.fatal || turnRejected) get().cancelPending(sid)
          if (attentionKind) {
            // The banner is the report; suppress the abnormal-stop footer from the `result` that follows.
            bannerErrored.add(sid)
            raiseAttention(sid, attentionKind)
          } else {
            pushItem(sid, {
              kind: 'notice',
              text: `⚠ engine notice: ${e.message}`,
              replaySeq: e.replaySeq,
            })
          }
          break
        }
      }
    },

    addPending: (req) => {
      let inserted = false
      set((state) => {
        if (state.pending.some((r) => r.requestId === req.requestId)) return state
        inserted = true
        return { pending: [...state.pending, req] }
      })
      if (inserted) raiseAttention(req.sessionId, 'waiting')
    },

    cancelPending: (sessionId) =>
      set((state) => ({ pending: state.pending.filter((r) => r.sessionId !== sessionId) })),

    // A single request was answered on some head — drop just that prompt. On the head that answered
    // it's already gone (answerApproval removed it optimistically), so this is a no-op there; on any
    // OTHER head it clears a prompt that would otherwise latch the session on "Needs your approval".
    resolvePending: (requestId) =>
      set((state) => ({ pending: state.pending.filter((r) => r.requestId !== requestId) })),

    answerApproval: (requestId, kind, postPlanMode) => {
      const req = get().pending.find((r) => r.requestId === requestId)
      // The prompt's exit animation keeps its buttons mounted/clickable for ~120ms after the answer, so a
      // fast second click (or Allow-then-Deny) could fire a second, conflicting resolve on a safety gate.
      // Once it's gone from `pending` it's already answered — drop the duplicate.
      if (!req) return
      set((state) => ({ pending: state.pending.filter((r) => r.requestId !== requestId) }))
      // Approving a plan mirrors Claude Code: the engine self-exits plan mode into the chosen build
      // tier in the SAME process and starts building — so sync our gate to match (NOT a respawn; the
      // engine already switched). The Plan card offers the tier (Auto / Check first); default to
      // Auto. Push the flip BEFORE releasing the approval so the engine's first post-plan tool
      // call is decided under the new posture, not still-plan.
      if (req?.toolName === 'ExitPlanMode' && kind === 'allow' && req.sessionId) {
        const build = postPlanMode ?? 'auto'
        patchSession(req.sessionId, (s) => (s.approvalMode === 'plan' ? { ...s, approvalMode: build } : s))
        window.koda.setApprovalMode({ sessionId: req.sessionId, mode: build }).catch(console.error)
      }
      window.koda.resolveApproval({ requestId, decision: { kind } }).catch(console.error)
    },

    answerQuestion: (requestId, updatedInput) => {
      // The engine consumes AskUserQuestion answers via the permission response's updatedInput (not a
      // tool_result): resolve with allow-with-edit carrying {questions, answers}. Guard the duplicate
      // resolve like answerApproval (the card locks itself too, but the gate is single-shot).
      if (!get().pending.some((r) => r.requestId === requestId)) return
      set((state) => ({ pending: state.pending.filter((r) => r.requestId !== requestId) }))
      window.koda
        .resolveApproval({ requestId, decision: { kind: 'allow-with-edit', input: updatedInput } })
        .catch(console.error)
    },

    dismissQuestion: (requestId) => {
      // "Reply instead": the user would rather answer in their own words than pick an option. Deny the
      // tool so the engine stops and waits for their next message — the reason steers it not to guess a
      // pick (a plain skip runs the tool with no answer and lets it proceed on its own judgment instead).
      if (!get().pending.some((r) => r.requestId === requestId)) return
      set((state) => ({ pending: state.pending.filter((r) => r.requestId !== requestId) }))
      window.koda
        .resolveApproval({
          requestId,
          decision: {
            kind: 'deny',
            reason:
              'The user chose to reply in their own words instead of picking an option. Do not select an option or assume an answer — stop and wait for their next message, which will answer this.',
          },
        })
        .catch(console.error)
    },

    interrupt: (sessionId) => {
      const s = get().sessions[sessionId]
      if (!s || !s.busy) return
      userInterrupted.add(sessionId) // suppress the interrupted turn's error footer (see TurnComplete)
      window.koda.interruptSession({ sessionId }).catch(console.error)
      // The graceful interrupt aborts the turn but keeps the process alive; clear busy now so the user
      // can immediately type a correction. A late `result`/TurnComplete is idempotent (busy already false).
      patchSession(sessionId, (x) => ({ ...endTurn(x), error: undefined }))
    },

    stopSubagent: (sessionId, taskId) => {
      const s = get().sessions[sessionId]
      const child = s?.items.find((it) => it.kind === 'subagent' && it.taskId === taskId)
      if (!child || child.kind !== 'subagent' || child.status !== 'running' || child.stopRequested) return
      updateSubagent(sessionId, child.toolUseId, { stopRequested: true, lastActivityAt: Date.now() })
      window.koda.stopSubagent({ sessionId, taskId }).catch((err) => {
        console.error(err)
        updateSubagent(sessionId, child.toolUseId, { stopRequested: undefined, lastActivityAt: Date.now() })
      })
    },

    retryLastTurn: (sessionId) => {
      const s = get().sessions[sessionId]
      if (!s || s.busy) return
      const target = latestTurnFailureOf(s.items)?.target
      if (!target) {
        // Nothing sensible to re-send — just clear the banner so the composer is usable again.
        patchSession(sessionId, (x) => ({ ...x, error: undefined }))
        return
      }
      if (target.hadImages && !target.images?.length) {
        // The transcript remembers that photos existed but not their bytes. Re-sending a caption (or
        // the legacy `(image)` sentinel) would silently ask the engine to do different work.
        patchSession(sessionId, (x) => ({
          ...x,
          error: {
            message: "Those images aren't available anymore. Add them again, then resend the turn.",
            fatal: false,
          },
        }))
        return
      }
      const exactAttachmentsComplete =
        !!target.images?.length &&
        (!target.attachments?.length ||
          (target.images.length === target.attachments.length &&
            target.attachments.every((attachment, index) => {
              const exact = target.images?.[index]
              return (
                exact?.mediaType === attachment.mediaType &&
                (attachment.name === undefined || exact.name === attachment.name)
              )
            })))
      if (target.hadAttachments && !exactAttachmentsComplete) {
        // Provenance without the complete ordered payload is display-only. A mixed image/document turn
        // must not retry whichever subset happened to survive and silently change the user's request.
        patchSession(sessionId, (x) => ({
          ...x,
          error: {
            message: "Those attachments aren't available anymore. Add them again, then resend the turn.",
            fatal: false,
          },
        }))
        return
      }
      const images = target.images as ImageDraft[] | undefined
      if (!target.text.trim() && !images?.length) {
        patchSession(sessionId, (x) => ({ ...x, error: undefined }))
        return
      }
      void dispatchTurn(sessionId, {
        sentText: target.text,
        images,
        displayItem: {
          kind: 'user',
          text: target.text,
          ...(target.hadImages ? { hadImages: true } : {}),
          ...(target.hadAttachments ? { hadAttachments: true } : {}),
          ...(target.attachments?.length ? { attachments: target.attachments } : {}),
          ...(target.attachments?.some((attachment) => attachment.name)
            ? {
                files: target.attachments.flatMap((attachment) =>
                  attachment.name ? [attachment.name] : [],
                ),
              }
            : {}),
          ...(images?.length ? { images } : {}),
        },
      })
    },

    startSession: async (posture) => {
      // New sessions start in the default posture (never plan) — picking Plan in the composer
      // reattaches the session in plan mode on its next turn (see setSessionApprovalMode). The engine
      // defaults to the last one the user picked; main owns that durable posture for desktop and phone.
      // A handoff can supply a one-start override so it stays on its source conversation's engine.
      const started = await window.koda.startSession(posture ? { ...posture } : {})
      const { sessionId, cwd } = started
      const engineId = started.engineId ?? posture?.engineId ?? 'claude'
      const model = started.model ?? posture?.model
      const effort = started.effort ?? posture?.effort
      const label = NEW_SESSION_TITLE // placeholder until the first turn names it (titleFromPrompt → nameSession)
      const approvalMode = get().defaultApprovalMode
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            id: sessionId,
            label,
            userNamed: false,
            // Starting a session is activity: it enters the map as live work, and only goes quiet if
            // it is genuinely left alone for days.
            lastActivityAt: Date.now(),
            cwd,
            items: [],
            streaming: '',
            busy: false,
            errored: false,
            draft: '',
            attachments: [],
            live: true,
            attention: false,
            approvalMode,
            engineId,
            model,
            effort,
            spendUsd: 0,
            byModel: {},
          },
        },
        order: [sessionId, ...state.order],
        activeId: sessionId,
      }))
      // Tell the gate this session's posture (no-op if it equals the default, but keeps gate + UI
      // in lockstep). Fire-and-forget.
      window.koda.setApprovalMode({ sessionId, mode: approvalMode }).catch(console.error)
    },

    adoptHeadless: async () => {
      const adopted = await window.koda.adoptHeadlessSessions().catch(() => [])
      let any = false
      for (const s of adopted) {
        any = true
        const existing = get().sessions[s.id]
        const incomingLabel = originSafeAdoptedLabel(s.label, s.fromRemote, s.userNamed)
        if (existing) {
          // A reopened window hydrates this same id as a cold transcript before main transfers the
          // still-running engine back to it. The persisted replay cursor lets the normal reducer apply
          // only the exact headless tail—no text-based guessing when the user says "continue" twice.
          patchSession(s.id, (current) => ({
            ...current,
            label:
              originSafeAdoptedLabel(
                current.label,
                s.fromRemote,
                current.userNamed || s.userNamed,
              ) ?? current.label,
            cwd: s.cwd,
            streaming: '',
            busy: s.working ?? current.busy,
            live: true,
            approvalMode: s.approvalMode,
            engineId: s.engineId,
            model: s.model,
            effort: s.effort,
            // Main now reports origin explicitly. `undefined` keeps a phone flag across a mixed-version
            // development reload; an authoritative false clears any stale renderer-only inference.
            fromRemote: s.fromRemote === undefined ? current.fromRemote : s.fromRemote || undefined,
          }))
          const tail = s.events.filter(
            (entry) => entry.replaySeq === undefined || entry.replaySeq > (existing.replaySeq ?? 0),
          )
          replayingSessions.add(s.id)
          suppressStartNotice.add(s.id)
          try {
            for (const entry of tail) {
              if (entry.type === 'RemoteUserTurn')
                get().applyRemoteUserTurn(
                  s.id,
                  entry.text,
                  entry.replaySeq,
                  true,
                  entry.hadImages,
                  entry.images,
                  entry.clientTurnId,
                  entry.hadAttachments,
                  entry.attachments,
                )
              else get().applyEngineEvent(entry)
            }
          } finally {
            replayingSessions.delete(s.id)
            suppressStartNotice.delete(s.id)
          }
          const activeChildren = new Set(s.activeSubagentToolUseIds ?? [])
          const activeWorkflows = new Map(
            (s.activeWorkflows ?? []).map((workflow) => [workflow.runId, new Set(workflow.runningAgentIds)]),
          )
          patchSession(s.id, (current) => {
            const items = settleRestoredTranscriptItems(
              current.items,
              activeChildren,
              activeWorkflows,
            ) as Entry[]
            const turnFailure = latestTurnFailureOf(items)
            return {
              ...current,
              items,
              busy: s.working ?? current.busy,
              replaySeq: Math.max(
                current.replaySeq ?? 0,
                ...s.events.map((entry) => entry.replaySeq ?? 0),
              ),
              errored: !!turnFailure?.error.fatal || turnFailure?.error.category === 'turnRejected',
              ...(turnFailure
                ? { error: { message: turnFailure.error.message, fatal: turnFailure.error.fatal } }
                : { error: undefined }),
            }
          })
          if (s.capabilities)
            get().applyEngineEvent({
              type: 'SessionCapabilitiesUpdated',
              sessionId: s.id,
              snapshot: s.capabilities,
            })
          for (const receipt of s.stageReceipts ?? []) get().applyStageReceipt(receipt, { catchup: true })
          repairAdoptedTitle(s.id, incomingLabel, s.userNamed)
          continue
        }
        // Create the tab first so the replay + subsequent live events have a session to land in. It's
        // `live: true` — the engine is already running on main; a Mac turn sends straight through (no
        // reattach). This path also reconstructs a desktop-owned session after a renderer reload, so
        // main's explicit origin bit—not the fact that this adoption API returned it—owns the fallback
        // label and phone marker. approvalMode mirrors the gate's ACTUAL posture for this session.
        set((state) => ({
          sessions: {
            ...state.sessions,
            [s.id]: {
              id: s.id,
              // `fromRemote` was added after adoption shipped. An older/mixed-version main omits it,
              // so only an explicit desktop-origin `false` may select the desktop fallback.
              label:
                incomingLabel ||
                (s.fromRemote === false ? NEW_SESSION_TITLE : PHONE_SESSION_TITLE),
              userNamed: s.userNamed ?? false,
              // Adoption is the moment this renderer starts observing the live session, so it enters
              // the map as active work instead of sitting outside the settling rule indefinitely.
              lastActivityAt: Date.now(),
              cwd: s.cwd,
              items: [],
              streaming: '',
              busy: false,
              errored: false,
              draft: '',
              attachments: [],
              live: true,
              attention: false,
              approvalMode: s.approvalMode,
              engineId: s.engineId,
              model: s.model,
              effort: s.effort,
              spendUsd: 0,
              byModel: {},
              fromRemote: s.fromRemote || undefined,
            },
          },
          order: [s.id, ...state.order],
        }))
        // Replay the buffered history through the normal reducer. Guarded so replaying old turns can't
        // fire native "finished" pings or thrash git; the SessionStarted notice is swallowed too (this
        // is restored history, not a fresh start).
        replayingSessions.add(s.id)
        suppressStartNotice.add(s.id)
        try {
          for (const entry of s.events) {
            if (entry.type === 'RemoteUserTurn')
              get().applyRemoteUserTurn(
                s.id,
                entry.text,
                entry.replaySeq,
                true,
                entry.hadImages,
                entry.images,
                entry.clientTurnId,
                entry.hadAttachments,
                entry.attachments,
              )
            else get().applyEngineEvent(entry)
          }
        } finally {
          replayingSessions.delete(s.id)
          suppressStartNotice.delete(s.id)
        }
        // Replaying describes the history; main's ownership snapshot is authoritative for what remains
        // live at the handoff boundary (including a child whose Start event predates this window).
        const activeChildren = new Set(s.activeSubagentToolUseIds ?? [])
        const activeWorkflows = new Map(
          (s.activeWorkflows ?? []).map((workflow) => [workflow.runId, new Set(workflow.runningAgentIds)]),
        )
        patchSession(s.id, (current) => ({
          ...current,
          items: settleRestoredTranscriptItems(current.items, activeChildren, activeWorkflows) as Entry[],
          busy: s.working ?? current.busy,
          replaySeq: Math.max(
            current.replaySeq ?? 0,
            ...s.events.map((entry) => entry.replaySeq ?? 0),
          ),
        }))
        if (s.capabilities)
          get().applyEngineEvent({
            type: 'SessionCapabilitiesUpdated',
            sessionId: s.id,
            snapshot: s.capabilities,
          })
        for (const receipt of s.stageReceipts ?? []) get().applyStageReceipt(receipt, { catchup: true })
        // A settled label from main wins verbatim. Otherwise a first replayed prompt replaces the
        // phone placeholder immediately and the configured writer refines it in the background.
        repairAdoptedTitle(s.id, incomingLabel, s.userNamed)
      }
      // One git refresh after replay settles (the per-turn refreshes were suppressed during replay).
      if (any) void get().refreshGitStatus()
      // Fill a blank window: if nothing's selected (e.g. a project whose only sessions are phone-started),
      // focus the newest. Never yanks focus from a session the user is already looking at.
      if (any && !get().activeId) set({ activeId: get().order[0] })
    },

    bumpScratch: () => set((s) => ({ scratchTick: s.scratchTick + 1 })),

    bumpFilesRev: () => set((s) => ({ filesRev: s.filesRev + 1 })),

    applyRemoteUserTurn: (
      sessionId,
      text,
      replaySeq,
      append = true,
      hadImages,
      images,
      clientTurnId,
      hadAttachments,
      attachments,
    ) => {
      const s = get().sessions[sessionId]
      if (!s) return // not owned by this window — nothing to append or stamp
      // Every live turn is activity, including an optimistic desktop row receiving its replay identity
      // and a durable phone retry reconciling into the same logical bubble. Replay is history, not work.
      if (!replayingSessions.has(sessionId)) markActivity(sessionId)
      const matchingLogicalIndex = clientTurnId
        ? s.items.findIndex((item) => item.kind === 'user' && item.clientTurnId === clientTurnId)
        : -1
      if (!append) {
        // The desktop already rendered this turn optimistically. Main assigns the replay identity before
        // the engine receives it, so stamp the newest unstamped turn row rather than appending a copy.
        patchSession(sessionId, (current) => {
          const unstampedIndex = current.items.findLastIndex(
            (item) =>
              (item.kind === 'user' || item.kind === 'canvas') && item.replaySeq === undefined,
          )
          const replayIndex = replaySeq === undefined
            ? -1
            : current.items.findIndex(
                (item) => item.kind === 'user' && item.replaySeq === replaySeq,
              )
          const index = clientTurnId
            ? current.items.findIndex(
                (item) => item.kind === 'user' && item.clientTurnId === clientTurnId,
              )
            : replayIndex >= 0
              ? replayIndex
              : unstampedIndex
          if (index === -1) return current
          const items = current.items.slice()
          const optimistic = items[index]
          if (optimistic.kind === 'user') {
            const superseded = clientTurnId ? supersedeTurnFailure(optimistic) : optimistic
            const {
              images: _oldImages,
              attachments: _oldAttachments,
              files: _oldFiles,
              ...stable
            } = superseded
            items[index] = {
              ...(clientTurnId ? stable : optimistic),
              replaySeq,
              ...(clientTurnId ? { clientTurnId } : {}),
              ...(hadImages !== undefined ? { hadImages } : {}),
              ...(hadAttachments !== undefined ? { hadAttachments } : {}),
              ...(attachments?.length ? { attachments } : {}),
              ...(attachments?.some((attachment) => attachment.name)
                ? {
                    files: attachments.flatMap((attachment) =>
                      attachment.name ? [attachment.name] : [],
                    ),
                  }
                : {}),
              ...(images?.length ? { images } : {}),
            }
            // Keep legacy optimistic payload fields when this is merely the first replay stamp. A stable
            // logical retry replaces them with the latest attempt's exact/provenance material above.
          } else items[index] = { ...optimistic, replaySeq }
          return {
            ...current,
            ...(clientTurnId ? { error: undefined, errored: false } : {}),
            items,
            replaySeq: replaySeq === undefined ? current.replaySeq : Math.max(current.replaySeq ?? 0, replaySeq),
          }
        })
        return
      }
      if (matchingLogicalIndex >= 0) {
        // A fresh engine attempt for a durable failure emits a new replay boundary but belongs to the
        // same phone bubble. Reconcile metadata in place; never append a second owner-window row.
        patchSession(sessionId, (current) => ({
          ...current,
          error: undefined,
          errored: false,
          replaySeq:
            replaySeq === undefined
              ? current.replaySeq
              : Math.max(current.replaySeq ?? 0, replaySeq),
          items: current.items.map((item, index) => {
            if (index !== matchingLogicalIndex || item.kind !== 'user') return item
            const superseded = supersedeTurnFailure(item)
            const {
              images: _oldImages,
              attachments: _oldAttachments,
              files: _oldFiles,
              ...stable
            } = superseded
            return {
              ...stable,
              text: text || (hadImages || images?.length ? '(image)' : ''),
              ...(replaySeq !== undefined ? { replaySeq } : {}),
              ...(hadImages !== undefined ? { hadImages } : {}),
              ...(hadAttachments !== undefined ? { hadAttachments } : {}),
              ...(attachments?.length ? { attachments } : {}),
              ...(attachments?.some((attachment) => attachment.name)
                ? { files: attachments.flatMap((attachment) => attachment.name ? [attachment.name] : []) }
                : {}),
              ...(images?.length ? { images } : {}),
            }
          }),
        }))
        return
      }
      // This is the session's first real prompt if nothing before it was one (an image-only turn shows
      // as "(image)" and never names the tab). Decide BEFORE appending so the new turn isn't counted.
      const hadPrompt = s.items.some(
        (it) => it.kind === 'user' && isSessionNamingPrompt(it.text),
      )
      pushItem(sessionId, {
        kind: 'user',
        text: text || (hadImages || images?.length ? '(image)' : ''),
        ...(clientTurnId ? { clientTurnId } : {}),
        ...(hadImages !== undefined ? { hadImages } : {}),
        ...(hadAttachments !== undefined ? { hadAttachments } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(attachments?.some((attachment) => attachment.name)
          ? { files: attachments.flatMap((attachment) => attachment.name ? [attachment.name] : []) }
          : {}),
        ...(images?.length ? { images } : {}),
        replaySeq,
      })
      if (replaySeq !== undefined)
        patchSession(sessionId, (current) => ({
          ...current,
          replaySeq: Math.max(current.replaySeq ?? 0, replaySeq),
        }))
      // Mirror adoptHeadless's first-turn naming: the session was adopted empty (before any turn), so it
      // never got titled. Instant first-words label, then the fire-and-forget engine naming turn.
      // Replay has its own settled-label/substance naming pass after the full history is reduced, and
      // adoption already stamps activity at the handoff. Keep this live-only side effect out of catch-up.
      if (!replayingSessions.has(sessionId)) {
        if (!s.userNamed && !hadPrompt && isSessionNamingPrompt(text)) {
          patchSession(sessionId, (ss) => ({ ...ss, label: titleFromPrompt(text) }))
          nameSession(sessionId, 'initial', text)
        }
      }
    },

    archiveSession: (id) =>
      queueArchiveMove(async () => {
        const s = get().sessions[id]
        if (!s) return
        // The archive index couldn't be read this run (archiveLoadFailed) — archiving is a two-writer
        // move (out of `sessions`, into `archived`) backed by ONE persisted index; writing half of that
        // (the session leaves the hot list) while the other half (its new archived entry) can't be saved
        // would drop the chat from both the hot store and the index, with its transcript body orphaned on
        // disk. Refuse outright rather than half-complete it — the chat stays exactly where it is, visible.
        if (get().archiveLoadFailed) {
          console.error(
            `archive blocked for session ${id} — this project's archive index failed to load this run; ` +
              'archiving is disabled until the project is reopened',
          )
          return
        }
        // The transcript body goes to its own cold file; the metadata index stays light. Baked preview +
        // maxItemId let the list render and boot advance the id counter WITHOUT re-loading bodies.
        const persisted = persistedSessionFromState(s)
        const items = persisted.items
        // Await and require an acknowledgement before recording metadata or removing the hot session.
        // A metadata row with no body is not an archive; it is a conversation whose only transcript was
        // just thrown away.
        try {
          if ((await window.koda.writeArchivedBody?.(id, items)) !== true) {
            console.error(`archive aborted for session ${id} — its conversation body refused the write`)
            if (!get().archiveWriteFailed) set({ archiveWriteFailed: true })
            return
          }
        } catch (err) {
          console.error(err)
          if (!get().archiveWriteFailed) set({ archiveWriteFailed: true })
          return
        }
        // Snapshot the durable metadata (same fields the persist blob keeps, minus `items`) + an archive
        // stamp, so it restores byte-identical and reattaches via --resume like a boot-restored session.
        const { items: _items, ...durable } = persisted
        const meta: ArchivedSessionMeta = {
          ...durable,
          archivedAt: Date.now(),
          preview: buildArchivePreview(items),
          maxItemId: maxArchivedItemId(items),
        }
        // The move's other half, and the one that used to go out unacknowledged. The session leaves the
        // hot store only once the index is on disk holding it — otherwise the hot save (which never fails
        // the same way) would write the removal and the chat would be gone from both, its body orphaned.
        // The committed list below is this exact array, so memory and disk can't disagree about the move.
        // It still composes with a second move asked for at the same time: `queueArchiveMove` holds that
        // one until this one has committed, so the base read here already carries whatever landed first.
        // A stale hot-store row may legitimately retry after an interrupted save/reload. Replace its
        // earlier metadata instead of accumulating several rows for the same conversation.
        const nextArchived = [meta, ...get().archived.filter((row) => row.id !== id)]
        if (!(await persistArchived(nextArchived))) {
          console.error(`archive aborted for session ${id} — the archive index refused the write`)
          return
        }
        // Only now is the move real, so only now does the live agent go. A refused archive above leaves the
        // session running, which is the whole point of asking first.
        window.koda.disposeSession({ sessionId: id }).catch(console.error)
        set((state) => {
          // The session went away across the awaits (a phone close). The index on disk already holds
          // `nextArchived`, so commit that half regardless — same rule restoreArchived's setter follows.
          if (!state.sessions[id]) {
            const completionBySession = { ...state.completionBySession }
            delete completionBySession[id]
            return { archived: nextArchived, completionBySession }
          }
          const rest = { ...state.sessions }
          delete rest[id]
          const order = state.order.filter((sid) => sid !== id)
          const activeId =
            state.activeId === id ? (order.length ? order[0] : null) : state.activeId
          // Drop the session's editor workbench too — its tabs die with it.
          const editors = { ...state.editors }
          delete editors[id]
          const completionBySession = { ...state.completionBySession }
          delete completionBySession[id]
          return {
            sessions: rest,
            order,
            activeId,
            editors,
            pending: state.pending.filter((r) => r.sessionId !== id),
            archived: nextArchived,
            completionBySession,
          }
        })
      }),

    // Reopening runs the same move as archiving, in the other direction: the row leaves the index and a
    // session joins the hot store. Same rule, then — the index write is acknowledged first, and a refusal
    // leaves the archived chat listed and its body on disk instead of half-reopening it. The chat itself
    // is never at risk here (its transcript is in hand before anything is removed), but committing on an
    // unacknowledged write would leave a row on disk whose body this function has already deleted, which
    // reads to the user as an archived chat that reopens to nothing.
    restoreArchived: (id) =>
      queueArchiveMove(async () => {
        const a = get().archived.find((x) => x.id === id)
        if (!a) return
        // Already open (shouldn't happen) — just focus it, drop the stale archive entry, and let its now
        // unused body file go.
        if (get().sessions[id]) {
          const withoutRow = get().archived.filter((x) => x.id !== id)
          if (!(await persistArchived(withoutRow))) {
            set({ activeId: id }) // focusing it is still right and costs nothing
            return
          }
          set({ activeId: id, archived: withoutRow })
          window.koda.deleteArchivedBody?.(id).catch(console.error)
          return
        }
        // The transcript body lives in its own cold file — fetch it, then rehydrate. `null` = the read
        // FAILED (vs a genuinely empty transcript): keep the archive intact and bail rather than restore an
        // empty session and delete the body we couldn't read. Bailing used to be the end of it, and the
        // Settings panel closes on the click either way, so the user watched their chat not reopen with
        // nothing anywhere saying why. Raise it to the banner instead.
        const raw = await window.koda.loadArchivedBody?.(id)
        if (raw == null) {
          console.error(`reopen aborted for archived session ${id} — its saved conversation couldn't be read`)
          if (!get().archiveRestoreFailed) set({ archiveRestoreFailed: true })
          return
        }
        const items = (raw as Entry[]).map(settleRestoredTranscriptItem)
        // Main may have folded a durable replay tail into the cold body after the archive metadata was
        // snapshotted. Carry the strongest cursor visible in the restored transcript before deleting
        // that sidecar, or the next attached event can reuse an existing identity and disappear.
        const restoredReplaySeq = Math.max(a.replaySeq ?? 0, maxTranscriptReplaySeq(items)) || undefined
        // Drop the row from the index BEFORE the session joins the hot store, and only if that lands. The
        // body file is deleted at the end, so a refusal here has to stop everything: otherwise the row
        // survives on disk pointing at a transcript that no longer exists.
        const nextArchived = get().archived.filter((x) => x.id !== id)
        if (!(await persistArchived(nextArchived))) {
          console.error(`reopen aborted for archived session ${id} — the archive index refused the write`)
          if (!get().archiveRestoreFailed) set({ archiveRestoreFailed: true })
          return
        }
        set((state) => {
          // Re-check under the setter: a second restore may have raced us across the awaits. The index on
          // disk already holds `nextArchived`, so every branch out of here commits that same list — bailing
          // with `{}` would leave the row alive in memory and gone from the file, which is the disagreement
          // this whole change exists to prevent.
          if (state.sessions[id]) return { archived: nextArchived }
          // Bump the entry counter past the restored items so new entries can't collide with them (the
          // boot hydrate only counted live sessions; an archive can hold higher ids than the current max).
          for (const it of items) {
            if (it.id > entryId) entryId = it.id
            if (it.kind === 'subagent')
              for (const c of it.children) if (c.id > entryId) entryId = c.id
          }
          // Reopening is fresh activity, but every other durable field follows the same conversion as
          // boot hydration. Combining the cold metadata with its body here prevents archive and hot
          // persistence from growing competing field lists again.
          const session = sessionStateFromPersisted(
            { ...a, items },
            state.defaultApprovalMode,
            { freshActivity: true, replaySeq: restoredReplaySeq },
          )
          return {
            sessions: { ...state.sessions, [id]: session },
            order: [id, ...state.order],
            activeId: id,
            archived: nextArchived,
          }
        })
        // Body consumed back into the live session — its cold file is no longer needed.
        window.koda.deleteArchivedBody?.(id).catch(console.error)
        // A reopen that worked takes the notice down, the same way a write that lands clears the other.
        if (get().archiveRestoreFailed) set({ archiveRestoreFailed: false })
      }),

    // The genuinely destructive one, so the order matters most here: the index has to record the removal
    // before the transcript file is unlinked. Committing on an unacknowledged write would delete the only
    // copy of the transcript and leave its row in the index, so the chat the user deleted would come back
    // on the next launch and open to nothing.
    deleteArchived: (id) =>
      queueArchiveMove(async () => {
        const nextArchived = get().archived.filter((x) => x.id !== id)
        if (!(await persistArchived(nextArchived))) {
          console.error(`delete aborted for archived session ${id} — the archive index refused the write`)
          return
        }
        set({ archived: nextArchived })
        window.koda.deleteArchivedBody?.(id).catch(console.error)
      }),

    send: async () => {
      const { activeId, sessions } = get()
      const active = activeId ? sessions[activeId] : null
      if (!active || active.busy) return
      const text = active.draft
      // Images travel inline as engine content blocks; document files (csv/pdf) travel as a saved
      // `.koda/scratch/` path only — the engine reads files natively, and a path survives the turn.
      const images = active.attachments.filter((a) => a.mediaType.startsWith('image/'))
      const files = active.attachments.filter((a) => !a.mediaType.startsWith('image/'))
      if (!text.trim() && active.attachments.length === 0) return // nothing to send
      const id = active.id
      // Same synchronous double-send guard dispatchTurn applies, re-checked here so we don't consume
      // (clear) the composer for a dispatch that would early-return on a racing reattach.
      if ((!active.live && reattaching.has(id)) || sending.has(id)) return
      // Document mention resolution and scratch persistence both await IPC before dispatchTurn can set
      // `busy`. Claim this exact composer snapshot now so a second click cannot send it twice. The
      // composer itself remains editable; only the captured text/attachments are consumed below, so
      // typing the next message during preflight is never erased by this continuation.
      sending.add(id)
      try {
        // Ambient open-file context: tell the agent which file the user is looking at — a doc OR a code
        // file (a diff counts; a preview doesn't) — so "shorten the intro" / "fix this" work without an
        // explicit selection. The transcript shows the raw text; only the engine sees the hint, and only
        // when the user actually typed something. The composer shows the same file as a visible cue.
        const ed = activeEditor(get())
      // Test for what qualifies, not for the one kind that doesn't: `kind` is optional (undefined means
      // a file), so excluding only 'preview' let the `terminal` and `changes` stage tabs through and
      // told the engine it was looking at a file called ` terminal`.
        const activeFile = ed.surfaces.find(
        (s) => s.path === ed.activeSurfaceId && (s.kind ?? 'file') === 'file',
      )
        const noun = activeFile && isMarkdown(activeFile.path) ? 'document' : 'file'
      // Engine-facing text restores the full path behind any pretty `@`-mention; the transcript keeps
      // the clean name (displayItem uses `text` below).
        const engineText = await resolveDocMentions(text)
        const docText =
        activeFile && text.trim()
          ? `${engineText}\n\n(I'm currently looking at the ${noun} \`${activeFile.path}\` in Koda — if this is about it, work with that file.)`
          : engineText
      // Persist the attached images to the project's scratch folder so they outlive the conversation and
      // the agent can re-read them by path later (they're ALSO sent inline below for the immediate turn).
      // Best-effort: a save failure (no project open, fs error) just means no durable copy — never blocks
      // the turn. The saved paths are appended to the ENGINE text only (the transcript shows raw text).
        let sentText = docText
        if (images.length) {
        const saved = await Promise.all(
          images.map(async (img) => {
            // A Recent images attachment already has a durable scratch copy. Reuse it instead of
            // writing the same bytes under a new timestamped name on every re-send.
            if (img.scratchPath) return img.scratchPath
            try {
              return (await window.koda.saveScratchImage({ mediaType: img.mediaType, dataBase64: img.dataBase64 })).path
            } catch {
              return null
            }
          }),
        )
        const paths = saved.filter((p): p is string => p !== null)
        if (paths.length) {
          const one = paths.length === 1
          const list = paths.map((p) => `\`${p}\``).join(', ')
          sentText = `${sentText}\n\n(${one ? 'This image is' : 'These images are'} saved in the project at ${list} — read that path if you need to refer back to ${one ? 'it' : 'them'} later.)`
        }
        // Durable copies just landed — nudge the Recent images strip to refetch the folder.
        set((s) => ({ scratchTick: s.scratchTick + 1 }))
        }
      // Document attachments: the scratch path IS the delivery (no inline copy), so unlike images a
      // failed save is surfaced to the agent by omission from the list below. Staged in scratch, the
      // agent is told to promote anything load-bearing out of it (scratch prunes by age).
        if (files.length) {
        const saved = await Promise.all(
          files.map(async (f) => {
            try {
              const { path } = await window.koda.saveScratchImage({
                mediaType: f.mediaType,
                dataBase64: f.dataBase64,
                fileName: f.name,
              })
              return path
            } catch {
              return null
            }
          }),
        )
        const paths = saved.filter((p): p is string => p !== null)
        if (paths.length) sentText = `${sentText}\n\n${attachedFilesNote(paths)}`
        }
      // Re-check after every preflight await. A phone turn or another surface may have claimed the engine
      // meanwhile; in that case the original composer snapshot stays untouched for a later send.
        const ready = get().sessions[id]
        if (!ready || ready.busy) return
        const dispatch = dispatchTurn(id, {
        sentText,
        images,
        displayItem: {
          kind: 'user',
          text,
          images: images.length ? images : undefined,
          files: files.length ? files.map((f) => f.name ?? 'file') : undefined,
        },
        nameFromText: text,
        })
      // `dispatchTurn` executes synchronously through its optimistic busy/transcript claim before its
      // first await. Consume only the snapshot this call sent: a new draft or attachment added while
      // mention/scratch IPC was pending belongs to the next message and stays in the composer.
        const sentAttachments = new Set(active.attachments)
        patchSession(id, (s) => ({
        ...s,
        draft: s.draft === text ? '' : s.draft,
        attachments: s.attachments.filter((attachment) => !sentAttachments.has(attachment)),
        replyStaged: s.draft === text ? false : s.replyStaged,
        }))
        await dispatch
      } finally {
        sending.delete(id)
      }
    },

    sendCanvasEdit: async ({ path, selection, instruction }) => {
      const { activeId, sessions } = get()
      const id = activeId
      if (!id || !sessions[id] || sessions[id].busy) return
      const instr = instruction.trim()
      if (!instr) return
      const sel = selection.trim()
      // The selected passage is the edit anchor: quoted from the RENDERED doc (Crepe normalises
      // markdown, so it may not be a byte-exact file substring) — the agent reads the file, locates the
      // matching text, and edits in place. The auto-save (renderer-side, before this call) guarantees
      // the file already reflects what the user sees.
      const sentText = sel
        ? `I'm editing the document \`${path}\` in Koda's doc view, and I've selected this passage:\n\n"""\n${sel}\n"""\n\nInstruction: ${instr}\n\nEdit the file to apply this to the selected passage only — make a surgical edit to that passage and leave the rest of the document unchanged. The passage is quoted from the rendered document; find the matching text in the file and edit it in place.`
        : `I'm editing the document \`${path}\` in Koda's doc view. Instruction: ${instr}\n\nEdit the document to apply this.`
      await dispatchTurn(id, {
        sentText,
        displayItem: {
          kind: 'canvas',
          docTitle: basename(path),
          instruction: instr,
          // This is the one send path that puts real document words in a turn (the passage is quoted
          // verbatim above), so the chip says how many went. Only the count is kept: the passage
          // itself never enters the transcript, which is written to disk and sent to the phone.
          selectedWords: sel ? countWords(sel) : undefined,
        },
      })
    },

    sendFaceTurn: async ({ text }) => {
      const msg = text.trim()
      if (!msg) return null
      const { faceDir, miniApps } = get()
      const app = faceDir ? miniApps.find((a) => a.dir === faceDir) : undefined
      if (!app) return null
      // Every face turn lands in the APP'S OWN summon thread (mini-apps-plan's summon-thread model),
      // remembered per app dir — never in whichever conversation happens to be active, which dropped an
      // app question into the middle of an unrelated chat (dogfood 07-30). A thread whose session is
      // gone just earns the app a fresh one: files are the durable memory, sessions are disposable.
      // With day threads on (the default), that thread is scoped to the local day and named for it.
      const daySessions = await window.koda
        .getSettings()
        .then((s) => s.appDaySessions)
        .catch(() => true) // a failed read must not silently revert to forever-threads
      const now = new Date()
      const day = daySessions ? faceDayKey(now) : null
      const dayLabel = daySessions ? faceDayLabel(app.name, now) : null
      let id = appSummonThread(localStorage, app.dir, day)
      if (id && !get().sessions[id]) id = null
      // Cross-head adoption: the phone keeps its OWN thread map, so a day thread it opened this
      // morning is invisible here except by its (deterministic) name. Join it instead of opening a
      // second thread for the same day. A window only ever holds its own project's sessions, so the
      // label is already project-scoped, and the app name inside it scopes it to this app.
      if (!id && dayLabel) {
        const { sessions, order } = get()
        id = order.find((sid) => sessions[sid]?.label === dayLabel) ?? null
      }
      if (id && get().sessions[id].busy) return null // the app's thread is mid-turn — summon says try again
      if (!id) {
        await get().startSession() // creates + activates the fresh thread
        id = get().activeId
        if (!id) return null
        // userNamed, so the first-prompt auto-titler can't rename the day to whatever got logged first.
        if (dayLabel) get().renameSession(id, dayLabel)
      } else {
        get().selectSession(id) // front the thread so the workshop flip shows the turn in progress
      }
      rememberAppSummonThread(localStorage, app.dir, id, day)
      const rel =
        app.dir.startsWith(app.projectPath + '/') ? app.dir.slice(app.projectPath.length + 1) : app.dir
      // Grounding + RUN-mode framing live in the shared faceTurnText (see its doc comment) — the
      // turn says WHICH app the user is inside, that the app exists (operate, don't shape), and that
      // the closing message renders inside the app. The transcript shows a compact ✦-prefixed line.
      await dispatchTurn(id, {
        sentText: faceTurnText(app.name, rel, msg),
        displayItem: { kind: 'user', text: `✦ ${app.name} — ${msg}` },
      })
      return id
    },

    sendGuardrailAuthoring: async ({ kind, description }) => {
      const { activeId, sessions } = get()
      const id = activeId
      if (!id || !sessions[id] || sessions[id].busy) return false
      const desc = description.trim()
      if (!desc) return false
      // Project scope only — the agent writes within its own cwd (`.claude/…` or CLAUDE.md). Authoring
      // into the shared Koda pack (outside cwd) needs the capability surface, deferred (guardrails.md §4.3).
      const dest =
        kind === 'rule'
          ? "the project's CLAUDE.md (create it if it doesn't exist), as a short guidance line"
          : kind === 'skill'
            ? 'a new `.claude/skills/<name>/SKILL.md` (YAML frontmatter with name + description, then the body)'
            : 'a new `.claude/agents/<name>.md` (YAML frontmatter with name + description, then the body)'
      const sentText = `Add a new ${kind} for this project: ${desc}\n\nCreate it as ${dest}. Keep it focused and in the standard format. When done, tell me in one line what you created and where.`
      const visibleKind = kind === 'rule' ? 'core guidance' : kind === 'skill' ? 'playbook' : 'specialist'
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: `New ${visibleKind}: ${desc}` },
      })
      return true
    },

    sendBranchAction: async ({ branch, headBranch }) => {
      const { activeId, sessions } = get()
      const id = activeId
      if (!id || !sessions[id] || sessions[id].busy) return false
      const into = headBranch ?? 'the current branch'
      const sentText =
        `There's a Git branch named "${branch}" with work that isn't in ${into}. ` +
        `Help me deal with it: look at what's on the branch, tell me in plain language what it contains, ` +
        `and recommend whether to bring it into ${into} (merge it) or delete it as a dead end. ` +
        `Do the irreversible step (merge or delete) only after I confirm.`
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: `Help me deal with the "${branch}" branch` },
      })
      return true
    },

    sendBackupAction: async (args) => {
      const { activeId, sessions } = get()
      const id = activeId
      if (!id || !sessions[id] || sessions[id].busy) return false
      const sentText =
        args.kind === 'publish'
          ? `My project's saved versions only exist on this computer — I want them backed up to GitHub. Help me publish this project:\n` +
            `1. Check whether the GitHub CLI (gh) is installed and signed in. If not, help me get set up — I may not have a GitHub account yet, so walk me through creating one if needed.\n` +
            `2. Create a repository for this project (ask me for the name and whether it should be private or public — recommend private).\n` +
            `3. Connect it as the "origin" remote and push all my versions.\n` +
            `4. Give me the link when it's done.\n` +
            `Ask before creating anything on GitHub or uploading.`
          : `I tried to back up my versions from the Versions panel (a git push) and it failed with this error:\n\n${args.error}\n\n` +
            `Figure out what's wrong, explain it in plain language, and fix it so the backup goes through. Ask before doing anything destructive.`
      await dispatchTurn(id, {
        sentText,
        displayItem: {
          kind: 'user',
          text: args.kind === 'publish' ? 'Publish this project to GitHub' : 'Help me fix backing up my versions',
        },
      })
      return true
    },

    sendFinishBranch: async ({ branch, into }) => {
      const { activeId, sessions } = get()
      const id = activeId
      if (!id || !sessions[id] || sessions[id].busy) return false
      const sentText =
        `I'm working on a Git branch named "${branch}" — a side branch of "${into}". Help me finish it: ` +
        `look at what it changes compared to ${into} and tell me in plain language what it adds. ` +
        `If it looks complete, bring it into ${into} (merge) and switch me back to ${into}. ` +
        `If anything looks unfinished or conflicts with ${into}, explain and ask me how to proceed before merging.`
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: `Finish the "${branch}" branch into ${into}` },
      })
      return true
    },

    sendTidySideLines: async ({ names }) => {
      const { activeId, sessions } = get()
      const id = activeId
      if (!id || !sessions[id] || sessions[id].busy || names.length === 0) return false
      const sentText =
        `My project has a pile of side lines left over from earlier work (Git branches and leftover ` +
        `checkouts): ${names.map((n) => `"${n}"`).join(', ')}. Deal with the whole pile for me: for each ` +
        `one, look at what it holds, tell me in plain language whether it's finished work worth keeping, ` +
        `unfinished work I should come back to, or a dead end. Clean up the dead ends and the leftover ` +
        `checkouts, and leave the ones worth keeping alone. Ask me before deleting anything that isn't ` +
        `already saved somewhere else, and finish with a short summary of what you kept and what you cleared.`
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: `Tidy up ${names.length} leftover side lines` },
      })
      return true
    },

    refreshMemoryWeight: async () => {
      try {
        set({ memoryWeight: await window.koda.getMemoryWeight() })
      } catch (err) {
        console.error('memory weight fetch failed', err)
      }
    },

    sendMemoryTidy: async () => {
      // Tidy runs in its OWN fresh session so it never interrupts (or gets tangled up in) whatever the
      // active session is mid-way through. startSession sets the new session active; dispatch into that.
      await get().startSession()
      const id = get().activeId
      if (!id) return false
      // The recipe itself lives in the memory skill (the pack's content, versioned with the app);
      // this turn just points the agent at the job in the user's terms.
      const sentText =
        `This project's memory in .koda/memory/ has grown heavy. Its navigation notes (MEMORY.md and ` +
        `active-context.md) are now big enough to make relevant context harder to retrieve reliably. ` +
        `Tidy the memory following the memory skill's tidy recipe: distill active-context.md back to a short ` +
        `current-state page, move narrative detail into the right topic notes, archive the old tail of any ` +
        `log-style notes, fold notes about replaced approaches into the note that superseded them (keep the ` +
        `lesson, delete the leftover), and keep every MEMORY.md index line in sync with its note — a good tidy ` +
        `leaves the index with fewer lines, not just shorter ones. When you're done, tell me in a line or two ` +
        `what you trimmed.`
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: "Tidy this project's memory" },
        nameFromText: "Tidy this project's memory",
      })
      return true
    },

    continueInFreshChat: () => {
      const id = get().activeId
      const active = id ? get().sessions[id] : undefined
      if (!id || !active || active.busy) return
      // Mark this session so its next TurnComplete carries the handoff into a fresh chat, then ask the
      // agent for the summary. A subtle notice (not a user bubble) shows what's happening in the old chat.
      handoffPending.add(id)
      void dispatchTurn(id, {
        sentText: HANDOFF_PROMPT,
        displayItem: { kind: 'notice', text: 'Preparing a handoff to a fresh chat…' },
      })
    },

    // Select a session AND clear its attention (the user has now seen it). Guard against a session
    // closed between an event and the action that targets it (notification onclick, ⌘1–9, card).
    selectSession: (id) => {
      if (!get().sessions[id]) return
      set({ activeId: id })
      patchSession(id, (s) => (s.attention ? { ...s, attention: false } : s))
    },

    askAside: (sessionId, question) => {
      const q = question.trim()
      if (!q) return
      const asideId = crypto.randomUUID()
      // Open the overlay immediately (streaming, empty) and clear the composer; main streams the answer
      // back over onAsideEvent. A new ask replaces any prior aside (cancel the old fork first).
      const prev = get().sessions[sessionId]?.aside
      if (prev && prev.status === 'streaming') {
        window.koda.cancelAside({ sessionId, asideId: prev.id }).catch(console.error)
      }
      patchSession(sessionId, (s) => ({ ...s, draft: '', aside: { id: asideId, question: q, answer: '', status: 'streaming' } }))
      // Overlay shows the pretty `q`; the engine gets `@`-mentions expanded to full paths.
      resolveDocMentions(q)
        .then((eq) => window.koda.askAside({ sessionId, asideId, question: eq }))
        .catch((err) => {
          console.error(err)
          patchSession(sessionId, (s) =>
            s.aside?.id === asideId ? { ...s, aside: { ...s.aside, status: 'error', answer: "couldn't ask that" } } : s,
          )
        })
    },

    dismissAside: (sessionId) => {
      const aside = get().sessions[sessionId]?.aside
      if (!aside) return
      if (aside.status === 'streaming') window.koda.cancelAside({ sessionId, asideId: aside.id }).catch(console.error)
      patchSession(sessionId, (s) => ({ ...s, aside: undefined }))
    },

    promoteAside: (sessionId) => {
      const aside = get().sessions[sessionId]?.aside
      if (!aside || !aside.answer.trim()) return
      // Bring the side question AND its answer back into the real chat so the agent has it going forward.
      // Stage it as the composer draft flagged a real reply (replyStaged) so it isn't re-read as another
      // aside while the agent is busy — the user can add extra info, then send. Auto-send only when the
      // session is free and focused (a busy session has no turn slot; it waits in the composer). Re-read
      // busy fresh (not a captured snapshot) so the dispatch decision can't go stale.
      const note = `Bringing this back from a side question.\n\nI asked: ${aside.question}\n\nThe answer was:\n${aside.answer.trim()}`
      get().dismissAside(sessionId)
      patchSession(sessionId, (st) => ({ ...st, draft: note, replyStaged: true }))
      if (sessionId === get().activeId && !get().sessions[sessionId]?.busy) void get().send()
    },

    setDraft: (id, text) =>
      patchSession(id, (s) => ({ ...s, draft: text, replyStaged: text.trim() ? s.replyStaged : false })),
    addAttachments: (id, imgs) =>
      patchSession(id, (s) => {
        const attachments = [...s.attachments]
        for (const img of imgs) {
          if (
            attachments.some(
              (existing) =>
                (img.scratchPath && existing.scratchPath === img.scratchPath) ||
                (existing.mediaType === img.mediaType && existing.dataBase64 === img.dataBase64),
            )
          ) {
            continue
          }
          attachments.push(img)
        }
        return { ...s, attachments }
      }),
    removeAttachment: (id, index) =>
      patchSession(id, (s) => ({ ...s, attachments: s.attachments.filter((_, i) => i !== index) })),
    setAttachNotice: (id, message) => patchSession(id, (s) => ({ ...s, attachNotice: message ?? undefined })),

    setDefaultApprovalMode: (mode) => set({ defaultApprovalMode: mode }),

    setBilling: (mode, apiActive) => set({ billingMode: mode, apiActive }),

    confirmApiFallback: async () => {
      const prompt = get().billingFallbackPrompt
      if (!prompt) return
      // Activate FIRST; only mark this window resolved on success, so an IPC failure leaves the banner up
      // to retry rather than stranding the user (prompted-but-not-active).
      let state
      try {
        state = await window.koda.activateApiFallback({ until: prompt.resetsAt })
      } catch (err) {
        console.error('activate fallback failed', err)
        return
      }
      fallbackPromptedFor.add(prompt.resetsAt)
      set({ billingFallbackPrompt: null, billingMode: state.mode, apiActive: state.apiActive })
      // Switch-forward: mark IDLE live sessions not-live so their NEXT turn reattaches on the API key (the
      // engine can't swap credentials on a -p process; start() disposes the old child on reattach — same
      // as a model/effort switch). Skip busy / pending-approval sessions — dropping one mid-turn would
      // orphan its child or approval (the model-switch guards do the same); they reattach when idle.
      const pendingIds = new Set(get().pending.map((p) => p.sessionId))
      for (const id of get().order) {
        const s = get().sessions[id]
        if (!s?.live) continue
        if (!s.busy && !hasRunningDelegation(s.items) && !pendingIds.has(id))
          patchSession(id, (x) => ({ ...x, live: false }))
        else billingRespawnPending.add(id)
      }
      const active = get().activeId
      if (active)
        pushItem(active, {
          kind: 'notice',
          text: `Plan limit reached — continuing on your API key (resets ${fmtClock(prompt.resetsAt)}). Send your message again.`,
        })
    },

    dismissApiFallback: () => {
      const prompt = get().billingFallbackPrompt
      if (prompt) fallbackPromptedFor.add(prompt.resetsAt)
      set({ billingFallbackPrompt: null })
    },

    setSessionApprovalMode: (id, mode) => {
      const s = get().sessions[id]
      if (!s || mode === s.approvalMode) return
      // `plan` is a real mode, not a gate tier like the other three. On an engine with a native plan
      // mode it is a spawn-time flag (`--permission-mode plan`), so crossing the boundary needs a
      // respawn — and a respawn would kill an in-flight turn or strand a pending approval, hence the
      // guard below.
      const crossesPlan = (mode === 'plan') !== (s.approvalMode === 'plan')
      // Only an engine whose plan mode is a spawn-time flag has to respawn. An engine that carries the
      // mode in each turn's text (Codex) keeps its process, so the cross costs nothing and can happen
      // mid-turn — it lands on the next message. Delegated children still block it on both, matching
      // main's own guard.
      const needsRespawn = crossesPlan && engineCapabilities(s.engineId).planMode === 'native'
      if (
        (needsRespawn && (s.busy || get().pending.some((r) => r.sessionId === id))) ||
        (crossesPlan && hasRunningDelegation(s.items))
      )
        return
      patchSession(id, (x) => ({ ...x, approvalMode: mode }))
      // Tell main in EVERY case (fire-and-forget). ask ↔ acceptEdits ↔ auto is the live gate switch
      // (no-op if the engine isn't live yet — re-pushed on reattach in send()). For a plan crossing the
      // gate value is moot until the respawn, but pushing now broadcasts ApprovalModeChanged so other
      // surfaces (the phone sheet) follow immediately instead of at the next turn's re-push.
      window.koda.setApprovalMode({ sessionId: id, mode }).catch((err) => {
        console.error(err)
        // Main owns the final race check. If a child started before this IPC arrived, restore the
        // optimistic pill/process state unless the user has already made a newer choice.
        patchSession(id, (current) =>
          current.approvalMode === mode
            ? { ...current, approvalMode: s.approvalMode, live: s.live }
            : current,
        )
      })

      if (!needsRespawn) return
      // Cross the plan boundary: mark the session not-live so the next turn reattaches in the new
      // --permission-mode (send() reads approvalMode for planMode). We do NOT dispose here — the old
      // idle child is torn down by main's start() right before the respawn (atomic, no two-children
      // race). A not-yet-live session just spawns in the new mode on first send.
      if (s.live) patchSession(id, (x) => ({ ...x, live: false }))
    },

    setSessionModel: (id, model) => {
      const s = get().sessions[id]
      if (!s || model === s.model) return
      // A respawn would kill an in-flight turn or strand a pending approval — block the switch while
      // either is outstanding (same guard as crossing the plan boundary; --model is also spawn-time).
      if (s.busy || hasRunningDelegation(s.items) || get().pending.some((r) => r.sessionId === id)) return
      patchSession(id, (x) => ({ ...x, model }))
      // Tell main at pick time (fire-and-forget, like setApprovalMode) so a real change broadcasts
      // ModelEffortChanged to the phone and main's map reads fresh — not stale until the next reattach.
      window.koda
        .setModelEffort({ sessionId: id, model, effort: s.effort })
        .then(() => {
          const current = get().sessions[id]
          if (!current || current.engineId !== s.engineId || current.model !== model) return
          // Remember an explicit full id so it's a quick-pick next time (aliases are always offered).
          if (engineCapabilities(s.engineId).customModelIds && model && !isModelAlias(model))
            window.koda.addRecentModel({ model }).catch(console.error)
        })
        .catch((err) => {
          console.error(err)
          patchSession(id, (current) =>
            current.model === model ? { ...current, model: s.model, live: s.live } : current,
          )
        })
      // Drop the live engine so the next turn reattaches with the new --model (send() reads `model`).
      // We don't dispose here — main's start() tears the old idle child down right before the respawn.
      if (s.live) patchSession(id, (x) => ({ ...x, live: false }))
    },

    setSessionEngine: (id, engineId, model) => {
      const s = get().sessions[id]
      if (!s) return
      // Bound to its engine once the conversation started (context lives in the engine process) — the
      // dropdown grays the other engine out, but guard here too. A respawn would also kill an in-flight
      // turn or strand a pending approval, so block while either is outstanding.
      // Gate on a real user/canvas turn, NOT item count: a fresh session already carries the engine's
      // auto "session started" notice, so `items.length > 0` would lock the switch prematurely and the
      // dropdown pick would silently no-op (same signal ModelControl uses for `conversationStarted`).
      if (s.items.some((it) => it.kind === 'user' || it.kind === 'canvas')) return
      if (s.busy || hasRunningDelegation(s.items) || get().pending.some((r) => r.sessionId === id)) return
      if (engineId === s.engineId && model === s.model) return
      // Drop the old engine's ground-truth fields: `activeModel` (what the pill falls back to when no
      // model is picked) and the resume cursor (the abandoned engine's own reattach state) both describe
      // the engine being left. Leaving `activeModel` makes a "Default" pick on the new engine still show
      // the old engine's model in the pill (e.g. switch to Claude Default → pill keeps reading Codex's
      // stale "gpt-5.5"). The new engine re-reports both as it starts.
      patchSession(id, (x) => ({ ...x, engineId, model, activeModel: undefined, resumeCursor: undefined }))
      // Pick-time push (see setSessionModel) — carries engineId so the phone's sheet switches groups too.
      window.koda
        .setModelEffort({ sessionId: id, model, effort: s.effort, engineId })
        .then(() => {
          const current = get().sessions[id]
          if (!current || current.engineId !== engineId || current.model !== model) return
          if (engineCapabilities(engineId).customModelIds && model && !isModelAlias(model))
            window.koda.addRecentModel({ model }).catch(console.error)
        })
        .catch((err) => {
          console.error(err)
          patchSession(id, (current) =>
            current.engineId === engineId && current.model === model
              ? {
                  ...current,
                  engineId: s.engineId,
                  model: s.model,
                  activeModel: s.activeModel,
                  resumeCursor: s.resumeCursor,
                  live: s.live,
                }
              : current,
          )
        })
      // Drop the live engine so the next turn spawns the new engine fresh (send() reads engineId+model).
      // No prior transcript to resume (guarded above), so it's a clean --session-id respawn.
      if (s.live) patchSession(id, (x) => ({ ...x, live: false }))
    },

    setSessionEffort: (id, effort) => {
      const s = get().sessions[id]
      if (!s || effort === s.effort) return
      // Spawn-time like --model: a respawn would kill an in-flight turn or strand a pending approval,
      // so block the switch while either is outstanding.
      if (s.busy || hasRunningDelegation(s.items) || get().pending.some((r) => r.sessionId === id)) return
      patchSession(id, (x) => ({ ...x, effort }))
      // Pick-time push (see setSessionModel) — always the full pair so model doesn't reset to default.
      window.koda
        .setModelEffort({ sessionId: id, model: s.model, effort })
        .catch((err) => {
          console.error(err)
          patchSession(id, (current) =>
            current.effort === effort ? { ...current, effort: s.effort, live: s.live } : current,
          )
        })
      // Drop the live engine so the next turn reattaches with the new --effort (send() reads `effort`).
      if (s.live) patchSession(id, (x) => ({ ...x, live: false }))
    },

    renameSession: (id, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      // The overview was generated to sit under the GENERATED title. Once the user names the thread
      // themselves, a leftover sentence about Koda's reading of it is just noise under their name.
      patchSession(id, (s) => ({ ...s, label: trimmed, userNamed: true, overview: undefined }))
    },

    setProjectPath: (projectPath) => set({ projectPath }),

    setIntakePending: (intakePending) => set({ intakePending }),

    setPendingFaceDir: (pendingFaceDir) => set({ pendingFaceDir }),

    refreshMiniApps: async () => {
      try {
        set({ miniApps: await window.koda.miniAppsList() })
      } catch {
        // the list is a convenience — a failed fetch just means no rail/toggle this round
      }
    },

    openFace: (faceDir) => set({ faceDir, faceView: 'app' }),

    setFaceView: (faceView) => set({ faceView }),

    maybeOfferIntake: async ({ hasSessions }) => {
      const path = get().projectPath
      if (!path || hasSessions || get().intakePending) return
      if (localStorage.getItem(intakeSkipKey(path))) return // dismissed for this project before
      try {
        // Never re-author existing guidelines — only offer when the project has none yet.
        const { hasGuidelines } = await window.koda.hasGuidelines()
        if (hasGuidelines) return
      } catch {
        return // can't tell ⇒ don't offer (fail safe: never risk clobbering)
      }
      // A late guard: a session may have appeared while we awaited (first turn elsewhere).
      if (get().intakePending || Object.keys(get().sessions).length > 0) return
      set({ intakePending: true })
    },

    skipIntake: () => {
      const path = get().projectPath
      if (path) localStorage.setItem(intakeSkipKey(path), '1')
      set({ intakePending: false })
    },

    resetIntake: async () => {
      const path = get().projectPath
      if (!path) return 'no-project'
      localStorage.removeItem(intakeSkipKey(path))
      await get().maybeOfferIntake({ hasSessions: Object.keys(get().sessions).length > 0 })
      return get().intakePending ? 'offered' : 'not-applicable'
    },

    startProjectIntake: async ({ description, notes }) => {
      const desc = description.trim()
      if (!desc) return false
      // A fresh project has no session yet — create the first one, then dispatch intake into it. Keep
      // `intakePending` set until the session exists: if startSession fails, the intake screen stays
      // (it's the only thing on screen) and the caller can retry — don't strand the user on the blank
      // empty-state believing the project was set up.
      try {
        await get().startSession()
      } catch {
        return false
      }
      const id = get().activeId
      if (!id) return false
      set({ intakePending: false }) // session exists now → the screen has already handed off
      const extra = notes.trim() ? `\n\nThings to keep in mind: ${notes.trim()}` : ''
      // Visible-user-turn pattern (like sendGuardrailAuthoring): the composed prompt goes through the
      // session as the user's own turn (shows in the worklog) — the agent's gated Write closes the loop.
      // Engine-neutral: "take a look at what's already here" handles existing folders too. The guide is
      // ONE canonical AGENTS.md with CLAUDE.md symlinked to it — both engines read the same file, so it
      // can never drift per engine (main's healGuidelinesPair backstops the link on later opens).
      // Three jobs woven in: (1) the project guide [Layer-3 state], (2) the shared bounded project card,
      // (3) a just-in-time tool top-up via ensure_tool when the project implies one.
      const sentText = `I'm setting up this project in Koda. Here's what it's about:\n\n"""\n${desc}${extra}\n"""\n\nHelp me get this project set up. First take a quick look at what's already here (there may be nothing yet). Then ask me the two or three questions whose answers would change what you build or how you set it up, and suggest anything I haven't thought of — you've built things like this before; I may not have. Once we've shaped it:\n\n1. Write a short, friendly project guide to \`AGENTS.md\` at the project root — what we're building, who it's for, what success looks like, and any constraints — as concise guidance for you to follow on later turns. Keep it human and in plain language (this is for a non-engineer). Then run \`ln -s AGENTS.md CLAUDE.md\` so every engine reads this same guide.\n2. Load the \`memory\` playbook and create .koda/memory/project-card.md using its project-card contract.\n3. If this project clearly needs a language runtime or tool that isn't set up yet (for example Python for a data project), set it up with your ensure_tool capability — I'll confirm.\n\nWhen you're done, tell me in one line what you set up.`
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: desc },
        nameFromText: desc,
      })
      return true
    },

    setLayout: (layout) => set({ layout }),

    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setVersionsOpen: (open) => set({ versionsOpen: open }),
    openSettingsTo: (section) => set({ settingsSection: section, settingsOpen: true }),
    clearSettingsSection: () => set({ settingsSection: null }),
    setSidebarWidth: (px) => set({ sidebarWidth: clampLayout({ sidebarWidth: px }).sidebarWidth }),
    setSessionsFrac: (frac) => set({ sessionsFrac: clampLayout({ sessionsFrac: frac }).sessionsFrac }),
    setConversationWidth: (px) =>
      set({ conversationWidth: clampLayout({ conversationWidth: px }).conversationWidth }),
    hydrateLayout: (layout) => set(clampLayout(layout)),
    persistLayout: () => {
      const { sidebarWidth, sessionsFrac, conversationWidth, artifactSplitFrac } = get()
      window.koda
        .updateSettings({ layout: { sidebarWidth, sessionsFrac, conversationWidth, artifactSplitFrac } })
        .catch(console.error)
    },
    resetLayout: () => {
      set({ ...DEFAULT_LAYOUT })
      get().persistLayout()
    },
    setSearchOpen: (open) => set({ searchOpen: open }),
    setStageExpanded: (expanded) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        return { stageExpanded: expanded, ...withEditor(state.editors, key, { ...ed, stageShown: true }) }
      }),
    setLightbox: (img) => set({ lightbox: img }),

    toggleRecentImagesExpanded: () =>
      set((s) => ({ recentImagesExpanded: !s.recentImagesExpanded })),
    setStoreIntegrity: (patch) => set(patch),

    openFile: (path, gotoLine, opts) =>
      set((state) => {
        // A user open lands in the ACTIVE session's editor (the dock is that session's workbench).
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        const existing = ed.surfaces.find((s) => s.path === path)
        // Markdown opens as the WYSIWYG document (everyday-user default); everything else as the
        // editable Monaco file. The per-pane toggle exposes the raw-markdown view for a doc. An
        // explicit `view` overrides this (e.g. technical `.claude/**` files open as raw markdown).
        const view: FileSurface['view'] = opts?.view ?? (isMarkdown(path) ? 'doc' : 'file')
        const openedDiffSource: FileDiffSource | undefined =
          view === 'diff' ? (opts?.diffSource ?? { kind: 'working-tree' }) : undefined
        const surfaces = existing
          ? // Already open — refocus, apply any forced view, and re-trigger a line reveal (bump nonce).
            ed.surfaces.map((s) =>
              s.path === path
                ? {
                    ...s,
                    ...(opts?.view ? { view: opts.view } : {}),
                    ...(opts?.view ? { diffSource: openedDiffSource } : {}),
                    ...(gotoLine
                      ? { gotoLine, gotoColumn: opts?.gotoColumn, gotoNonce: (s.gotoNonce ?? 0) + 1 }
                      : {}),
                  }
                : s,
            )
          : addSurface(ed, {
              path,
              title: basename(path),
              view,
              rev: 0,
              gotoLine,
              gotoColumn: opts?.gotoColumn,
              gotoNonce: 0,
              diffSource: openedDiffSource,
            })
        return {
          // A user open is explicit intent — it takes the stage and releases a pin (the pin guards
          // against the AGENT yanking the stage, never against the user's own hand).
          // stageShown deliberately dropped: an explicit open releases any hide the user had set, and
          // the default (follow the tabs) then keeps the stage up for as long as something is on it.
          ...withEditor(state.editors, key, { surfaces, activeSurfaceId: path, pinned: false }),
          // MRU for the Find overlay's quick-open: this path to the front, deduped, capped.
          recentFiles: [path, ...state.recentFiles.filter((p) => p !== path)].slice(0, 12),
        }
      }),

    newDocument: async (parent) => {
      // Provenance: the session in front of the user when they made this doc, written once into the
      // file's own frontmatter (`source:`) so it survives a rename or a move. Undefined when no chat
      // is open, which is honest — an absent source beats a guessed one.
      const source = get().activeId ?? undefined
      const { path } = await window.koda.createFile({ ...(parent ? { parent } : {}), ...(source ? { source } : {}) })
      // Nudge the Files tree to re-read so the new doc appears, then open it (markdown ⇒ Doc view).
      set((state) => ({ filesRev: state.filesRev + 1 }))
      get().openFile(path)
    },

    newFolder: async (parent, home) => {
      try {
        const { path } = await window.koda.createDir(parent ? { parent } : home ? { home: true } : {})
        if (parent) get().setDirOpen(parent, true) // reveal where the new folder landed
        set((state) => ({ filesRev: state.filesRev + 1, treeError: null }))
        return path
      } catch (e) {
        set({ treeError: humanFsError(e) })
        return null
      }
    },

    renameEntry: async (path, newName) => {
      const clean = newName.replace(/[/\\]/g, '').trim()
      if (!clean) return
      const to = `${parentDir(path)}/${clean}`
      if (to === path) return // unchanged
      try {
        const { path: np } = await window.koda.renamePath({ from: path, to })
        get().notePathMoved(path, np)
        set({ treeError: null })
      } catch (e) {
        set({ treeError: humanFsError(e) })
      }
    },

    moveEntry: async (from, toDir) => {
      // Already in that folder, or moving a folder into itself/a descendant — nothing to do.
      if (parentDir(from) === toDir || toDir === from || toDir.startsWith(from + '/')) return
      const to = `${toDir}/${basename(from)}`
      try {
        const { path: np } = await window.koda.renamePath({ from, to })
        get().notePathMoved(from, np)
        set({ treeError: null })
      } catch (e) {
        set({ treeError: humanFsError(e) })
      }
    },

    deleteEntry: async (path, options) => {
      let affectedSurfacePaths: string[]
      try {
        // The mounted editor is the only owner of text inside its debounce window. Main must not make
        // the delete checkpoint until that buffer (and any older in-flight write) has settled.
        affectedSurfacePaths = await flushFileWritersUnder(path)
      } catch {
        const error = "Couldn't save the latest edits, so nothing was deleted."
        set({ treeError: error })
        return { ok: false, error }
      }

      try {
        // Keep the renderer compatible while the main-side document-delete contract evolves: a named
        // variable is structurally valid for the older `{ path }` bridge and carries the new hint.
        const request = { path, ...options }
        await window.koda.deletePath(request)
        // Main's resolved file identity can differ from the lexical path that keys a Stage tab (an
        // in-project symlink or case alias). Close both only after main confirms the delete.
        for (const deletedPath of new Set([path, ...affectedSurfacePaths])) {
          get().notePathDeleted(deletedPath)
        }
        set({ treeError: null })
        return { ok: true }
      } catch (e) {
        const error = humanFsError(e)
        set({ treeError: error })
        return { ok: false, error }
      }
    },

    duplicateEntry: async (path) => {
      try {
        await window.koda.duplicatePath({ path })
        set((state) => ({ filesRev: state.filesRev + 1, treeError: null }))
      } catch (e) {
        set({ treeError: humanFsError(e) })
      }
    },

    importFiles: async (destDir, files) => {
      // Read the dropped bytes in the renderer (Electron 42 no longer exposes File.path) and hand
      // them to main to write — deduped, contained, checkpointed. Empty drop = nothing to do.
      const payload = await Promise.all(
        [...files].map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
      )
      if (!payload.length) return
      try {
        await window.koda.importFiles({ destDir, files: payload })
        set((state) => ({ filesRev: state.filesRev + 1, treeError: null }))
      } catch (e) {
        set({ treeError: humanFsError(e) })
      }
    },

    clearTreeError: () => set({ treeError: null }),

    // Rebase open tabs + the tree's expansion when a path is renamed/moved. A folder move carries its
    // descendants (anything under `from/` → under `to/`). A rename is project-wide, so EVERY session's
    // editor gets its matching surfaces re-keyed + retitled; the focused/split panes and openDirs follow.
    notePathMoved: (from, to) => {
      const root = get().projectPath
      const legacyPathChange = root ? pathChangeFromAbsolute(root, from, to) : null
      // Retired local pins remain the durable copy until the hot-store save is acknowledged. Repair
      // that copy synchronously too, so a quit inside the debounce window cannot revive the old path.
      if (root && legacyPathChange) repairLegacyDocPins(root, [legacyPathChange])
      set((state) => {
        const reb = (p: string): string => rebasePath(p, from, to) ?? p
        const editors = mapEditors(state.editors, (ed) => ({
          ...ed,
          surfaces: ed.surfaces.map((s) => {
            const np = rebasePath(s.path, from, to)
            return np ? { ...s, path: np, title: basename(np) } : s
          }),
          activeSurfaceId: ed.activeSurfaceId ? reb(ed.activeSurfaceId) : ed.activeSurfaceId,
        }))
        return {
          editors,
          openDirs: state.openDirs.map(reb),
          filesRev: state.filesRev + 1,
          ...remapStarredDocs(state, (abs) => rebasePath(abs, from, to) ?? abs),
          ...(legacyPathChange
            ? {
                legacyKeptDocPathChanges: appendLegacyPathChange(
                  state.legacyKeptDocPathChanges,
                  legacyPathChange,
                ),
              }
            : {}),
        }
      })
    },

    // Close any tab under a deleted path (across every session's editor) and drop its tree expansion.
    notePathDeleted: (path) => {
      const under = (p: string): boolean => p === path || p.startsWith(path + '/')
      const root = get().projectPath
      const legacyPathChange = root ? pathChangeFromAbsolute(root, path, null) : null
      if (root && legacyPathChange) repairLegacyDocPins(root, [legacyPathChange])
      set((state) => {
        const editors = mapEditors(state.editors, (ed) => {
          const surfaces = ed.surfaces.filter((s) => !under(s.path))
          const activeSurfaceId =
            ed.activeSurfaceId && under(ed.activeSurfaceId)
              ? (surfaces[surfaces.length - 1]?.path ?? null)
              : ed.activeSurfaceId
          return { ...ed, surfaces, activeSurfaceId }
        })
        return {
          editors,
          openDirs: state.openDirs.filter((p) => !under(p)),
          filesRev: state.filesRev + 1,
          ...remapStarredDocs(state, (abs) => (under(abs) ? null : abs)),
          ...(legacyPathChange
            ? {
                legacyKeptDocPathChanges: appendLegacyPathChange(
                  state.legacyKeptDocPathChanges,
                  legacyPathChange,
                ),
              }
            : {}),
        }
      })
    },

    applyStageReceipt: (receipt, opts) =>
      set((state) => {
        const session = state.sessions[receipt.sessionId]
        if (!session) return {}
        const key = receipt.sessionId
        const ed = state.editors[key] ?? EMPTY_EDITOR

        if (receipt.kind === 'present-file') {
          const path = workspaceAbsolute(session.cwd, receipt.path)
          const existing = ed.surfaces.find((surface) => surface.path === path)
          if (existing?.receiptId === receipt.id) return {}
          const view: FileSurface['view'] =
            receipt.view === 'document' ? 'doc' : receipt.view
          const diffSource: FileDiffSource | undefined =
            receipt.view === 'diff'
              ? {
                  kind: 'checkpoint',
                  sessionId: receipt.sessionId,
                  checkpointId: receipt.checkpointId!,
                  path: receipt.path,
                }
              : undefined
          const surfaces = existing
            ? ed.surfaces.map((surface) =>
                surface.path === path
                  ? {
                      ...surface,
                      view,
                      rev: surface.rev + 1,
                      sessionId: receipt.sessionId,
                      diffSource,
                      receiptId: receipt.id,
                      gotoLine: receipt.line,
                      gotoColumn: receipt.column,
                      gotoNonce: (surface.gotoNonce ?? 0) + 1,
                    }
                  : surface,
              )
            : addSurface(ed, {
                path,
                title: basename(path),
                view,
                rev: 0,
                sessionId: receipt.sessionId,
                diffSource,
                receiptId: receipt.id,
                gotoLine: receipt.line,
                gotoColumn: receipt.column,
                gotoNonce: 0,
              })
          const select = !opts?.catchup && ed.stageShown !== false && !stageHeld(ed)
          return withEditor(state.editors, key, {
            ...ed,
            surfaces,
            activeSurfaceId: select ? path : ed.activeSurfaceId,
          })
        }

        const existing = ed.surfaces.find((surface) => surface.path === TURN_CHANGES_SURFACE_ID)
        if (existing?.receiptId === receipt.id) return {}
        if (receipt.files.length === 0) {
          if (!existing) return {}
          const surfaces = ed.surfaces.filter((surface) => surface.path !== TURN_CHANGES_SURFACE_ID)
          return withEditor(state.editors, key, {
            ...ed,
            surfaces,
            activeSurfaceId:
              ed.activeSurfaceId === TURN_CHANGES_SURFACE_ID
                ? (surfaces[surfaces.length - 1]?.path ?? null)
                : ed.activeSurfaceId,
          })
        }
        const surface: FileSurface = {
          kind: 'turn-changes',
          path: TURN_CHANGES_SURFACE_ID,
          title: 'This turn',
          view: 'file',
          rev: existing ? existing.rev + 1 : 0,
          sessionId: receipt.sessionId,
          receiptCheckpointId: receipt.checkpointId,
          receiptId: receipt.id,
          receiptFiles: receipt.files,
          receiptComplete: receipt.complete,
          receiptOverlapObserved: receipt.overlapObserved,
        }
        const surfaces = existing
          ? ed.surfaces.map((item) => (item.path === TURN_CHANGES_SURFACE_ID ? surface : item))
          : addSurface(ed, surface)
        const select =
          !opts?.catchup &&
          ed.stageShown !== false &&
          ed.activeSurfaceId === null &&
          !stageHeld(ed)
        return withEditor(state.editors, key, {
          ...ed,
          surfaces,
          activeSurfaceId: select ? TURN_CHANGES_SURFACE_ID : ed.activeSurfaceId,
        })
      }),

    showEditDiff: (path, sessionId) =>
      // Re-stamps `sessionId` each edit (last-writer-wins) → the diff is "cumulative since the most
      // recent editing session's turn start". If two sessions edit one file, or the file is re-edited
      // in a later turn, the baseline follows the newer turn — by design (cumulative-per-turn), not a bug.
      // Lands in the EDITING session's editor (keyed by sessionId), so a background session's diffs pile
      // up in its own workbench without disturbing the session you're looking at. When it's the active
      // session, the dock is already showing this editor, so the diff appears live.
      set((state) => {
        const ed = state.editors[sessionId] ?? EMPTY_EDITOR
        const existing = ed.surfaces.find((s) => s.path === path)
        const surfaces = existing
          ? ed.surfaces.map((s) =>
              s.path === path
                ? {
                    ...s,
                    view: 'diff' as const,
                    rev: s.rev + 1,
                    sessionId,
                    diffSource: { kind: 'session' as const, sessionId },
                  }
                : s,
            )
          : addSurface(ed, {
              path,
              title: basename(path),
              view: 'diff' as const,
              rev: 0,
              sessionId,
              diffSource: { kind: 'session', sessionId },
            })
        return withEditor(state.editors, sessionId, {
          ...ed,
          surfaces,
          // Auto-follow: the just-edited file joins the strip as a tab and gets SELECTED, so the user
          // watches the change land while everything they already had open stays open — unless the
          // stage is HELD (pinned, or a live surface is on stage: soft pin). Held, the tab still appears
          // and its rev still bumps; only the selection is withheld.
          // `...ed` keeps any explicit hide: agent edits fire constantly, so a stage the user closed by
          // hand stays closed. A stage the user never touched follows its tabs, so the first edit of a
          // fresh chat does bring it up.
          activeSurfaceId: stageHeld(ed) ? ed.activeSurfaceId : path,
        })
      }),

    showEditDoc: (path, sessionId) =>
      // Mirrors showEditDiff but lands on the rendered Doc view. Re-stamps sessionId + bumps rev each
      // edit so the open doc re-reads and replaces its content in place (DocSurfaceView → CrepeDocEditor
      // replaceAll). Always pulls the doc back to front so the user watches it appear/grow.
      // See showEditDiff — keyed by the editing session so a background session's docs stay in its editor.
      set((state) => {
        const ed = state.editors[sessionId] ?? EMPTY_EDITOR
        const existing = ed.surfaces.find((s) => s.path === path)
        const surfaces = existing
          ? ed.surfaces.map((s) =>
              s.path === path
                ? { ...s, view: 'doc' as const, rev: s.rev + 1, sessionId, diffSource: undefined }
                : s,
            )
          : addSurface(ed, { path, title: basename(path), view: 'doc' as const, rev: 0, sessionId })
        return withEditor(state.editors, sessionId, {
          ...ed,
          surfaces,
          // Same hold rule as showEditDiff; a collapsed dock likewise stays put.
          activeSurfaceId: stageHeld(ed) ? ed.activeSurfaceId : path,
        })
      }),

    setSurfaceView: (path, view) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        return withEditor(state.editors, key, {
          ...ed,
          surfaces: ed.surfaces.map((s) =>
            s.path === path
              ? {
                  ...s,
                  view,
                  diffSource:
                    view === 'diff'
                      ? (s.diffSource ?? (s.sessionId
                          ? { kind: 'session' as const, sessionId: s.sessionId }
                          : { kind: 'working-tree' as const }))
                      : s.diffSource,
                }
              : s,
          ),
        })
      }),

    setDirOpen: (path, open) =>
      set((state) => ({
        openDirs: open
          ? state.openDirs.includes(path)
            ? state.openDirs
            : [...state.openDirs, path]
          : state.openDirs.filter((p) => p !== path),
      })),

    closeSurface: (path) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        const idx = ed.surfaces.findIndex((s) => s.path === path)
        const surfaces = ed.surfaces.filter((s) => s.path !== path)
        // Closing the SELECTED tab falls to the tab that slid into its place (or the new last one, when
        // it was the rightmost) — the browser-tab behaviour; closing the last tab empties the stage.
        const activeSurfaceId =
          ed.activeSurfaceId === path
            ? (surfaces[Math.min(idx, surfaces.length - 1)]?.path ?? null)
            : ed.activeSurfaceId
        return {
          ...withEditor(state.editors, key, { ...ed, surfaces, activeSurfaceId }),
          // Emptying the stage takes the panel away (stageVisible), so full-width mode has to end with
          // it — otherwise the next file opened would land in an expanded stage nobody asked for.
          ...(surfaces.length === 0 ? { stageExpanded: false } : {}),
        }
      }),

    selectSurface: (path) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        // Clicking a tab is explicit user intent — it releases a pin (like openFile).
        return withEditor(state.editors, key, { ...ed, activeSurfaceId: path, pinned: false })
      }),

    setStagePinned: (pinned) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        return withEditor(state.editors, key, { ...ed, pinned })
      }),

    openPreview: (url, opts) => {
      const fronted = frontAgentSurface(opts?.sessionId)
      set((state) => {
        // The preview belongs to the session that TRIGGERED it (opts.sessionId on an agent push), not
        // whichever tab is focused when the push lands — a window can host several sessions. A user
        // click carries no sessionId → the active session. (The underlying dev server is still
        // window-scoped in main — Phase 2 keys it per session so two sessions can each run their own app.)
        const key = opts?.sessionId ?? editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        const existing = ed.surfaces.find((s) => s.kind === 'preview')
        const surfaces = existing
          ? // Already open — re-point its URL (e.g. static → dev server) and bump rev to force reload.
            ed.surfaces.map((s) =>
              s.kind === 'preview' ? { ...s, previewUrl: url, rev: s.rev + 1, live: true } : s,
            )
          : addSurface(ed, {
              kind: 'preview' as const,
              path: PREVIEW_SURFACE_ID,
              title: 'Preview',
              view: 'file' as const,
              rev: 0,
              previewUrl: url,
              // Main only pushes a preview once it has confirmed something answers on that URL.
              live: true,
            })
        // A preview pushed by the session already in front respects its pin. A background push is an
        // explicit handoff: front that session and show the preview once, even if its old Stage state
        // was pinned or hidden. User opens always take the Stage.
        const takeStage = fronted || !(opts?.respectPin && ed.pinned)
        const isActive = key === editorKey(state)
        return withEditor(state.editors, key, {
          ...ed,
          surfaces,
          activeSurfaceId: takeStage ? PREVIEW_SURFACE_ID : ed.activeSurfaceId,
          pinned: fronted ? false : ed.pinned,
          ...(isActive ? { stageShown: undefined } : {}),
        })
      })
    },

    bringPreviewToStage: () =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        if (!ed.surfaces.some((s) => s.kind === 'preview')) return {}
        return withEditor(state.editors, key, {
          ...ed,
          activeSurfaceId: PREVIEW_SURFACE_ID,
          stageShown: undefined,
        })
      }),

    rememberPreview: (sessionId, restart) => patchSession(sessionId, (s) => ({ ...s, lastPreview: restart })),

    starDoc: (rel) => {
      const { starredDocs, legacyKeptDocsImported } = get()
      // Guard before setting: an existing star must not schedule another debounced rewrite of the
      // whole project store.
      if (!rel || starredDocs.includes(rel)) return
      set({
        starredDocs: [...starredDocs, rel],
        // A manually touched path is settled migration state too. If an old archive with the same
        // path becomes readable later, it must not get a second vote after the user unstars it.
        legacyKeptDocsImported: mergeUniquePaths(legacyKeptDocsImported, [rel]),
      })
    },

    unstarDoc: (rel) => {
      const { starredDocs, legacyKeptDocsImported, projectPath } = get()
      if (!starredDocs.includes(rel)) return
      // Removing an adopted legacy pin must consume it from that source too. Otherwise the next mount
      // sees the old key and silently puts the star back before the first hot-save acknowledgement.
      if (projectPath) {
        const pinsKey = `koda:doc-pins:${projectPath}`
        try {
          const raw: unknown = JSON.parse(localStorage.getItem(pinsKey) ?? '[]')
          const pins = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
          if (pins.includes(rel)) {
            const remaining = pins.filter((pin) => pin !== rel)
            if (remaining.length) localStorage.setItem(pinsKey, JSON.stringify(remaining))
            else localStorage.removeItem(pinsKey)
          }
        } catch {
          // Storage is fail-soft. The in-memory unstar still stands for this run; an unreadable legacy
          // source is not rewritten because doing so could erase pins we could not inspect.
        }
      }
      set({
        starredDocs: starredDocs.filter((path) => path !== rel),
        legacyKeptDocsImported: mergeUniquePaths(legacyKeptDocsImported, [rel]),
      })
    },

    // Adoption and deletion are deliberately separate. The legacy key is the only durable copy until
    // main acknowledges a project-store write containing the merged stars, so this action only adopts.
    // `completeDocPinMigration` owns deletion after that acknowledgement.
    migrateDocPins: () => {
      const {
        projectPath,
        starredDocs,
        legacyKeptDocsImported,
        legacyKeptDocPathChanges,
      } = get()
      if (!projectPath) return
      const pinsKey = `koda:doc-pins:${projectPath}`
      const pins = repairLegacyDocPins(
        projectPath,
        legacyKeptDocPathChanges,
        (path) => starredDocs.includes(path) || !legacyKeptDocsImported.includes(path),
      )
      if (!pins) return // storage unreadable: change nothing, and try again on the next mount
      const merged = mergeUniquePaths(starredDocs, pins)
      if (merged.length !== starredDocs.length) set({ starredDocs: merged })
      // No choices to protect: clear the retired pane's empty residue immediately.
      if (pins.length) return
      try {
        localStorage.removeItem(pinsKey)
        localStorage.removeItem(`koda:doc-folders-open:${projectPath}`) // the retired pane's other key
      } catch {
        // Storage refused the delete: harmless. The merge above skips anything already starred, so the
        // next mount re-runs it without duplicating a row.
      }
    },

    completeDocPinMigration: (persisted) => {
      const {
        projectPath,
        starredDocs,
        legacyKeptDocsImported,
        legacyKeptDocPathChanges,
      } = get()
      if (!projectPath) return
      const pinsKey = `koda:doc-pins:${projectPath}`
      const pins = repairLegacyDocPins(
        projectPath,
        legacyKeptDocPathChanges,
        (path) => starredDocs.includes(path) || !legacyKeptDocsImported.includes(path),
      )
      if (!pins) return
      // The acknowledgement is for THIS blob. Only it can prove every legacy choice has reached disk;
      // current Zustand state may already have changed while the IPC round-trip was in flight.
      if (pins.length && !pins.every((path) => persisted.starredDocs?.includes(path))) return
      try {
        localStorage.removeItem(pinsKey)
        localStorage.removeItem(`koda:doc-folders-open:${projectPath}`)
      } catch {
        // Harmless and retryable: adoption de-duplicates the next time the old key is seen.
      }
    },

    closePreview: () => get().closeSurface(PREVIEW_SURFACE_ID),

    // Across EVERY session's editor, not just the active one: the dev server is window-wide, so a
    // background session's preview tab is pointed at the same dead URL and would keep claiming green.
    notePreviewStopped: (url) =>
      set((state) => ({
        editors: mapEditors(state.editors, (ed) => {
          if (!ed.surfaces.some((s) => s.kind === 'preview' && s.previewUrl === url && s.live)) return ed
          return {
            ...ed,
            surfaces: ed.surfaces.map((s) =>
              s.kind === 'preview' && s.previewUrl === url ? { ...s, live: false } : s,
            ),
          }
        }),
      })),

    refreshGitStatus: async () => {
      // Core path first: repo state + working-tree status. This must NOT depend on anything newer,
      // so a stale preload (HMR doesn't reload preload) can't take git detection down with it.
      try {
        const info = await window.koda.gitDetect()
        if (!info.isRepo) {
          set({ gitRepo: false, gitFiles: [], gitChangesTruncated: false, gitSideLinesWaiting: false })
          return
        }
        const status = await window.koda.gitStatus()
        set({ gitRepo: true, gitFiles: status.files, gitChangesTruncated: status.truncated })
      } catch (err) {
        // Non-fatal — a missing project/window or a git hiccup just leaves the last-known state.
        console.error('refreshGitStatus failed', err)
        return
      }
      // The side-line cue is additive + best-effort. A clean committed branch and a dirty sibling
      // checkout are both waiting work, so read both existing sources. Keep a previous true cue if
      // either source is temporarily unavailable; a later complete refresh can clear it honestly.
      const [worktreesResult, graphResult] = await Promise.allSettled([
        window.koda.gitWorktrees?.() ?? Promise.resolve([]),
        window.koda.gitGraph?.({ limit: 1 }) ?? Promise.resolve(null),
      ])
      if (worktreesResult.status === 'rejected') {
        console.error('refreshGitStatus: worktrees skipped', worktreesResult.reason)
      }
      if (graphResult.status === 'rejected') {
        console.error('refreshGitStatus: branch check skipped', graphResult.reason)
      }
      const dirtySibling =
        worktreesResult.status === 'fulfilled' &&
        worktreesResult.value.some(
          (w) => !w.isCurrent && (!w.statusKnown || w.dirtyCount > 0 || w.prunable),
        )
      const unmergedBranch =
        graphResult.status === 'fulfilled' &&
        graphResult.value !== null &&
        graphResult.value.unmergedBranches.length > 0
      const bothKnown =
        worktreesResult.status === 'fulfilled' &&
        graphResult.status === 'fulfilled' &&
        graphResult.value !== null
      if (dirtySibling || unmergedBranch || bothKnown) {
        set({ gitSideLinesWaiting: dirtySibling || unmergedBranch })
      }
    },

    openChanges: (focusSessionId) => {
      set((state) => ({
        ...stageSingleton(state, { kind: 'changes', path: CHANGES_SURFACE_ID, title: 'Changes' }),
        changesFocus: focusSessionId ?? null,
      }))
      void get().refreshGitStatus()
    },

    openAgents: (sessionId) =>
      set((state) =>
        stageSingleton(state, { kind: 'agents', path: AGENTS_SURFACE_ID, title: 'Agents' }, sessionId),
      ),

    setDockOpen: (open) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        return {
          ...withEditor(state.editors, key, { ...ed, stageShown: open }),
          stageExpanded: open ? state.stageExpanded : false,
        }
      }),
    toggleDock: () => get().setDockOpen(!stageVisible(get())),
    openTerminal: (command, sessionId) =>
      set((state) => ({
        ...stageSingleton(state, { kind: 'terminal', path: TERMINAL_SURFACE_ID, title: 'Terminal' }, sessionId),
        // The staged command stays window-scoped because the pty is: one shell per window, so whichever
        // session asked, the command belongs at that one prompt (the Stage follows the same rule).
        pendingTermCommand: command && command.trim() ? command : null,
      })),
    clearPendingTermCommand: () => set({ pendingTermCommand: null }),

    hydrate: (blob) => {
      // An acknowledged archive row is the durable user intent. If an oversized/stalled hot-store save
      // left the old live row behind, do not resurrect it on reload. Older affected builds could also
      // append the same archive id repeatedly, so collapse those redundant rows at the same boundary.
      const archived: ArchivedSessionMeta[] = []
      const archivedIds = new Set<string>()
      for (const row of blob.archived ?? []) {
        if (archivedIds.has(row.id)) continue
        archivedIds.add(row.id)
        archived.push(row)
      }
      const protectedArchived: ArchivedSessionMeta[] = []
      const protectedIds = new Set<string>()
      for (const row of blob.protectedArchived ?? []) {
        if (archivedIds.has(row.id) || protectedIds.has(row.id)) continue
        protectedIds.add(row.id)
        protectedArchived.push(row)
      }
      const liveSessions = blob.sessions.filter((session) => !archivedIds.has(session.id))
      const legacyKeptDocPathChanges = blob.legacyKeptDocPathChanges ?? []
      // Session-scoped shelves were the old storage model. Import every legacy path once, with the
      // active chat first so the order the user was looking at remains the head of the new project
      // shelf. The append-only ledger is the tombstone too: an unstarred path stays "seen", so an
      // archive that was unavailable on the first upgraded launch cannot resurrect it later.
      const legacyPaths = legacyKeptDocsInOrder(liveSessions, blob.activeId, archived)
      const importedBefore = blob.legacyKeptDocsImported ?? []
      const legacyKeptDocsImported = mergeUniquePaths(importedBefore, legacyPaths)
      const unseenLegacyPaths = legacyPaths
        .filter((path) => !importedBefore.includes(path))
        .map((path) => applyLegacyPathChanges(path, legacyKeptDocPathChanges))
        .filter(
          (path): path is string =>
            !!path && !importedBefore.includes(path),
        )
      const starredDocs = mergeUniquePaths(blob.starredDocs ?? [], unseenLegacyPaths)
      // Advance the entry-id counter past BOTH live AND archived sessions, so a later restore (or a new
      // entry) can never reissue an entry id that a not-yet-restored archive still holds.
      let maxEntryId = 0
      const scanItems = (items: Entry[]): void => {
        for (const it of items) {
          if (it.id > maxEntryId) maxEntryId = it.id
          if (it.kind === 'subagent')
            for (const c of it.children) if (c.id > maxEntryId) maxEntryId = c.id
        }
      }
      for (const s of liveSessions) scanItems(s.items as Entry[])
      // Archived metadata carries only its baked maxItemId (bodies aren't loaded on boot) — advance past
      // it so a new entry can't reuse an id a not-yet-restored archive still holds.
      for (const a of archived) if ((a.maxItemId ?? 0) > maxEntryId) maxEntryId = a.maxItemId ?? 0
      entryId = maxEntryId
      if (!liveSessions.length) {
        set({
          archived,
          protectedArchived,
          starredDocs,
          legacyKeptDocsImported,
          legacyKeptDocPathChanges,
          legacyKeptDocsMigrationComplete: blob.legacyKeptDocsMigrationComplete ?? false,
          hydrated: true,
          rateLimits: blob.rateLimits ?? {},
        })
        return
      }
      const sessions: Record<string, SessionState> = {}
      for (const s of liveSessions)
        sessions[s.id] = sessionStateFromPersisted(s, get().defaultApprovalMode)
      set({
        sessions,
        order: liveSessions.map((s) => s.id),
        activeId:
          blob.activeId && sessions[blob.activeId]
            ? blob.activeId
            : (liveSessions[0]?.id ?? null),
        archived,
        protectedArchived,
        starredDocs,
        legacyKeptDocsImported,
        legacyKeptDocPathChanges,
        legacyKeptDocsMigrationComplete: blob.legacyKeptDocsMigrationComplete ?? false,
        hydrated: true,
        rateLimits: blob.rateLimits ?? {},
      })
    },

    persistBlob: () => {
      const {
        order,
        sessions,
        activeId,
        starredDocs,
        legacyKeptDocsImported,
        legacyKeptDocPathChanges,
        legacyKeptDocsMigrationComplete,
      } = get()
      return {
        version: 3,
        activeId,
        starredDocs,
        legacyKeptDocsImported,
        legacyKeptDocPathChanges,
        legacyKeptDocsMigrationComplete,
        sessions: order
          .map((id) => sessions[id])
          .filter(Boolean)
          .map(persistedSessionFromState),
        // `archived` deliberately absent: it lives in its own cold file, written by the three actions
        // that move a session in or out of it (archiveSession / restoreArchived / deleteArchived, via
        // `persistArchived`), never in this constantly-rewritten hot blob.
      }
    },

    noteRestored: (label) => {
      const id = get().activeId
      if (id)
        pushItem(id, {
          kind: 'notice',
          text: `↶ Went back to ${label} · your latest work is saved too`,
        })
    },
  }
})

// Keep the dirty state fresh without a file watcher: on window focus (the user may have edited in
// another tool or a sibling session's turn landed while away) + once at boot. Per-turn refresh lives
// in TurnComplete. Fires against whatever project the window holds; fails soft to not-a-repo.
//
// Focus also clears the unseen mark on the session in FRONT, which is the only way it can be cleared
// there. `raiseAttention` skips the mark for a session the user is watching, and watching means active
// AND focused — so a turn that finished while the user was in another app marked the session they were
// already on. Selecting it is what clears the mark, and it is already selected, so nothing could: it
// sat under "Needs you" for the rest of the window's life. Coming back to the window IS looking at it.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    const { activeId, sessions } = useWorkspace.getState()
    if (activeId && sessions[activeId]?.attention) useWorkspace.getState().selectSession(activeId)
    void useWorkspace.getState().refreshGitStatus()
  })
  void useWorkspace.getState().refreshGitStatus()
}

/** Per-project key remembering that the user dismissed the intake offer (so reopening doesn't re-nag). */
function intakeSkipKey(projectPath: string): string {
  return `koda.intakeSkipped:${projectPath}`
}

/** Last path segment — the renderer has no node:path, and surface paths are always absolute. */
function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** Project/session roots are main-owned and receipts are schema-validated POSIX relatives. This join
 * is projection only; every subsequent file read/diff is contained again in main. */
function workspaceAbsolute(cwd: string, rel: string): string {
  return `${cwd.replace(/\/+$/, '')}/${rel}`
}

/** The containing directory of an absolute path (no trailing slash). */
function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

/** Map a path through a rename/move: the moved path itself, or one nested beneath it (folder move).
 *  Returns null when `p` isn't affected, so callers can leave it untouched. */
function rebasePath(p: string, from: string, to: string): string | null {
  if (p === from) return to
  if (p.startsWith(from + '/')) return to + p.slice(from.length)
  return null
}

/** Convert one successful Koda filesystem operation into the project-relative prefix rule used only
 *  for legacy star sources. A destination outside the project is a deletion from this project's point
 *  of view. */
function pathChangeFromAbsolute(
  root: string,
  from: string,
  to: string | null,
): LegacyKeptDocPathChange | null {
  if (!from.startsWith(`${root}/`)) return null
  const fromRel = from.slice(root.length + 1)
  const toRel = to?.startsWith(`${root}/`) ? to.slice(root.length + 1) : null
  if (!fromRel || fromRel === toRel) return null
  return { from: fromRel, to: toRel }
}

/** Replay Koda-observed prefix moves/deletions over a legacy project-relative path. Rules are ordered:
 *  A→B followed by B→C lands at C, while a matching deletion ends the path permanently. */
function applyLegacyPathChanges(
  rel: string,
  changes: readonly LegacyKeptDocPathChange[],
): string | null {
  let current: string | null = rel
  for (const change of changes) {
    if (!current) return null
    if (current !== change.from && !current.startsWith(change.from + '/')) continue
    if (change.to === null) return null
    current = change.to + current.slice(change.from.length)
  }
  return current
}

/** Keep the ordered change log compact under duplicate filesystem notifications. */
function appendLegacyPathChange(
  changes: readonly LegacyKeptDocPathChange[],
  next: LegacyKeptDocPathChange,
): LegacyKeptDocPathChange[] {
  const last = changes[changes.length - 1]
  return last?.from === next.from && last.to === next.to ? [...changes] : [...changes, next]
}

/** Apply path repair to the retired Documents pane's still-unacknowledged localStorage copy. Returns
 *  null only when that copy could not be read; otherwise returns (and, when needed, writes) its repaired
 *  stable list. This synchronous rewrite closes the rename/delete-before-save crash window. */
function repairLegacyDocPins(
  projectPath: string,
  changes: readonly LegacyKeptDocPathChange[],
  keep: (path: string) => boolean = () => true,
): string[] | null {
  const key = `koda:doc-pins:${projectPath}`
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    const pins = Array.isArray(raw) ? raw.filter((path): path is string => typeof path === 'string') : []
    const repaired = mergeUniquePaths(
      pins
        .map((path) => applyLegacyPathChanges(path, changes))
        .filter((path): path is string => !!path && keep(path)),
    )
    const unchanged = repaired.length === pins.length && repaired.every((path, index) => path === pins[index])
    if (!unchanged) {
      if (repaired.length) localStorage.setItem(key, JSON.stringify(repaired))
      else localStorage.removeItem(key)
    }
    return repaired
  } catch {
    return null
  }
}

/**
 * Carry the project's starred-document shelf through a rename, move, or delete. Starred paths are
 * project-relative while file events are absolute, so this converts both ways around `projectPath`
 * (main resolves that to the same realpath it derives `rel` from).
 *
 * Every old and new path also joins the append-only legacy ledger. That is not bookkeeping noise: an
 * archived session may still carry the old path, and without the tombstone it could re-import the star
 * the next time its index becomes readable. `next` returns the new absolute path, or null to drop it.
 *
 * Returns `{}` when nothing changed, so the caller can spread it into a `set` payload without ever
 * replacing either array for a file event that touched no star.
 */
function remapStarredDocs(
  state: {
    starredDocs: string[]
    legacyKeptDocsImported: string[]
    projectPath: string | null
  },
  next: (abs: string) => string | null,
): { starredDocs?: string[]; legacyKeptDocsImported?: string[] } {
  const root = state.projectPath
  if (!root) return {}
  const touched: string[] = []
  const mapped: string[] = []
  for (const rel of state.starredDocs) {
    const absolute = next(`${root}/${rel}`)
    if (!absolute || !absolute.startsWith(`${root}/`)) {
      touched.push(rel)
      continue
    }
    const nextRel = absolute.slice(root.length + 1)
    mapped.push(nextRel)
    if (nextRel !== rel) touched.push(rel, nextRel)
  }
  const starredDocs = mergeUniquePaths(mapped)
  const unchanged =
    starredDocs.length === state.starredDocs.length &&
    starredDocs.every((rel, index) => rel === state.starredDocs[index])
  if (unchanged) return {}
  return {
    starredDocs,
    legacyKeptDocsImported: mergeUniquePaths(state.legacyKeptDocsImported, touched),
  }
}

/** Stable, first-seen ordering for path lists. Empty strings are never useful document identities. */
function mergeUniquePaths(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of lists) {
    for (const path of list) {
      if (!path || seen.has(path)) continue
      seen.add(path)
      merged.push(path)
    }
  }
  return merged
}

/** The migration order preserves the shelf currently in front of the user, then the remaining live
 * chats in their saved order, then archived chats newest-first. */
function legacyKeptDocsInOrder(
  sessions: PersistedSession[],
  activeId: string | null,
  archived: ArchivedSessionMeta[],
): string[] {
  const active = activeId ? sessions.find((session) => session.id === activeId) : undefined
  const ordered = active
    ? [active, ...sessions.filter((session) => session.id !== active.id)]
    : sessions
  return mergeUniquePaths(
    ...ordered.map((session) => session.keptDocs ?? []),
    ...archived.map((session) => session.keptDocs ?? []),
  )
}

/** Is `filePath` inside `dir`? Both are absolute POSIX paths (Edit tools pass absolute file_path).
 *  Gates the auto-surface: an edit outside the session's cwd (a global `~/.claude/` file) can't be
 *  diffed against its safety-git root, so surfacing it just errors in main and hijacks the Stage. */
function withinDir(filePath: string, dir: string | undefined): boolean {
  if (!dir) return false
  return filePath === dir || filePath.startsWith(dir.replace(/\/+$/, '') + '/')
}

/** Turn a raw IPC rejection into a calm, non-engineer-readable line for the Files browser. */
function humanFsError(e: unknown): string {
  const m = String(e)
  // Main refused a destroying action it couldn't make undoable. That sentence is already written for
  // the user and names what did NOT happen, so pass it through rather than flattening it.
  const noUndo = undoPointRefusal(e)
  if (noUndo) return noUndo
  if (/already exists/i.test(m)) return 'A file or folder with that name already exists.'
  if (/escapes the project root/i.test(m)) return 'That location is outside this project.'
  if (/cannot delete the project root/i.test(m)) return "The project folder itself can't be deleted."
  return "Couldn't complete that — the file may have moved or be in use."
}

/** Markdown files default to the WYSIWYG document view. */
function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** The last few readable turns, baked into archive metadata at archive time so Settings can preview the
 *  chat without loading its (cold-stored) transcript body. Mirrors the main-side builder. */
function buildArchivePreview(items: Entry[]): ArchivedPreviewTurn[] {
  const turns: ArchivedPreviewTurn[] = []
  for (const it of items) {
    if (it.kind === 'user' && it.text?.trim()) turns.push({ kind: 'user', text: clipArchivePreview(it.text.trim()) })
    else if (it.kind === 'assistant' && it.markdown?.trim())
      turns.push({ kind: 'assistant', text: clipArchivePreview(it.markdown.trim()) })
  }
  return turns.slice(-6)
}
const clipArchivePreview = (s: string): string => (s.length > 500 ? s.slice(0, 500) : s)

/** Highest entry (and subagent-child) id in a transcript — baked into metadata so boot can advance the
 *  id counter past a not-yet-restored archive without loading its body. */
function maxArchivedItemId(items: Entry[]): number {
  let max = 0
  for (const it of items) {
    if (it.id > max) max = it.id
    if (it.kind === 'subagent') for (const c of it.children) if (c.id > max) max = c.id
  }
  return max
}

/** Highest durable replay identity present in a rendered transcript, including a subagent's nested
 *  prose/tool rows. Archive-body loading can merge either level from the sidecar. */
function maxTranscriptReplaySeq(items: Entry[]): number {
  let max = 0
  for (const item of items) {
    max = Math.max(max, item.replaySeq ?? 0)
    if (item.kind === 'subagent')
      for (const child of item.children) max = Math.max(max, child.replaySeq ?? 0)
  }
  return max
}

/** Derived per-session status (one source per signal). A delegated task the engine backgrounded
 *  outlives its parent turn, so `busy` alone would settle the icon on the finished check while the
 *  fan-out is still running — and re-twinkle on each follow-up turn. Work in flight is work in
 *  flight, whoever is doing it. */
export function statusOf(s: SessionState, pending: ApprovalRequest[]): SessionStatus {
  if (pending.some((r) => r.sessionId === s.id)) return 'waiting'
  if (s.busy || hasRunningDelegation(s.items)) return 'thinking'
  if (s.errored) return 'error'
  return 'idle'
}

// ── Per-session change attribution ─────────────────────────────────────────────────
// Git has ONE working tree per project (all sessions edit the same files), so `gitFiles` is aggregate.
// Main's completion tracker provides exact turn-boundary paths after a turn. Edit-tool cards remain the
// best-effort fallback only for in-flight or older sessions. A dirty file neither source owns falls into
// "Loose changes" without pretending Koda knows who caused it.

/** A group of dirty files, all attributed to one session (or the loose/unattributed bucket). */
export interface SessionChangeGroup {
  /** The owning session, or null when transcript evidence cannot identify one. */
  sessionId: string | null
  label: string
  files: GitStatusFile[]
}

export interface SessionChanges {
  groups: SessionChangeGroup[]
  /** path → other sessions' labels that also edited it (the primary owner excluded). */
  alsoBy: Record<string, string[]>
  /** sessionId → count of dirty files it owns (drives the sidebar chip). */
  countBySession: Record<string, number>
}

/** Absolute file paths a session's agent wrote this run (edit-tool cards, incl. subagent children).
 *  We don't filter on isError: a failed edit that changed nothing won't appear in `gitFiles` anyway,
 *  so it can't create a phantom group — and skipping the check keeps this cheap. */
function editedPathsOfCurrentTurn(s: SessionState): string[] {
  const out: string[] = []
  const take = (name: string, input: unknown): void => {
    if (!EDIT_TOOLS.has(name)) return
    const i = input as { file_path?: string; notebook_path?: string } | null
    const p = i?.file_path ?? i?.notebook_path // NotebookEdit uses notebook_path
    if (p) out.push(p)
  }
  let turnStart = 0
  for (let i = 0; i < s.items.length; i++) if (s.items[i].kind === 'user') turnStart = i + 1
  for (const it of s.items.slice(turnStart)) {
    if (it.kind === 'tool') take(it.name, it.input)
    else if (it.kind === 'subagent') for (const c of it.children) if (c.kind === 'tool') take(c.name, c.input)
  }
  return out
}

/** Does one of `absPaths` refer to the project-relative `rel`? Match by suffix so we needn't reconcile
 *  the session cwd against the git root (a subdir project would otherwise mismatch): an absolute
 *  `/…/proj/src/a.ts` owns rel `src/a.ts`. */
function touches(absPaths: string[], rel: string): boolean {
  return absPaths.some(
    (abs) =>
      abs === rel ||
      abs.endsWith('/' + rel) ||
      (rel.endsWith('/') && (abs.startsWith(rel) || abs.includes('/' + rel))),
  )
}

/** Aggregate Git intentionally collapses a new untracked folder to `dir/`; main keeps the exact files
 * below it. Treat that one row as representing every owned descendant without discarding the exact
 * file count carried by completion state. */
function completionTouches(paths: string[], rel: string): boolean {
  return paths.some((path) => path === rel || (rel.endsWith('/') && path.startsWith(rel)))
}

/**
 * Attribute aggregate working-tree changes to sessions. Completed turns use main's safety-git boundary;
 * a currently busy turn may provisionally fall back to only its latest recorded edit tools. Deliberately
 * independent of focus: the row's loose count is a passive fact and must not jump when the user clicks
 * another session. Other touchers surface as `alsoBy` hints; unowned files fall to the null group.
 */
export function computeSessionChanges(
  sessions: Record<string, SessionState>,
  order: string[],
  files: GitStatusFile[],
  completionBySession: Record<string, TaskCompletionState> = {},
): SessionChanges {
  // Clean tree (the common case, incl. every streaming re-render before anything's edited) — skip the
  // per-session items walk entirely.
  if (files.length === 0) return { groups: [], alsoBy: {}, countBySession: {} }

  const edited: Record<string, string[]> = {}
  for (const id of order) {
    const session = sessions[id]
    if (session?.busy) edited[id] = editedPathsOfCurrentTurn(session)
  }

  const groups = new Map<string | null, GitStatusFile[]>()
  const alsoBy: Record<string, string[]> = {}
  const countBySession: Record<string, number> = {}
  const provisionalCountBySession: Record<string, number> = {}

  for (const f of files) {
    const evidenceOwners = order.filter((id) => {
      const completion = completionBySession[id]
      return completion?.state === 'loose-ends' && completionTouches(completion.paths, f.path)
    })
    // The transcript heuristic is provisional and current-turn-only. Restored/idle transcripts never
    // reclaim dirt after restart; absent main evidence means the honest Loose changes bucket.
    const fallbackOwners = order.filter(
      (id) =>
        completionBySession[id]?.state !== 'needs-check' &&
        edited[id] &&
        touches(edited[id], f.path),
    )
    const owners = [...evidenceOwners, ...fallbackOwners.filter((id) => !evidenceOwners.includes(id))]
    const primary = owners.length === 0 ? null : owners[0]
    if (!groups.has(primary)) groups.set(primary, [])
    groups.get(primary)!.push(f)
    if (
      primary &&
      fallbackOwners.includes(primary) &&
      !completionTouches(completionBySession[primary]?.paths ?? [], f.path)
    ) {
      provisionalCountBySession[primary] = (provisionalCountBySession[primary] ?? 0) + 1
    }
    const others = owners.filter((id) => id !== primary)
    if (others.length) alsoBy[f.path] = others.map((id) => sessions[id]?.label ?? 'a session')
  }

  // Order groups: sessions in `order` (newest-first), null bucket last.
  const ordered: SessionChangeGroup[] = []
  for (const id of order) {
    const fs = groups.get(id)
    if (fs && fs.length) ordered.push({ sessionId: id, label: sessions[id]?.label ?? 'Session', files: fs })
  }
  const orphan = groups.get(null)
  if (orphan && orphan.length) ordered.push({ sessionId: null, label: 'Loose changes', files: orphan })

  for (const id of order) {
    const exact =
      completionBySession[id]?.state === 'loose-ends'
        ? completionBySession[id].paths.filter((path) =>
            files.some((file) => completionTouches([path], file.path)),
          ).length
        : 0
    const count = exact + (provisionalCountBySession[id] ?? 0)
    if (count > 0) countBySession[id] = count
  }

  return { groups: ordered, alsoBy, countBySession }
}
