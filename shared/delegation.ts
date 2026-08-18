import {
  AttachmentProvenanceSchema,
  EngineEventSchema,
  ImageAttachmentSchema,
  MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS,
  TURN_REJECTED_STOP_REASON,
  TurnFailureEnvelopeSchema,
  stripRawEnvelope,
  type EngineEvent,
  type ReplayEntry,
  type TurnFailureEnvelope,
  type TurnFailureTarget,
} from './ipc'

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

/** One rendered delegation row is live when its process or any observed workflow member is running. */
export function delegationItemIsLive(item: unknown): boolean {
  const current = row(item)
  if (current?.kind === 'subagent') return current.status === 'running'
  if (current?.kind !== 'workflow') return false
  return (
    current.status === 'running' ||
    (Array.isArray(current.agents) &&
      current.agents.some((agent) => row(agent)?.status === 'running'))
  )
}

/** How many rendered delegated workers still belong to the live engine process. A workflow with no
 * observed member yet counts as one coordinator; once members appear, their running rows are the
 * count. This keeps teardown-sensitive posture controls locked for both delegation protocols. */
export function runningDelegationCount(items: readonly unknown[]): number {
  let running = 0
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (row.kind === 'subagent' && delegationItemIsLive(row)) running++
    if (row.kind === 'workflow') {
      const members = Array.isArray(row.agents)
        ? row.agents.filter((agent) => {
            const member = agent && typeof agent === 'object' ? (agent as Record<string, unknown>) : null
            return member?.status === 'running'
          }).length
        : 0
      running += members || (delegationItemIsLive(row) ? 1 : 0)
    }
  }
  return running
}

/** True while at least one rendered delegated worker still belongs to the live engine process. */
export function hasRunningDelegation(items: readonly unknown[]): boolean {
  return runningDelegationCount(items) > 0
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
  if (row.kind === 'workflow') {
    let changed = row.status === 'running'
    const agents = Array.isArray(row.agents)
      ? row.agents.map((agent) => {
          if (!agent || typeof agent !== 'object') return agent
          const member = agent as Record<string, unknown>
          if (member.status !== 'running') return agent
          changed = true
          return { ...member, status: 'unknown' }
        })
      : row.agents
    if (changed) return { ...row, status: 'unknown', agents } as T
  }
  if (row.kind === 'subagent' && row.status === 'running')
    return { ...row, status: 'unknown', stopRequested: undefined } as T
  return item
}

export function settleRestoredTranscriptItems<T>(
  items: readonly T[],
  activeSubagentToolUseIds: ReadonlySet<string> = new Set(),
  activeWorkflows: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): T[] {
  return items.map((item) => {
    const current = row(item)
    if (
      current?.kind === 'subagent' &&
      typeof current.toolUseId === 'string' &&
      activeSubagentToolUseIds.has(current.toolUseId)
    )
      return { ...current, status: 'running', stopRequested: undefined } as T
    if (
      current?.kind === 'workflow' &&
      typeof current.runId === 'string' &&
      activeWorkflows.has(current.runId)
    ) {
      const runningAgentIds = activeWorkflows.get(current.runId)!
      const agents = Array.isArray(current.agents)
        ? current.agents.map((agent) => {
            const member = row(agent)
            return member && runningAgentIds.has(String(member.agentId))
              ? { ...member, status: 'running' }
              : agent
          })
        : current.agents
      // Hydration honestly settles an unobserved workflow to unknown. If main still owns the exact
      // watcher, re-open only that coordinator and its explicitly-running members. A quiet-completed
      // coordinator stays completed while the watcher lingers for a possible late wave.
      const status = current.status === 'unknown' ? 'running' : current.status
      return { ...current, status, agents } as T
    }
    return settleRestoredTranscriptItem(item)
  })
}

/**
 * A replay file can end mid-delegation when Koda itself disappears. Append one honest unknown event
 * for every task or workflow that never reached a terminal observation, preserving completed results.
 */
