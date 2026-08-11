/**
 * Approval policy — pure, deterministic classification used by the permission gate.
 * No Electron, no MCP, no I/O: just "is this tool a mutation?" and "is this a destructive
 * git op we must stop even in Auto-approve?". Kept separate so it stays trivially testable
 * and so the gate (broker/gate.ts) reads as policy-applied-to-a-decision, not policy-tangled.
 */

/**
 * Tools that only READ — no file/state mutation, so they need no safety checkpoint in front of
 * them. Everything NOT in this set (Write/Edit/MultiEdit/NotebookEdit/Bash, MCP tools, and any
 * tool we don't recognize) is treated as mutating: we'd rather take a redundant (cheap,
 * skip-on-no-change) checkpoint than miss one before a real mutation.
 */
/**
 * Koda's own capability tools — hosted by the broker's MCP server (`koda_broker`) and invoked BY
 * the agent (agent-driven recovery, dual-git.md §2). The engine presents them to the gate under
 * their NAMESPACED names (`mcp__<server>__<tool>`) — confirmed empirically
 * (spike/broker/run-capability-tools.ts) — so the gate matches these exact strings. They MUST track
 * SERVER_NAME in broker/server.ts ('koda_broker').
 */
export const RECOVERY_LIST_TOOL = 'mcp__koda_broker__list_checkpoints'
export const RECOVERY_RESTORE_TOOL = 'mcp__koda_broker__restore_checkpoint'

/** Koda's preview capability (preview-surface.md, Rung 2) — the agent asks Koda to start the dev
 *  server. Mutates no project files (it spawns a process), so no safety checkpoint; the
 *  `previewAutoStart` setting decides whether the gate confirms it first (broker/gate.ts). */
export const PREVIEW_TOOL = 'mcp__koda_broker__preview'
export function isPreviewTool(toolName: string): boolean {
  return toolName === PREVIEW_TOOL
}

/** Agent-sees-preview (preview-surface.md, Rung 3) — the agent screenshots the live preview to check
 *  its UI work. Pure read (it captures pixels, mutates nothing), so no checkpoint; it rides the
 *  session's posture like any read (auto-approved in Auto). */
export const VIEW_PREVIEW_TOOL = 'mcp__koda_broker__view_preview'

/** Koda's static-preview capability (preview-surface.md, Rung 1) — the agent points the preview at a
 *  project `.html` file it produced (a mock, a generated page). It only SHOWS an existing file (no
 *  project mutation, spawns nothing), so no checkpoint and no forced confirm: it rides the session
 *  posture like any read (auto-approved in Auto), same as view_preview. */
export const PREVIEW_FILE_TOOL = 'mcp__koda_broker__preview_file'

/** Koda's just-in-time tool provisioner — the agent asks Koda to install a curated CLI (ripgrep/fd/jq)
 *  it needs. Installs into a Koda-owned dir (no project file touched → no safety checkpoint), but
 *  ALWAYS confirms first: it's a network download + software install the user should see, even in
 *  Auto-approve. */
export const ENSURE_TOOL_TOOL = 'mcp__koda_broker__ensure_tool'

/** Koda's "pop the terminal shelf" capability — the agent opens the in-app terminal for the user (for a
 *  sudo/interactive command it can't run itself) and optionally stages a command at the prompt. It runs
 *  nothing and touches no project file → no checkpoint, and frictionless in Auto like the preview tools. */
export const OPEN_TERMINAL_TOOL = 'mcp__koda_broker__open_terminal'

/** The engine's plan-mode exit tool. Touches no project file (it presents a plan + asks to
 *  proceed), so no checkpoint — but it ALWAYS confirms (see ALWAYS_CONFIRM_TOOLS) so the user
 *  actually sees the plan before building, even in Auto-approve. */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode'

