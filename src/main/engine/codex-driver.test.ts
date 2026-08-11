import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '@shared/ipc'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}))

import {
  codexPlanSteps,
  delegationDescription,
  mcpElicitationResponse,
  parseMcpToolElicitation,
  startCodexSession,
} from './codex-driver'
import {
  KODA_CLEAN_FINISH_HOOK_KEY,
  kodaCleanFinishCommandForSource,
} from './codex-clean-finish'
import { codexHome } from './codex-home'

class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  kodaHook: Record<string, unknown> | null = null
  hookTrusted = false
  readonly stdin = new Writable({
    write: (chunk, _encoding, done) => {
      const request = JSON.parse(String(chunk)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      if (request.id !== undefined && request.method) {
        this.requests.push({ id: request.id, method: request.method, params: request.params ?? {} })
        if (request.method === 'config/batchWrite') this.hookTrusted = true
        const result =
          request.method === 'hooks/list'
            ? {
                data: [
                  {
                    cwd: '/tmp/project',
                    hooks: this.kodaHook
                      ? [
                          {
                            ...this.kodaHook,
                            trustStatus: this.hookTrusted ? 'trusted' : 'untrusted',
                          },
                        ]
                      : [],
                  },
                ],
              }
            : request.method === 'model/list'
            ? { data: [{ id: 'gpt-5.5', isDefault: true }] }
            : request.method === 'thread/start'
              ? { thread: { id: 'parent-thread' }, model: 'gpt-5.5' }
              : request.method === 'turn/start'
                ? { turn: { id: 'parent-turn' } }
                : request.method === 'account/rateLimits/read'
                  ? { rateLimits: {} }
                  : {}
        queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`))
      }
      done()
    },
  })

  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close'))
    return true
  })

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`)
  }
}

beforeEach(() => spawnMock.mockReset())

describe('Codex MCP elicitation', () => {
  it('recovers Koda Preview approval as the existing gate tool name + input', () => {
    expect(
      parseMcpToolElicitation({
        mode: 'form',
        serverName: 'koda_broker',
        message: 'Allow the koda_broker MCP server to run tool "preview"?',
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          tool_params: { command: 'npm run dev', cwd: 'site' },
        },
      }),
    ).toEqual({
      toolName: 'mcp__koda_broker__preview',
      input: { command: 'npm run dev', cwd: 'site' },
    })
  })

  it('does not treat general MCP forms or URLs as tool approvals', () => {
    expect(
      parseMcpToolElicitation({
        mode: 'form',
        serverName: 'other',
        message: 'Share an email address',
        _meta: {},
      }),
    ).toBeNull()
    expect(
      parseMcpToolElicitation({
        mode: 'url',
        serverName: 'other',
        message: 'Sign in',
        url: 'https://example.com',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
    ).toBeNull()
  })

  it('returns Codex\'s complete response shape for either gate decision', () => {
    expect(mcpElicitationResponse(true)).toEqual({ action: 'accept', content: null, _meta: null })
    expect(mcpElicitationResponse(false)).toEqual({ action: 'decline', content: null, _meta: null })
  })
})

describe('Codex live plan mapping', () => {
  it('normalizes app-server plan rows for Koda\'s existing task list', () => {
    expect(
      codexPlanSteps([
        { step: 'Inspect the adapter', status: 'completed' },
        { step: 'Wire live output', status: 'inProgress' },
      ]),
    ).toEqual([
      { id: '1', subject: 'Inspect the adapter', status: 'completed' },
      { id: '2', subject: 'Wire live output', status: 'in_progress' },
    ])
  })
})

describe('Codex delegation labels', () => {
  it('uses the first meaningful assignment line and bounds long card titles', () => {
    expect(delegationDescription('\n  Inspect the renderer state.\nReturn evidence.')).toBe(
      'Inspect the renderer state.',
    )
    expect(delegationDescription('')).toBe('Delegated task')
    expect(delegationDescription('x'.repeat(200))).toBe(`${'x'.repeat(117)}…`)
  })

  it('fans out, isolates child transcripts, stops one child, and routes a reused child', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
    await vi.waitFor(() =>
      expect(child.requests.some((request) => request.method === 'account/rateLimits/read')).toBe(true),
    )
    const initialRateReads = child.requests.filter(
      (request) => request.method === 'account/rateLimits/read',
    ).length

    session.sendTurn('fan out')
    await vi.waitFor(() => expect(child.requests.some((request) => request.method === 'turn/start')).toBe(true))
    child.notify('turn/started', {
      threadId: 'parent-thread',
      turn: { id: 'parent-turn', status: 'inProgress' },
    })
    child.notify('item/started', {
      threadId: 'unknown-child',
      item: { type: 'commandExecution', id: 'unknown-command', command: 'do not leak' },
    })
    // Codex can publish a child's turn and tools before the parent's spawn item. They are held until
    // the relationship arrives, then replayed beneath that delegated-work card in original order.
    child.notify('turn/started', {
      threadId: 'child-a',
      turn: { id: 'child-a-turn-1', status: 'inProgress' },
    })
    child.notify('item/started', {
      threadId: 'child-a',
      item: { type: 'commandExecution', id: 'child-a-command', command: 'rg name package.json' },
    })
    child.notify('item/completed', {
      threadId: 'child-a',
      item: {
        type: 'commandExecution',
        id: 'child-a-command',
        command: 'rg name package.json',
        aggregatedOutput: '"name": "koda"',
        status: 'completed',
        exitCode: 0,
      },
    })
    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-a',
        kind: 'started',
        agentThreadId: 'child-a',
        agentPath: '/root/package-inspector',
      },
    })
    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-b',
        kind: 'started',
        agentThreadId: 'child-b',
        agentPath: '/root/script-inspector',
      },
    })

    // The early turn id remains stoppable after replay and the sibling continues unaffected.
    expect(session.stopTask?.('child-a')).toBe(true)
    expect(session.stopTask?.('not-a-child')).toBe(false)
    child.notify('turn/started', {
      threadId: 'child-b',
      turn: { id: 'child-b-turn-1', status: 'inProgress' },
    })
    // Streaming/plan/compaction notifications from a child must not mutate the parent's live UI or
    // context meter. The same parent notifications still flow normally after the child events.
    child.notify('item/commandExecution/outputDelta', {
      threadId: 'child-b',
      itemId: 'child-b-command',
      delta: 'child output',
    })
    child.notify('turn/plan/updated', {
      threadId: 'child-b',
      plan: [{ step: 'Child-only step', status: 'inProgress' }],
    })
    child.notify('thread/compacted', { threadId: 'child-b' })
    child.notify('item/completed', {
      threadId: 'child-b',
      item: { type: 'contextCompaction', id: 'child-compaction' },
    })
    expect(events.some((event) => event.type === 'ContextCompacted')).toBe(false)
    child.notify('item/commandExecution/outputDelta', {
      threadId: 'parent-thread',
      itemId: 'parent-command',
      delta: 'parent output',
    })
    child.notify('turn/plan/updated', {
      threadId: 'parent-thread',
      plan: [{ step: 'Parent step', status: 'inProgress' }],
    })
    child.notify('thread/compacted', { threadId: 'parent-thread' })
    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: {
        type: 'subAgentActivity',
        id: 'steer-a',
        kind: 'interacted',
        agentThreadId: 'child-a',
        agentPath: '/root/package-inspector',
      },
    })
    await vi.waitFor(() =>
      expect(child.requests).toContainEqual({
        id: expect.any(Number),
        method: 'turn/interrupt',
        params: { threadId: 'child-a', turnId: 'child-a-turn-1' },
      }),
    )

    child.notify('item/agentMessage/delta', { threadId: 'child-a', delta: 'do not leak' })
    child.notify('item/completed', {
      threadId: 'child-a',
      item: { type: 'agentMessage', id: 'child-a-answer', text: 'The package is koda.', phase: 'final_answer' },
    })
    child.notify('turn/completed', {
      threadId: 'child-a',
      turn: { id: 'child-a-turn-1', status: 'interrupted' },
    })
    await vi.waitFor(() =>
      expect(
        child.requests.filter((request) => request.method === 'account/rateLimits/read').length,
      ).toBeGreaterThan(initialRateReads),
    )

    child.notify('item/started', {
      threadId: 'child-b',
      item: { type: 'commandExecution', id: 'child-b-command', command: 'rg scripts package.json' },
    })
    child.notify('item/completed', {
      threadId: 'child-b',
      item: {
        type: 'commandExecution',
        id: 'child-b-command',
        command: 'rg scripts package.json',
        aggregatedOutput: '"scripts": {}',
        status: 'completed',
        exitCode: 0,
      },
    })
    child.notify('item/completed', {
      threadId: 'child-b',
      item: { type: 'agentMessage', id: 'child-b-answer', text: 'Scripts found.', phase: 'final_answer' },
    })
    child.notify('turn/completed', {
      threadId: 'child-b',
      turn: { id: 'child-b-turn-1', status: 'completed' },
    })

    // A follow-up on an idle child creates a fresh card and remains individually stoppable.
    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: {
        type: 'subAgentActivity',
        id: 'followup-a',
        kind: 'interacted',
        agentThreadId: 'child-a',
        agentPath: '/root/package-inspector',
      },
    })
    expect(session.stopTask?.('child-a')).toBe(true)
    child.notify('turn/started', {
      threadId: 'child-a',
      turn: { id: 'child-a-turn-2', status: 'inProgress' },
    })
    await vi.waitFor(() =>
      expect(child.requests).toContainEqual({
        id: expect.any(Number),
        method: 'turn/interrupt',
        params: { threadId: 'child-a', turnId: 'child-a-turn-2' },
      }),
    )
    child.notify('item/completed', {
      threadId: 'child-a',
      item: { type: 'agentMessage', id: 'child-a-answer-2', text: 'Version checked.', phase: 'final_answer' },
    })
    child.notify('turn/completed', {
      threadId: 'child-a',
      turn: { id: 'child-a-turn-2', status: 'interrupted' },
    })
    child.notify('item/agentMessage/delta', { threadId: 'parent-thread', delta: 'Parent answer' })
    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: { type: 'agentMessage', id: 'parent-answer', text: 'Parent answer', phase: 'final_answer' },
    })
    child.notify('turn/completed', {
      threadId: 'parent-thread',
      turn: { id: 'parent-turn', status: 'completed' },
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'TurnComplete')).toBe(true))
    expect(events.filter((event) => event.type === 'TurnComplete')).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SubagentStarted',
        toolUseId: 'spawn-a',
        taskId: 'child-a',
        description: 'package-inspector',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SubagentStarted',
        toolUseId: 'spawn-b',
        taskId: 'child-b',
        description: 'script-inspector',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SubagentStarted',
        toolUseId: 'followup-a',
        taskId: 'child-a',
        description: 'Follow-up · package-inspector',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ToolRequested',
        id: 'child-a-command',
        parentToolUseId: 'spawn-a',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ToolRequested',
        id: 'child-b-command',
        parentToolUseId: 'spawn-b',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SubagentCompleted',
        toolUseId: 'spawn-a',
        outcome: 'interrupted',
        resultText: 'The package is koda.',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SubagentCompleted',
        toolUseId: 'spawn-b',
        outcome: 'completed',
        resultText: 'Scripts found.',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'SubagentCompleted',
        toolUseId: 'followup-a',
        outcome: 'interrupted',
        resultText: 'Version checked.',
      }),
    )

    const interruptTargets = child.requests
      .filter((request) => request.method === 'turn/interrupt')
      .map((request) => request.params)
    expect(interruptTargets).toEqual([
      { threadId: 'child-a', turnId: 'child-a-turn-1' },
      { threadId: 'child-a', turnId: 'child-a-turn-2' },
    ])

    const assistantBlocks = events.filter(
      (event): event is Extract<EngineEvent, { type: 'AssistantBlock' }> => event.type === 'AssistantBlock',
    )
    expect(assistantBlocks.filter((event) => !event.parentToolUseId)).toEqual([
      expect.objectContaining({ markdown: 'Parent answer' }),
    ])
    expect(assistantBlocks.filter((event) => event.parentToolUseId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ markdown: 'The package is koda.', parentToolUseId: 'spawn-a' }),
        expect.objectContaining({ markdown: 'Scripts found.', parentToolUseId: 'spawn-b' }),
        expect.objectContaining({ markdown: 'Version checked.', parentToolUseId: 'followup-a' }),
      ]),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: 'AssistantDelta', text: 'Parent answer' }))
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'AssistantDelta', text: 'do not leak' }))
    expect(events).not.toContainEqual(expect.objectContaining({ id: 'unknown-command' }))
    expect(events.filter((event) => event.type === 'ToolProgress')).toEqual([
      expect.objectContaining({ id: 'parent-command', output: 'parent output' }),
    ])
    expect(events.filter((event) => event.type === 'PlanUpdate')).toEqual([
      expect.objectContaining({ steps: [{ id: '1', subject: 'Parent step', status: 'in_progress' }] }),
    ])
    expect(events.filter((event) => event.type === 'ContextCompacted')).toHaveLength(1)
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'SubagentStarted', toolUseId: 'steer-a' }),
    )

    await session.dispose()
  })

  it('gives every child in a legacy multi-agent spawn a distinct lifecycle identity', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: {
        type: 'collabAgentToolCall',
        id: 'legacy-spawn',
        tool: 'spawnAgent',
        prompt: 'Inspect both halves.',
        receiverThreadIds: ['legacy-child-a', 'legacy-child-b'],
      },
    })

    const started = events.filter(
      (event): event is Extract<EngineEvent, { type: 'SubagentStarted' }> =>
        event.type === 'SubagentStarted',
    )
    expect(started.map((event) => [event.taskId, event.toolUseId])).toEqual([
      ['legacy-child-a', 'legacy-spawn:legacy-child-a'],
      ['legacy-child-b', 'legacy-spawn:legacy-child-b'],
    ])
    expect(new Set(started.map((event) => event.toolUseId)).size).toBe(2)

    await session.dispose()
  })
})