export function settleRestoredDelegationReplay(entries: readonly ReplayEntry[]): ReplayEntry[] {
  const active = new Map<string, { sessionId: string; taskId?: string }>()
  const workflows = new Map<
    string,
    { sessionId: string; coordinatorDone: boolean; runningAgentIds: Set<string> }
  >()
  for (const entry of entries) {
    if (entry.type === 'SubagentStarted') {
      active.set(entry.toolUseId, { sessionId: entry.sessionId, taskId: entry.taskId })
    } else if (entry.type === 'SubagentProgress') {
      const current = active.get(entry.toolUseId)
      if (current && entry.taskId) current.taskId = entry.taskId
    } else if (entry.type === 'SubagentCompleted') {
      active.delete(entry.toolUseId)
    } else if (entry.type === 'WorkflowStarted') {
      workflows.set(entry.runId, {
        sessionId: entry.sessionId,
        coordinatorDone: false,
        runningAgentIds: new Set(),
      })
    } else if (entry.type === 'WorkflowAgent') {
      const workflow = workflows.get(entry.runId)
      if (workflow) {
        if (entry.status === 'running') workflow.runningAgentIds.add(entry.agentId)
        else workflow.runningAgentIds.delete(entry.agentId)
      }
    } else if (entry.type === 'WorkflowCompleted') {
      const workflow = workflows.get(entry.runId)
      if (workflow) workflow.coordinatorDone = true
    } else if (entry.type === 'WorkflowObservationEnded') {
      workflows.delete(entry.runId)
    }
  }
  if (active.size === 0 && workflows.size === 0) return [...entries]
  const settled: ReplayEntry[] = [...entries]
  for (const [toolUseId, task] of active) {
    settled.push({
      type: 'SubagentCompleted' as const,
      sessionId: task.sessionId,
      toolUseId,
      ...(task.taskId ? { taskId: task.taskId } : {}),
      outcome: 'unknown' as const,
    })
  }
  for (const [runId, workflow] of workflows) {
    if (workflow.coordinatorDone && workflow.runningAgentIds.size === 0) continue
    settled.push({
      type: 'WorkflowObservationEnded',
      sessionId: workflow.sessionId,
      runId,
      unresolvedAgentIds: [...workflow.runningAgentIds],
    })
  }
  return settled
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

/** A newer engine attempt for the same logical user bubble supersedes the prior attempt's terminal
 * failure. Remove both the canonical envelope and its one-commit legacy predecessor before replacing
 * cursor/attachment metadata; otherwise a successful retry resurrects Retry after persistence. */
export function supersedeTurnFailure<T>(item: T): T {
  const current = row(item)
  if (!current || (!('turnFailure' in current) && !('engineError' in current))) return item
  const {
    turnFailure: _turnFailure,
    engineError: _legacyEngineError,
    ...withoutFailure
  } = current
  return withoutFailure as T
}

/** Canonical turn-level error threshold shared by replay, renderer banners, and remote attention. */
export function isRetryableTerminalEngineError(
  event: Extract<EngineEvent, { type: 'EngineError' }>,
): boolean {
  return event.fatal || event.category === 'apiError' || event.category === 'turnRejected'
}

/** Common terminal-attention meaning of an engine event. Consumers still own local effects such as
 * revisions, notification guards, error dominance, and whether a workflow card is actually settled. */
export function terminalAttentionKind(event: EngineEvent): 'done' | 'error' | null {
  if (event.type === 'EngineError')
    return isRetryableTerminalEngineError(event) ? 'error' : null
  if (event.type === 'WorkflowCompleted') return 'done'
  if (event.type === 'TurnComplete' && event.stopReason !== TURN_REJECTED_STOP_REASON)
    return 'done'
  return null
}

/** Correlate the launcher's terminal fact with the exact live/replayed event that produced it. Events
 * outside durable remote replay have no sequence; main owns their UUID fallback. */
export function terminalAttentionRevision(event: EngineEvent): string | undefined {
  return event.replaySeq === undefined ? undefined : String(event.replaySeq)
}

function failureTargetFromUserRow(current: TranscriptRow | undefined): TurnFailureTarget | undefined {
  if (current?.kind !== 'user') return undefined
  const userId = typeof current.id === 'number' && Number.isInteger(current.id) && current.id > 0
    ? current.id
    : undefined
  const replaySeq =
    typeof current.replaySeq === 'number' && Number.isInteger(current.replaySeq) && current.replaySeq > 0
      ? current.replaySeq
      : undefined
  const clientTurnId = typeof current.clientTurnId === 'string' && current.clientTurnId
    ? current.clientTurnId
    : undefined
  if (userId === undefined && replaySeq === undefined && clientTurnId === undefined) return undefined
  const parsedImages = ImageAttachmentSchema.array().min(1).safeParse(current.images)
  const images = parsedImages.success ? parsedImages.data : undefined
  const parsedAttachments = AttachmentProvenanceSchema.array().min(1).safeParse(current.attachments)
  const attachments = parsedAttachments.success ? parsedAttachments.data : undefined
  const legacyImageOnly = current.text === '(image)' && current.hadImages !== false
  const hadImages =
    current.hadImages === true ||
    images?.some((item) => item.mediaType.startsWith('image/')) === true ||
    legacyImageOnly
  const hadAttachments =
    current.hadAttachments === true || !!attachments?.length || !!images?.length || legacyImageOnly
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(replaySeq !== undefined ? { replaySeq } : {}),
    ...(clientTurnId ? { clientTurnId } : {}),
    // Old replay wrote `(image)` in place of the empty original prompt. Preserving it as send text
    // would retry a caption after its photo bytes disappeared, so normalize only that legacy sentinel.
    text: legacyImageOnly ? '' : typeof current.text === 'string' ? current.text : '',
    hadImages,
    hadAttachments,
    ...(attachments?.length ? { attachments } : {}),
    ...(images?.length ? { images } : {}),
  }
}