/** The engine's "ask the user a multiple-choice question" tool. It mutates nothing, but its answer
 *  IS the permission response: the engine reads the user's picks from the tool's `answers` input,
 *  supplied as `updatedInput`. So the gate ALWAYS awaits the user (even in Auto) and resolves with
 *  `allow-with-edit` carrying the answers — never auto-allows (that would record "(no option
 *  selected)"). Read-only → no checkpoint. The renderer's QuestionCard surfaces the options. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'
export function isUserQuestion(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION_TOOL
}

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite', // in-memory todo list; touches no project file
  // The Task family (engine 2.1.185's todo/checklist system) only mutates the agent's task list,
  // not project files — no safety checkpoint, and keeps their raw names out of the recovery timeline.
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'NotebookRead',
  EXIT_PLAN_MODE_TOOL,
  ASK_USER_QUESTION_TOOL, // asks the user a question; mutates nothing (also auto-allowed in the gate)
  // Listing recovery checkpoints only reads the safety store — no mutation, no pre-checkpoint.
  RECOVERY_LIST_TOOL,
  // Starting the preview server spawns a process; it doesn't edit project files, so no checkpoint.
  PREVIEW_TOOL,
  // Viewing the preview only captures pixels — no mutation, no checkpoint.
  VIEW_PREVIEW_TOOL,
  // Showing a static file in the preview reads an existing project file — no mutation, no checkpoint.
  PREVIEW_FILE_TOOL,
  // Installing a CLI lands in Koda's own dir, not the user's project — no checkpoint (it still always
  // confirms via ALWAYS_CONFIRM_TOOLS).
  ENSURE_TOOL_TOOL,
  // Popping the terminal shelf (and staging, never running, a command) mutates no project file.
  OPEN_TERMINAL_TOOL,
])

/** The optional Playwright browser-testing tools (`mcp__playwright__*`, server name 'playwright' in
 *  the merged mcp-config). They drive a browser — read pages, click, screenshot — but never touch the
 *  user's PROJECT files (what safety-git protects), so they take no pre-checkpoint. Prefix match: the
 *  server exposes ~20 tools (browser_navigate/click/…) and they all share the same posture. */
export function isBrowserTool(toolName: string): boolean {
  return toolName.startsWith('mcp__playwright__')
}

/** True when a safety checkpoint should be taken before this tool runs (fail-closed: unknown ⇒ mutating). */
export function isMutating(toolName: string): boolean {
  if (isBrowserTool(toolName)) return false // browsing mutates no project file → no checkpoint
  return !READ_ONLY_TOOLS.has(toolName)
}

/**
 * File-edit tools — the ones the `acceptEdits` posture auto-approves (it still asks before COMMANDS,
 * e.g. Bash). Mirrors Claude Code's own acceptEdits semantics (edits proceed; shell prompts).
 * Conservative on purpose: only the known editors. Anything else mutating (Bash, MCP tools, unknown)
 * is NOT an edit, so acceptEdits asks for it.
 */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName)
}

/**
 * Tools that ALWAYS require a human confirm — even in Auto-approve. A different tier from the
 * destructive-git tripwire: the tripwire is a hard DENY (no user path), an always-confirm is a
 * forced ASK (the user can still allow). Restoring a checkpoint can throw away forward work, so it
 * always looks the user in the eye regardless of mode (dual-git.md §2, guardrails.md §7).
 */
const ALWAYS_CONFIRM_TOOLS = new Set([RECOVERY_RESTORE_TOOL, EXIT_PLAN_MODE_TOOL, ENSURE_TOOL_TOOL])
export function isAlwaysConfirm(toolName: string): boolean {
  return ALWAYS_CONFIRM_TOOLS.has(toolName)
}

/**
 * Tools that take their OWN safety snapshot internally, so the gate must NOT add a redundant
 * pre-checkpoint in front of them — which would also leak an ugly internal tool name into the
 * human-terms recovery timeline. `restore_checkpoint` snapshots "before recovery" itself (restore.ts).
 */
const SELF_CHECKPOINTING_TOOLS = new Set([RECOVERY_RESTORE_TOOL])
export function isSelfCheckpointing(toolName: string): boolean {
  return SELF_CHECKPOINTING_TOOLS.has(toolName)
}

