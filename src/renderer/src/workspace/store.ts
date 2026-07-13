import { create } from 'zustand'
import { clampLayout, DEFAULT_LAYOUT } from '@shared/ipc'
import type {
  ApprovalMode,
  ApprovalRequest,
  ArchivedSession,
  AsideEvent,
  BillingMode,
  MemoryWeight,
  ContextUsage,
  EngineEvent,
  EngineId,
  GitStatusFile,
  ModelSpend,
  PreviewRestart,
  ProviderStatusEvent,
  RateLimitInfo,
  WorkspaceLayoutSizes,
} from '@shared/ipc'
import { isModelAlias, prettyModel } from './models'
import type {
  Entry,
  SubagentChild,
  SubagentChildData,
  SubagentItem,
  TurnItem,
} from '../transcript/Transcript'
import type { TaskRow } from '../transcript/TaskList'

/** An image staged for the next turn (base64). Transient draft state — never persisted. */
export type ImageDraft = { mediaType: string; dataBase64: string }
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
  /** True once the user manually renamed this session. Locks the label: the local-assist auto-title
   *  upgrade (fired on the first turn) won't overwrite a name the user chose. Persisted. */
  userNamed: boolean
  /** The project dir this session runs in — persisted so a restored session resumes in the same
   *  place (resume is cwd-scoped; spike/resume). */
  cwd: string
  items: Entry[]
  streaming: string
  busy: boolean
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
  /** The engine's own native session/thread id, when it differs from Koda's `id` (Codex thread id;
   *  Claude reuses `id`). Captured from `SessionStarted` and persisted so a reattach resumes THAT
   *  thread by id (context preserved across a restart / model change). Undefined for Claude. */
  engineNativeId?: string
  /** The model the engine ACTUALLY reported running (system/init) — ground truth for display, not
   *  persisted (refreshed every reattach). Differs from `model` only briefly before a switch lands,
   *  or if the engine fell back from a retired id. */
  activeModel?: string
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
export interface FileSurface {
  /** 'file' (default) = a file pane keyed by its path. 'preview' = the project-level rendered-web
   *  surface (one slot per window; preview-surface.md). A preview has no real file path — its `path`
   *  is the reserved PREVIEW_SURFACE_ID sentinel so the rest of the tab machinery (dedup, close,
   *  split) works unchanged while never colliding with an absolute path. */
  kind?: 'file' | 'preview'
  /** Absolute path — also the stable tab identity (dedup on open). For a preview surface this is the
   *  PREVIEW_SURFACE_ID sentinel, not a filesystem path. */
  path: string
  /** Display label (basename; 'Preview' for the preview surface). */
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
  /** A line to reveal when the file opens in the Monaco editor (1-based) — set when a search hit
   *  opens the file. Ignored by the doc/diff views. */
  gotoLine?: number
  /** Bumped each time the file is (re-)opened at a line, so the editor re-reveals even when the tab
   *  was already open (an effect dep — see MonacoFileEditor). */
  gotoNonce?: number
  /** The session whose edit opened this as a diff — selects main's pinned turn-start baseline so the
   *  diff is cumulative-this-turn. Undefined for Files-browser opens (diff falls back to HEAD). */
  sessionId?: string
}

/**
 * One session's editor workbench — the open file/preview surfaces plus which are focused/split. The
 * dock is the ACTIVE session's editor (`editors[activeId]`), so tabs follow the session in the sidebar
 * and clear when it's gone, instead of accumulating every file ever opened across every task. The
 * agent's own edits land in the editor of the session that made them (showEditDiff/Doc carry the
 * sessionId) — a background session's diffs pile up in ITS workbench without disturbing what you're
 * looking at. Files opened with no active session (pre-session Files browsing) live under a sentinel key.
 */
export interface EditorState {
  surfaces: FileSurface[]
  /** What's ON STAGE (the dock's single surface); null ⇒ this session's stage is empty. */
  activeSurfaceId: string | null
  /** User pinned the stage: the agent's edits/preview pushes stop stealing it (they still land in
   *  `surfaces` + bump rev). User actions (open a file, pick from the switcher) always override. */
  pinned: boolean
}

const EMPTY_EDITOR: EditorState = { surfaces: [], activeSurfaceId: null, pinned: false }

/** Whether the agent's edit pushes should stop stealing the stage. True when the user explicitly
 *  pinned it, OR — the "soft pin" — when the preview is what's currently on stage: someone iterating
 *  on a page with the agent shouldn't get yanked back to a diff every time the agent touches a file.
 *  Soft because it needs no toggle and clears itself the moment the user picks another surface. */
function stageHeld(ed: EditorState): boolean {
  return ed.pinned || ed.activeSurfaceId === PREVIEW_SURFACE_ID
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

/** Dock open/closed is window UI state — persisted renderer-side (like the theme), so it survives a
 *  reload without an IPC/settings round-trip. Fails soft to open. (The dock is the STAGE now — one
 *  surface, no tool tabs — so `open` is all there is to remember; an old `{open, tool}` blob parses
 *  fine, the tool half is just ignored.) */
const DOCK_KEY = 'koda.dock'
function readDock(): { open: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY) ?? '')
    return { open: typeof v?.open === 'boolean' ? v.open : true }
  } catch {
    return { open: true }
  }
}

/** Reserved tab identity for the (single, per-window) preview surface. A NUL prefix can never be a
 *  real absolute path, so it slots into the path-keyed `surfaces` array without colliding. */
export const PREVIEW_SURFACE_ID = '\u0000preview'

/** Shape persisted to disk (mirrors the renderer-facing half of @shared PersistedSessions). v2 =
 *  per-project persistence; main keys the file by the window's project root, so projectPath stays
 *  out of this payload. */
export interface PersistedBlob {
  version: 2
  activeId: string | null
  sessions: {
    id: string
    label: string
    cwd: string
    userNamed?: boolean
    approvalMode?: ApprovalMode
    model?: string
    effort?: string
    engineId?: EngineId
    engineNativeId?: string
    context?: ContextUsage
    spendUsd?: number
    byModel?: Record<string, ModelSpend>
    lastPreview?: PreviewRestart
    items: Entry[]
  }[]
  /** Archived sessions — present only when HYDRATING (useEngineBridge merges them in from the cold
   *  archive file). persistBlob never writes them: the cold file is saved separately, only on change. */
  archived?: ArchivedSession[]
  /** Last-known account-level rate-limit windows (5-hour / weekly), so the footer survives a restart
   *  instead of going blank until the next turn re-emits them. `resetsAt` is absolute, so a restored
   *  value stays meaningful; the next turn refreshes it. */
  rateLimits?: Record<string, Record<string, RateLimitInfo>>
}

// The engine a new session defaults to — the last one the user picked, remembered across restarts
// (a small global preference, like the dock state). New sessions start here; the user can switch
// engine from the model dropdown before the first turn. Fails soft to 'claude'.
const LAST_ENGINE_KEY = 'koda.lastEngine'
function readLastEngine(): EngineId {
  return localStorage.getItem(LAST_ENGINE_KEY) === 'codex' ? 'codex' : 'claude'
}
function writeLastEngine(engineId: EngineId): void {
  try {
    localStorage.setItem(LAST_ENGINE_KEY, engineId)
  } catch {
    /* private mode / quota — last-engine memory is a nicety, never fatal */
  }
}

