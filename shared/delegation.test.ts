import { describe, expect, it } from 'vitest'
import {
  appendLiveToolOutput,
  attachTurnFailureToTranscript,
  delegationItemIsLive,
  hasRunningDelegation,
  isTopLevelTurnActivity,
  mergeDelegationReplayIntoTranscript,
  mergeReplayIntoTranscript,
  normalizeReplaySequence,
  latestReplayTurnFailure,
  latestTurnFailureOf,
  replayedEngineErrorOf,
  runningDelegationCount,
  settleRestoredDelegationReplay,
  settleRestoredTranscriptItems,
  terminalAttentionKind,
  terminalAttentionRevision,
  transcriptFromReplay,
  turnFailureOf,
} from './delegation'
import {
  MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS,
  TURN_REJECTED_STOP_REASON,
  type EngineEvent,
} from './ipc'

const terminalAttentionCases: Array<[
  string,
  EngineEvent,
  'done' | 'error' | null,
]> = [
  ['successful turn completion', { type: 'TurnComplete', sessionId: 's1', stopReason: 'success' }, 'done'],
  ['interrupted turn completion', { type: 'TurnComplete', sessionId: 's1', stopReason: 'interrupted' }, 'done'],
  ['completion without a reason', { type: 'TurnComplete', sessionId: 's1' }, 'done'],
  [
    'compatibility turn rejection',
    { type: 'TurnComplete', sessionId: 's1', stopReason: TURN_REJECTED_STOP_REASON },
    null,
  ],
  [
    'settled workflow completion',
    { type: 'WorkflowCompleted', sessionId: 's1', runId: 'review', agentCount: 2 },
    'done',
  ],
  [
    'fatal engine error',
    { type: 'EngineError', sessionId: 's1', message: 'exited', fatal: true },
    'error',
  ],
  [
    'API engine error',
    { type: 'EngineError', sessionId: 's1', message: 'rate limited', fatal: false, category: 'apiError' },
    'error',
  ],
  [
    'turn-rejected engine error',
    { type: 'EngineError', sessionId: 's1', message: 'rejected', fatal: false, category: 'turnRejected' },
    'error',
  ],
  [
    'recoverable engine notice',
    { type: 'EngineError', sessionId: 's1', message: 'reconnecting', fatal: false },
    null,
  ],
  ['unrelated engine event', { type: 'AssistantBlock', sessionId: 's1', markdown: 'hello' }, null],
]

describe('terminal attention classification', () => {
  it.each(terminalAttentionCases)('%s', (_name, event, expected) => {
    expect(terminalAttentionKind(event)).toBe(expected)
  })

  it('uses the durable replay identity as the shared launcher/event revision', () => {
    expect(
      terminalAttentionRevision({
        type: 'TurnComplete',
        sessionId: 's1',
        stopReason: 'success',
        replaySeq: 42,
      }),
    ).toBe('42')
    expect(
      terminalAttentionRevision({ type: 'TurnComplete', sessionId: 's1', stopReason: 'success' }),
    ).toBeUndefined()
  })
})