/** Exact bytes are useful retry material only while the whole payload fits the durable budget. When it
 * does not, preserve the stable target and lightweight attachment provenance so hydration can say
 * "reattach" instead of losing the failure envelope altogether. Also self-heals legacy envelopes written
 * before the cap existed. */
function boundedFailureTarget(target: unknown): unknown {
  const current = row(target)
  if (!current || !Array.isArray(current.images)) return target
  const exact = ImageAttachmentSchema.array().min(1).safeParse(current.images)
  if (!exact.success) return target
  const exactChars = exact.data.reduce(
    (chars, attachment) => chars + attachment.dataBase64.length,
    0,
  )
  if (exactChars <= MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS) return target
  const existingProvenance = AttachmentProvenanceSchema.array().min(1).safeParse(
    current.attachments,
  )
  const provenance = existingProvenance.success
    ? existingProvenance.data
    : exact.data.map(({ mediaType, name }) => ({ mediaType, ...(name ? { name } : {}) }))
  const { images: _oversizedImages, attachments: _oldAttachments, ...bounded } = current
  return {
    ...bounded,
    hadImages:
      current.hadImages === true ||
      exact.data.some((attachment) => attachment.mediaType.startsWith('image/')),
    hadAttachments: true,
    attachments: provenance,
  }
}

function makeTurnFailure(
  event: Extract<EngineEvent, { type: 'EngineError' }>,
  target?: TurnFailureTarget,
): TurnFailureEnvelope | undefined {
  if (!isRetryableTerminalEngineError(event)) return undefined
  const parsed = TurnFailureEnvelopeSchema.safeParse({
    error: stripRawEnvelope(event),
    ...(target ? { target: boundedFailureTarget(target) } : {}),
  })
  return parsed.success ? parsed.data : undefined
}

/** Recover the canonical durable failure from an opaque transcript row. `engineError` is the one-commit
 * legacy shape; reading it here makes already-written snapshots self-migrating while every new writer
 * emits the single `turnFailure` envelope. */
export function turnFailureOf(item: unknown): TurnFailureEnvelope | undefined {
  const current = row(item)
  let candidate = current?.turnFailure
  const failure = row(candidate)
  const target = row(failure?.target)
  if (failure && target) candidate = { ...failure, target: boundedFailureTarget(target) }
  const parsed = TurnFailureEnvelopeSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  const legacy = EngineEventSchema.safeParse(current?.engineError)
  return legacy.success && legacy.data.type === 'EngineError'
    ? makeTurnFailure(legacy.data, failureTargetFromUserRow(current))
    : undefined
}

/** Back-compatible error-only reader for callers that have not moved to the durable target envelope. */
export function replayedEngineErrorOf(
  item: unknown,
): Extract<EngineEvent, { type: 'EngineError' }> | undefined {
  return turnFailureOf(item)?.error
}

/** Attach a live terminal failure to the exact user row that owns it. Generic because main treats
 * renderer transcript rows opaquely. When there is no user row, the live banner still works; replay
 * conversion attaches the target-less envelope to its readable notice instead. */