// The model a new session defaults to — the last one the user actually ran on, so the composer's model
// pill names a real model up front instead of a blank "Model" before the first turn. Stores an explicit
// pick (alias or full id, preserving alias auto-upgrade) or, for a "Default" session, the concrete model
// the engine resolved to (see SessionStarted). Belongs to `lastEngine` — the two are always written
// together on an engine switch, and each engine's SessionStarted overwrites it with that engine's model.
const LAST_MODEL_KEY = 'koda.lastModel'
function readLastModel(): string | undefined {
  return localStorage.getItem(LAST_MODEL_KEY) || undefined
}
function writeLastModel(model: string | undefined): void {
  try {
    if (model) localStorage.setItem(LAST_MODEL_KEY, model)
    else localStorage.removeItem(LAST_MODEL_KEY)
  } catch {
    /* private mode / quota — last-model memory is a nicety, never fatal */
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
// Sessions being ADOPTED from the phone right now — their buffered history is being replayed through
// the normal reducer. While a session's id is here, per-event side-effects that only make sense for a
// LIVE turn (native "finished" notifications, the working-tree git refresh) are suppressed, so
// replaying old TurnCompletes doesn't ping the user or thrash git for history they're just catching up on.
const replayingSessions = new Set<string>()
// Engine events that mean "a turn is actively running right now". Receiving any of these re-arms `busy`
// so the sidebar/status FOLLOWS the real engine turn — not just the optimistic flag set in dispatchTurn.
// A turn driven from the phone / relay goes straight through backend.sendTurn (bypassing dispatchTurn),
// so without this the desktop sidebar shows a session as idle (checkmark) while the agent is working.
// ToolResult is excluded on purpose: it can arrive AFTER a user interrupt/TurnComplete and must not
// re-arm a finished turn. Workflow events are excluded too — a workflow runs in the BACKGROUND and
// outlives its turn's TurnComplete, so arming on it would re-lock the composer after the turn ended.
// Subagents, by contrast, always complete inside the turn (their Task tool call blocks the result).
const ENGINE_ACTIVITY = new Set<EngineEvent['type']>([
  'ThinkingDelta',
  'AssistantDelta',
  'AssistantBlock',
  'ToolRequested',
  'SubagentStarted',
  'SubagentProgress',
])
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

/** A short clock time from unix seconds — for the "resets at 4:31 PM" fallback notice. */
function fmtClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Restore the full relative path behind `@`-mentions before the text reaches the engine. The composer
 *  inserts the pretty name (`@ship-checklist-iphone`) for readability; the agent needs an exact location
 *  to Read. We resolve each bare-name token (no slash) against the project's live doc list. Path-shaped
 *  tokens the user typed by hand, and names that match no doc, are left untouched. Runs only when the
 *  text actually contains an `@`, so the common no-mention turn skips the listDocs round-trip. */
async function expandDocMentions(text: string): Promise<string> {
  if (!text.includes('@')) return text
  // Bare-name tokens only: `@` at a word boundary, no slash (a slash means it's already a path).
  const re = /(^|\s)@([^\s/]+)/g
  if (!re.test(text)) return text
  const res = await window.koda.listDocs({}).catch(() => null)
  const docs = res?.docs ?? []
  if (!docs.length) return text
  // displayName → rel; docs arrive most-recent-first, so on a name collision the freshest doc wins.
  const byLabel = new Map<string, string>()
  for (const d of docs) {
    const label = d.name.replace(/\.[^.]+$/, '')
    if (!byLabel.has(label)) byLabel.set(label, d.rel)
  }
  return text.replace(/(^|\s)@([^\s/]+)/g, (m, pre: string, name: string) => {
    const rel = byLabel.get(name)
    return rel ? `${pre}@${rel}` : m
  })
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

interface WorkspaceStore {
  sessions: Record<string, SessionState>
  order: string[] // stable display order (replaces the old array order)
  activeId: string | null
  /** Archived (closed-but-kept) sessions, newest first. Persisted in the per-project blob; surfaced
   *  in Settings → Archived sessions for restore. */
  archived: ArchivedSession[]
  pending: ApprovalRequest[]
  /** Account-level subscription rate-limit windows, keyed by ENGINE then window type
   *  (`claude`/`codex` → `five_hour`/`weekly`). Each engine is a separate subscription with its own
   *  caps, so they never share a map. Not per-session — within one engine the windows are an account
   *  fact (newest update wins). Persisted so the footer survives a restart; refreshed on the next turn. */
  rateLimits: Record<string, Record<string, RateLimitInfo>>
  /** Engines mid provider-outage (feed-confirmed, main-watched), keyed by engine → the status-bar
   *  pill. Pushed over `providerStatus` + seeded on boot; not persisted (main re-seeds on reopen). */
  providerDown: Record<string, { note?: string }>
  applyProviderStatus: (e: ProviderStatusEvent) => void
  /** Billing mode, mirrored from main's settings (seeded on boot + onSettingsChanged). Drives the
   *  status-bar chip + the 'auto' fallback trigger in the RateLimitUpdate handler. */
  billingMode: BillingMode
  /** Whether the API key is what the next turn bills against right now (always true in 'api'; in 'auto'
   *  only while a confirmed fallback window is live). Mirrored from billing:getState. */
  apiActive: boolean
  /** 'auto' mode only: set when a plan-limit rejection lands and we haven't yet asked → renders the
   *  "continue on your API key?" banner. Carries the rejected window's resetsAt (the fallback expiry). */
  billingFallbackPrompt: { resetsAt: number } | null
  /** How heavy this project's always-injected memory pair is (memory:weight). Null until the first
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
  /** What the lower sidebar section shows: the doc-first flat **Documents** list (the everyday-user
   *  default — find your writing by glancing, no tree-spelunking) or the full **Files** tree (the
   *  organize/code view). In-memory only — every launch lands doc-first, deliberately. */
  filesView: 'docs' | 'tree'
  /** Conversation column width in px when an artifact (file/preview) is open beside it. Drag the
   *  divider between the conversation and the artifact zone. In-memory only. */
  conversationWidth: number
  /** Legacy 2-up-split fraction — the split died with the Stage, but the persisted-layout schema still
   *  round-trips it, so it stays as inert state. */
  artifactSplitFrac: number
  /** Whether the right dock (the Stage) is showing. Collapsed ⇒ the conversation takes the full
   *  width; nothing running is torn down (the preview server keeps going). Persisted (localStorage). */
  dockOpen: boolean
  /** The desk (the changes strip under the stage) is expanded into its review sheet. In-memory. */
  deskOpen: boolean
  setDeskOpen: (open: boolean) => void
  /** The terminal shelf under the stage is open. The xterm view stays mounted once first opened (the
   *  pty + scrollback survive); this only animates its height. In-memory. */
  termOpen: boolean
  setTermOpen: (open: boolean) => void
  /** A command the agent staged for the terminal (open_terminal): the TerminalSurfaceView types it at
   *  the prompt once the shell is ready, then clears it. Never auto-run. In-memory. */
  pendingTermCommand: string | null
  /** Pop the terminal shelf open (agent's open_terminal), optionally staging a command at the prompt. */
  openTerminalShelf: (command?: string) => void
  /** Clear the staged command once the terminal view has consumed it. */
  clearPendingTermCommand: () => void
  /** Pin/unpin the ACTIVE session's stage (see EditorState.pinned). */
  setStagePinned: (pinned: boolean) => void
  /** Preview focus mode: while the preview is on stage, hide the session workspace so the preview
   *  can use the full main area. In-memory only; it is a transient viewing mode. */
  previewExpanded: boolean
  /** Whether the open project is a git repo (drives the Changes surface + dirty indicators). Refreshed
   *  by refreshGitStatus (after each turn / on focus). In-memory. */
  gitRepo: boolean
  /** The user-git working-tree changes, aggregate across the whole project (one tree, all sessions).
   *  Attributed per session by computeSessionChanges. In-memory; refreshed, not persisted. */
  gitFiles: GitStatusFile[]
  /** True when the changed count exceeded the status cap and gitFiles is clipped. */
  gitChangesTruncated: boolean
  /** True when ANOTHER worktree (not this window's) has uncommitted work — drives the Versions badge so
   *  a past session's stranded work is visible without opening the surface. Refreshed with git status. */
  gitWorktreesDirty: boolean
  /** Re-read git repo state + working-tree status into gitRepo/gitFiles. Fire-and-forget; fails soft. */
  refreshGitStatus: () => Promise<void>
  /** Session whose change group the desk sheet should scroll to on open (set by openChanges,
   *  cleared by the surface once consumed). In-memory. */
  changesFocus: string | null
  /** Open the desk's review sheet, optionally scrolling to a session's change group. */
  openChanges: (focusSessionId?: string) => void
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
  /** Retry the failed turn behind the error banner: re-send the session's last user prompt as a fresh
   *  turn (what the user would do by hand). Clears the banner. No-op if there's no last prompt. */
  retryLastTurn: (sessionId: string) => void

  // lifecycle (IPC-driven)
  startSession: () => Promise<void>
  /** Pull this window's project's live headless (phone-started) sessions into the window: create a tab
   *  for each and replay its buffered history so the conversation shows up. Idempotent — skips sessions
   *  already open. Called after boot-hydrate and whenever a phone starts a session in this project. */
  adoptHeadless: () => Promise<void>
  /** A phone turn arrived on a session THIS window already owns (adopted before it had any turn). The
   *  engine stream never carries the human's prompt, so append it here — and, if the tab is still the
   *  unnamed "From your phone" default, run the same first-turn titling adoptHeadless does. */
  applyRemoteUserTurn: (sessionId: string, text: string) => void
  /** End a session's live agent and move it to the archive (keeps the whole conversation; restorable
   *  from Settings). Replaces the old hard close — nothing is deleted. */
  archiveSession: (id: string) => Promise<void>
  /** Reopen an archived session as a live tab (reattaches via --resume on its next turn). */
  restoreArchived: (id: string) => void
  /** Permanently drop an archived session (the one genuinely destructive session action). */
  deleteArchived: (id: string) => void
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
  /** Re-read this project's memory weight from main (status-bar poll + Settings → Memory on open). */
  refreshMemoryWeight: () => Promise<void>
  /** "Tidy memory" from Settings → Memory: composes a turn telling the agent to distill the
   *  always-injected pair per the memory skill's tidy recipe. Returns false if no session / busy. */
  sendMemoryTidy: () => Promise<boolean>
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
  setFilesView: (view: 'docs' | 'tree') => void
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
  setPreviewExpanded: (expanded: boolean) => void

  // surfaces (artifact zone)
  /** Open a file in the artifact zone (focuses its tab if already open). `gotoLine` (from a search
   *  hit) reveals that line in the Monaco editor view. `view` forces a starting view (e.g. open a
   *  `.md` skill/subagent as raw Markdown, not the WYSIWYG doc — those files are technical). */
  openFile: (path: string, gotoLine?: number, opts?: { view?: FileSurface['view'] }) => void
  /** Create a new empty document at the project root and open it (focused, in the Doc view). */
  newDocument: () => Promise<void>
  /** Create a new folder — at the project root, or inside `parent` (which is then expanded), or in
   *  the user's Documents/ home when `home` (the doc-first view's New folder). */
  newFolder: (parent?: string, home?: boolean) => Promise<void>
  /** Rename a file/folder in place (new basename in the same folder). Rebases any open tab + the
   *  Files tree's expansion to the new path on success. */
  renameEntry: (path: string, newName: string) => Promise<void>
  /** Move a file/folder into another folder (drag-and-drop). Same rebasing as rename. No-op if it's
   *  already there, or if dropping a folder into itself/a descendant. */
  moveEntry: (from: string, toDir: string) => Promise<void>
  /** Delete a file/folder (recursive). Closes any open tab under it. Checkpointed, so undoable. */
  deleteEntry: (path: string) => Promise<void>
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
  /** Close the preview surface. */
  closePreview: () => void
  /** Bring the preview on stage (dock open + preview focused), if one exists. Used by the agent's
   *  view_preview capture — an explicit "look at it", so it overrides a pin. */
  bringPreviewToStage: () => void
  /** Show/hide the dock. */
  setDockOpen: (open: boolean) => void
  /** Flip the dock open↔closed (the session-header toggle). */
  toggleDock: () => void

  // persistence
  hydrate: (blob: PersistedBlob) => void
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

  // Shared turn dispatch for every path that drives the engine (the composer + Canvas edits). Pushes an
  // optimistic transcript item, marks the session busy, lazily reattaches a restored session via
  // --resume, then sends. `sentText` is what the engine receives; `displayItem` is what the transcript
  // shows (they differ for a Canvas edit — a readable chip, but a fuller prompt to the agent).
  // `nameFromText` opts into first-turn session naming (composer only; a Canvas edit shouldn't rename).
  async function dispatchTurn(
    id: string,
    opts: { sentText: string; images?: ImageDraft[]; displayItem: TurnItem; nameFromText?: string },
  ): Promise<void> {
    const active = get().sessions[id]
    if (!active || active.busy) return
    const needsReattach = !active.live
    const cwd = active.cwd
    // Synchronous guard: two dispatches in one tick (before `busy` flushes) could both spawn a second
    // `claude --resume` and orphan the first child.
    if (needsReattach && reattaching.has(id)) return
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
      errored: false,
      error: undefined, // a fresh turn clears any prior error banner
      label: firstTurn && name ? titleFromPrompt(name) : s.label,
    }))
    // Interacting with a session (sending a turn) bumps it to the top — newest activity first. Merely
    // selecting a session to glance at it does NOT reorder (that would yank the list under the user).
    set((state) =>
      state.order[0] === id
        ? {}
        : { order: [id, ...state.order.filter((sid) => sid !== id)] },
    )
    if (firstTurn && name) {
      // Fire-and-forget on-device title upgrade; never blocks the turn, never rejects.
      void window.koda
        .assistTitle({ text: name })
        .then(({ title }) => {
          if (title.trim()) patchSession(id, (s) => (s.userNamed ? s : { ...s, label: title }))
        })
        .catch(() => {})
    }
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
        const engineNativeId = active.engineNativeId
        if (!firstTurn && engineId === 'codex' && !engineNativeId) {
          suppressStartNotice.delete(id)
          patchSession(id, (s) => ({ ...s, busy: false }))
          pushItem(id, {
            kind: 'notice',
            text:
              "Couldn't reattach this Codex session: Koda is missing the Codex thread id for it. Start a new chat to keep going.",
          })
          reattaching.delete(id)
          return
        }
        await window.koda.startSession(
          firstTurn
            ? { cwd, sessionId: id, planMode, model, effort, engineId }
            : { cwd, resumeSessionId: id, planMode, model, effort, engineId, engineNativeId },
        )
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
        return
      } finally {
        reattaching.delete(id)
      }
    }
    await window.koda.sendTurn({
      sessionId: id,
      text: opts.sentText,
      images: opts.images?.length ? opts.images : undefined,
    })
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
            ? { ...it, children: [...it.children, { ...child, id: childId } as SubagentChild] }
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

  const initialDock = readDock() // seed dock open/tool from the last session (localStorage)

  return {
    sessions: {},
    order: [],
    activeId: null,
    archived: [],
    pending: [],
    rateLimits: {},
    providerDown: {},
    applyProviderStatus: (e) =>
      set((state) => {
        const next = { ...state.providerDown }
        if (e.down) next[e.engine] = { note: e.note }
        else delete next[e.engine]
        return { providerDown: next }
      }),
    billingMode: 'subscription',
    apiActive: false,
    billingFallbackPrompt: null,
    memoryWeight: null,
    defaultApprovalMode: 'auto',
    projectPath: null,
    intakePending: false,
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
    filesView: 'docs', // doc-first by default; the tree is a deliberate toggle

    conversationWidth: DEFAULT_LAYOUT.conversationWidth,
    artifactSplitFrac: DEFAULT_LAYOUT.artifactSplitFrac,
    dockOpen: initialDock.open,
    deskOpen: false,
    termOpen: false,
    pendingTermCommand: null,
    previewExpanded: false,
    gitRepo: false,
    gitFiles: [],
    gitChangesTruncated: false,
    gitWorktreesDirty: false,
    changesFocus: null,
    searchOpen: false,
    lightbox: null,
    scratchTick: 0,
    recentImagesExpanded: false,
    recentFiles: [],
    hydrated: false,

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
      // Reconcile `busy` from the live stream so the sidebar follows the ACTUAL turn, including turns
      // started outside this renderer (phone/relay → backend.sendTurn, which never runs dispatchTurn).
      // Skip while a user interrupt is settling so a trailing event can't re-arm a turn just stopped.
      if (ENGINE_ACTIVITY.has(e.type) && !userInterrupted.has(sid))
        patchSession(sid, (s) => (s.busy ? s : { ...s, busy: true }))
      switch (e.type) {
        case 'SessionStarted': {
          // Record the model the engine actually reports running — ground truth for the model pill
          // (confirms a switch landed, or shows the engine default when the user picked nothing).
          // Capture the engine's native id (Codex thread id) so a later reattach can resume THAT thread.
          const hadModel = !!get().sessions[sid]?.model
          patchSession(sid, (s) => ({
            ...s,
            activeModel: e.model || undefined,
            // A phone-started session begins with no model pick, so its row would show blank and lose
            // the model on restart (activeModel isn't persisted). Adopt the engine's resolved model as
            // this session's model — but only on the FIRST SessionStarted (activeModel still unset): a
            // later respawn with no model is an explicit "Default" pick, which must stay unpinned.
            // Local sessions never inherit (undefined ⇒ "Default", which auto-upgrades).
            model: s.fromRemote && !s.model && !s.activeModel && e.model ? e.model : s.model,
            engineNativeId: e.engineNativeId ?? s.engineNativeId,
          }))
          // Seed the next new session's pill. An explicit pick was already remembered at pick time (keep
          // its alias for auto-upgrade); a "Default" session had no name to show, so remember the concrete
          // model the engine just resolved to — after any first turn, new sessions name a real model.
          if (!hadModel && e.model) writeLastModel(e.model)
          // A reattach (--resume) re-fires this; swallow its banner so restored history stays clean.
          if (suppressStartNotice.has(sid)) suppressStartNotice.delete(sid)
          // No banner in a fresh session — the composer's model pill owns model truth, and a spawn-time
          // readout can contradict it (the engine may boot on a default before the user's pick applies
          // at turn 1). A restart UNDER an existing conversation is the only start that's news.
          else if (get().sessions[sid]?.items.some((it) => it.kind !== 'notice'))
            pushItem(sid, {
              kind: 'notice',
              text: e.model ? `continuing on ${prettyModel(e.model)}` : 'session restarted',
            })
          break
        }
        case 'ApprovalModeChanged':
          // A change made on another surface (the phone) — route through the full action so the pill
          // updates, persistence saves it, and a plan crossing respawns. The echo of this window's own
          // change arrives as a same-value no-op there.
          get().setSessionApprovalMode(sid, e.mode)
          break
        case 'ModelEffortChanged':
          // A change made on another surface (the phone) — adopt the new pair so the pill follows and
          // the next reattach doesn't revert it. Patch directly (NOT setSessionModel): main already
          // respawned the engine with this pair, so the session stays live — and no re-push, so this
          // window's own echo can't loop. An engine flip also drops the old engine's ground-truth
          // fields (activeModel, Codex thread id), exactly as setSessionEngine does locally.
          patchSession(sid, (s) => ({
            ...s,
            model: e.model,
            effort: e.effort,
            ...(e.engineId && e.engineId !== s.engineId
              ? { engineId: e.engineId, activeModel: undefined, engineNativeId: undefined }
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
            addChild(sid, e.parentToolUseId, { kind: 'assistant', markdown: e.markdown })
          else {
            finalizeThinking(sid)
            patchSession(sid, (s) => ({ ...s, streaming: '' }))
            pushItem(sid, { kind: 'assistant', markdown: e.markdown })
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
            pushItem(sid, { kind: 'tool', toolUseId: e.id, name: e.name, input: e.input })
          }
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
                ? { ...it, result: e.output, isError: e.isError }
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
            subagentType: e.subagentType,
            description: e.description,
            prompt: e.prompt,
            status: 'running',
            children: [],
          })
          break
        case 'WorkflowStarted':
          finalizeThinking(sid)
          pushItem(sid, { kind: 'workflow', runId: e.runId, name: e.name, status: 'running', agents: [] })
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
          mutateWorkflow(sid, e.runId, (w) => ({ ...w, status: 'completed' }))
          raiseAttention(sid, 'done') // a backgrounded workflow finishing pings the user
          break
        case 'SubagentProgress': {
          const patch: Partial<SubagentItem> = {}
          if (e.status === 'completed') patch.status = 'completed'
          if (e.description) patch.liveStatus = e.description // live one-liner, not task identity
          if (e.lastToolName) patch.lastToolName = e.lastToolName
          if (e.usage) patch.usage = e.usage
          updateSubagent(sid, e.toolUseId, patch)
          break
        }
        case 'SubagentCompleted':
          updateSubagent(sid, e.toolUseId, {
            status: 'completed',
            isError: e.isError,
            ...(e.resultText ? { resultText: e.resultText } : {}),
            ...(e.usage ? { usage: e.usage } : {}),
          })
          break
        case 'TurnComplete': {
          finalizeThinking(sid) // covers a thinking-only turn that produced no text
          patchSession(sid, (s) => ({
            ...s,
            streaming: '',
            busy: false,
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
          raiseAttention(sid, 'done')
          // A completed turn is the moment the working tree most likely changed — refresh the dirty
          // state that feeds the per-session chips + Changes surface (aggregate, so any session's turn
          // updates the shared picture). Fire-and-forget. Skipped while replaying an adopted session's
          // history — one refresh after the replay settles covers it (see adoptHeadless).
          if (!replayingSessions.has(sid)) void get().refreshGitStatus()
          break
        }
        case 'RateLimitUpdate': {
          // Account-level window — attribute it to the EMITTING session's engine (each engine is its own
          // subscription), then store by type (five_hour/weekly), newest wins within that engine.
          const rlEngine = get().sessions[sid]?.engineId ?? 'claude'
          set((state) => ({
            rateLimits: {
              ...state.rateLimits,
              [rlEngine]: { ...(state.rateLimits[rlEngine] ?? {}), [e.info.rateLimitType]: e.info },
            },
          }))
          // 'auto' billing: a 'rejected' window means the plan limit is hit (the engine guide confirms it
          // lands at the END of the crossing turn, so the NEXT turn is blocked → switch forward). Raise
          // the one-time "continue on your API key?" banner. We re-fetch live billing state rather than
          // trust the mirrored `apiActive` — that only refreshes on settings broadcasts, so after a prior
          // window's fallback EXPIRED in main, a stale `true` here would wrongly suppress the next prompt.
          const resetsAt = e.info.resetsAt
          if (
            !replayingSessions.has(sid) && // a replayed historical 'rejected' isn't live news — don't pop the banner
            rlEngine === 'claude' && // the API-key fallback bills an Anthropic key; a Codex window can't trigger it
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
          const banner = e.category === 'apiError' || e.fatal
          // Only a FATAL error ends the turn (an apiError is followed by its own turn-ending `result`);
          // clearing busy on a mid-turn non-fatal notice would flip the sidebar to idle under a live turn.
          patchSession(sid, (s) => ({
            ...s,
            busy: e.fatal ? false : s.busy,
            errored: e.fatal ? true : s.errored,
            ...(banner ? { error: { message: e.message, fatal: e.fatal } } : {}),
          }))
          // A fatal error ends the turn too (see the TurnComplete invariant): drop any now-stale prompt so
          // the session doesn't die stuck on "Needs your approval". Non-fatal notices leave the turn live.
          if (e.fatal) get().cancelPending(sid)
          if (banner) {
            // The banner is the report; suppress the abnormal-stop footer from the `result` that follows.
            bannerErrored.add(sid)
            raiseAttention(sid, 'error')
          } else {
            pushItem(sid, { kind: 'notice', text: `⚠ engine notice: ${e.message}` })
          }
          break
        }
      }
    },

    addPending: (req) => {
      set((state) => ({ pending: [...state.pending, req] }))
      raiseAttention(req.sessionId, 'waiting')
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
      patchSession(sessionId, (x) => ({ ...x, busy: false, error: undefined }))
    },

    retryLastTurn: (sessionId) => {
      const s = get().sessions[sessionId]
      if (!s || s.busy) return
      // Re-send the last user prompt (image turns re-send text-only — the common failure is a text turn).
      const lastUser = [...s.items].reverse().find((it) => it.kind === 'user') as
        | { kind: 'user'; text: string }
        | undefined
      const text = lastUser?.text?.trim()
      if (!text || text === '(image)') {
        // Nothing sensible to re-send — just clear the banner so the composer is usable again.
        patchSession(sessionId, (x) => ({ ...x, error: undefined }))
        return
      }
      void dispatchTurn(sessionId, { sentText: text, displayItem: { kind: 'user', text } })
    },

    startSession: async () => {
      // New sessions start in the default posture (never plan) — picking Plan in the composer
      // reattaches the session in plan mode on its next turn (see setSessionApprovalMode). The engine
      // defaults to the last one the user picked; they can switch it from the model dropdown until the
      // first turn (after that the conversation is bound to its engine).
      const engineId = readLastEngine()
      const model = readLastModel() // pin the last model so the pill names it before the first turn
      const { sessionId, cwd } = await window.koda.startSession({ engineId })
      const label = 'New session' // placeholder until the first turn names it (titleFromPrompt → assistTitle)
      const approvalMode = get().defaultApprovalMode
      set((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            id: sessionId,
            label,
            userNamed: false,
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
        if (get().sessions[s.id]) continue // already open in this window (idempotent re-call)
        any = true
        // Create the tab first so the replay + subsequent live events have a session to land in. It's
        // `live: true` — the engine is already running on main; a Mac turn sends straight through (no
        // reattach). approvalMode follows this window's default (the gate's per-session posture was set
        // when the phone started it).
        set((state) => ({
          sessions: {
            ...state.sessions,
            [s.id]: {
              id: s.id,
              label: 'From your phone',
              userNamed: false,
              cwd: s.cwd,
              items: [],
              streaming: '',
              busy: false,
              errored: false,
              draft: '',
              attachments: [],
              live: true,
              attention: false,
              approvalMode: state.defaultApprovalMode,
              engineId: s.engineId,
              model: s.model,
              spendUsd: 0,
              byModel: {},
              fromRemote: true,
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
            if (entry.type === 'RemoteUserTurn') pushItem(s.id, { kind: 'user', text: entry.text })
            else get().applyEngineEvent(entry)
          }
        } finally {
          replayingSessions.delete(s.id)
          suppressStartNotice.delete(s.id)
        }
        // Name the tab from its first user turn (mirrors first-turn naming), falling back to the marker.
        // A phone-started session never ran through dispatchTurn locally, so it also never got the
        // on-device AI title upgrade — mirror both stages here: the instant prompt-word title, then the
        // fire-and-forget assistTitle refinement (skipped only if the user has since named it).
        const first = get().sessions[s.id]?.items.find((it) => it.kind === 'user') as
          | { kind: 'user'; text: string }
          | undefined
        if (first?.text.trim()) {
          patchSession(s.id, (ss) => ({ ...ss, label: titleFromPrompt(first.text) }))
          void window.koda
            .assistTitle({ text: first.text })
            .then(({ title }) => {
              if (title.trim())
                patchSession(s.id, (ss) => (ss.userNamed ? ss : { ...ss, label: title }))
            })
            .catch(() => {})
        }
      }
      // One git refresh after replay settles (the per-turn refreshes were suppressed during replay).
      if (any) void get().refreshGitStatus()
      // Fill a blank window: if nothing's selected (e.g. a project whose only sessions are phone-started),
      // focus the newest. Never yanks focus from a session the user is already looking at.
      if (any && !get().activeId) set({ activeId: get().order[0] })
    },

    applyRemoteUserTurn: (sessionId, text) => {
      const s = get().sessions[sessionId]
      if (!s) return // not owned by this window — nothing to append to
      // This is the session's first real prompt if nothing before it was one (an image-only turn shows
      // as "(image)" and never names the tab). Decide BEFORE appending so the new turn isn't counted.
      const hadPrompt = s.items.some((it) => it.kind === 'user' && it.text.trim() && it.text !== '(image)')
      pushItem(sessionId, { kind: 'user', text: text || '(image)' })
      // Mirror adoptHeadless's first-turn naming: the session was adopted empty (before any turn), so it
      // never got titled. Instant first-words label, then the fire-and-forget assistTitle upgrade.
      if (!s.userNamed && !hadPrompt && text.trim()) {
        patchSession(sessionId, (ss) => ({ ...ss, label: titleFromPrompt(text) }))
        void window.koda
          .assistTitle({ text })
          .then(({ title }) => {
            if (title.trim()) patchSession(sessionId, (ss) => (ss.userNamed ? ss : { ...ss, label: title }))
          })
          .catch(() => {})
      }
    },

    archiveSession: async (id) => {
      window.koda.disposeSession({ sessionId: id }).catch(console.error)
      set((state) => {
        const s = state.sessions[id]
        if (!s) return {}
        // Snapshot the durable payload (same fields the persist blob keeps) + an archive stamp, so it
        // restores byte-identical and reattaches via --resume just like a boot-restored session.
        const entry: ArchivedSession = {
          id: s.id,
          label: s.label,
          cwd: s.cwd,
          userNamed: s.userNamed,
          approvalMode: s.approvalMode,
          model: s.model,
          effort: s.effort,
          engineId: s.engineId,
          engineNativeId: s.engineNativeId,
          context: s.context,
          spendUsd: s.spendUsd,
          byModel: s.byModel,
          items: s.items,
          archivedAt: Date.now(),
        }
        const rest = { ...state.sessions }
        delete rest[id]
        const order = state.order.filter((sid) => sid !== id)
        const activeId =
          state.activeId === id ? (order.length ? order[0] : null) : state.activeId
        // Drop the session's editor workbench too — its tabs die with it.
        const editors = { ...state.editors }
        delete editors[id]
        return {
          sessions: rest,
          order,
          activeId,
          editors,
          pending: state.pending.filter((r) => r.sessionId !== id),
          archived: [entry, ...state.archived],
        }
      })
    },

    restoreArchived: (id) => {
      set((state) => {
        const a = state.archived.find((x) => x.id === id)
        if (!a) return {}
        // Already open (shouldn't happen) — just focus it and drop the stale archive entry.
        if (state.sessions[id])
          return { activeId: id, archived: state.archived.filter((x) => x.id !== id) }
        const items = (a.items as Entry[]).map(settleRestoredItem)
        // Bump the entry counter past the restored items so new entries can't collide with them (the
        // boot hydrate only counted live sessions; an archive can hold higher ids than the current max).
        for (const it of items) {
          if (it.id > entryId) entryId = it.id
          if (it.kind === 'subagent')
            for (const c of it.children) if (c.id > entryId) entryId = c.id
        }
        const session: SessionState = {
          id: a.id,
          label: a.label,
          userNamed: a.userNamed ?? false,
          cwd: a.cwd,
          items,
          context: a.context,
          streaming: '',
          busy: false,
          errored: false,
          draft: '',
          attachments: [],
          live: false, // engine not spawned — reattaches via --resume on its next turn
          attention: false,
          approvalMode: a.approvalMode ?? state.defaultApprovalMode,
          model: a.model,
          effort: a.effort,
          engineId: a.engineId ?? 'claude',
          engineNativeId: a.engineNativeId,
          spendUsd: a.spendUsd ?? 0,
          byModel: a.byModel ?? {},
        }
        return {
          sessions: { ...state.sessions, [id]: session },
          order: [id, ...state.order],
          activeId: id,
          archived: state.archived.filter((x) => x.id !== id),
        }
      })
    },

    deleteArchived: (id) =>
      set((state) => ({ archived: state.archived.filter((x) => x.id !== id) })),

    send: async () => {
      const { activeId, sessions } = get()
      const active = activeId ? sessions[activeId] : null
      if (!active || active.busy) return
      const text = active.draft
      const images = active.attachments
      if (!text.trim() && images.length === 0) return // nothing to send
      const id = active.id
      // Same synchronous double-send guard dispatchTurn applies, re-checked here so we don't consume
      // (clear) the composer for a dispatch that would early-return on a racing reattach.
      if (!active.live && reattaching.has(id)) return
      // Ambient open-file context: tell the agent which file the user is looking at — a doc OR a code
      // file (a diff counts; a preview doesn't) — so "shorten the intro" / "fix this" work without an
      // explicit selection. The transcript shows the raw text; only the engine sees the hint, and only
      // when the user actually typed something. The composer shows the same file as a visible cue.
      const ed = activeEditor(get())
      const activeFile = ed.surfaces.find((s) => s.path === ed.activeSurfaceId && s.kind !== 'preview')
      const noun = activeFile && isMarkdown(activeFile.path) ? 'document' : 'file'
      // Engine-facing text restores the full path behind any pretty `@`-mention; the transcript keeps
      // the clean name (displayItem uses `text` below).
      const engineText = await expandDocMentions(text)
      const docText =
        activeFile && text.trim()
          ? `${engineText}\n\n(I'm currently looking at the ${noun} \`${activeFile.path}\` in Koda — if this is about it, work with that file.)`
          : engineText
      // Clear the composer optimistically; dispatchTurn pushes the transcript item + drives the send.
      // Naming from the first prompt happens inside dispatchTurn (nameFromText).
      patchSession(id, (s) => ({ ...s, draft: '', attachments: [], replyStaged: false }))
      // Persist the attached images to the project's scratch folder so they outlive the conversation and
      // the agent can re-read them by path later (they're ALSO sent inline below for the immediate turn).
      // Best-effort: a save failure (no project open, fs error) just means no durable copy — never blocks
      // the turn. The saved paths are appended to the ENGINE text only (the transcript shows raw text).
      let sentText = docText
      if (images.length) {
        const saved = await Promise.all(
          images.map(async (img) => {
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
      await dispatchTurn(id, {
        sentText,
        images,
        displayItem: { kind: 'user', text, images: images.length ? images : undefined },
        nameFromText: text,
      })
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
        displayItem: { kind: 'canvas', docTitle: basename(path), instruction: instr },
      })
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
      await dispatchTurn(id, {
        sentText,
        displayItem: { kind: 'user', text: `New ${kind}: ${desc}` },
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
        `This project's memory in .koda/memory/ has grown heavy. The two files that load into every ` +
        `conversation (the MEMORY.md index and active-context.md) are now big enough to weigh every turn down. ` +
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
      expandDocMentions(q)
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
      patchSession(id, (s) => ({ ...s, attachments: [...s.attachments, ...imgs] })),
    removeAttachment: (id, index) =>
      patchSession(id, (s) => ({ ...s, attachments: s.attachments.filter((_, i) => i !== index) })),

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
        if (s?.live && !s.busy && !pendingIds.has(id)) patchSession(id, (x) => ({ ...x, live: false }))
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
      // `plan` is the engine's real --permission-mode (read-only); the other three are pure gate
      // tiers. Crossing the plan boundary needs a respawn — the engine can't switch --permission-mode
      // live on a -p process. A respawn would kill an in-flight turn or strand a pending approval, so
      // the control blocks the cross while either is outstanding.
      const crossesPlan = (mode === 'plan') !== (s.approvalMode === 'plan')
      if (crossesPlan && (s.busy || get().pending.some((r) => r.sessionId === id))) return
      patchSession(id, (x) => ({ ...x, approvalMode: mode }))
      // Tell main in EVERY case (fire-and-forget). ask ↔ acceptEdits ↔ auto is the live gate switch
      // (no-op if the engine isn't live yet — re-pushed on reattach in send()). For a plan crossing the
      // gate value is moot until the respawn, but pushing now broadcasts ApprovalModeChanged so other
      // surfaces (the phone sheet) follow immediately instead of at the next turn's re-push.
      window.koda.setApprovalMode({ sessionId: id, mode }).catch(console.error)

      if (!crossesPlan) return
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
      if (s.busy || get().pending.some((r) => r.sessionId === id)) return
      patchSession(id, (x) => ({ ...x, model }))
      writeLastModel(model) // seed the next new session (undefined "Default" clears it — SessionStarted refills concrete)
      // Remember an explicit full id so it's a quick-pick next time (engine aliases are always offered,
      // so they're not worth remembering). This is Koda's substitute for an enumerable model list.
      // Claude only — Codex models come from the engine's own model/list, not the typed-id recents.
      if (s.engineId === 'claude' && model && !isModelAlias(model)) window.koda.addRecentModel({ model }).catch(console.error)
      // Tell main at pick time (fire-and-forget, like setApprovalMode) so a real change broadcasts
      // ModelEffortChanged to the phone and main's map reads fresh — not stale until the next reattach.
      window.koda.setModelEffort({ sessionId: id, model, effort: s.effort }).catch(console.error)
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
      if (s.busy || get().pending.some((r) => r.sessionId === id)) return
      if (engineId === s.engineId && model === s.model) return
      writeLastEngine(engineId) // remember as the new-session default
      writeLastModel(model) // keep last-model aligned with last-engine (both seed the next new session)
      // Recents are the Claude group's "recently typed" ids; Codex models come from the engine's own
      // model/list, so don't pollute the Claude recents with a gpt-* id.
      if (engineId === 'claude' && model && !isModelAlias(model)) window.koda.addRecentModel({ model }).catch(console.error)
      // Drop the old engine's ground-truth fields: `activeModel` (what the pill falls back to when no
      // model is picked) and `engineNativeId` (the Codex thread id) both describe the abandoned engine.
      // Leaving `activeModel` makes a "Default" pick on the new engine still show the old engine's model
      // in the pill (e.g. switch to Claude Default → pill keeps reading Codex's stale "gpt-5.5"). The
      // new engine re-reports both on its next SessionStarted.
      patchSession(id, (x) => ({ ...x, engineId, model, activeModel: undefined, engineNativeId: undefined }))
      // Pick-time push (see setSessionModel) — carries engineId so the phone's sheet switches groups too.
      window.koda.setModelEffort({ sessionId: id, model, effort: s.effort, engineId }).catch(console.error)
      // Drop the live engine so the next turn spawns the new engine fresh (send() reads engineId+model).
      // No prior transcript to resume (guarded above), so it's a clean --session-id respawn.
      if (s.live) patchSession(id, (x) => ({ ...x, live: false }))
    },

    setSessionEffort: (id, effort) => {
      const s = get().sessions[id]
      if (!s || effort === s.effort) return
      // Spawn-time like --model: a respawn would kill an in-flight turn or strand a pending approval,
      // so block the switch while either is outstanding.
      if (s.busy || get().pending.some((r) => r.sessionId === id)) return
      patchSession(id, (x) => ({ ...x, effort }))
      // Pick-time push (see setSessionModel) — always the full pair so model doesn't reset to default.
      window.koda.setModelEffort({ sessionId: id, model: s.model, effort }).catch(console.error)
      // Drop the live engine so the next turn reattaches with the new --effort (send() reads `effort`).
      if (s.live) patchSession(id, (x) => ({ ...x, live: false }))
    },

    renameSession: (id, name) => {
      const trimmed = name.trim()
      if (!trimmed) return
      patchSession(id, (s) => ({ ...s, label: trimmed, userNamed: true }))
    },

    setProjectPath: (projectPath) => set({ projectPath }),

    setIntakePending: (intakePending) => set({ intakePending }),

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
      // Engine-neutral: "take a look at what's already here" handles existing folders too; the agent
      // writes its own native guidance file (CLAUDE.md for Claude, AGENTS.md for Codex) — we don't dictate.
      // Three jobs woven in: (1) the project guide [Layer-3 state], (2) a .koda/memory brief [the
      // "what-this-is" half], (3) a just-in-time tool top-up via ensure_tool when the project implies one.
      const sentText = `I'm setting up this project in Koda. Here's what it's about:\n\n"""\n${desc}${extra}\n"""\n\nHelp me get this project set up. First take a quick look at what's already here (there may be nothing yet). Then ask me the two or three questions whose answers would change what you build or how you set it up, and suggest anything I haven't thought of — you've built things like this before; I may not have. Once we've shaped it:\n\n1. Write a short, friendly project guide as your guidance file at the project root — what we're building, who it's for, what success looks like, and any constraints — as concise guidance for you to follow on later turns. Keep it human and in plain language (this is for a non-engineer).\n2. Jot a brief note in .koda/memory/ capturing what this project is, so you can orient quickly in future sessions.\n3. If this project clearly needs a language runtime or tool that isn't set up yet (for example Python for a data project), set it up with your ensure_tool capability — I'll confirm.\n\nWhen you're done, tell me in one line what you set up.`
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
    setFilesView: (view) => set({ filesView: view }),
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
    setPreviewExpanded: (expanded) => {
      // Expanding is a user act on the preview — make sure it's the thing on stage first.
      get().bringPreviewToStage()
      set({ previewExpanded: expanded, dockOpen: true })
    },
    setLightbox: (img) => set({ lightbox: img }),
    toggleRecentImagesExpanded: () =>
      set((s) => ({ recentImagesExpanded: !s.recentImagesExpanded })),

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
        const surfaces = existing
          ? // Already open — refocus, apply any forced view, and re-trigger a line reveal (bump nonce).
            ed.surfaces.map((s) =>
              s.path === path
                ? {
                    ...s,
                    ...(opts?.view ? { view: opts.view } : {}),
                    ...(gotoLine ? { gotoLine, gotoNonce: (s.gotoNonce ?? 0) + 1 } : {}),
                  }
                : s,
            )
          : [...ed.surfaces, { path, title: basename(path), view, rev: 0, gotoLine, gotoNonce: 0 }]
        return {
          // A user open is explicit intent — it takes the stage and releases a pin (the pin guards
          // against the AGENT yanking the stage, never against the user's own hand).
          ...withEditor(state.editors, key, { surfaces, activeSurfaceId: path, pinned: false }),
          // MRU for the Find overlay's quick-open: this path to the front, deduped, capped.
          recentFiles: [path, ...state.recentFiles.filter((p) => p !== path)].slice(0, 12),
          dockOpen: true,
        }
      }),

    newDocument: async () => {
      const { path } = await window.koda.createFile({})
      // Nudge the Files tree to re-read so the new doc appears, then open it (markdown ⇒ Doc view).
      set((state) => ({ filesRev: state.filesRev + 1 }))
      get().openFile(path)
    },

    newFolder: async (parent, home) => {
      try {
        await window.koda.createDir(parent ? { parent } : home ? { home: true } : {})
        if (parent) get().setDirOpen(parent, true) // reveal where the new folder landed
        set((state) => ({ filesRev: state.filesRev + 1, treeError: null }))
      } catch (e) {
        set({ treeError: humanFsError(e) })
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

    deleteEntry: async (path) => {
      try {
        await window.koda.deletePath({ path })
        get().notePathDeleted(path)
        set({ treeError: null })
      } catch (e) {
        set({ treeError: humanFsError(e) })
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
    notePathMoved: (from, to) =>
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
        return { editors, openDirs: state.openDirs.map(reb), filesRev: state.filesRev + 1 }
      }),

    // Close any tab under a deleted path (across every session's editor) and drop its tree expansion.
    notePathDeleted: (path) =>
      set((state) => {
        const under = (p: string): boolean => p === path || p.startsWith(path + '/')
        const editors = mapEditors(state.editors, (ed) => {
          const surfaces = ed.surfaces.filter((s) => !under(s.path))
          const activeSurfaceId =
            ed.activeSurfaceId && under(ed.activeSurfaceId)
              ? (surfaces[surfaces.length - 1]?.path ?? null)
              : ed.activeSurfaceId
          return { ...ed, surfaces, activeSurfaceId }
        })
        return { editors, openDirs: state.openDirs.filter((p) => !under(p)), filesRev: state.filesRev + 1 }
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
              s.path === path ? { ...s, view: 'diff' as const, rev: s.rev + 1, sessionId } : s,
            )
          : [...ed.surfaces, { path, title: basename(path), view: 'diff' as const, rev: 0, sessionId }]
        return withEditor(state.editors, sessionId, {
          ...ed,
          surfaces,
          // Pop the just-edited file onto the stage so the user watches the change land — unless the
          // stage is HELD (pinned, or the preview is on stage: soft pin). The edit still lands in
          // `surfaces` + bumps rev; only focus is withheld.
          // Deliberately NOT touching dockOpen: agent edits fire constantly; a collapsed dock stays put.
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
              s.path === path ? { ...s, view: 'doc' as const, rev: s.rev + 1, sessionId } : s,
            )
          : [...ed.surfaces, { path, title: basename(path), view: 'doc' as const, rev: 0, sessionId }]
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
          surfaces: ed.surfaces.map((s) => (s.path === path ? { ...s, view } : s)),
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
        const surfaces = ed.surfaces.filter((s) => s.path !== path)
        // Closing the staged surface falls back to the neighbour; closing the last empties the stage.
        const activeSurfaceId =
          ed.activeSurfaceId === path
            ? (surfaces[surfaces.length - 1]?.path ?? null)
            : ed.activeSurfaceId
        return withEditor(state.editors, key, { ...ed, surfaces, activeSurfaceId })
      }),

    selectSurface: (path) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        // Picking from the stage switcher is explicit user intent — it releases a pin (like openFile).
        return withEditor(state.editors, key, { ...ed, activeSurfaceId: path, pinned: false })
      }),

    setStagePinned: (pinned) =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        return withEditor(state.editors, key, { ...ed, pinned })
      }),

    openPreview: (url, opts) =>
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
              s.kind === 'preview' ? { ...s, previewUrl: url, rev: s.rev + 1 } : s,
            )
          : [
              ...ed.surfaces,
              { kind: 'preview' as const, path: PREVIEW_SURFACE_ID, title: 'Preview', view: 'file' as const, rev: 0, previewUrl: url },
            ]
        // Agent-pushed previews respect a pinned stage (the URL still updates behind it); user opens
        // take the stage.
        const takeStage = !(opts?.respectPin && ed.pinned)
        // The dock is window-global and renders the ACTIVE session's editor — so only pop it open when
        // the preview lands on the session in front. A background session's push stages itself in its
        // own editor (seen when the user switches to it) without yanking the dock over another session.
        const isActive = key === editorKey(state)
        return {
          ...withEditor(state.editors, key, {
            ...ed,
            surfaces,
            activeSurfaceId: takeStage ? PREVIEW_SURFACE_ID : ed.activeSurfaceId,
          }),
          ...(isActive ? { dockOpen: true } : {}),
        }
      }),

    bringPreviewToStage: () =>
      set((state) => {
        const key = editorKey(state)
        const ed = state.editors[key] ?? EMPTY_EDITOR
        if (!ed.surfaces.some((s) => s.kind === 'preview')) return {}
        return {
          ...withEditor(state.editors, key, { ...ed, activeSurfaceId: PREVIEW_SURFACE_ID }),
          dockOpen: true,
        }
      }),

    rememberPreview: (sessionId, restart) => patchSession(sessionId, (s) => ({ ...s, lastPreview: restart })),

    closePreview: () => get().closeSurface(PREVIEW_SURFACE_ID),

    refreshGitStatus: async () => {
      // Core path first: repo state + working-tree status. This must NOT depend on anything newer,
      // so a stale preload (HMR doesn't reload preload) can't take git detection down with it.
      try {
        const info = await window.koda.gitDetect()
        if (!info.isRepo) {
          set({ gitRepo: false, gitFiles: [], gitChangesTruncated: false, gitWorktreesDirty: false })
          return
        }
        const status = await window.koda.gitStatus()
        set({ gitRepo: true, gitFiles: status.files, gitChangesTruncated: status.truncated })
      } catch (err) {
        // Non-fatal — a missing project/window or a git hiccup just leaves the last-known state.
        console.error('refreshGitStatus failed', err)
        return
      }
      // The worktree badge is strictly additive + best-effort. Optional-call (`?.()`) so a preload
      // that predates gitWorktrees short-circuits to undefined instead of throwing synchronously, and
      // catch any IPC rejection — either way it degrades to "no worktree info", never breaking above.
      try {
        const worktrees = (await window.koda.gitWorktrees?.()) ?? []
        set({ gitWorktreesDirty: worktrees.some((w) => !w.isCurrent && w.dirtyCount > 0) })
      } catch (err) {
        console.error('refreshGitStatus: worktrees skipped', err)
      }
    },

    openChanges: (focusSessionId) => {
      set({ deskOpen: true, dockOpen: true, changesFocus: focusSessionId ?? null })
      void get().refreshGitStatus()
    },

    setDockOpen: (open) => set({ dockOpen: open, previewExpanded: open ? get().previewExpanded : false }),
    toggleDock: () =>
      set((state) => {
        const dockOpen = !state.dockOpen
        return { dockOpen, previewExpanded: dockOpen ? state.previewExpanded : false }
      }),
    setDeskOpen: (open) => set({ deskOpen: open }),
    setTermOpen: (open) => set({ termOpen: open, dockOpen: open ? true : get().dockOpen }),
    openTerminalShelf: (command) =>
      set({ termOpen: true, dockOpen: true, pendingTermCommand: command && command.trim() ? command : null }),
    clearPendingTermCommand: () => set({ pendingTermCommand: null }),

    hydrate: (blob) => {
      const archived = blob.archived ?? []
      // Advance the id/label counters past BOTH live AND archived sessions, so a later restore (or a
      // new session) can never reissue an entry id or "Session N" label an archived session still holds.
      let maxEntryId = 0
      const scanItems = (items: Entry[]): void => {
        for (const it of items) {
          if (it.id > maxEntryId) maxEntryId = it.id
          if (it.kind === 'subagent')
            for (const c of it.children) if (c.id > maxEntryId) maxEntryId = c.id
        }
      }
      for (const s of blob.sessions) scanItems(s.items)
      for (const a of archived) scanItems(a.items as Entry[])
      entryId = maxEntryId
      if (!blob.sessions.length) {
        set({ archived, hydrated: true, rateLimits: blob.rateLimits ?? {} })
        return
      }
      const sessions: Record<string, SessionState> = {}
      for (const s of blob.sessions)
        sessions[s.id] = {
          id: s.id,
          label: s.label,
          userNamed: s.userNamed ?? false,
          cwd: s.cwd,
          // Settle live-only item states: no engine is attached yet, so a thinking burst or workflow
          // that was in flight when we last saved must not restore as a forever-spinning indicator.
          items: s.items.map(settleRestoredItem),
          context: s.context, // restore the fuel gauge; refreshed on the next completed turn
          streaming: '',
          busy: false,
          errored: false,
          draft: '',
          attachments: [],
          live: false, // engine not spawned yet — reattaches on the next turn
          attention: false,
          approvalMode: s.approvalMode ?? get().defaultApprovalMode,
          model: s.model, // activeModel refreshes when the engine reattaches next turn
          effort: s.effort,
          engineId: s.engineId ?? 'claude',
          engineNativeId: s.engineNativeId,
          spendUsd: s.spendUsd ?? 0,
          byModel: s.byModel ?? {},
          lastPreview: s.lastPreview, // one-click "Restart preview" survives the restart
        }
      set({
        sessions,
        order: blob.sessions.map((s) => s.id),
        activeId: blob.activeId ?? blob.sessions[0]?.id ?? null,
        archived,
        hydrated: true,
        rateLimits: blob.rateLimits ?? {},
      })
    },

    persistBlob: () => {
      const { order, sessions, activeId } = get()
      return {
        version: 2,
        activeId,
        rateLimits: get().rateLimits,
        sessions: order
          .map((id) => sessions[id])
          .filter(Boolean)
          .map((s) => ({
            id: s.id,
            label: s.label,
            cwd: s.cwd,
            userNamed: s.userNamed,
            approvalMode: s.approvalMode,
            model: s.model,
            effort: s.effort,
            engineId: s.engineId,
            engineNativeId: s.engineNativeId,
            context: s.context,
            spendUsd: s.spendUsd,
            byModel: s.byModel,
            lastPreview: s.lastPreview,
            items: s.items,
          })),
        // `archived` deliberately absent: it lives in its own cold file (saved by useEngineBridge's
        // archived subscription only when it changes), never in this constantly-rewritten hot blob.
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

/** Persist the dock's open flag whenever it changes (any action can change it — the explicit toggles,
 *  or opening a file/preview). Cheap: a compare gates the localStorage write to real changes. */
let lastDock: boolean | null = null
useWorkspace.subscribe((s) => {
  if (s.dockOpen === lastDock) return
  lastDock = s.dockOpen
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify({ open: s.dockOpen }))
  } catch {
    /* private mode / quota — dock just won't persist, no-op */
  }
})

// Keep the dirty state fresh without a file watcher: on window focus (the user may have edited in
// another tool or a sibling session's turn landed while away) + once at boot. Per-turn refresh lives
// in TurnComplete. Fires against whatever project the window holds; fails soft to not-a-repo.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => void useWorkspace.getState().refreshGitStatus())
  void useWorkspace.getState().refreshGitStatus()
}

/**
 * The INSTANT provisional title shown the moment the first turn is sent — first words of the prompt.
 * The local-assist seam (`assist:title`) upgrades this to a clean on-device-model title ~300ms later
 * (or leaves a deterministic name when the model's unavailable). User rename (`renameSession`) wins
 * over both.
 */
function titleFromPrompt(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length <= 40 ? clean : `${clean.slice(0, 40).trimEnd()}…`
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
  if (/already exists/i.test(m)) return 'A file or folder with that name already exists.'
  if (/escapes the project root/i.test(m)) return 'That location is outside this project.'
  if (/cannot delete the project root/i.test(m)) return "The project folder itself can't be deleted."
  return "Couldn't complete that — the file may have moved or be in use."
}

/** Markdown files default to the WYSIWYG document view. */
function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** Settle a restored transcript item's live-only state — a session loaded from disk has no engine
 *  behind it, so a `thinking` burst or `workflow` left mid-flight at save time would otherwise spin
 *  forever (its finalize/complete event can never arrive). Freeze them to a resting state. */
function settleRestoredItem(it: Entry): Entry {
  if (it.kind === 'thinking' && it.active) return { ...it, active: false }
  if (it.kind === 'workflow' && it.status === 'running') return { ...it, status: 'completed' }
  return it
}

/** Derived per-session status (one source per signal). */
export function statusOf(s: SessionState, pending: ApprovalRequest[]): SessionStatus {
  if (pending.some((r) => r.sessionId === s.id)) return 'waiting'
  if (s.busy) return 'thinking'
  if (s.errored) return 'error'
  return 'idle'
}

// ── Per-session change attribution ─────────────────────────────────────────────────
// Git has ONE working tree per project (all sessions edit the same files), so `gitFiles` is aggregate.
// But Koda records every file each session's agent edited (edit-tool cards carry `input.file_path`),
// so we can slice that shared pile per session. A dirty file no session touched → the "Not from a
// session" group (a manual edit, `npm install`, Bash codegen). Best-effort by design.

/** A group of dirty files, all attributed to one session (or the no-session bucket). */
export interface SessionChangeGroup {
  /** The owning session, or null for "Not from a session". */
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
function editedPathsOf(s: SessionState): string[] {
  const out: string[] = []
  const take = (name: string, input: unknown): void => {
    if (!EDIT_TOOLS.has(name)) return
    const i = input as { file_path?: string; notebook_path?: string } | null
    const p = i?.file_path ?? i?.notebook_path // NotebookEdit uses notebook_path
    if (p) out.push(p)
  }
  for (const it of s.items) {
    if (it.kind === 'tool') take(it.name, it.input)
    else if (it.kind === 'subagent') for (const c of it.children) if (c.kind === 'tool') take(c.name, c.input)
  }
  return out
}

/** Does one of `absPaths` refer to the project-relative `rel`? Match by suffix so we needn't reconcile
 *  the session cwd against the git root (a subdir project would otherwise mismatch): an absolute
 *  `/…/proj/src/a.ts` owns rel `src/a.ts`. */
function touches(absPaths: string[], rel: string): boolean {
  return absPaths.some((abs) => abs === rel || abs.endsWith('/' + rel))
}

/**
 * Attribute the aggregate working-tree changes to the sessions that produced them. Primary owner of a
 * file: the most-recently-created session that touched it (`order` is newest-first) — a pragmatic
 * "last writer" without per-edit timestamps. Deliberately independent of which session is focused: the
 * row's dirty count is a passive fact about the session, so it must not shift when you click into a
 * different one (a co-edited file kept jumping ownership to whichever row was active). Other touchers
 * surface as `alsoBy` hints. Untouched files fall to the null group.
 */
export function computeSessionChanges(
  sessions: Record<string, SessionState>,
  order: string[],
  files: GitStatusFile[],
): SessionChanges {
  // Clean tree (the common case, incl. every streaming re-render before anything's edited) — skip the
  // per-session items walk entirely.
  if (files.length === 0) return { groups: [], alsoBy: {}, countBySession: {} }

  const edited: Record<string, string[]> = {}
  for (const id of order) if (sessions[id]) edited[id] = editedPathsOf(sessions[id])

  const groups = new Map<string | null, GitStatusFile[]>()
  const alsoBy: Record<string, string[]> = {}
  const countBySession: Record<string, number> = {}

  for (const f of files) {
    const owners = order.filter((id) => edited[id] && touches(edited[id], f.path))
    const primary = owners.length === 0 ? null : owners[0]
    if (!groups.has(primary)) groups.set(primary, [])
    groups.get(primary)!.push(f)
    if (primary) countBySession[primary] = (countBySession[primary] ?? 0) + 1
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
  if (orphan && orphan.length) ordered.push({ sessionId: null, label: 'Not from a session', files: orphan })

  return { groups: ordered, alsoBy, countBySession }
}