/**
 * Destructive-git hard-stop tripwire (dual-git.md §3, guardrails.md §7). These operations
 * rewrite or delete the user's *history* — safety-git protects working *files*, but it can't
 * bring back a force-pushed remote or a deleted branch. So they're denied even in Auto-approve;
 * the engine must stop and ask. Git runs via Bash in our setup, so we scan Bash command strings.
 *
 * Deliberately conservative pattern set — covers the named ops (force-push, hard-reset, history
 * rewrite, branch/tag delete) without trying to be a full git parser. False positives are
 * acceptable here (the user can rephrase or approve explicitly); a missed destructive op is not.
 */
const DESTRUCTIVE_GIT_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\bgit\b[^&|;]*\bpush\b[^&|;]*(--force\b|--force-with-lease\b|\s-f\b)/, what: 'force-push' },
  { re: /\bgit\b[^&|;]*\bpush\b[^&|;]*\s\+[^\s]/, what: 'force-push (+refspec)' },
  { re: /\bgit\b[^&|;]*\breset\b[^&|;]*--hard\b/, what: 'hard reset' },
  { re: /\bgit\b[^&|;]*\brebase\b/, what: 'rebase (history rewrite)' },
  { re: /\bgit\b[^&|;]*\bfilter-branch\b/, what: 'filter-branch (history rewrite)' },
  { re: /\bgit\b[^&|;]*\bfilter-repo\b/, what: 'filter-repo (history rewrite)' },
  // Only the FORCE delete (-D, or --delete --force) is destructive — it discards unmerged commits.
  // Safe delete (git branch -d / --delete) refuses to drop unmerged work, so it's routine merge
  // cleanup the agent is told to do (CLAUDE.md "a merge isn't done until the branch is gone") — must
  // pass. tag -d has no safe variant (it's the only way to delete a tag, and that's history), so it stays.
  { re: /\bgit\b[^&|;]*\bbranch\b[^&|;]*(\s-D\b|--delete\b[^&|;]*--force\b|--force\b[^&|;]*--delete\b)/, what: 'branch force-delete' },
  { re: /\bgit\b[^&|;]*\btag\b[^&|;]*\s-d\b/, what: 'tag delete' },
  { re: /\bgit\b[^&|;]*\breflog\b[^&|;]*\bexpire\b/, what: 'reflog expire' },
  { re: /\bgit\b[^&|;]*\bupdate-ref\b[^&|;]*\s-d\b/, what: 'ref delete' },
]

export interface TripwireHit {
  what: string
}

/**
 * Self-protection: mutations aimed at Koda's OWN machinery always look the user in the eye — even in
 * Auto-approve. The agent operates on the user's content and config, never silently on the thing
 * that runs and governs it (CLAUDE.md governing principle; the Hermes-agent audit is the prior art:
 * their config file is agent-unwritable because "a prompt-injected agent could silently disable
 * exec approval"). Forced ASK, not deny — the user may genuinely want the change; what's banned is
 * it happening without them seeing it.
 *
 * Protected targets:
 * - `.koda/guardrails.json` — the per-project switch that turns guardrail rules OFF. A silent edit
 *   here is the agent rewriting its own rules for every future session.
 * - `.koda/safety.git` — the safety store. Writing into it (or `rm`-ing `.koda` wholesale) destroys
 *   the undo net; the destructive-git tripwire can't see it because it isn't the user's git history.
 * - `koda-settings.json` — the app's settings file (approval default, billing mode, feature
 *   toggles) in userData. Matched by basename so this module stays pure (no Electron path lookups);
 *   a project file coincidentally named this false-positives into an ask, which is acceptable.
 * - `Koda*.app/Contents/` — the installed app bundle (the pack, the binary) on packaged installs.
 *
 * Like the tripwire, this is a deliberately small heuristic over file paths and Bash strings — it
 * catches cooperative-mode drift and casual injection, not a determined obfuscated attacker (the
 * honest Hermes framing: in-process screening is a heuristic, the OS is the boundary). Note
 * `.koda/scratch` and `.koda/memory` stay frictionless: only the named targets match.
 */
