/**
 * The permission broker — an in-process HTTP MCP server the engine consults before
 * every tool call (`--permission-prompt-tool mcp__koda_broker__approve`). Proven in
 * spike/broker: hosting it in-process (not a separate stdio process) removes the bundled-node
 * packaging cost and keeps the decision where it belongs — in main, next to safety-git and the
 * renderer. The broker is pure TRANSPORT; the judgment lives in the prompt guardrails and the
 * thin gate it calls (broker/gate.ts).
 *
 * Shape: ONE shared HTTP listener on 127.0.0.1:<random>, one MCP Server+transport PER session,
 * routed by URL path (/mcp/<sessionId>) and authenticated by a per-session bearer token. The
 * token is passed to the engine via env (`${KODA_BROKER_TOKEN}` expansion in the mcp-config), so
 * it never appears in the process argv (`ps aux`).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  DocKindSchema,
  type CreateInteractiveRequest,
  type CreateInteractiveResult,
  type ToolDecision,
} from '@shared/ipc'
import type { Checkpoint } from '../safety-git/checkpoint'
import { REREAD_AFTER_RESTORE } from '../safety-git/restore-notice'
import { CLIS, RUNTIMES, RUNTIME_IDS, CLI_IDS } from '../runtime/registry'
import type { EnsureToolResult } from '../runtime/provision'
import type { CreateDocumentArgs, CreatedDocument, StarredDocument } from '../doc-commands'
import type { KeepDocumentArgs, KeptDocument } from '../keep-document'
import { log } from '../logger'

// The gate contract now lives in ./types (engine-neutral, so Codex can reach the same gate without
// depending on this HTTP/MCP transport). Re-exported here for back-compat with existing importers.
export type { ApproveRequest, DecideFn } from './types'
import type { ApproveRequest, DecideFn } from './types'

/**
 * Agent-driven recovery capabilities (dual-git.md §2). The broker DRIVES (exposes the tools, routes
 * the call); the manager's closures EXECUTE via safety-git — the driver/implementer split, so the
 * agent can never hand-roll git against the store.
 */
export type ListCheckpointsFn = (sessionId: string) => Promise<Checkpoint[]>
export type RestoreCheckpointFn = (sessionId: string, checkpointId: string) => Promise<Checkpoint>

/** Preview capability (preview-surface.md): start the session's window's dev server. The broker
 *  drives; the manager spawns + owns the child and returns the URL the preview iframe will load. */
export type StartPreviewFn = (sessionId: string, command: string, cwd?: string) => Promise<{ url: string }>

/** Agent-sees-preview (preview-surface.md, Rung 3): capture the window's live preview as an image the
 *  agent can SEE. The broker drives; the manager captures via the window's webContents (preview.ts). */
export type CapturePreviewFn = (sessionId: string) => Promise<{ data: string; mimeType: string }>

/** Static-preview capability (preview-surface.md, Rung 1): point the window's preview at a project
 *  `.html` file the agent produced. The broker drives; the manager serves it via preview.ts. */
export type PreviewFileFn = (sessionId: string, relPath: string) => Promise<{ url: string }>

/** Just-in-time tool provisioning: the agent asks Koda to install a curated CLI by id. The broker
 *  drives; the manager provisions via runtime/provision.ts (ensureTool) and returns the JSON result. */
export type EnsureToolFn = (sessionId: string, toolId: string) => Promise<EnsureToolResult>

/** Put the terminal on stage for the user (open_terminal): the escape hatch for the rare command the agent
 *  can't run itself. The broker drives; the manager pushes to the session's window (terminal.ts). A set
 *  `command` is staged at the prompt for the user to run — never executed. */
export type OpenTerminalFn = (sessionId: string, command?: string) => Promise<void>

/** Put one existing workspace file on Koda's Stage. The manager owns path resolution and broadcast. */
export type PresentFileFn = (
  sessionId: string,
  args: { path: string; view?: 'auto' | 'document' | 'file' | 'diff'; line?: number; column?: number },
) => Promise<unknown>

/** "Keep this as a document" (document-workspace.md, the magic layer §1): the user asked for the
 *  conversation to become a durable document, and the agent supplies the words. The broker drives; the
 *  manager resolves session → project root and keep-document.ts writes it through `createProjectFile`,
 *  which is where the frontmatter and the session's own id as provenance come from. */
export type KeepDocumentFn = (sessionId: string, args: KeepDocumentArgs) => Promise<KeptDocument>

/** Star or unstar a project document (typed-documents plan, Slice 0 decision 3). The same command the
 *  Library and the Stage bar run: the shelf is main-owned project state, so the agent changes it by
 *  asking for the command rather than by imitating a UI mutation it cannot reach. */
export type StarDocumentFn = (
  sessionId: string,
  args: { path: string; starred: boolean },
) => Promise<StarredDocument>

/** Create a document in the format the ask needs (typed-documents plan, Slice 1). The broker drives;
 *  `doc-commands.createDocument` owns containment, naming, the no-clobber write and the metadata block
 *  both formats are born with. The session id becomes the document's provenance. */
export type CreateDocumentFn = (sessionId: string, args: CreateDocumentArgs) => Promise<CreatedDocument>

/** Turn a passage of an existing document into a self-contained interactive HTML view beside it. The
 *  same command the Stage action runs. It writes only the new artifact — the link back into the source
 *  belongs to whoever asked, so a half-done write can never leave a link to a file that never existed. */
export type CreateInteractiveFn = (
  sessionId: string,
  args: CreateInteractiveRequest,
) => Promise<CreateInteractiveResult>

/** Mini-app lifecycle capability (mini-apps-plan.md): install/start/stop/status for the project's mini
 *  apps. The broker drives; the manager resolves session → project → app dir (containment) and the
 *  supervisor (mini-apps.ts) owns the processes. The verbs are advertised only when register() is told
 *  the mini-apps flag is on — that's this feature's activation seam. Results are JSON-stringified. */
export interface MiniAppsFns {
  install: (sessionId: string, path: string) => Promise<unknown>
  start: (sessionId: string, path: string) => Promise<unknown>
  stop: (sessionId: string, path: string) => Promise<unknown>
  status: (sessionId: string) => Promise<unknown>
}

