/**
 * The approval-gate contract — engine-neutral, transport-free. These are what the gate
 * (`gate.ts`) needs to decide a tool call and what a transport provides to reach it.
 *
 * Extracted from `server.ts` so a second engine can call the SAME `gate.decide()` from a different
 * transport (architecture/multi-engine-codex.md, Piece 3): Claude reaches the gate through the
 * in-process HTTP MCP broker; Codex reaches it directly from its app-server approval callback. Neither
 * transport-specific module should be a dependency of the gate, hence this shared home for the types.
 */
import type { ToolDecision } from '@shared/ipc'

/** What the gate needs to decide on a tool call (the broker's contract, engine-neutral). */
export interface ApproveRequest {
  toolName: string
  input: unknown
  toolUseId: string
}

/** Resolve a tool call to a decision. Provided by the gate; same fn for every session and engine.
 *  `signal` is the asking transport's cancellation (Claude's MCP `approve` request): if it fires while
 *  a human is still deciding, the gate cleans the pending slot instead of leaking it. Optional — Codex
 *  reaches the gate from its native approval callback and passes none. */
export type DecideFn = (sessionId: string, req: ApproveRequest, signal?: AbortSignal) => Promise<ToolDecision>