const PROTECTED_PATH_PATTERNS: ReadonlyArray<{ re: RegExp; what: string; bashNeedsWriteShape?: boolean }> = [
  // guardrails.json + koda-settings.json only ask in Bash when the command LOOKS like a write —
  // the agent grepping/catting these names is routine in dogfood (and reads are frictionless via
  // the Read tool anyway); it's the silent WRITE that must surface. Patterns are case-insensitive
  // because the macOS filesystem is.
  { re: /\.koda[\\/]guardrails\.json/i, what: "this project's guardrail switches", bashNeedsWriteShape: true },
  { re: /\.koda[\\/]safety\.git/i, what: "this project's recovery store" },
  { re: /(^|[\\/\s"'])koda-settings\.json/i, what: "Koda's app settings", bashNeedsWriteShape: true },
  // Anchored at the .app boundary so DELETING the bundle matches, not just writes inside Contents/.
  { re: /\bKoda[^/\\]*\.app(?=[\\/\s"';&|]|$)/i, what: "Koda's app bundle" },
]

/** Does this Bash command look like it writes/moves/deletes (vs a pure read like grep/cat)? A loose
 *  shape check, only used to keep read-ish mentions of protected names frictionless. */
const BASH_WRITE_SHAPE_RE = /(\brm\b|\bmv\b|\bcp\b|\bsed\b[^&|;]*\s-i\b|\btee\b|>>?|\btruncate\b|\bchmod\b|\bln\b|\binstall\b)/i

/** Bash shapes that take out the whole `.koda` dir (and the safety store with it) without naming it.
 *  Terminators cover `;`-chaining and quoted bare targets (`rm -rf ".koda"`). */
const KODA_DIR_DELETE_RE = /\brm\b[^&|;]*\s["']?(?:\S*[\\/])?\.koda[\\/]?(?:[\s;&|"')]|$)/i

export function protectedTarget(toolName: string, input: unknown): TripwireHit | null {
  const i = input as Record<string, unknown> | null | undefined
  if (isEditTool(toolName)) {
    const target = [i?.file_path, i?.path, i?.notebook_path].find((v) => typeof v === 'string') as
      | string
      | undefined
    if (!target) return null
    for (const { re, what } of PROTECTED_PATH_PATTERNS) if (re.test(target)) return { what }
    return null
  }
  if (toolName === 'Bash') {
    const command = i?.command
    if (typeof command !== 'string') return null
    for (const { re, what, bashNeedsWriteShape } of PROTECTED_PATH_PATTERNS) {
      if (!re.test(command)) continue
      if (bashNeedsWriteShape && !BASH_WRITE_SHAPE_RE.test(command)) continue
      return { what }
    }
    if (KODA_DIR_DELETE_RE.test(command)) return { what: "this project's .koda folder (holds the recovery store)" }
  }
  return null
}

/**
 * Returns the matched destructive op when this tool call is a destructive git command, else null.
 * Only Bash can run git in our setup; the engine's own edit tools can't force-push.
 */
export function destructiveGit(toolName: string, input: unknown): TripwireHit | null {
  if (toolName !== 'Bash') return null
  const command = (input as { command?: unknown })?.command
  if (typeof command !== 'string') return null
  for (const { re, what } of DESTRUCTIVE_GIT_PATTERNS) {
    if (re.test(command)) return { what }
  }
  return null
}

/**
 * Human-terms checkpoint label for a per-tool snapshot, from data we already hold (no model call):
 * "before Write: foo.txt", "before Bash: npm install". Powers the recovery timeline a non-engineer
 * reads. Falls back to the tool name when there's no obvious target.
 */
export function checkpointLabel(toolName: string, input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined
  const target =
    pickString(i?.file_path) ??
    pickString(i?.path) ??
    pickString(i?.notebook_path) ??
    firstLine(pickString(i?.command)) ??
    pickString(i?.pattern)
  return target ? `before ${toolName}: ${target}` : `before ${toolName}`
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function firstLine(v: string | undefined): string | undefined {
  if (!v) return undefined
  const line = v.split('\n', 1)[0].trim()
  return line.length > 80 ? line.slice(0, 77) + '…' : line
}
