import { describe, expect, it } from 'vitest'
import {
  appendLiveToolOutput,
  hasRunningSubagent,
  isTopLevelTurnActivity,
  mergeDelegationReplayIntoTranscript,
  mergeReplayIntoTranscript,
  normalizeReplaySequence,
  settleRestoredDelegationReplay,
  settleRestoredTranscriptItems,
  transcriptFromReplay,
} from './delegation'

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
    expect(hasRunningSubagent([item])).toBe(false)
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