/** The MCP server name — MUST match the `mcp__koda_broker__approve` tool reference on the engine.
 *  Exported so the Codex driver attaches the same server under the same `mcp_servers.<name>` key. */
export const SERVER_NAME = 'koda_broker'
/** Bare MCP tool names this server exposes (the engine namespaces them as `mcp__koda_broker__<name>`). */
const TOOL_APPROVE = 'approve'
const TOOL_CAPABILITIES = 'capabilities'
const TOOL_LIST_CHECKPOINTS = 'list_checkpoints'
const TOOL_RESTORE_CHECKPOINT = 'restore_checkpoint'
const TOOL_PREVIEW = 'preview'
const TOOL_PREVIEW_FILE = 'preview_file'
const TOOL_VIEW_PREVIEW = 'view_preview'
const TOOL_ENSURE_TOOL = 'ensure_tool'
const TOOL_OPEN_TERMINAL = 'open_terminal'
const TOOL_PRESENT_FILE = 'present_file'
const TOOL_APP_INSTALL = 'app_install'
const TOOL_APP_START = 'app_start'
const TOOL_APP_STOP = 'app_stop'
const TOOL_APP_STATUS = 'app_status'
const TOOL_KEEP_DOCUMENT = 'keep_document'
const TOOL_STAR_DOCUMENT = 'star_document'
const TOOL_CREATE_DOCUMENT = 'create_document'
const TOOL_CREATE_INTERACTIVE = 'create_interactive'
/** The mini-app lifecycle verbs — advertised only when the mini-apps flag is on (register() opts). */
const MINI_APP_TOOLS = new Set([TOOL_APP_INSTALL, TOOL_APP_START, TOOL_APP_STOP, TOOL_APP_STATUS])
/** The env var the engine expands for the bearer token (kept out of argv). */
export const BROKER_TOKEN_ENV = 'KODA_BROKER_TOKEN'

/**
 * The routing contract, in front of BOTH engines on every turn as create_document's tool description,
 * for the same reason keep_document's polarity is: a playbook has to be routed to be read, and the one
 * decision this tool exists to get right is made before the first word is written. It routes by the
 * reader's FEEDBACK LOOP, never by the noun in the request — "report", "plan" and "comparison" are all
 * sometimes Markdown and sometimes HTML. It also names the two asks that are NOT a document (a mini
 * app, an office handoff Koda cannot produce yet), so the agent does not force them into one.
 *
 * Exported so the routing assay can pin the four branches as a unit, without standing up the broker
 * (routing-contract.test.ts). The description text is the contract — a change here is a change to what
 * both engines route on.
 */
export const CREATE_DOCUMENT_GUIDANCE =
  'Create a new document in the user\'s Documents/ folder, in the format the ask actually needs. Choose by what the reader will DO with it, never by the word they used. Writing, revising, citing, or maintaining something that has to stay editable and quotable → format "markdown". Comparing, inspecting, navigating, or interacting — a page with controls, a filterable table, a chart, a walkthrough — → format "html", one self-contained file whose own styles and scripts run inside Koda\'s sandbox (no external fonts, stylesheets, scripts, or network requests: inline everything). A recurring workflow with data that has to persist between uses is a mini app, NOT a document — do not force it into one here. Sending a file into a Word workflow, or freezing it for print or signature, is an office handoff Koda cannot produce yet: say so plainly instead of approximating it in another format. Koda writes the title, date, kind and provenance (frontmatter for Markdown, koda: meta tags for HTML) — you write the content. The name is deduped, never clobbered, and the result tells you the path it actually got.'

/** create_interactive carries the SAME four-branch routing rule as create_document, restated for the
 *  selection→view move, plus the boundary that it writes only the artifact and never the source.
 *  Exported for the same routing assay. */
export const CREATE_INTERACTIVE_GUIDANCE =
  'Turn a passage of an existing document into a self-contained interactive HTML view filed beside it — the move for when part of a written document wants comparing, inspecting, navigating, or tuning rather than reading. Same routing rule as create_document: prose that is being written, revised, or cited stays Markdown; a recurring workflow with persistent data is a mini app, not a document; a Word or print handoff is not available yet, so say so. Pass the source document, the exact passage, and a name for the view. Koda writes ONE new file and returns its project-relative path — it does not touch the source document, so if the user wants the narrative to point at the view, add an ordinary relative Markdown link yourself.'

interface CapabilityDirectoryEntry {
  id: string
  label: string
  outcome: string
  invoke: string[]
  note?: string
}

interface CapabilityDirectoryDefinition extends Omit<CapabilityDirectoryEntry, 'invoke'> {
  tools: string[]
}

const brokerTool = (name: string): string => `mcp__${SERVER_NAME}__${name}`

const CAPABILITY_DIRECTORY: CapabilityDirectoryDefinition[] = [
  {
    id: 'recovery',
    label: 'Recovery',
    outcome: 'Inspect Koda safety checkpoints and restore a known-good project state.',
    tools: [TOOL_LIST_CHECKPOINTS, TOOL_RESTORE_CHECKPOINT],
    note: 'Restoring always asks the user first.',
  },
  {
    id: 'preview',
    label: 'Preview',
    outcome: 'Show a static HTML artifact or run, embed, and inspect a live web app.',
    tools: [TOOL_PREVIEW_FILE, TOOL_PREVIEW, TOOL_VIEW_PREVIEW],
  },
  {
    id: 'stage',
    label: 'Stage',
    outcome: 'Show a file you created or changed in Koda, with an optional source location.',
    tools: [TOOL_PRESENT_FILE],
    note: 'Use preview_file for static HTML and preview for a running app.',
  },
  {
    id: 'environment',
    label: 'Tools and terminal',
    outcome: 'Install a curated runtime or put Koda\'s built-in terminal on stage for the user.',
    tools: [TOOL_ENSURE_TOOL, TOOL_OPEN_TERMINAL],
    note: 'Installing software asks the user first; open_terminal stages commands but never runs them.',
  },
  {
    id: 'documents',
    label: 'Documents',
    outcome:
      'Create a document in the format the ask needs — Markdown to write and revise, self-contained HTML to compare, inspect, navigate, or interact — turn a passage of one into an interactive view beside it, keep a conversation as a durable document when the user explicitly asks, and put a document on (or take it off) this project\'s shelf.',
    tools: [TOOL_CREATE_DOCUMENT, TOOL_CREATE_INTERACTIVE, TOOL_KEEP_DOCUMENT, TOOL_STAR_DOCUMENT],
    note: 'A recurring workflow with data that persists is a mini app, not a document. Never create a kept document on the agent\'s own initiative.',
  },
  {
    id: 'mini-apps',
    label: 'Mini apps',
    outcome: 'Register and control this project\'s Koda mini-app lifecycle.',
    tools: [TOOL_APP_INSTALL, TOOL_APP_START, TOOL_APP_STOP, TOOL_APP_STATUS],
  },
]