export function attachTurnFailureToTranscript<T>(
  items: readonly T[],
  event: Extract<EngineEvent, { type: 'EngineError' }>,
): T[] {
  const index = replayFailureUserIndex(items, event)
  if (index < 0) return [...items]
  const current = row(items[index])
  const failure = makeTurnFailure(event, failureTargetFromUserRow(current))
  if (!failure) return [...items]
  const next = [...items]
  next[index] = { ...current, turnFailure: failure } as T
  return next
}

/** Latest unsuperseded persisted failure. A newer user turn clears an older failure even though its row
 * remains in history; this mirrors the live fresh-send behavior and prevents a reload resurrecting A's
 * banner after B already ran. */
export function latestTurnFailureOf(items: readonly unknown[]): TurnFailureEnvelope | undefined {
  let latest: TurnFailureEnvelope | undefined
  for (const item of items) {
    if (row(item)?.kind === 'user') latest = undefined
    const failure = turnFailureOf(item)
    if (failure) latest = failure
  }
  return latest
}

/** Find the user row that preceded this failure in durable replay. When the transcript already contains
 * a later turn, the matching notice's replay identity is the ordering boundary; without that guard a
 * backfill of turn A could incorrectly make newer turn B the retry target. */
function replayFailureUserIndex(
  items: readonly unknown[],
  event: Extract<EngineEvent, { type: 'EngineError' }>,
): number {
  let from = items.length - 1
  if (event.replaySeq !== undefined) {
    const existing = items.findIndex((item) => row(item)?.replaySeq === event.replaySeq)
    if (existing >= 0) from = existing - 1
  }
  for (let i = from; i >= 0; i--) {
    const current = row(items[i])
    if (current?.kind !== 'user') continue
    if (
      event.replaySeq === undefined ||
      current.replaySeq === undefined ||
      (typeof current.replaySeq === 'number' && current.replaySeq < event.replaySeq)
    )
      return i
  }
  return -1
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

function workflowIndex(items: readonly unknown[], runId: string): number {
  return items.findIndex((item) => {
    const current = row(item)
    return current?.kind === 'workflow' && current.runId === runId
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
    if (entry.type === 'WorkflowStarted') {
      const index = workflowIndex(items, entry.runId)
      if (index === -1) {
        items.push({
          id: nextId++,
          kind: 'workflow',
          runId: entry.runId,
          name: entry.name,
          status: 'running',
          agents: [],
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
        })
      } else {
        const current = row(items[index])!
        items[index] = { ...current, name: current.name || entry.name }
      }
      continue
    }

    if (entry.type === 'WorkflowAgent') {
      const index = workflowIndex(items, entry.runId)
      if (index === -1) continue
      const current = row(items[index])!
      const agents = Array.isArray(current.agents) ? [...current.agents] : []
      const agentIndex = agents.findIndex((agent) => row(agent)?.agentId === entry.agentId)
      if (agentIndex === -1) {
        agents.push({ agentId: entry.agentId, status: entry.status, result: entry.result })
      } else {
        const agent = row(agents[agentIndex])!
        agents[agentIndex] = {
          ...agent,
          status: entry.status,
          ...(entry.result ? { result: entry.result } : {}),
        }
      }
      items[index] = { ...current, agents }
      continue
    }

    if (entry.type === 'WorkflowCompleted') {
      const index = workflowIndex(items, entry.runId)
      if (index !== -1) items[index] = { ...row(items[index])!, status: 'completed' }
      continue
    }

    if (entry.type === 'WorkflowObservationEnded') {
      const index = workflowIndex(items, entry.runId)
      if (index === -1) continue
      const current = row(items[index])!
      const unresolved = new Set(entry.unresolvedAgentIds)
      // A synthetic observer-loss tail must not overwrite a renderer snapshot that already holds
      // stronger terminal evidence. A non-empty unresolved set still wins: it means a later wave was
      // live even if the coordinator had previously reached its quiet-completion heuristic.
      if (unresolved.size === 0 && current.status !== 'running') continue
      const agents = Array.isArray(current.agents)
        ? current.agents.map((agent) => {
            const member = row(agent)
            return member && unresolved.has(String(member.agentId))
              ? { ...member, status: 'unknown' }
              : agent
          })
        : current.agents
      items[index] = { ...current, status: 'unknown', agents }
      continue
    }

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
      if (entry.clientTurnId) {
        const existingIndex = items.findIndex((item) => {
          const current = row(item)
          return current?.kind === 'user' && current.clientTurnId === entry.clientTurnId
        })
        if (existingIndex >= 0) {
          const current = row(supersedeTurnFailure(items[existingIndex]))!
          const {
            images: _oldImages,
            attachments: _oldAttachments,
            files: _oldFiles,
            ...stable
          } = current
          items[existingIndex] = {
            ...stable,
            text: entry.text || (entry.hadImages || entry.images?.length ? '(image)' : ''),
            ...(entry.replaySeq !== undefined ? { replaySeq: entry.replaySeq } : {}),
            ...(entry.hadImages !== undefined ? { hadImages: entry.hadImages } : {}),
            ...(entry.hadAttachments !== undefined
              ? { hadAttachments: entry.hadAttachments }
              : {}),
            ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
            ...(entry.attachments?.some((item) => item.name)
              ? { files: entry.attachments.flatMap((item) => (item.name ? [item.name] : [])) }
              : {}),
            ...(entry.images?.length ? { images: entry.images } : {}),
          }
          continue
        }
      }
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
          text: entry.text || (entry.hadImages || entry.images?.length ? '(image)' : ''),
          ...(entry.clientTurnId ? { clientTurnId: entry.clientTurnId } : {}),
          ...(entry.hadAttachments !== undefined ? { hadAttachments: entry.hadAttachments } : {}),
          ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
          ...(entry.attachments?.some((item) => item.name)
            ? { files: entry.attachments.flatMap((item) => (item.name ? [item.name] : [])) }
            : {}),
          ...(entry.hadImages || entry.images?.length ? { hadImages: true } : {}),
          ...(entry.images?.length ? { images: entry.images } : {}),
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
      // Bind retry semantics to the exact user row, not to nearby display prose. This runs before the
      // notice dedupe so replay can backfill a renderer snapshot produced by an older converter that
      // already contains the plain notice but discarded the EngineError classification.
      let boundToUser = false
      let turnFailure = makeTurnFailure(entry)
      if (isRetryableTerminalEngineError(entry)) {
        const i = replayFailureUserIndex(items, entry)
        if (i >= 0) {
          const current = row(items[i])!
          turnFailure = makeTurnFailure(entry, failureTargetFromUserRow(current))
          if (turnFailure) {
            items[i] = { ...current, turnFailure }
            boundToUser = true
          }
        }
      }
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
          ...(!boundToUser && turnFailure ? { turnFailure } : {}),
          ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
        })
      continue
    }
    if (
      entry.type === 'WorkflowStarted' ||
      entry.type === 'WorkflowAgent' ||
      entry.type === 'WorkflowCompleted' ||
      entry.type === 'WorkflowObservationEnded' ||
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

/** Build response-level failure metadata directly from a replay log. This is the headless counterpart
 * to latestTurnFailureOf(items): the relay can carry the exact target independently of pagination even
 * when no rendered transcript exists yet. */
export function latestReplayTurnFailure(
  entries: readonly ReplayEntry[],
): TurnFailureEnvelope | undefined {
  let target: TurnFailureTarget | undefined
  let latest: TurnFailureEnvelope | undefined
  for (const entry of entries) {
    if (entry.type === 'RemoteUserTurn') {
      latest = undefined
      const hadImages =
        entry.hadImages === true ||
        entry.images?.some((item) => item.mediaType.startsWith('image/')) === true ||
        entry.text === '(image)'
      const hadAttachments =
        entry.hadAttachments === true ||
        !!entry.attachments?.length ||
        !!entry.images?.length ||
        entry.text === '(image)'
      target = entry.replaySeq || entry.clientTurnId
        ? {
            ...(entry.replaySeq ? { replaySeq: entry.replaySeq } : {}),
            ...(entry.clientTurnId ? { clientTurnId: entry.clientTurnId } : {}),
            text: entry.text === '(image)' && hadImages ? '' : entry.text,
            hadImages,
            hadAttachments,
            ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
            ...(entry.images?.length ? { images: entry.images } : {}),
          }
        : undefined
    } else if (entry.type === 'EngineError') {
      const failure = makeTurnFailure(entry, target)
      if (failure) latest = failure
    }
  }
  return latest
}
