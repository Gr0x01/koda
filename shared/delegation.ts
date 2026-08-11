import type { EngineEvent, ReplayEntry } from './ipc'

const LIVE_TOOL_OUTPUT_LIMIT = 8_000
const LIVE_TOOL_OUTPUT_TRUNCATED = '… earlier output omitted …\n'

/** Keep noisy running commands cheap to repaint; ToolResult still carries the engine's final output. */
export function appendLiveToolOutput(current: string | undefined, delta: string): string {
  const next = (current ?? '') + delta
  if (next.length <= LIVE_TOOL_OUTPUT_LIMIT) return next
  return LIVE_TOOL_OUTPUT_TRUNCATED + next.slice(-(LIVE_TOOL_OUTPUT_LIMIT - LIVE_TOOL_OUTPUT_TRUNCATED.length))
}

/**
 * Only activity from the parent turn owns the composer/working state. Claude forwards finalized
 * child prose and tool calls through the same event types, distinguished by `parentToolUseId`; those
 * events belong inside the delegated-task card and must not re-lock a parent turn that already ended.
 */
export function isTopLevelTurnActivity(event: EngineEvent): boolean {
  if (event.type === 'ThinkingDelta' || event.type === 'AssistantDelta') return true
  if (event.type === 'AssistantBlock' || event.type === 'ToolRequested') return !event.parentToolUseId
  return false
}

/** True while at least one rendered delegated task still belongs to the live engine process. */
export function hasRunningSubagent(items: readonly unknown[]): boolean {
  return items.some((item) => {
    if (!item || typeof item !== 'object') return false
    const row = item as Record<string, unknown>
    return row.kind === 'subagent' && row.status === 'running'
  })
}

/**
 * Settle transcript-only states after a restart. No engine is attached to these rows yet, so leaving
 * them live would promise work Koda can no longer observe. Generic on purpose: main stores renderer
 * transcript rows opaquely, while the renderer retains its concrete Entry type.
 */
export function settleRestoredTranscriptItem<T>(item: T): T {
  if (!item || typeof item !== 'object') return item
  const row = item as Record<string, unknown>
  if (row.kind === 'thinking' && row.active === true) return { ...row, active: false } as T
  if (row.kind === 'workflow' && row.status === 'running') return { ...row, status: 'completed' } as T
  if (row.kind === 'subagent' && row.status === 'running')
    return { ...row, status: 'unknown', stopRequested: undefined } as T
  return item
}

export function settleRestoredTranscriptItems<T>(
  items: readonly T[],
  activeSubagentToolUseIds: ReadonlySet<string> = new Set(),
): T[] {
  return items.map((item) => {
    const current = row(item)
    if (
      current?.kind === 'subagent' &&
      typeof current.toolUseId === 'string' &&
      activeSubagentToolUseIds.has(current.toolUseId)
    )
      return { ...current, status: 'running', stopRequested: undefined } as T
    return settleRestoredTranscriptItem(item)
  })
}

/**
 * A replay file can end mid-task when Koda itself disappears. Append one honest unknown event for
 * every task that started but never reached a terminal notification, preserving completed results.
 */
export function settleRestoredDelegationReplay(entries: readonly ReplayEntry[]): ReplayEntry[] {
  const active = new Map<string, { sessionId: string; taskId?: string }>()
  for (const entry of entries) {
    if (entry.type === 'SubagentStarted') {
      active.set(entry.toolUseId, { sessionId: entry.sessionId, taskId: entry.taskId })
    } else if (entry.type === 'SubagentProgress') {
      const current = active.get(entry.toolUseId)
      if (current && entry.taskId) current.taskId = entry.taskId
    } else if (entry.type === 'SubagentCompleted') {
      active.delete(entry.toolUseId)
    }
  }
  if (active.size === 0) return [...entries]
  return [
    ...entries,
    ...[...active].map(([toolUseId, task]) => ({
      type: 'SubagentCompleted' as const,
      sessionId: task.sessionId,
      toolUseId,
      ...(task.taskId ? { taskId: task.taskId } : {}),
      outcome: 'unknown' as const,
    })),
  ]
}

/** Give every replay row a monotonic identity. Older sidecars and engine-JSONL recovery have no
 * sequence; assigning one while loading makes all future overlap decisions exact and rewrites the
 * migrated sidecar once. Existing valid sequences are preserved. */
export function normalizeReplaySequence(entries: readonly ReplayEntry[]): ReplayEntry[] {
  let last = 0
  return entries.map((entry) => {
    const replaySeq = entry.replaySeq && entry.replaySeq > last ? entry.replaySeq : last + 1
    last = replaySeq
    return entry.replaySeq === replaySeq ? entry : { ...entry, replaySeq }
  })
}

type TranscriptRow = Record<string, unknown>

function row(item: unknown): TranscriptRow | undefined {
  return item && typeof item === 'object' ? (item as TranscriptRow) : undefined
}

