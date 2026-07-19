import type { SubagentUsage } from '@shared/ipc'
import type { TaskRow } from './TaskList'
import type { WorkflowItemData } from './WorkflowCard'

/**
 * The transcript's turn-item model — extracted here as PURE TYPES (no runtime imports) so non-renderer
 * consumers (the phone client in src/mobile) can reuse them without dragging the store-coupled render
 * components (Transcript → QuestionCard/UserMessage → workspace/store → window.koda). The Transcript
 * component re-exports these for back-compat with existing `from './Transcript'` import sites.
 */
export type TurnItem =
  | {
      kind: 'user'
      text: string
      /** Staged attachments. On the phone, document files (csv/pdf) ride here too, marked by a
       *  non-`image/*` mediaType + their original `name` (the desktop uses `files` instead). */
      images?: { mediaType: string; dataBase64: string; name?: string }[]
      /** Names of attached document files (csv/pdf) — bytes live in `.koda/scratch/`, not the transcript. */
      files?: string[]
    }
  | { kind: 'assistant'; markdown: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'notice'; text: string }
  | { kind: 'canvas'; docTitle: string; instruction: string }
  | { kind: 'thinking'; estimatedTokens?: number; active: boolean }
  | { kind: 'tasklist'; tasks: TaskRow[] }
  | ({ kind: 'workflow' } & WorkflowItemData)
  | SubagentItem

/** A subagent's own inner work, rendered nested inside its card. */
export type SubagentChildData =
  | { kind: 'assistant'; markdown: string }
  | { kind: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean }

/** Same, with a stable React identity. */
export type SubagentChild = SubagentChildData & { id: number }

export type SubagentItem = {
  kind: 'subagent'
  /** The Agent launch tool_use id — the join key for lifecycle + inner events. */
  toolUseId: string
  subagentType: string
  /** Stable task identity (from launch) — the card's resting label, never overwritten. */
  description: string
  /** Live progress one-liner ("Writing sub.txt"), updated as the subagent works. */
  liveStatus?: string
  prompt?: string
  status: 'running' | 'completed'
  isError?: boolean
  lastToolName?: string
  usage?: SubagentUsage
  resultText?: string
  children: SubagentChild[]
}

/** A transcript item with a stable React identity (separate from any domain id). */
export type Entry = TurnItem & { id: number }
