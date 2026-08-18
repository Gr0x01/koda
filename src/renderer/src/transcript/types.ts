import type { SubagentUsage, TurnFailureEnvelope } from '@shared/ipc'
import type { TaskRow } from './TaskList'
import type { WorkflowItemData } from './WorkflowCard'

/**
 * The transcript's turn-item model — extracted here as PURE TYPES (no runtime imports) so non-renderer
 * consumers (the phone client in src/mobile) can reuse them without dragging the store-coupled render
 * components (Transcript → QuestionCard/UserMessage → workspace/store → window.koda). The Transcript
 * component re-exports these for back-compat with existing `from './Transcript'` import sites.
 */
export type TurnItem = (
  | {
      kind: 'user'
      text: string
      /** Staged attachments. On the phone, document files (csv/pdf) ride here too, marked by a
       *  non-`image/*` mediaType + their original `name` (the desktop uses `files` instead). */
      images?: { mediaType: string; dataBase64: string; name?: string }[]
      /** True when the original turn had image bytes even if an older replay could retain only the
       * display sentinel. A failed turn with no retained bytes must ask for the images again. */
      hadImages?: boolean
      /** Stable logical identity assigned by a phone outbox. Engine-failure retries keep this id while
       * transport attempts change, so replay/catch-up still renders one user bubble. */
      clientTurnId?: string
      /** Attachment provenance survives successful replay without retaining unbounded base64 bytes. */
      hadAttachments?: boolean
      attachments?: { mediaType: string; name?: string }[]
      /** Names of attached document files (csv/pdf) — bytes live in `.koda/scratch/`, not the transcript. */
      files?: string[]
      /** How long the agent worked on this message, stamped when its turn ended. Rides with the item so
       *  it survives a reload; absent on turns that predate it, which fold by step count instead. */
      elapsedMs?: number
      /** Phone-only identity for an optimistic/outbox turn. It binds reconnect admission and retry to
       *  the exact bubble when several messages were queued before the Mac came back. Never persisted. */
      localTurnId?: string
      /** Canonical retryable terminal failure for this exact row. Persisted with the transcript so a
       * renderer or phone reload restores the banner and payload without relying on session ephemera. */
      turnFailure?: TurnFailureEnvelope
    }
  | { kind: 'assistant'; markdown: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: unknown; liveOutput?: string; result?: string; isError?: boolean }
  | { kind: 'notice'; text: string }
  | { kind: 'canvas'; docTitle: string; instruction: string; selectedWords?: number }
  | { kind: 'thinking'; estimatedTokens?: number; active: boolean }
  | { kind: 'tasklist'; tasks: TaskRow[] }
  | ({ kind: 'workflow' } & WorkflowItemData)
  | SubagentItem
) & { replaySeq?: number }

/** A subagent's own inner work, rendered nested inside its card. */
export type SubagentChildData = (
  | { kind: 'assistant'; markdown: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: unknown; liveOutput?: string; result?: string; isError?: boolean }
) & { replaySeq?: number }

/** Same, with a stable React identity. */
export type SubagentChild = SubagentChildData & { id: number }

export type SubagentItem = {
  kind: 'subagent'
  /** The Agent launch tool_use id — the join key for lifecycle + inner events. */
  toolUseId: string
  /** Claude background-task identity. Present once task_started lands; powers targeted Stop. */
  taskId?: string
  subagentType: string
  /** Stable task identity (from launch) — the card's resting label, never overwritten. */
  description: string
  /** Live progress one-liner ("Writing sub.txt"), updated as the subagent works. */
  liveStatus?: string
  prompt?: string
  status: 'running' | 'completed' | 'interrupted' | 'unknown'
  /** A targeted stop was sent, but the engine has not confirmed the child's terminal outcome yet. */
  stopRequested?: boolean
  /** Last child lifecycle/progress event. A quiet 10-minute child is labeled stalled, never auto-killed. */
  lastActivityAt?: number
  isError?: boolean
  lastToolName?: string
  usage?: SubagentUsage
  resultText?: string
  children: SubagentChild[]
}

/** A transcript item with a stable React identity (separate from any domain id). */
export type Entry = TurnItem & { id: number }