function maxTranscriptId(items: readonly unknown[]): number {
  let max = 0
  for (const item of items) {
    const current = row(item)
    if (typeof current?.id === 'number') max = Math.max(max, current.id)
    if (current?.kind === 'subagent' && Array.isArray(current.children)) {
      for (const child of current.children) {
        const childRow = row(child)
        if (typeof childRow?.id === 'number') max = Math.max(max, childRow.id)
      }
    }
  }
  return max
}

function subagentIndex(items: readonly unknown[], toolUseId: string): number {
  return items.findIndex((item) => {
    const current = row(item)
    return current?.kind === 'subagent' && current.toolUseId === toolUseId
  })
}

function terminalStatus(outcome: 'completed' | 'interrupted' | 'unknown' | undefined): string {
  if (outcome === 'interrupted') return 'interrupted'
  if (outcome === 'unknown') return 'unknown'
  return 'completed'
}

/**
 * Fold only delegated-task events over an existing rendered transcript. This is deliberately
 * idempotent: a renderer may already have persisted the beginning of the sidecar before its window
 * closed, while later child progress/results exist only in durable replay.
 */
export function mergeDelegationReplayIntoTranscript(
  transcript: readonly unknown[],
  entries: readonly ReplayEntry[],
  assistantOccurrences = new Map<string, number>(),
): unknown[] {
  const items = [...transcript]
  let nextId = maxTranscriptId(items) + 1

  for (const entry of entries) {
    if (entry.type === 'SubagentStarted') {
      const index = subagentIndex(items, entry.toolUseId)
      if (index === -1) {
        items.push({
          id: nextId++,
          kind: 'subagent',
          toolUseId: entry.toolUseId,
          taskId: entry.taskId,
          subagentType: entry.subagentType,
          description: entry.description,
          prompt: entry.prompt,
          status: 'running',
          lastActivityAt: Date.now(),
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
          children: [],
        })
      } else {
        const current = row(items[index])!
        items[index] = {
          ...current,
          ...(entry.taskId ? { taskId: entry.taskId } : {}),
          subagentType: current.subagentType || entry.subagentType,
          description: current.description || entry.description,
          prompt: current.prompt || entry.prompt,
          lastActivityAt: Date.now(),
        }
      }
      continue
    }

    if (entry.type === 'SubagentProgress') {
      const index = subagentIndex(items, entry.toolUseId)
      if (index === -1) continue
      const current = row(items[index])!
      items[index] = {
        ...current,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        ...(entry.description ? { liveStatus: entry.description } : {}),
        ...(entry.lastToolName ? { lastToolName: entry.lastToolName } : {}),
        ...(entry.usage ? { usage: entry.usage } : {}),
        ...(entry.status === 'completed' ? { status: 'completed', stopRequested: undefined } : {}),
        lastActivityAt: Date.now(),
      }
      continue
    }

    if (
      (entry.type === 'AssistantBlock' || entry.type === 'ToolRequested' || entry.type === 'ToolResult') &&
      entry.parentToolUseId
    ) {
      const index = subagentIndex(items, entry.parentToolUseId)
      if (index === -1) continue
      const current = row(items[index])!
      const children = Array.isArray(current.children) ? [...current.children] : []
      if (entry.type === 'AssistantBlock') {
        const seenBySequence =
          entry.replaySeq !== undefined &&
          children.some((child) => row(child)?.replaySeq === entry.replaySeq)
        if (!seenBySequence) {
          const key = `${entry.parentToolUseId}\u0000${entry.markdown}`
          const occurrence = (assistantOccurrences.get(key) ?? 0) + 1
          assistantOccurrences.set(key, occurrence)
          const alreadyPersisted = children.filter((child) => {
            const childRow = row(child)
            return childRow?.kind === 'assistant' && childRow.markdown === entry.markdown
          }).length
          if (entry.replaySeq !== undefined || occurrence > alreadyPersisted)
            children.push({
              id: nextId++,
              kind: 'assistant',
              markdown: entry.markdown,
              ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
            })
        }
      } else if (entry.type === 'ToolRequested') {
        const exists = children.some((child) => {
          const childRow = row(child)
          return childRow?.kind === 'tool' && childRow.toolUseId === entry.id
        })
        if (!exists)
          children.push({
            id: nextId++,
            kind: 'tool',
            toolUseId: entry.id,
            name: entry.name,
            input: entry.input,
            ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
          })
      } else {
        for (let i = 0; i < children.length; i++) {
          const child = row(children[i])
          if (child?.kind === 'tool' && child.toolUseId === entry.id)
            children[i] = { ...child, result: entry.output, isError: entry.isError }
        }
      }
      items[index] = { ...current, children, lastActivityAt: Date.now() }
      continue
    }

    if (entry.type === 'SubagentCompleted') {
      const index = subagentIndex(items, entry.toolUseId)
      if (index === -1) continue
      const current = row(items[index])!
      // `unknown` is synthetic evidence that replay ended without a terminal event. A renderer snapshot
      // that already holds completed/interrupted is stronger evidence and must never be downgraded.
      if (entry.outcome === 'unknown' && current.status !== 'running') continue
      items[index] = {
        ...current,
        status: terminalStatus(entry.outcome),
        stopRequested: undefined,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        isError: entry.isError,
        ...(entry.resultText ? { resultText: entry.resultText } : {}),
        ...(entry.usage ? { usage: entry.usage } : {}),
        lastActivityAt: Date.now(),
      }
    }
  }
  return items
}