describe('delegation lifecycle helpers', () => {
  it('bounds noisy live tool output while preserving the newest tail', () => {
    const output = appendLiveToolOutput('old'.repeat(3_000), 'LATEST')
    expect(output.length).toBeLessThanOrEqual(8_000)
    expect(output).toContain('earlier output omitted')
    expect(output.endsWith('LATEST')).toBe(true)
  })

  it('does not treat forwarded child prose or tools as parent-turn activity', () => {
    expect(isTopLevelTurnActivity({ type: 'AssistantBlock', sessionId: 's1', markdown: 'parent' })).toBe(true)
    expect(
      isTopLevelTurnActivity({
        type: 'AssistantBlock',
        sessionId: 's1',
        markdown: 'child',
        parentToolUseId: 'agent-1',
      }),
    ).toBe(false)
    expect(
      isTopLevelTurnActivity({
        type: 'ToolRequested',
        sessionId: 's1',
        id: 'read-1',
        name: 'Read',
        input: {},
        parentToolUseId: 'agent-1',
      }),
    ).toBe(false)
    expect(isTopLevelTurnActivity({ type: 'AssistantDelta', sessionId: 's1', text: 'live' })).toBe(true)
  })

  it('settles a persisted running card as unknown and clears its pending stop', () => {
    const [item] = settleRestoredTranscriptItems([
      { kind: 'subagent', status: 'running', stopRequested: true },
    ])
    expect(item).toEqual({ kind: 'subagent', status: 'unknown', stopRequested: undefined })
    expect(hasRunningDelegation([item])).toBe(false)
  })

  it('settles every unresolved workflow member when no journal watcher survives restoration', () => {
    const [item] = settleRestoredTranscriptItems([
      {
        kind: 'workflow',
        status: 'completed',
        agents: [
          { agentId: 'lost', status: 'running' },
          { agentId: 'done', status: 'done', result: 'finished' },
        ],
      },
    ])
    expect(item).toEqual({
      kind: 'workflow',
      status: 'unknown',
      agents: [
        { agentId: 'lost', status: 'unknown' },
        { agentId: 'done', status: 'done', result: 'finished' },
      ],
    })
  })

  it('keeps teardown-sensitive posture locked for a live workflow coordinator or member', () => {
    const preparing = { kind: 'workflow', status: 'running', agents: [] }
    const lateWave = {
      kind: 'workflow',
      status: 'completed',
      agents: [
        { agentId: 'done', status: 'done' },
        { agentId: 'late', status: 'running' },
      ],
    }
    const settled = {
      kind: 'workflow',
      status: 'unknown',
      agents: [{ agentId: 'lost', status: 'unknown' }],
    }

    expect(runningDelegationCount([preparing])).toBe(1)
    expect(runningDelegationCount([lateWave])).toBe(1)
    expect(delegationItemIsLive(preparing)).toBe(true)
    expect(delegationItemIsLive(settled)).toBe(false)
    expect(hasRunningDelegation([preparing])).toBe(true)
    expect(hasRunningDelegation([settled])).toBe(false)
    expect(hasRunningDelegation([lateWave])).toBe(true)
  })

  it('preserves a running card when main still owns that exact child', () => {
    const [item] = settleRestoredTranscriptItems(
      [{ kind: 'subagent', toolUseId: 'agent-1', status: 'running' }],
      new Set(['agent-1']),
    )
    expect(item).toEqual({ kind: 'subagent', toolUseId: 'agent-1', status: 'running' })
  })

  it('reactivates a hydrated unknown card only when main owns that exact child', () => {
    const [item] = settleRestoredTranscriptItems(
      [{ kind: 'subagent', toolUseId: 'agent-1', status: 'unknown', stopRequested: true }],
      new Set(['agent-1']),
    )
    expect(item).toEqual({
      kind: 'subagent',
      toolUseId: 'agent-1',
      status: 'running',
      stopRequested: undefined,
    })
  })

  it('reactivates only the workflow and members main is still observing', () => {
    const [item] = settleRestoredTranscriptItems(
      [
        {
          kind: 'workflow',
          runId: 'review',
          status: 'unknown',
          agents: [
            { agentId: 'live', status: 'unknown' },
            { agentId: 'done', status: 'done', result: 'finished' },
          ],
        },
      ],
      new Set(),
      new Map([['review', new Set(['live'])]]),
    )
    expect(item).toEqual({
      kind: 'workflow',
      runId: 'review',
      status: 'running',
      agents: [
        { agentId: 'live', status: 'running' },
        { agentId: 'done', status: 'done', result: 'finished' },
      ],
    })
  })

  it('migrates legacy replay rows to stable monotonic identities', () => {
    const normalized = normalizeReplaySequence([
      { type: 'RemoteUserTurn', sessionId: 's1', text: 'first' },
      { type: 'AssistantBlock', sessionId: 's1', markdown: 'reply', replaySeq: 4 },
      { type: 'RemoteUserTurn', sessionId: 's1', text: 'again', replaySeq: 2 },
    ])
    expect(normalized.map((entry) => entry.replaySeq)).toEqual([1, 4, 5])
  })

  it('adds unknown only for replayed tasks that never reached a terminal event', () => {
    const restored = settleRestoredDelegationReplay([
      {
        type: 'SubagentStarted',
        sessionId: 's1',
        toolUseId: 'lost',
        taskId: 'task-lost',
        subagentType: 'scout',
        description: 'Inspect',
      },
      {
        type: 'SubagentStarted',
        sessionId: 's1',
        toolUseId: 'done',
        taskId: 'task-done',
        subagentType: 'scout',
        description: 'Report',
      },
      {
        type: 'SubagentCompleted',
        sessionId: 's1',
        toolUseId: 'done',
        taskId: 'task-done',
        outcome: 'completed',
        resultText: 'finished',
      },
    ])
    expect(restored.at(-1)).toEqual({
      type: 'SubagentCompleted',
      sessionId: 's1',
      toolUseId: 'lost',
      taskId: 'task-lost',
      outcome: 'unknown',
    })
    expect(restored.filter((entry) => entry.type === 'SubagentCompleted')).toHaveLength(2)
  })

  it('settles an unobserved workflow and preserves one with confirmed completion', () => {
    const restored = settleRestoredDelegationReplay([
      {
        type: 'WorkflowStarted',
        sessionId: 's1',
        runId: 'lost-run',
        name: 'Lost review',
      },
      {
        type: 'WorkflowAgent',
        sessionId: 's1',
        runId: 'lost-run',
        agentId: 'lost',
        status: 'running',
      },
      {
        type: 'WorkflowAgent',
        sessionId: 's1',
        runId: 'lost-run',
        agentId: 'done',
        status: 'done',
        result: 'finished',
      },
      {
        type: 'WorkflowStarted',
        sessionId: 's1',
        runId: 'done-run',
        name: 'Finished review',
      },
      {
        type: 'WorkflowCompleted',
        sessionId: 's1',
        runId: 'done-run',
        agentCount: 0,
      },
    ])

    expect(restored.filter((entry) => entry.type === 'WorkflowObservationEnded')).toEqual([
      {
        type: 'WorkflowObservationEnded',
        sessionId: 's1',
        runId: 'lost-run',
        unresolvedAgentIds: ['lost'],
      },
    ])
    expect(settleRestoredDelegationReplay(restored)).toEqual(restored)
  })

  it('rebuilds a headless conversation and its completed delegated result', () => {
    const items = transcriptFromReplay([
      { type: 'RemoteUserTurn', sessionId: 's1', text: 'inspect this' },
      {
        type: 'SubagentStarted',
        sessionId: 's1',
        toolUseId: 'agent-1',
        subagentType: 'scout',
        description: 'Inspect',
      },
      {
        type: 'AssistantBlock',
        sessionId: 's1',
        markdown: 'found evidence',
        parentToolUseId: 'agent-1',
      },
      {
        type: 'SubagentCompleted',
        sessionId: 's1',
        toolUseId: 'agent-1',
        outcome: 'completed',
        resultText: 'summary',
      },
      { type: 'AssistantBlock', sessionId: 's1', markdown: 'parent reply' },
    ]) as Array<Record<string, unknown>>

    expect(items.map((item) => item.kind)).toEqual(['user', 'subagent', 'assistant'])
    expect(items[1]).toMatchObject({ status: 'completed', resultText: 'summary' })
    expect(items[1].children).toEqual([
      expect.objectContaining({ kind: 'assistant', markdown: 'found evidence' }),
    ])
  })

  it('keeps terminal failure semantics on the exact replayed user row', () => {
    const items = transcriptFromReplay([
      { type: 'RemoteUserTurn', sessionId: 's1', text: 'first', replaySeq: 1 },
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'provider refused the request',
        fatal: false,
        category: 'apiError',
        replaySeq: 2,
        raw: { source: 'claude', method: 'result', payload: { private: 'main-only' } },
      },
      { type: 'TurnComplete', sessionId: 's1', stopReason: 'error_during_execution', replaySeq: 3 },
      { type: 'RemoteUserTurn', sessionId: 's1', text: 'second', replaySeq: 4 },
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'turn never started',
        fatal: false,
        category: 'turnRejected',
        replaySeq: 5,
      },
      {
        type: 'TurnComplete',
        sessionId: 's1',
        stopReason: TURN_REJECTED_STOP_REASON,
        replaySeq: 6,
      },
      { type: 'RemoteUserTurn', sessionId: 's1', text: 'third', replaySeq: 7 },
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'process exited',
        fatal: true,
        replaySeq: 8,
      },
    ]) as Array<Record<string, unknown>>

    const users = items.filter((item) => item.kind === 'user')
    expect(replayedEngineErrorOf(users[0])).toMatchObject({
      type: 'EngineError',
      message: 'provider refused the request',
      fatal: false,
      category: 'apiError',
    })
    expect(replayedEngineErrorOf(users[0])).not.toHaveProperty('raw')
    expect(turnFailureOf(users[0])?.target).toMatchObject({
      userId: expect.any(Number),
      replaySeq: 1,
      text: 'first',
      hadImages: false,
    })
    expect(replayedEngineErrorOf(users[1])).toMatchObject({
      type: 'EngineError',
      message: 'turn never started',
      fatal: false,
      category: 'turnRejected',
    })
    expect(replayedEngineErrorOf(users[2])).toMatchObject({
      type: 'EngineError',
      message: 'process exited',
      fatal: true,
    })
    expect(items.filter((item) => item.kind === 'notice').map((item) => item.text)).toEqual([
      'engine notice: provider refused the request',
      'engine notice: turn never started',
      'engine notice: process exited',
    ])
  })

  it('backfills typed failure metadata over a legacy plain replay notice', () => {
    const error = {
      type: 'EngineError' as const,
      sessionId: 's1',
      message: 'turn never started',
      fatal: false,
      category: 'turnRejected' as const,
      replaySeq: 2,
    }
    const merged = mergeReplayIntoTranscript(
      [
        { id: 1, kind: 'user', text: 'retry me', replaySeq: 1 },
        { id: 2, kind: 'notice', text: 'engine notice: turn never started', replaySeq: 2 },
        { id: 3, kind: 'user', text: 'newer turn', replaySeq: 3 },
      ],
      [error],
    ) as Array<Record<string, unknown>>

    expect(merged).toHaveLength(3)
    expect(replayedEngineErrorOf(merged[0])).toEqual(error)
    expect(replayedEngineErrorOf(merged[1])).toBeUndefined()
    expect(replayedEngineErrorOf(merged[2])).toBeUndefined()
  })

  it('keeps a terminal failure recoverable even when replay has no user row', () => {
    const [notice] = transcriptFromReplay([
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'process exited during startup',
        fatal: true,
        replaySeq: 1,
      },
    ])

    expect(replayedEngineErrorOf(notice)).toMatchObject({
      type: 'EngineError',
      message: 'process exited during startup',
      fatal: true,
    })
  })

  it('retains exact image retry bytes and marks a legacy missing photo honestly', () => {
    const retained = transcriptFromReplay([
      {
        type: 'RemoteUserTurn',
        sessionId: 's1',
        text: '',
        hadImages: true,
        images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
        replaySeq: 1,
      },
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'upload rejected',
        fatal: false,
        category: 'turnRejected',
        replaySeq: 2,
      },
    ])
    expect(turnFailureOf(retained[0])?.target).toMatchObject({
      replaySeq: 1,
      text: '',
      hadImages: true,
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
    })

    const lost = latestReplayTurnFailure([
      { type: 'RemoteUserTurn', sessionId: 's1', text: '(image)', replaySeq: 3 },
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'process exited',
        fatal: true,
        replaySeq: 4,
      },
    ])
    expect(lost?.target).toEqual({
      replaySeq: 3,
      text: '',
      hadImages: true,
      hadAttachments: true,
    })
  })

  it('updates one logical retry row to the newest cursor, provenance, and failure target', () => {
    const replay = [
      {
        type: 'RemoteUserTurn' as const,
        sessionId: 's1',
        text: 'inspect',
        clientTurnId: 'logical-a',
        hadAttachments: true,
        attachments: [{ mediaType: 'text/csv', name: 'first.csv' }],
        replaySeq: 1,
      },
      {
        type: 'EngineError' as const,
        sessionId: 's1',
        message: 'first failed',
        fatal: false,
        category: 'turnRejected' as const,
        replaySeq: 2,
      },
      {
        type: 'RemoteUserTurn' as const,
        sessionId: 's1',
        text: 'inspect',
        clientTurnId: 'logical-a',
        hadAttachments: true,
        attachments: [{ mediaType: 'application/pdf', name: 'latest.pdf' }],
        images: [{ mediaType: 'application/pdf', name: 'latest.pdf', dataBase64: 'AAAA' }],
        replaySeq: 3,
      },
      {
        type: 'EngineError' as const,
        sessionId: 's1',
        message: 'second failed',
        fatal: false,
        category: 'turnRejected' as const,
        replaySeq: 4,
      },
    ]

    const transcript = transcriptFromReplay(replay) as Array<Record<string, unknown>>
    expect(transcript.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(transcript[0]).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 3,
      files: ['latest.pdf'],
      attachments: [{ mediaType: 'application/pdf', name: 'latest.pdf' }],
      images: [{ mediaType: 'application/pdf', name: 'latest.pdf', dataBase64: 'AAAA' }],
    })
    expect(latestReplayTurnFailure(replay)?.target).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 3,
      images: [{ mediaType: 'application/pdf', name: 'latest.pdf', dataBase64: 'AAAA' }],
    })
  })

  it('forgets a failed attempt when the same logical turn succeeds on retry', () => {
    const replay = [
      {
        type: 'RemoteUserTurn' as const,
        sessionId: 's1',
        text: 'inspect',
        clientTurnId: 'logical-a',
        replaySeq: 1,
      },
      {
        type: 'EngineError' as const,
        sessionId: 's1',
        message: 'first attempt failed',
        fatal: false,
        category: 'turnRejected' as const,
        replaySeq: 2,
      },
      {
        type: 'RemoteUserTurn' as const,
        sessionId: 's1',
        text: 'inspect',
        clientTurnId: 'logical-a',
        replaySeq: 3,
      },
      {
        type: 'TurnComplete' as const,
        sessionId: 's1',
        stopReason: 'success',
        replaySeq: 4,
      },
    ]

    const transcript = transcriptFromReplay(replay) as Array<Record<string, unknown>>
    expect(transcript.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(transcript[0]).toMatchObject({ clientTurnId: 'logical-a', replaySeq: 3 })
    expect(turnFailureOf(transcript[0])).toBeUndefined()
    expect(latestTurnFailureOf(transcript)).toBeUndefined()
    expect(latestReplayTurnFailure(replay)).toBeUndefined()
  })

  it('exposes only the latest unsuperseded failure for transport metadata', () => {
    const error = {
      type: 'EngineError' as const,
      sessionId: 's1',
      message: 'turn failed',
      fatal: false,
      category: 'apiError' as const,
      replaySeq: 2,
    }
    const failed = attachTurnFailureToTranscript(
      [{ id: 10, kind: 'user', text: 'A', replaySeq: 1 }],
      error,
    )
    expect(latestTurnFailureOf(failed)?.target).toMatchObject({ userId: 10, replaySeq: 1, text: 'A' })
    expect(latestTurnFailureOf([...failed, { id: 11, kind: 'user', text: 'B', replaySeq: 3 }]))
      .toBeUndefined()
  })

  it('keeps legacy oversized failure identity while dropping exact retry bytes', () => {
    const failure = latestTurnFailureOf([
      {
        id: 10,
        kind: 'user',
        text: '(image)',
        replaySeq: 1,
        turnFailure: {
          error: {
            type: 'EngineError',
            sessionId: 's1',
            message: 'turn failed',
            fatal: false,
            category: 'turnRejected',
            replaySeq: 2,
          },
          target: {
            userId: 10,
            replaySeq: 1,
            text: '',
            hadImages: true,
            images: [{ mediaType: 'image/png', dataBase64: 'X'.repeat(2_000_001) }],
          },
        },
      },
    ])

    expect(failure?.target).toMatchObject({
      userId: 10,
      replaySeq: 1,
      text: '',
      hadImages: true,
      hadAttachments: true,
    })
    expect(failure?.target?.images).toBeUndefined()
  })

  it('drops oversized exact retry bytes when first writing a durable failure', () => {
    const [failed] = attachTurnFailureToTranscript(
      [
        {
          id: 10,
          kind: 'user',
          text: 'inspect',
          replaySeq: 1,
          images: [
            {
              mediaType: 'application/pdf',
              name: 'large.pdf',
              dataBase64: 'X'.repeat(MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS + 1),
            },
          ],
        },
      ],
      {
        type: 'EngineError',
        sessionId: 's1',
        message: 'turn failed',
        fatal: false,
        category: 'turnRejected',
        replaySeq: 2,
      },
    )

    const rawFailure = (failed as Record<string, unknown>).turnFailure as
      | Record<string, unknown>
      | undefined
    const rawTarget = rawFailure?.target as Record<string, unknown> | undefined
    expect(rawTarget).toMatchObject({
      userId: 10,
      replaySeq: 1,
      text: 'inspect',
      hadImages: false,
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'large.pdf' }],
    })
    expect(rawTarget?.images).toBeUndefined()
    expect(turnFailureOf(failed)?.target).toEqual(rawTarget)
  })

  it('gives a replay-built running child a stall clock', () => {
    const [child] = transcriptFromReplay([
      {
        type: 'SubagentStarted',
        sessionId: 's1',
        toolUseId: 'agent-1',
        subagentType: 'scout',
        description: 'Inspect',
        replaySeq: 1,
      },
    ]) as Array<Record<string, unknown>>
    expect(child).toMatchObject({ kind: 'subagent', status: 'running' })
    expect(child.lastActivityAt).toEqual(expect.any(Number))
  })

  it('rebuilds a headless workflow lifecycle without duplicating its run or members', () => {
    const replay = [
      {
        type: 'WorkflowStarted' as const,
        sessionId: 's1',
        runId: 'review',
        name: 'Parallel review',
        replaySeq: 1,
      },
      {
        type: 'WorkflowAgent' as const,
        sessionId: 's1',
        runId: 'review',
        agentId: 'critic',
        status: 'running' as const,
        replaySeq: 2,
      },
      {
        type: 'WorkflowAgent' as const,
        sessionId: 's1',
        runId: 'review',
        agentId: 'critic',
        status: 'done' as const,
        result: 'No blockers',
        replaySeq: 3,
      },
      {
        type: 'WorkflowCompleted' as const,
        sessionId: 's1',
        runId: 'review',
        agentCount: 1,
        replaySeq: 4,
      },
    ]
    const once = transcriptFromReplay(replay) as Array<Record<string, unknown>>
    const twice = mergeReplayIntoTranscript(once, replay) as Array<Record<string, unknown>>

    expect(twice).toHaveLength(1)
    expect(twice[0]).toMatchObject({
      kind: 'workflow',
      runId: 'review',
      name: 'Parallel review',
      status: 'completed',
      replaySeq: 1,
      agents: [{ agentId: 'critic', status: 'done', result: 'No blockers' }],
    })
  })

  it('folds a durable completion over a renderer snapshot that ended while the child ran', () => {
    const merged = mergeDelegationReplayIntoTranscript(
      [
        {
          id: 7,
          kind: 'subagent',
          toolUseId: 'agent-1',
          subagentType: 'scout',
          description: 'Inspect',
          status: 'running',
          children: [],
        },
      ],
      [
        {
          type: 'SubagentCompleted',
          sessionId: 's1',
          toolUseId: 'agent-1',
          outcome: 'completed',
          resultText: 'survived',
        },
      ],
    ) as Array<Record<string, unknown>>
    expect(merged[0]).toMatchObject({ status: 'completed', resultText: 'survived' })
  })

  it('never downgrades renderer-confirmed completion with synthetic unknown replay', () => {
    const merged = mergeDelegationReplayIntoTranscript(
      [
        {
          id: 7,
          kind: 'subagent',
          toolUseId: 'agent-1',
          status: 'completed',
          resultText: 'known result',
          children: [],
        },
      ],
      [
        {
          type: 'SubagentCompleted',
          sessionId: 's1',
          toolUseId: 'agent-1',
          outcome: 'unknown',
        },
      ],
    ) as Array<Record<string, unknown>>
    expect(merged[0]).toMatchObject({ status: 'completed', resultText: 'known result' })
  })

  it('merges the headless tail without duplicating the persisted prefix', () => {
    const merged = mergeReplayIntoTranscript(
      [{ id: 9, kind: 'user', text: 'first' }],
      [
        { type: 'RemoteUserTurn', sessionId: 's1', text: 'first' },
        { type: 'AssistantBlock', sessionId: 's1', markdown: 'after close' },
      ],
    ) as Array<Record<string, unknown>>
    expect(merged.map((item) => item.kind)).toEqual(['user', 'assistant'])
    expect(merged[1]).toMatchObject({ markdown: 'after close' })
  })

  it('keeps identical new text when stable replay identities differ', () => {
    const merged = mergeReplayIntoTranscript(
      [{ id: 1, kind: 'user', text: 'continue', replaySeq: 10 }],
      [
        { type: 'RemoteUserTurn', sessionId: 's1', text: 'continue', replaySeq: 10 },
        { type: 'RemoteUserTurn', sessionId: 's1', text: 'continue', replaySeq: 11 },
      ],
    ) as Array<Record<string, unknown>>
    expect(merged).toHaveLength(2)
    expect(merged.map((item) => item.replaySeq)).toEqual([10, 11])
  })

  it('keeps identical child blocks once each and remains idempotent', () => {
    const replay = [
      {
        type: 'SubagentStarted' as const,
        sessionId: 's1',
        toolUseId: 'agent-1',
        subagentType: 'scout',
        description: 'Inspect',
        replaySeq: 1,
      },
      {
        type: 'AssistantBlock' as const,
        sessionId: 's1',
        markdown: 'same update',
        parentToolUseId: 'agent-1',
        replaySeq: 2,
      },
      {
        type: 'AssistantBlock' as const,
        sessionId: 's1',
        markdown: 'same update',
        parentToolUseId: 'agent-1',
        replaySeq: 3,
      },
    ]
    const once = mergeReplayIntoTranscript([], replay) as Array<Record<string, unknown>>
    const twice = mergeReplayIntoTranscript(once, replay) as Array<Record<string, unknown>>
    expect((twice[0].children as unknown[])).toHaveLength(2)
  })
})