describe('Codex clean-finish hook', () => {
  it('trusts only Koda\'s exact Stop hook before starting the thread', async () => {
    const child = new FakeCodexProcess()
    const sourcePath = join(codexHome(), 'plugins/cache/koda-market/koda/0.1.9/hooks/hooks.json')
    const hookKey = KODA_CLEAN_FINISH_HOOK_KEY
    child.kodaHook = {
      key: hookKey,
      eventName: 'stop',
      handlerType: 'command',
      executionMode: 'sync',
      pluginId: 'koda@koda-market',
      command: kodaCleanFinishCommandForSource(sourcePath),
      timeoutSec: 10,
      statusMessage: 'Checking that this topic is saved',
      sourcePath,
      currentHash: 'sha256:koda-clean-finish',
    }
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
    const writes = child.requests.filter((request) => request.method === 'config/batchWrite')
    expect(writes).toHaveLength(1)
    expect(writes[0].params).toEqual({
      edits: [
        {
          keyPath: 'hooks.state',
          value: {
            [hookKey]: {
              enabled: true,
              trusted_hash: 'sha256:koda-clean-finish',
            },
          },
          mergeStrategy: 'upsert',
        },
      ],
      reloadUserConfig: true,
    })
    expect(child.requests.filter((request) => request.method === 'hooks/list')).toHaveLength(2)
    expect(child.requests.findIndex((request) => request.method === 'config/batchWrite')).toBeLessThan(
      child.requests.findIndex((request) => request.method === 'thread/start'),
    )
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['-c', 'features.hooks=true']),
    )

    await session.dispose()
  })

  it('does not trust hooks from the project or another plugin', async () => {
    const child = new FakeCodexProcess()
    child.kodaHook = {
      key: '/tmp/project/.codex/hooks.json:stop:0:0',
      eventName: 'stop',
      pluginId: null,
      currentHash: 'sha256:project-hook',
    }
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
    expect(child.requests.some((request) => request.method === 'config/batchWrite')).toBe(false)

    await session.dispose()
  })

  it('does not trust a near-match added under Koda\'s plugin identity', async () => {
    const child = new FakeCodexProcess()
    const sourcePath = join(codexHome(), 'plugins/cache/koda-market/koda/0.1.9/hooks/hooks.json')
    child.kodaHook = {
      key: KODA_CLEAN_FINISH_HOOK_KEY,
      eventName: 'stop',
      handlerType: 'command',
      executionMode: 'sync',
      pluginId: 'koda@koda-market',
      command: '/tmp/replaced-clean-finish',
      timeoutSec: 10,
      statusMessage: 'Checking that this topic is saved',
      sourcePath,
      currentHash: 'sha256:replaced-hook',
    }
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
    expect(child.requests.some((request) => request.method === 'config/batchWrite')).toBe(false)

    await session.dispose()
  })
})