/** Build the live directory from the exact descriptors registered on this MCP server. A capability
 * disappears automatically when any required verb is gated or removed, so directory truth cannot
 * drift from ListTools. */
function capabilityDirectory(registeredToolNames: ReadonlySet<string>): CapabilityDirectoryEntry[] {
  return CAPABILITY_DIRECTORY
    .filter((entry) => entry.tools.every((tool) => registeredToolNames.has(tool)))
    .map(({ tools, ...entry }) => ({ ...entry, invoke: tools.map(brokerTool) }))
}

interface SessionEntry {
  server: Server
  transport: StreamableHTTPServerTransport
  token: string
  /** Codex rebuilds every MCP connection between turns. Keep the logical Koda session while allowing
   *  each fresh MCP initialize request to replace this transport (Claude normally keeps one). */
  initialized: boolean
  closing: boolean
  /** Serializes only MCP initialize/reconnect requests. Tool calls remain concurrent (an approval may
   *  wait on the user), but two client retries cannot replace the shared transport underneath each other. */
  initializeChain: Promise<void>
  /** Keeps the server→client standalone SSE stream warm (see register()); cleared in unregister(). */
  keepalive: ReturnType<typeof setInterval>
}

/** How often to ping the client to keep the standalone SSE stream alive — comfortably under the
 *  engine's MCP client (Node fetch/undici) ~5-min idle body timeout, which any received byte resets. */
const STANDALONE_KEEPALIVE_MS = 25_000

/**
 * Per-server MCP idle timeout for koda_broker (ms), set on the config entry (mcpConfig). The engine
 * now aborts an idle MCP tool call after ~1025s by default — verbatim from its own error: `MCP server
 * "koda_broker" tool "approve" sent no response or progress for 1025s; aborting. … set a per-server
 * "timeout" (ms) to allow longer silent runs for just this server; otherwise set
 * CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables).` A forced ask (destructive-git,
 * self-protection) legitimately waits on a human who may be away overnight or a weekend, and the
 * progress heartbeat no longer reliably resets that clock, so hold this server a full day.
 */
const BROKER_APPROVE_IDLE_TIMEOUT_MS = 86_400_000

/** After a dev server is confirmed serving, give the just-pointed preview iframe this long to navigate
 *  and paint its first frame before we auto-screenshot it for the agent. Long enough for a typical SPA
 *  to render something; a slow first-hit compile may still capture a spinner (honest — the agent can
 *  re-shoot with view_preview). */
const PREVIEW_CAPTURE_SETTLE_MS = 700

export class PermissionBroker {
  private http: HttpServer | null = null
  private port = 0
  private readonly sessions = new Map<string, SessionEntry>()

  constructor(
    private readonly decide: DecideFn,
    /** Surface a broker failure for a session (non-fatal) so it's never silent. */
    private readonly onError: (sessionId: string, message: string) => void,
    /** Agent-driven recovery: list the session's safety checkpoints (read-only). */
    private readonly listCheckpoints: ListCheckpointsFn,
    /** Agent-driven recovery: restore the session's tree to a checkpoint (forward-only). */
    private readonly restoreCheckpoint: RestoreCheckpointFn,
    /** Preview capability: start the session's window's dev server, return the URL to embed. */
    private readonly startPreview: StartPreviewFn,
    /** Agent-sees-preview: capture the window's live preview as an image returned to the agent. */
    private readonly capturePreview: CapturePreviewFn,
    /** Static preview: point the session window's preview at a project `.html` file, return its URL. */
    private readonly previewFile: PreviewFileFn,
    /** Just-in-time tool provisioning: install a curated CLI the agent asks for, return the result. */
    private readonly ensureTool: EnsureToolFn,
    /** Put the terminal on stage for the user, optionally staging (never running) a command at the prompt. */
    private readonly openTerminal: OpenTerminalFn,
    /** Mini-app lifecycle verbs (install/start/stop/status) — surfaced only when register() opts in. */
    private readonly miniApps: MiniAppsFns,
    /** "Keep this as a document": write the conversation the user asked to keep into their Documents/. */
    private readonly keepDocument: KeepDocumentFn,
    /** Explicit presentation: show an existing workspace file on every Koda control head. */
    private readonly presentFile: PresentFileFn,
    /** Star/unstar a project document — the shelf command the UI runs, reached from the conversation. */
    private readonly starDocument: StarDocumentFn,
    /** Create a document in the format the ask needs, born with the same metadata block Koda's own
     *  creation route writes. Closes the ledger gap where an agent-made document arrived untitled. */
    private readonly createDocument: CreateDocumentFn,
    /** Turn a passage of a document into an interactive HTML view beside it (writes only the artifact). */
    private readonly createInteractive: CreateInteractiveFn,
  ) {}

