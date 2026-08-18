/**
 * The engine registration table: what each driver can actually do, declared once.
 *
 * THE RULE (T3 research §"one contract, native drivers"): code outside a driver never asks WHICH
 * engine it is talking to, it asks WHAT that engine can do. `engineId === 'claude'` scattered through
 * the session manager, the store, and the renderer meant every later fix had to be written twice and
 * the second copy got forgotten on whichever engine RB wasn't driving that week. This file is the one
 * place outside `adapter.ts` / `codex-driver.ts` where an engine is named — the drivers own these
 * answers, callers read them.
 *
 * Lives in `shared/` rather than main because the renderer and the phone client branch on the same
 * facts (which plan window to anchor, whether a typed model id is worth remembering). Keep it small:
 * a field earns its place by retiring a branch, or by being the seam a driver's own behavior is
 * declared through.
 */
import type { EngineId } from './ipc'

export interface EngineCapabilities {
  /**
   * Can a live session change model without a new process? Both engines answer no today (Claude's
   * `-p` process fixes `--model` at spawn; Codex takes the override on `thread/resume`), which is why
   * a model pick is a respawn. A driver that gains a live switch flips this and the respawn stops.
   */
  modelSwitchInSession: boolean
  /**
   * What a turn sent while a turn is already running does. Claude's stream-json stdin accepts the text
   * mid-turn and the running turn absorbs it (steering). Codex's `turn/start` is a new-turn RPC, so a
   * send waits for the current turn to finish (queued). Phase A4 is where Codex's turn-scoped steering
   * is delivered; this field is what tells a caller which of the two it is holding.
   */
  sendDuringTurn: 'steers' | 'queues'
  /**
   * How a Plan posture reaches the engine.
   *   `native`  — the engine has its own plan mode, set at spawn (`--permission-mode plan`). Crossing
   *               the plan boundary respawns the process, and the ENGINE is what refuses to mutate.
   *   `turnText` — the engine has no mode of its own. The driver ships a mode block with each turn
   *               (no respawn, old text superseded textually) and Koda's approval gate is the fence
   *               that makes the mode real (`ApprovalGate.setPlanFence`).
   * A caller reads this instead of asking "is this Codex": it decides whether a posture change needs
   * a respawn or just the next turn's text.
   */
  planMode: 'native' | 'turnText'
  /**
   * How a per-tool approval reaches Koda's gate. `broker` = the engine calls Koda's MCP `approve` tool
   * (Claude); `native` = the engine sends a server request the driver answers on the wire (Codex).
   * Either way the decision comes from the same `gate.decide()`.
   */
  approvals: 'broker' | 'native'
  /**
   * Does the engine leave a readable conversation transcript on disk that Koda can inspect? Claude
   * writes one per cwd + session id, so Koda can tell a resumable session from a ghost store row and
   * rebuild a blank phone transcript from it. Codex keeps its history inside its own store, so the
   * only proof a Codex conversation exists is Koda's own record of it.
   */
  transcriptOnDisk: boolean
  /**
   * Does the engine accept an arbitrary model id the user typed, beyond the offered catalog? Claude
   * does (and Koda remembers the ones that worked as quick-picks); Codex answers from `model/list`.
   */
  customModelIds: boolean
  /**
   * Does the account always have a 5-hour plan window worth showing, even when the engine reports
   * nothing? Anthropic's server went quiet on windows it considers unremarkable, so the row is
   * anchored and reads "nothing to report" instead of vanishing. Never fabricate a gauge for an engine
   * that doesn't publish one.
   */
  anchorsFiveHourWindow: boolean
  /**
   * Does Koda's plan-limit → API-key auto-fallback apply to this engine? Only the Anthropic path has
   * the confirmed 'rejected' window signal and a Koda-held key to switch forward onto.
   */
  apiKeyFallback: boolean
  /**
   * How delegated children are launched, which decides the guidance the pack ships for this engine:
   * `subagents` = Claude's Agent tool, `collab` = Codex's spawned collaboration threads.
   */
  delegation: 'subagents' | 'collab'
  /**
   * Can this engine satisfy Koda's ephemeral, non-mutating structured-generation contract? The native
   * mechanism may differ: Claude removes every tool, while Codex runs read-only from a neutral temp
   * directory. Callers depend on the contract, never on those engine-specific flags.
   */
  structuredGeneration: boolean
  /** Stable alias for system-owned structured jobs that do not expose a model choice. Undefined asks
   *  the engine to use its own current default (Codex catalogs are account/version dependent). */
  structuredGenerationDefaultModel?: string
  /** The account brand a user recognizes — for notices and pickers, never for a behavior decision. */
  accountLabel: string
}

/** Claude Code, driven as one long-lived `claude -p` stream-json process (`adapter.ts`). */
export const CLAUDE_CAPABILITIES: EngineCapabilities = {
  modelSwitchInSession: false,
  sendDuringTurn: 'steers',
  planMode: 'native',
  approvals: 'broker',
  transcriptOnDisk: true,
  customModelIds: true,
  anchorsFiveHourWindow: true,
  apiKeyFallback: true,
  delegation: 'subagents',
  structuredGeneration: true,
  structuredGenerationDefaultModel: 'sonnet',
  accountLabel: 'Claude',
}

/** OpenAI Codex, driven as one `codex app-server --stdio` JSON-RPC process (`codex-driver.ts`). */
export const CODEX_CAPABILITIES: EngineCapabilities = {
  modelSwitchInSession: false,
  sendDuringTurn: 'queues',
  planMode: 'turnText',
  approvals: 'native',
  transcriptOnDisk: false,
  customModelIds: false,
  anchorsFiveHourWindow: false,
  apiKeyFallback: false,
  delegation: 'collab',
  structuredGeneration: true,
  accountLabel: 'OpenAI',
}

const CAPABILITIES: Record<EngineId, EngineCapabilities> = {
  claude: CLAUDE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
}

/** Is this string one of the engines Koda drives? The table IS the registry, so it answers — a caller
 *  narrowing a stored or streamed id never has to spell the engines out itself. */
export function isEngineId(value: string): value is EngineId {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, value)
}

/** The capability record for an engine. `undefined` resolves to Claude, matching every stored row and
 *  IPC payload that predates the engine field. */
export function engineCapabilities(id: EngineId | undefined): EngineCapabilities {
  return CAPABILITIES[id ?? 'claude'] ?? CLAUDE_CAPABILITIES
}