/**
 * Fold the readable replay over an existing transcript without duplicating the prefix a renderer
 * already persisted before going headless. Tool/subagent identities are stable; repeated plain text is
 * counted so legitimate duplicates within one replay remain distinct.
 */
export function mergeReplayIntoTranscript(
  transcript: readonly unknown[],
  entries: readonly ReplayEntry[],
): unknown[] {
  let items = [...transcript]
  let nextId = maxTranscriptId(items) + 1
  const userOccurrences = new Map<string, number>()
  const assistantOccurrences = new Map<string, number>()
  const noticeOccurrences = new Map<string, number>()
  const childAssistantOccurrences = new Map<string, number>()

  for (const entry of entries) {
    if (entry.type === 'RemoteUserTurn') {
      if (
        entry.replaySeq !== undefined &&
        items.some((item) => row(item)?.replaySeq === entry.replaySeq)
      )
        continue
      const occurrence = (userOccurrences.get(entry.text) ?? 0) + 1
      userOccurrences.set(entry.text, occurrence)
      const existing = items.filter((item) => {
        const current = row(item)
        return current?.kind === 'user' && current.text === entry.text
      }).length
      if (entry.replaySeq !== undefined || occurrence > existing)
        items.push({
          id: nextId++,
          kind: 'user',
          text: entry.text,
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
        })
      continue
    }
    if (entry.type === 'AssistantBlock' && !entry.parentToolUseId) {
      if (
        entry.replaySeq !== undefined &&
        items.some((item) => row(item)?.replaySeq === entry.replaySeq)
      )
        continue
      const occurrence = (assistantOccurrences.get(entry.markdown) ?? 0) + 1
      assistantOccurrences.set(entry.markdown, occurrence)
      const existing = items.filter((item) => {
        const current = row(item)
        return current?.kind === 'assistant' && current.markdown === entry.markdown
      }).length
      if (entry.replaySeq !== undefined || occurrence > existing)
        items.push({
          id: nextId++,
          kind: 'assistant',
          markdown: entry.markdown,
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
        })
      continue
    }
    if (entry.type === 'ToolRequested' && !entry.parentToolUseId) {
      const exists = items.some((item) => {
        const current = row(item)
        return current?.kind === 'tool' && current.toolUseId === entry.id
      })
      if (!exists)
        items.push({
          id: nextId++,
          kind: 'tool',
          toolUseId: entry.id,
          name: entry.name,
          input: entry.input,
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
        })
      continue
    }
    if (entry.type === 'ToolResult' && !entry.parentToolUseId) {
      items = items.map((item) => {
        const current = row(item)
        return current?.kind === 'tool' && current.toolUseId === entry.id
          ? { ...current, result: entry.output, isError: entry.isError }
          : item
      })
      continue
    }
    if (entry.type === 'EngineError') {
      if (
        entry.replaySeq !== undefined &&
        items.some((item) => row(item)?.replaySeq === entry.replaySeq)
      )
        continue
      const text = `engine notice: ${entry.message}`
      const occurrence = (noticeOccurrences.get(text) ?? 0) + 1
      noticeOccurrences.set(text, occurrence)
      const existing = items.filter((item) => {
        const current = row(item)
        return current?.kind === 'notice' && current.text === text
      }).length
      if (entry.replaySeq !== undefined || occurrence > existing)
        items.push({
          id: nextId++,
          kind: 'notice',
          text,
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
        })
      continue
    }
    if (
      entry.type === 'SubagentStarted' ||
      entry.type === 'SubagentProgress' ||
      entry.type === 'SubagentCompleted' ||
      ((entry.type === 'AssistantBlock' || entry.type === 'ToolRequested' || entry.type === 'ToolResult') &&
        entry.parentToolUseId)
    ) {
      items = mergeDelegationReplayIntoTranscript(items, [entry], childAssistantOccurrences)
      nextId = maxTranscriptId(items) + 1
    }
  }
  return items
}

/** Rebuild the readable core of a headless transcript from its normalized replay sidecar. */
export function transcriptFromReplay(entries: readonly ReplayEntry[]): unknown[] {
  return mergeReplayIntoTranscript([], entries)
}