  /**
   * Bring the listener up (idempotent). MUST be awaited before the engine is spawned — the engine
   * needs the port baked into its mcp-config, and a missing broker means tool calls silently
   * bypass the gate (backend-architect #3). A bind failure rejects so session start aborts loudly.
   */
  async ensureListening(): Promise<void> {
    if (this.http) return
    const http = createServer((req, res) => this.handle(req, res))
    // A permission-prompt / AskUserQuestion call legitimately blocks on a human — the gate awaits the
    // user indefinitely (gate.ts). Node's default requestTimeout (300s) and headersTimeout would
    // destroy that still-open POST mid-wait; the engine then reports "transport dropped mid-call,
    // response for tool approve was lost", errors the tool, and re-asks (recreating the question).
    // Disable the caps so a pending approval survives however long the user takes to answer.
    http.requestTimeout = 0
    http.headersTimeout = 0
    http.timeout = 0
    // Never reap an idle keep-alive socket. The default (5s) closes the pooled connection the engine
    // reuses for back-to-back tool approvals; after a quiet gap the next POST races that close and
    // gets ECONNRESET, which the engine's MCP client treats as the whole server dropping. On a private
    // loopback broker with one client there's no socket-exhaustion downside to disabling it.
    http.keepAliveTimeout = 0
    this.http = http
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject) // bind failure → reject (hard error, no silent bypass)
      http.listen(0, '127.0.0.1', () => {
        http.removeListener('error', reject)
        http.on('error', (err) => log.error('broker', 'http server error', err.message))
        resolve()
      })
    })
    this.port = (this.http.address() as { port: number }).port
    log.info('broker', `permission broker listening on 127.0.0.1:${this.port}`)
  }

  /**
   * Create a per-session MCP server/transport. Call after ensureListening, before spawn.
   * `includeApprove` exposes the `approve` permission-prompt tool — true for Claude (its tool-gating
   * transport), false for Codex (native approvals; it only consumes the capability tools below).
   * `includeMiniApps` surfaces the mini-app lifecycle verbs — the caller reads the dogfood flag
   * (loadMiniAppsEnabled) at session start; a normal release keeps them invisible.
   */
  async register(sessionId: string, opts: { includeApprove?: boolean; includeMiniApps?: boolean } = {}): Promise<void> {
    // Defensive: the manager always disposes a live session before re-registering, but if that invariant
    // ever slipped a bare re-register would orphan the prior entry's keepalive interval + MCP server.
    if (this.sessions.has(sessionId)) await this.unregister(sessionId)
    const includeApprove = opts.includeApprove ?? true
    const includeMiniApps = opts.includeMiniApps ?? false
    const token = randomUUID()
    const server = new Server({ name: SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })

    const registeredTools = [
        {
          name: TOOL_APPROVE,
          description: 'Koda permission broker — approve or deny a tool call.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        {
          name: TOOL_CAPABILITIES,
          description:
            "Read Koda's live capability directory for this session. Use this once when a request could benefit from a Koda-owned surface, or when you are unsure how Koda can help. Pass a short goal to narrow the result. It returns only ready capabilities and their exact tool names — never infer a capability that is absent.",
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Optional short goal, e.g. "show the app", "recover files", or "keep this conversation".',
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: TOOL_LIST_CHECKPOINTS,
          description:
            "List this project's safety checkpoints — the recovery points Koda saves automatically before each change. Returns each one's id, a plain-language label (the user's own words for what they were doing), and when it was taken.",
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: TOOL_RESTORE_CHECKPOINT,
          description:
            "Take the project's files back to a safety checkpoint by id — a forward-only, undoable recovery (the current state is snapshotted first, so this can itself be undone). Koda always asks the user to confirm before it runs.",
          inputSchema: {
            type: 'object',
            properties: {
              checkpoint_id: { type: 'string', description: 'The id of the checkpoint to restore (from list_checkpoints).' },
            },
            required: ['checkpoint_id'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_PREVIEW,
          description:
            "Start a live preview of a web app by running its dev-server command (e.g. `npm run dev`). Koda owns and embeds the server and tears it down when the window closes. Waits until the server is actually accepting connections before returning, so a successful result means the page is really loading — it does NOT return early on the dev server merely printing its URL, and it errors if the server crashes on startup. Returns the URL Koda is showing AND a screenshot of what rendered, so you can confirm it looks right (a compile error appears as an in-page overlay) before telling the user it's ready. Use view_preview to re-screenshot later (e.g. after a change, or if the first shot caught a still-compiling page).",
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The dev-server command to run, e.g. "npm run dev" or "vite".' },
              cwd: { type: 'string', description: 'Optional working directory (defaults to the project root).' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_PREVIEW_FILE,
          description:
            "Open a static HTML file in Koda's preview surface — a self-contained .html page (a mock, a generated report/chart, a comparison). Write the file first, then pass its project-relative path. For a multi-file app with a dev server, use the preview tool instead. Returns the URL Koda is showing.",
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative path to the .html file, e.g. ".koda/scratch/mock.html".' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_VIEW_PREVIEW,
          description:
            'Take a screenshot of the live preview and return it as an image — the rendered web UI the user is currently seeing. Requires a preview to be showing first (start one with the preview tool).',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: TOOL_ENSURE_TOOL,
          description:
            `Install a tool or language runtime on demand so it's available in Bash. Koda downloads + verifies it and the user confirms. Available: ${ensureToolList()}. Returns its location: when status is "installed" or "already-present", use the returned binPath (or just the tool's name — it's on PATH for your next Bash call); status "unknown" means Koda doesn't provide it.`,
          inputSchema: {
            type: 'object',
            properties: {
              tool_id: { type: 'string', enum: [...RUNTIME_IDS, ...CLI_IDS], description: 'Which tool or runtime to install.' },
            },
            required: ['tool_id'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_OPEN_TERMINAL,
          description:
            "Open Koda's built-in terminal (a tab on the Stage) for the user. Use this for the rare command YOU can't run yourself — one needing a sudo/password prompt, an interactive login, or the user's own credentials typed in. Pass `command` to stage it at the prompt; Koda types it in but never runs it, so the user reviews it and presses Enter (their password step stays theirs). Prefer this over telling the user to open the macOS Terminal app. For everything you can run yourself, just use Bash — not this.",
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Optional shell command to stage at the prompt (not run) for the user to review and execute.' },
            },
            additionalProperties: false,
          },
        },
        {
          name: TOOL_PRESENT_FILE,
          description:
            "Put an existing project file on Koda's Stage so the user can see it. Use this for the primary artifact you made or changed; Koda also supplies a completed-turn file list as a fallback. Paths are project-relative. Markdown defaults to the rendered document view; other files default to the file view. A line/column target forces the file view. Diff view uses this turn's recovery point and is unavailable if that checkpoint failed. For static HTML use preview_file, and for a running app use preview.",
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Normalized project-relative file path.' },
              view: { type: 'string', enum: ['auto', 'document', 'file', 'diff'] },
              line: { type: 'integer', minimum: 1 },
              column: { type: 'integer', minimum: 1 },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_APP_INSTALL,
          description:
            'Register a mini app with Koda\'s lifecycle supervisor: validates its koda-app.json manifest (name, entry, icon, data paths) and records it. Pass the project-relative path to the app folder (e.g. "apps/fitness"). This does NOT install npm dependencies — do that yourself with Bash in the app folder. Idempotent.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative path to the app folder, e.g. "apps/fitness".' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_APP_START,
          description:
            "Start a mini app under Koda's supervisor — the ONLY way to run an app server (never start one with Bash; a Bash-started server dies with the session and nobody owns its port). Koda assigns the port (the app must read the PORT env var and bind 127.0.0.1), waits until it's actually serving, restarts it on crashes with backoff, and keeps it running across Koda relaunches until app_stop. Auto-registers a valid manifest, so a prior app_install isn't required. Returns { url } — the app's address AS OF THIS CALL. Koda reassigns the port on every restart, so never remember a url or a port from an earlier message: call app_status when you need the current one.",
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative path to the app folder, e.g. "apps/fitness".' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_APP_STOP,
          description:
            'Stop a running mini app and stop keeping it alive (it will no longer restart on crash or when Koda relaunches). Idempotent.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative path to the app folder, e.g. "apps/fitness".' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_APP_STATUS,
          description:
            "List this project's mini apps with their live state (starting / running / stopped / crashed), URL, pid, restart count, and whether they start when Koda launches. This is the way to get a running app's CURRENT url — Koda reassigns the port on every restart, so a url from an earlier message may already be dead. 'crashed' means it exited repeatedly and the supervisor gave up — fix the app, then app_start again.",
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: TOOL_KEEP_DOCUMENT,
          // This description is the deterministic half of the rule. A playbook has to be routed to be
          // read; a tool description is in front of the agent on every turn of every session, which is
          // why the polarity and the editorial bar are stated HERE and only reinforced in the pack.
          description:
            'Turn what you and the user just worked through into a durable document in their Documents/ folder. Use it ONLY when they ask — "keep this", "save this as a document", "write that up". Never on your own initiative: Koda does not decide that a conversation was worth keeping, and a document the user did not ask for is the failure this tool is shaped around. Look at the live Documents/ tree first — when a document already owns the topic, extend that one with an ordinary edit instead of filing a parallel memo. Keep only what outlives the conversation: the decisions, the conclusions, the reasoning someone will need later, never a transcript or a play-by-play of the chat. A quiet stretch of work earns one dated line rather than a padded summary, and when nothing durable came out of it, write nothing and say so — an empty result is a valid result, and manufacturing content to fill it is the failure. Koda writes the title block, the date and where the document came from; you write the words.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: "The document's name, e.g. \"Branch management notes\" — it becomes both the filename and the title on the page.",
              },
              description: {
                type: 'string',
                description:
                  'One honest sentence saying what this document is for. It is the single line shown under the title when the user is looking for something, so a description that restates the title is rejected.',
              },
              kind: {
                type: 'string',
                enum: [...DocKindSchema.options],
                description: 'What the document is for. Answer that, not where it lives — "note" is the honest catch-all.',
              },
              body: {
                type: 'string',
                description:
                  'The document itself, in markdown: headings, lists, tables, and callouts all render. Do not include a frontmatter block — Koda writes that.',
              },
              folder: {
                type: 'string',
                description:
                  'Optional project-relative topic folder under Documents/, e.g. "Documents/decisions". Created if it does not exist yet. Omit to file at the top of Documents/.',
              },
            },
            required: ['title', 'description', 'kind', 'body'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_STAR_DOCUMENT,
          description:
            "Put a document on this project's shelf — the starred shortcuts in Koda's sidebar — or take it off again. The shelf is what the user keeps coming back to, so star the document they say matters (including one you just created for them, when they ask for it to be kept handy), and unstar when they say they are done with it. Pass a project-relative path. Starring changes no file and is reversible in one call.",
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Project-relative path to the document, e.g. "Documents/decisions/Branches.md".',
              },
              starred: {
                type: 'boolean',
                description: 'true puts it on the shelf, false takes it off.',
              },
            },
            required: ['path', 'starred'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_CREATE_DOCUMENT,
          // The routing contract lives in CREATE_DOCUMENT_GUIDANCE (above), in front of both engines on
          // every turn. It is exported so the routing assay can pin its four branches as a unit.
          description: CREATE_DOCUMENT_GUIDANCE,
          inputSchema: {
            type: 'object',
            properties: {
              format: {
                type: 'string',
                enum: ['markdown', 'html'],
                description:
                  'markdown for writing/revising/citing; html for comparing/inspecting/navigating/interacting.',
              },
              title: {
                type: 'string',
                description: "The document's name — it becomes both the filename and the title on the page.",
              },
              kind: {
                type: 'string',
                enum: [...DocKindSchema.options],
                description:
                  'What the document is FOR, not where it lives — "note" is the honest catch-all. Omit to take the destination folder\'s default.',
              },
              description: {
                type: 'string',
                description:
                  'One honest sentence saying what this document is for — the line shown under the title when the user is looking for something.',
              },
              body: {
                type: 'string',
                description:
                  'The content: markdown source for format "markdown", or the body markup for format "html". Omit either block Koda writes — no frontmatter, no <html>/<head> wrapper.',
              },
              folder: {
                type: 'string',
                description:
                  'Optional project-relative topic folder under Documents/, e.g. "Documents/decisions". Created if it does not exist. Omit to file at the top of Documents/.',
              },
            },
            required: ['format', 'title'],
            additionalProperties: false,
          },
        },
        {
          name: TOOL_CREATE_INTERACTIVE,
          description: CREATE_INTERACTIVE_GUIDANCE,
          inputSchema: {
            type: 'object',
            properties: {
              source_path: {
                type: 'string',
                description:
                  'Project-relative path of the document the passage came from, e.g. "Documents/plans/Launch.md".',
              },
              selection: {
                type: 'string',
                description: 'The passage itself — it becomes the new view\'s seed content.',
              },
              title: {
                type: 'string',
                description: "The view's name — it becomes both the filename and the title on the page.",
              },
            },
            required: ['source_path', 'selection', 'title'],
            additionalProperties: false,
          },
        },
      ].filter(
        (t) => (includeApprove || t.name !== TOOL_APPROVE) && (includeMiniApps || !MINI_APP_TOOLS.has(t.name)),
      )
    const registeredToolNames = new Set(registeredTools.map((tool) => tool.name))
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registeredTools }))

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
      // Keep the call alive across a long wait — an `approve` for AskUserQuestion or an Ask-me prompt
      // blocks on a human, and the engine's MCP client times a tool response out at ~5 min. Progress
      // notifications reset that timer (verified vs 2.1.197). No-op for instant approvals.
      withApprovalHeartbeat(extra, req.params._meta?.progressToken, async () => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>

      if (req.params.name === TOOL_CAPABILITIES) {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        const entries = capabilityDirectory(registeredToolNames)
        const queryTerms = query.split(/\s+/).filter((term) => term.length >= 3)
        const capabilities = query
          ? entries.filter((entry) =>
              queryTerms.some((term) =>
                [entry.id, entry.label, entry.outcome, entry.note ?? '', ...entry.invoke]
                  .join(' ')
                  .toLowerCase()
                  .includes(term),
              ),
            )
          : entries
        const payload = {
          capabilities,
          ...(query && capabilities.length === 0
            ? { message: "No ready Koda capability matched that goal. Use the engine's ordinary tools or tell the user plainly." }
            : {}),
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
      }

      // Agent-driven recovery capability tools — the broker drives, safety-git executes. Errors come
      // back as an MCP tool error (isError) the engine reports to the user, never a thrown handler.
      if (req.params.name === TOOL_LIST_CHECKPOINTS) {
        try {
          return { content: [{ type: 'text', text: JSON.stringify(await this.listCheckpoints(sessionId)) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_RESTORE_CHECKPOINT) {
        const checkpointId = String(args.checkpoint_id ?? '')
        if (!checkpointId) return toolError(new Error('checkpoint_id is required'))
        try {
          const checkpoint = await this.restoreCheckpoint(sessionId, checkpointId)
          // The tree just moved under this conversation. Say so in the result rather than letting the
          // agent carry on from files it read before the rewind (dual-git.md §2; restore-notice.ts).
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ restored: true, checkpoint }) },
              { type: 'text' as const, text: REREAD_AFTER_RESTORE },
            ],
          }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_PREVIEW) {
        const command = String(args.command ?? '').trim()
        if (!command) return toolError(new Error('command is required'))
        const cwd = typeof args.cwd === 'string' ? args.cwd : undefined
        try {
          const { url } = await this.startPreview(sessionId, command, cwd)
          const started = { type: 'text' as const, text: JSON.stringify({ started: true, url }) }
          // The server is confirmed serving — now attach a screenshot of what actually RENDERED, in this
          // same result, so the agent SEES a compile-error overlay or a blank page here instead of
          // reporting "ready" off the URL alone (the failure mode that made previews feel broken). Best
          // effort: if the preview surface isn't visible/capturable (pinned, or a background session),
          // fall back to the URL-only result — the server is up regardless.
          try {
            await new Promise((r) => setTimeout(r, PREVIEW_CAPTURE_SETTLE_MS))
            const { data, mimeType } = await this.capturePreview(sessionId)
            return {
              content: [
                started,
                { type: 'text' as const, text: 'What the preview is rendering now (check it looks right — a compile error would appear as an in-page overlay):' },
                { type: 'image' as const, data, mimeType },
              ],
            }
          } catch {
            return { content: [started] }
          }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_PREVIEW_FILE) {
        const relPath = String(args.path ?? '').trim()
        if (!relPath) return toolError(new Error('path is required'))
        try {
          const { url } = await this.previewFile(sessionId, relPath)
          return { content: [{ type: 'text', text: JSON.stringify({ shown: true, url }) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_ENSURE_TOOL) {
        const toolId = String(args.tool_id ?? '').trim()
        try {
          const result = await this.ensureTool(sessionId, toolId)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_OPEN_TERMINAL) {
        const command = typeof args.command === 'string' ? args.command : undefined
        try {
          await this.openTerminal(sessionId, command)
          return { content: [{ type: 'text', text: JSON.stringify({ opened: true, staged: !!command }) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_PRESENT_FILE) {
        const path = String(args.path ?? '').trim()
        if (!path) return toolError(new Error('path is required'))
        const view = typeof args.view === 'string' ? args.view : undefined
        if (view && !['auto', 'document', 'file', 'diff'].includes(view))
          return toolError(new Error('view must be auto, document, file, or diff'))
        const line = typeof args.line === 'number' ? args.line : undefined
        const column = typeof args.column === 'number' ? args.column : undefined
        try {
          const receipt = await this.presentFile(sessionId, {
            path,
            view: view as 'auto' | 'document' | 'file' | 'diff' | undefined,
            ...(line !== undefined ? { line } : {}),
            ...(column !== undefined ? { column } : {}),
          })
          return { content: [{ type: 'text', text: JSON.stringify({ shown: true, receipt }) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_KEEP_DOCUMENT) {
        // Every field is validated in keep-document.ts, including the ones that look like plain
        // presence checks — one place to read for what this tool will and won't write, and every
        // refusal comes back as a sentence that says which rule it broke.
        try {
          const kept = await this.keepDocument(sessionId, {
            title: String(args.title ?? ''),
            description: String(args.description ?? ''),
            kind: String(args.kind ?? ''),
            body: String(args.body ?? ''),
            folder: typeof args.folder === 'string' ? args.folder : undefined,
          })
          return { content: [{ type: 'text', text: JSON.stringify(kept) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_STAR_DOCUMENT) {
        // Containment and existence are checked in doc-commands.ts, next to the shelf it writes, so a
        // bad path comes back as a sentence the agent can act on rather than a silent no-op.
        if (typeof args.starred !== 'boolean') {
          return toolError(new Error('starred is required — true puts the document on the shelf, false takes it off'))
        }
        try {
          const result = await this.starDocument(sessionId, {
            path: String(args.path ?? ''),
            starred: args.starred,
          })
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_CREATE_DOCUMENT) {
        // Format, title, kind and containment are all validated in doc-commands.ts, beside the write
        // they guard, so a refusal is one sentence naming the rule rather than a schema rejection the
        // agent has to guess at.
        try {
          const created = await this.createDocument(sessionId, {
            format: String(args.format ?? ''),
            title: String(args.title ?? ''),
            ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
            ...(typeof args.description === 'string' ? { description: args.description } : {}),
            ...(typeof args.body === 'string' ? { body: args.body } : {}),
            ...(typeof args.folder === 'string' ? { folder: args.folder } : {}),
          })
          // The completion message names what was created AND opens it on the Stage (typed-documents
          // plan, "Create the right artifact"). It rides the same read-only present_file receipt — path
          // only, no body, no model turn — so a created doc lands on stage without a second mechanism.
          await this.presentOnStage(sessionId, created.path)
          return { content: [{ type: 'text', text: JSON.stringify(created) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_CREATE_INTERACTIVE) {
        try {
          const result = await this.createInteractive(sessionId, {
            sourcePath: String(args.source_path ?? ''),
            selection: String(args.selection ?? ''),
            title: String(args.title ?? ''),
          })
          // The command answers refusals as a RESULT because two adapters render them differently. For
          // the agent, a refusal has to be an error it can act on — a success-shaped `ok:false` reads
          // as "done" and the next turn tells the user about a file that does not exist.
          if (!result.ok) return toolError(new Error(result.reason))
          // Open the new HTML view on the Stage beside its source, through the same read-only receipt
          // present_file uses (typed-documents plan, "Turn part of a document into a richer view").
          await this.presentOnStage(sessionId, result.htmlPath)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (err) {
          return toolError(err)
        }
      }
      if (MINI_APP_TOOLS.has(req.params.name)) {
        // Defense in depth: an unadvertised verb must also be uncallable (a session registered with the
        // flag off never reaches the supervisor, even if the agent guesses the tool name).
        if (!includeMiniApps) return toolError(new Error('mini apps are not enabled'))
        const path = String(args.path ?? '').trim()
        try {
          switch (req.params.name) {
            case TOOL_APP_INSTALL:
              return { content: [{ type: 'text', text: JSON.stringify(await this.miniApps.install(sessionId, path)) }] }
            case TOOL_APP_START:
              return { content: [{ type: 'text', text: JSON.stringify(await this.miniApps.start(sessionId, path)) }] }
            case TOOL_APP_STOP:
              return { content: [{ type: 'text', text: JSON.stringify(await this.miniApps.stop(sessionId, path)) }] }
            default:
              return { content: [{ type: 'text', text: JSON.stringify(await this.miniApps.status(sessionId)) }] }
          }
        } catch (err) {
          return toolError(err)
        }
      }
      if (req.params.name === TOOL_VIEW_PREVIEW) {
        try {
          const { data, mimeType } = await this.capturePreview(sessionId)
          // The image block is what the model actually SEES (spike/preview-vision: ingested under -p).
          return {
            content: [
              { type: 'text', text: 'Current state of the live preview:' },
              { type: 'image', data, mimeType },
            ],
          }
        } catch (err) {
          return toolError(err)
        }
      }

      // Default: the permission-prompt-tool `approve` (the engine consults it before every tool call).
      // No progressToken means withApprovalHeartbeat above is a no-op (nothing to address a ping to), so
      // it cannot hold the engine's MCP idle-abort off — the failure that stranded two overnight forced
      // asks after ~1025s. The per-server `timeout` in mcpConfig is the real hold now; log the missing
      // token at warn so the next engine bump that drops it shows up in the dogfood log rather than as a
      // silently bricked session.
      if (req.params._meta?.progressToken === undefined)
        log.warn('broker', 'approve call carried no progressToken — heartbeat is a no-op; relying on the per-server MCP timeout', { sessionId })
      const approve: ApproveRequest = {
        toolName: String(args.tool_name ?? ''),
        input: args.input,
        toolUseId: String(args.tool_use_id ?? ''),
      }
      // Thread the request's AbortSignal so the gate cleans the slot the instant the engine cancels its
      // own `approve` (an idle-abort that DOES notify, or a dead request stream) while the user decides.
      const decision = await this.decide(sessionId, approve, extra.signal)
      return { content: [{ type: 'text', text: JSON.stringify(toWire(decision, approve.input)) }] }
      }),
    )

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    await server.connect(transport)
    // Keep the server→client standalone SSE stream from going idle. Tool replies ride each POST's own
    // response stream, so during a quiet spell (the user reading/typing between turns) the standalone
    // stream carries zero bytes — and the engine's fetch/undici client aborts an idle response body
    // after ~5 min, then marks koda_broker "is not connected" and every later tool call fails (Bash,
    // Edit, Write — the whole gate). A periodic ping (a byte on that stream) resets the client's timer.
    // Fire-and-forget: a dropped ping is harmless and a truly dead session is healed by the manager's
    // reconnect path; the overlap guard avoids stacking pings if one is slow to answer.
    const keepalive = startStandaloneKeepalive(server)
    this.sessions.set(sessionId, {
      server,
      transport,
      token,
      initialized: false,
      closing: false,
      initializeChain: Promise.resolve(),
      keepalive,
    })
  }

  /**
   * Open a just-created document on its session's Stage, through the SAME read-only present_file
   * receipt path — path only, no body attachment, no model turn. The written file is the durable
   * outcome; a presentation hiccup is logged and swallowed rather than allowed to fail a create that
   * already put the document on disk.
   */
  private async presentOnStage(sessionId: string, path: string): Promise<void> {
    try {
      await this.presentFile(sessionId, { path })
    } catch (err) {
      log.warn('broker', 'present-on-create failed', err instanceof Error ? err.message : err)
    }
  }

  /** Tear down a session's MCP server (engine ended). Safe if never registered. */
  async unregister(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.closing = true
    this.sessions.delete(sessionId)
    // A Codex reconnect may already be queued behind another initialization. Let that queue observe
    // `closing` before tearing down the final transport, so it cannot resurrect an orphaned keepalive.
    await entry.initializeChain.catch(() => {})
    clearInterval(entry.keepalive)
    try {
      await entry.transport.close()
      await entry.server.close()
    } catch (err) {
      log.warn('broker', 'error closing session transport', err instanceof Error ? err.message : err)
    }
  }

  /**
   * The inline `--mcp-config` JSON for a session. Token is referenced as an env var
   * (`${KODA_BROKER_TOKEN}`, injected into the child env) so it stays out of argv. The config
   * MERGES with the user's shared ~/.claude servers (spike/broker finding) — additive, not replacing.
   */
  mcpConfig(sessionId: string): string {
    return JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: `http://127.0.0.1:${this.port}/mcp/${sessionId}`,
          headers: { Authorization: `Bearer \${${BROKER_TOKEN_ENV}}` },
          // Hold the engine's idle-abort off for a pending approval however long the user is away (see
          // BROKER_APPROVE_IDLE_TIMEOUT_MS — the field name is the engine's own idle-abort remedy).
          timeout: BROKER_APPROVE_IDLE_TIMEOUT_MS,
        },
      },
    })
  }

  /** The bearer token to inject into a session's engine env (matches what register() set). */
  tokenFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.token
  }

  /** The session's streamable-HTTP MCP endpoint — Codex consumes this as an `mcp_servers.*.url`
   *  (the token rides ${KODA_BROKER_TOKEN} via `bearer_token_env_var`, same as Claude's mcpConfig). */
  mcpHttpUrl(sessionId: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${sessionId}`
  }

  /** App teardown — close the shared listener. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.unregister(id)))
    if (this.http) {
      await new Promise<void>((resolve) => this.http!.close(() => resolve()))
      this.http = null
    }
  }

  /** Route an HTTP request to its session's transport, gated on path + token. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = parseSessionId(req.url)
    const entry = sessionId ? this.sessions.get(sessionId) : undefined
    if (!entry) {
      res.writeHead(404).end('unknown session')
      return
    }
    if (!tokenMatches(req.headers.authorization, entry.token)) {
      res.writeHead(401).end('unauthorized')
      log.warn('broker', 'rejected unauthorized approval request', { sessionId })
      return
    }
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      // Codex intentionally tears down and rebuilds all MCP services between turns. The MCP SDK's
      // stateful transport accepts exactly one initialization, so reusing it leaves Codex with
      // `startup_complete=true` but no cached Koda tools after turn one. Preserve the logical Koda
      // session (token + handlers + window ownership), but give each new MCP connection a fresh
      // transport. Claude's long-lived connection never enters this branch.
      if (isInitializeRequest(body)) {
        const initialize = entry.initializeChain.then(async () => {
          if (entry.closing) {
            if (!res.headersSent) res.writeHead(404).end('unknown session')
            return
          }
          if (entry.initialized) {
            clearInterval(entry.keepalive)
            await entry.server.close()
            entry.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
            await entry.server.connect(entry.transport)
            entry.keepalive = startStandaloneKeepalive(entry.server)
          }
          // Capture the selected transport: another request may queue a replacement, but cannot start
          // it until this initialization has finished writing its response.
          const transport = entry.transport
          await transport.handleRequest(req, res, body)
          entry.initialized = true
        })
        entry.initializeChain = initialize.catch(() => {})
        await initialize
        return
      }
      const transport = entry.transport
      await transport.handleRequest(req, res, body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('broker', 'request handling failed', { sessionId, message })
      this.onError(sessionId!, `safety broker error: ${message}`)
      if (!res.headersSent) res.writeHead(500).end('broker error')
    }
  }
}

function startStandaloneKeepalive(server: Server): ReturnType<typeof setInterval> {
  let pinging = false
  return setInterval(() => {
    if (pinging) return
    pinging = true
    server.ping().catch(() => {}).finally(() => { pinging = false })
  }, STANDALONE_KEEPALIVE_MS)
}

/** The curated installable tools + runtimes, as a phrase for the ensure_tool description ("'python'
 *  (Python — for data…, runs as `python3`), …") — built from the registries so it can't drift. */
function ensureToolList(): string {
  const runtimes = RUNTIME_IDS.map((id) => `'${id}' (${RUNTIMES[id].blurb}, runs as \`${RUNTIMES[id].probeBinary}\`)`)
  const clis = CLI_IDS.map((id) => `'${id}' (${CLIS[id].blurb}, runs as \`${CLIS[id].probeBinary}\`)`)
  return [...runtimes, ...clis].join(', ')
}

/** How often to ping progress while a tool call blocks — well under the engine client's ~5-min
 *  (~300s) tool-response timeout, which each progress notification resets. */
const HEARTBEAT_MS = 20_000

/**
 * Run a tool-call handler, emitting an MCP progress notification every HEARTBEAT_MS while it's
 * pending. The engine's MCP client times a tool response out at ~5 min (verified vs 2.1.197); an
 * `approve` for AskUserQuestion or an Ask-me prompt legitimately waits on a human far longer, and
 * without this the client drops the call ("transport dropped… response for tool approve was lost")
 * and the agent re-asks. Progress resets that timer. No-op when the client sent no progressToken
 * (nothing to address the notification to) or the work resolves before the first interval —
 * instant auto-approvals never emit a ping.
 */
export async function withApprovalHeartbeat<T>(
  extra: { sendNotification: (n: { method: string; params?: Record<string, unknown> }) => Promise<void> },
  progressToken: string | number | undefined,
  work: () => Promise<T>,
  intervalMs: number = HEARTBEAT_MS, // overridable so the regression test can observe pings fast
): Promise<T> {
  if (progressToken === undefined) return work()
  let progress = 0
  const timer = setInterval(() => {
    extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++progress } })
      .catch(() => {}) // a dropped ping is harmless; the next one (or the real response) follows
  }, intervalMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}

/** An MCP tool error result — the engine surfaces it to the user; the agent can react and retry. */
function toolError(err: unknown) {
  return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
}

/** ToolDecision → the engine's wire contract (one JSON text block). updatedInput required on allow. */
function toWire(decision: ToolDecision, originalInput: unknown): Record<string, unknown> {
  if (decision.kind === 'deny') {
    return { behavior: 'deny', message: decision.reason ?? 'Koda guardrail blocked this action.' }
  }
  const updatedInput = decision.kind === 'allow-with-edit' ? decision.input : originalInput
  return { behavior: 'allow', updatedInput: updatedInput ?? {} }
}

/** Constant-time bearer check (length-guarded — timingSafeEqual throws on unequal lengths). */
function tokenMatches(authHeader: string | undefined, token: string): boolean {
  const expected = `Bearer ${token}`
  const got = authHeader ?? ''
  if (got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

/** Pull the sessionId out of /mcp/<sessionId> (ignoring any querystring). */
function parseSessionId(url: string | undefined): string | undefined {
  if (!url) return undefined
  const path = url.split('?', 1)[0]
  const m = /^\/mcp\/([^/]+)$/.exec(path)
  return m ? decodeURIComponent(m[1]) : undefined
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}
