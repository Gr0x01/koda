import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TURN_REJECTED_STOP_REASON, type EngineEvent } from '@shared/ipc'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}))

import {
  codexIds,
  codexPlanSteps,
  codexResumeCursor,
  codexThreadId,
  delegationDescription,
  mcpElicitationResponse,
  parseCodexResumeCursor,
  parseMcpToolElicitation,
  startCodexSession,
} from './codex-driver'
import { flushUnmappedLog, resetUnmappedLogCounts, unmappedLogPath } from './unmapped-log'

class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  readonly responses: Array<{ id: number; result?: unknown; error?: unknown }> = []
  /** Methods the engine should ANSWER with a JSON-RPC error — how a gone thread actually reads. */
  failMethods = new Set<string>()
  /** Methods whose request kills the transport before any response — distinct from an RPC error. */
  closeOnMethods = new Set<string>()
  /** A full MCP read can block behind unrelated resources/templates; the driver must never request it. */
  stallFullMcpInventory = false
  skillNames = ['koda:code-work', 'koda:memory', 'koda:browser-verify']
  mcpServers: Array<Record<string, unknown>> = []
  skillNamesByCall: string[][] = []
  mcpServersByCall: Array<Array<Record<string, unknown>>> = []
  private skillListCalls = 0
  private mcpStatusCalls = 0
  readonly stdin = new Writable({
    write: (chunk, _encoding, done) => {
      const request = JSON.parse(String(chunk)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      if (request.id !== undefined && request.method) {
        this.requests.push({ id: request.id, method: request.method, params: request.params ?? {} })
        if (this.closeOnMethods.has(request.method)) {
          queueMicrotask(() => this.emit('close'))
          done()
          return
        }
        if (
          this.stallFullMcpInventory &&
          request.method === 'mcpServerStatus/list' &&
          request.params?.detail === 'full'
        ) {
          done()
          return
        }
        if (this.failMethods.has(request.method)) {
          const id = request.id
          queueMicrotask(() =>
            this.stdout.write(`${JSON.stringify({ id, error: { code: -32603, message: 'thread not found' } })}\n`),
          )
          done()
          return
        }
        const threadRequest = this.requests.find(
          (candidate) => candidate.method === 'thread/start' || candidate.method === 'thread/resume',
        )
        const result =
          request.method === 'model/list'
            ? { data: [{ id: 'gpt-5.5', isDefault: true }] }
            : request.method === 'thread/start'
              ? { thread: { id: 'parent-thread' }, model: 'gpt-5.5' }
              : request.method === 'thread/resume'
                ? { thread: { id: String(request.params?.threadId ?? 'parent-thread') }, model: 'gpt-5.5' }
              : request.method === 'turn/start'
                ? { turn: { id: 'parent-turn' } }
                : request.method === 'skills/list'
                  ? {
                      data: [{
                        cwd: String(threadRequest?.params.cwd ?? '/tmp/project'),
                        skills: (this.skillNamesByCall[this.skillListCalls++] ?? this.skillNames)
                          .map((name) => ({ name })),
                      }],
                    }
                  : request.method === 'mcpServerStatus/list'
                    ? { data: this.mcpServersByCall[this.mcpStatusCalls++] ?? this.mcpServers }
                : request.method === 'account/rateLimits/read'
                  ? { rateLimits: {} }
                  : {}
        queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`))
      } else if (request.id !== undefined) {
        this.responses.push(request as { id: number; result?: unknown; error?: unknown })
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

  request(id: number, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`)
  }
}

function notifyTokenUsage(
  child: FakeCodexProcess,
  threadId: string,
  totalTokens: number,
  lastWeightedTokens = 1_000,
): void {
  child.notify('thread/tokenUsage/updated', {
    threadId,
    tokenUsage: {
      total: {
        totalTokens,
        inputTokens: totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      last: {
        totalTokens: lastWeightedTokens,
        inputTokens: lastWeightedTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      modelContextWindow: 200_000,
    },
  })
}

beforeEach(() => spawnMock.mockReset())

describe('Codex process configuration', () => {
  it('passes project skill enablement natively and starts with no stop hook', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      skillConfig: [
        { path: '/tmp/Koda skills/documents/SKILL.md', enabled: false },
        { path: '/tmp/project/.claude/skills/documents/SKILL.md', enabled: true },
      ],
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain(
      'skills.config=[{path="/tmp/Koda skills/documents/SKILL.md",enabled=false},{path="/tmp/project/.claude/skills/documents/SKILL.md",enabled=true}]',
    )
    expect(args).not.toContain('features.hooks=true')
    expect(args).toContain('tool_output_token_limit=4000')
    expect(child.requests.some((request) => request.method.startsWith('hooks/'))).toBe(false)

    await session.dispose()
  })

  it('attests workspace skills and MCP tools without starting a hidden model turn', async () => {
    const child = new FakeCodexProcess()
    child.stallFullMcpInventory = true
    child.mcpServers = [
      { name: 'koda_broker', status: 'connected', tools: { capabilities: {}, preview: {} } },
      { name: 'playwright', status: 'connected', tools: { browser_navigate: {} } },
    ]
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'capabilities-codex',
      cwd: '/tmp/capabilities-project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      brokerUrl: 'http://127.0.0.1:1234/mcp/capabilities-codex',
      playwrightServer: { type: 'stdio', command: '/fake/node', args: ['playwright.js'], env: {} },
    })

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'SessionCapabilitiesUpdated')).toBe(true),
    )
    const update = events.find(
      (event): event is Extract<EngineEvent, { type: 'SessionCapabilitiesUpdated' }> =>
        event.type === 'SessionCapabilitiesUpdated',
    )!
    expect(update.snapshot.cwd).toBe('/tmp/capabilities-project')
    expect(update.snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'ready'],
      ['playbooks', 'ready'],
      ['browser-testing', 'ready'],
    ])
    expect(child.requests.filter((request) => request.method === 'skills/list')).toHaveLength(1)
    expect(child.requests.filter((request) => request.method === 'mcpServerStatus/list')).toHaveLength(1)
    expect(child.requests.find((request) => request.method === 'skills/list')?.params).toEqual({
      cwds: ['/tmp/capabilities-project'],
    })
    expect(child.requests.find((request) => request.method === 'mcpServerStatus/list')?.params).toEqual({
      detail: 'toolsAndAuthOnly',
      threadId: 'parent-thread',
    })
    expect(child.requests.some((request) => request.method === 'turn/start')).toBe(false)
    expect(events.find((event) => event.type === 'SessionStarted')).toMatchObject({
      tools: expect.arrayContaining([
        'mcp__koda_broker__capabilities',
        'mcp__playwright__browser_navigate',
      ]),
    })

    await session.dispose()
  })

  it('starts with an explicit degraded snapshot when native inventory calls fail', async () => {
    const child = new FakeCodexProcess()
    child.failMethods.add('skills/list')
    child.failMethods.add('mcpServerStatus/list')
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'capabilities-degraded',
      cwd: '/tmp/capabilities-project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      brokerUrl: 'http://127.0.0.1:1234/mcp/capabilities-degraded',
    })

    await vi.waitFor(
      () => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true),
      { timeout: 4_000 },
    )
    const update = events.find(
      (event): event is Extract<EngineEvent, { type: 'SessionCapabilitiesUpdated' }> =>
        event.type === 'SessionCapabilitiesUpdated',
    )!
    expect(update.snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'degraded'],
      ['playbooks', 'degraded'],
      ['browser-testing', 'disabled'],
    ])

    await session.dispose()
  })

  it('rereads an initially incomplete inventory once after app-server settles', async () => {
    const child = new FakeCodexProcess()
    child.skillNamesByCall = [[], ['koda:code-work']]
    child.mcpServersByCall = [
      [],
      [{ name: 'koda_broker', status: 'connected', tools: { capabilities: {}, preview: {} } }],
    ]
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'capabilities-settle',
      cwd: '/tmp/capabilities-project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      brokerUrl: 'http://127.0.0.1:1234/mcp/capabilities-settle',
    })

    await vi.waitFor(
      () => expect(events.some((event) => event.type === 'SessionCapabilitiesUpdated')).toBe(true),
      { timeout: 4_000 },
    )
    const update = events.find(
      (event): event is Extract<EngineEvent, { type: 'SessionCapabilitiesUpdated' }> =>
        event.type === 'SessionCapabilitiesUpdated',
    )!
    expect(update.snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'ready'],
      ['playbooks', 'ready'],
      ['browser-testing', 'disabled'],
    ])
    expect(child.requests.filter((request) => request.method === 'skills/list')).toHaveLength(2)
    expect(child.requests.filter((request) => request.method === 'mcpServerStatus/list')).toHaveLength(2)

    await session.dispose()
  })

  it('never announces a session when the process dies during capability inventory', async () => {
    const child = new FakeCodexProcess()
    child.closeOnMethods.add('skills/list')
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'capabilities-dead-process',
      cwd: '/tmp/capabilities-project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      brokerUrl: 'http://127.0.0.1:1234/mcp/capabilities-dead-process',
    })

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'EngineError' && event.fatal)).toBe(true),
    )
    expect(events.some((event) => event.type === 'SessionStarted')).toBe(false)
    expect(events.some((event) => event.type === 'SessionCapabilitiesUpdated')).toBe(false)

    await session.dispose()
  })
})

describe('Codex turn lifetime', () => {
  it('leaves long ordinary turns running until Codex completes them', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'long-turn',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    session.sendTurn('finish the ordinary task')
    await vi.waitFor(() => expect(child.requests.some((request) => request.method === 'turn/start')).toBe(true))
    child.notify('turn/started', {
      threadId: 'parent-thread',
      turn: { id: 'parent-turn', status: 'inProgress' },
    })
    for (let step = 1; step <= 64; step += 1) notifyTokenUsage(child, 'parent-thread', step * 20_000, 20_000)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.requests.some((request) => request.method === 'turn/steer')).toBe(false)
    expect(child.requests.some((request) => request.method === 'turn/interrupt')).toBe(false)

    child.notify('turn/completed', {
      threadId: 'parent-thread',
      turn: { id: 'parent-turn', status: 'completed' },
    })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'TurnComplete', stopReason: undefined }),
      ),
    )

    await session.dispose()
  })
})

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

describe('Codex native file approvals', () => {
  it('sends every path in a multi-file change through the shared gate', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const decide = vi.fn().mockResolvedValue({ kind: 'deny' })
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide,
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    child.notify('item/started', {
      threadId: 'parent-thread',
      item: {
        type: 'fileChange',
        id: 'multi-file-patch',
        changes: [
          { path: '.koda/memory/MEMORY.md' },
          { path: 'src/outside.ts' },
        ],
      },
    })
    child.request(901, 'item/fileChange/requestApproval', { itemId: 'multi-file-patch' })

    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith('koda-session', {
        toolUseId: 'multi-file-patch',
        toolName: 'Write',
        input: {
          file_path: '.koda/memory/MEMORY.md',
          file_paths: ['.koda/memory/MEMORY.md', 'src/outside.ts'],
        },
      }),
    )
    await vi.waitFor(() => expect(child.responses).toContainEqual({ id: 901, result: { decision: 'decline' } }))
    await session.dispose()
  })
})

describe('Codex turn-scoped steering', () => {
  /** The turn's leading text element is the steering block; the user's own words follow it. */
  const turnParts = (child: FakeCodexProcess): Array<{ block: string; text: string }> =>
    child.requests
      .filter((request) => request.method === 'turn/start')
      .map((request) => {
        const input = (request.params.input ?? []) as Array<{ type: string; text?: string }>
        const texts = input.filter((part) => part.type === 'text').map((part) => part.text ?? '')
        return { block: texts[0] ?? '', text: texts[1] ?? '' }
      })

  it('ships the posture block with every turn and leaves the user text untouched', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      approvalMode: 'auto',
      effort: 'high',
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    session.sendTurn('add a button')
    await vi.waitFor(() => expect(turnParts(child)).toHaveLength(1))
    const [first] = turnParts(child)
    expect(first.block).toContain('Active mode: Default.')
    expect(first.text).toBe('add a button')
    // The identity footer answers honestly with what the engine actually resolved for this thread.
    expect(first.block).toContain('running in Koda through the Codex harness as gpt-5.5 with high reasoning effort')
    // Durable text is NOT re-sent per turn: it stays in thread/start's developerInstructions.
    const start = child.requests.find((request) => request.method === 'thread/start')
    expect(start?.params.developerInstructions).toBeUndefined()

    await session.dispose()
  })

  it('pairs a pre-start rejection with an honest legacy terminal and keeps the process reusable', async () => {
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

    child.failMethods.add('turn/start')
    expect(session.sendTurn('please try this')).toBe(true)
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'TurnComplete')).toBe(true),
    )
    const terminal = events.filter(
      (event) => event.type === 'EngineError' || event.type === 'TurnComplete',
    )
    expect(terminal).toEqual([
      expect.objectContaining({
        type: 'EngineError',
        sessionId: 'koda-session',
        fatal: false,
        category: 'turnRejected',
      }),
      {
        type: 'TurnComplete',
        sessionId: 'koda-session',
        stopReason: TURN_REJECTED_STOP_REASON,
      },
    ])

    child.failMethods.delete('turn/start')
    expect(session.sendTurn('retry the same work')).toBe(true)
    await vi.waitFor(() =>
      expect(child.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2),
    )

    await session.dispose()
  })

  it('changes mode mid-thread on the next turn — no respawn, old block still in history', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const steered: string[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      approvalMode: 'auto',
      onTurnSteered: (mode) => steered.push(mode),
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    session.sendTurn('start on the importer')
    await vi.waitFor(() => expect(turnParts(child)).toHaveLength(1))

    session.setApprovalMode?.('plan')
    session.sendTurn('now think it through')
    await vi.waitFor(() => expect(turnParts(child)).toHaveLength(2))

    const [before, after] = turnParts(child)
    expect(before.block).toContain('Active mode: Default.')
    expect(after.block).toContain('Active mode: Plan.')
    // Each turn reports the posture its block declared, so the gate can judge that turn by the rules
    // the model was actually given — even if the user flips posture again while it runs.
    expect(steered).toEqual(['auto', 'plan'])
    expect(after.block).toContain('hard tool error')
    // Supersession, textually: the earlier block is still in the thread verbatim (nothing rewrote
    // history), and the new one opens by revoking it and pinning who may change the mode.
    expect(before.block).toContain('Active mode: Default.')
    expect(after.block).toContain('are no longer active')
    expect(after.block).toContain('changes only when new developer instructions')
    // One process, one thread: switching posture cost no respawn and no re-handshake.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(child.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1)
    expect(child.kill).not.toHaveBeenCalled()

    await session.dispose()
  })

  it('refuses to widen its own sandbox while Plan mode is active, without raising a card', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const decide = vi.fn().mockResolvedValue({ kind: 'allow' })
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide,
      approvalMode: 'plan',
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    child.request(950, 'item/permissions/requestApproval', {
      itemId: 'escalate-1',
      permissions: { filesystem: { write: ['/tmp/project'] } },
    })
    await vi.waitFor(() =>
      expect(child.responses).toContainEqual({ id: 950, result: { permissions: {}, scope: 'turn' } }),
    )
    expect(decide).not.toHaveBeenCalled()

    // Back in Default the same request reaches the gate again — the fence is the mode, not a latch.
    session.setApprovalMode?.('auto')
    child.request(951, 'item/permissions/requestApproval', {
      itemId: 'escalate-2',
      permissions: { filesystem: { write: ['/tmp/project'] } },
    })
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))

    await session.dispose()
  })

  it('holds a Plan-steered turn to its own block when the posture flips mid-turn', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const decide = vi.fn().mockResolvedValue({ kind: 'allow' })
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide,
      approvalMode: 'plan',
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    session.sendTurn('plan the migration')
    await vi.waitFor(() => expect(turnParts(child)).toHaveLength(1))
    expect(turnParts(child)[0].block).toContain('Active mode: Plan.')

    // The user flips to Auto while that turn is still running. The model is still working under the
    // Plan block, which promised Koda would refuse to widen the sandbox — so it still refuses.
    session.setApprovalMode?.('auto')
    child.request(960, 'item/permissions/requestApproval', {
      itemId: 'escalate-mid-turn',
      permissions: { filesystem: { write: ['/tmp/project'] } },
    })
    await vi.waitFor(() =>
      expect(child.responses).toContainEqual({ id: 960, result: { permissions: {}, scope: 'turn' } }),
    )
    expect(decide).not.toHaveBeenCalled()

    // Turn boundary. The next turn is steered as Default, and escalation is the gate's call again.
    child.notify('turn/completed', { threadId: 'parent-thread', turn: { id: 'parent-turn', status: 'completed' } })
    session.sendTurn('go build it')
    await vi.waitFor(() => expect(turnParts(child)).toHaveLength(2))
    expect(turnParts(child)[1].block).toContain('Active mode: Default.')

    child.request(961, 'item/permissions/requestApproval', {
      itemId: 'escalate-next-turn',
      permissions: { filesystem: { write: ['/tmp/project'] } },
    })
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1))

    await session.dispose()
  })
})

describe('Codex live plan mapping', () => {
  it('rereads account windows on demand after a login', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-usage-refresh',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })
    try {
      await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
      await vi.waitFor(() =>
        expect(child.requests.filter((request) => request.method === 'account/rateLimits/read')).toHaveLength(1),
      )
      session.refreshAccountUsage?.()
      await vi.waitFor(() =>
        expect(child.requests.filter((request) => request.method === 'account/rateLimits/read')).toHaveLength(2),
      )
    } finally {
      await session.dispose()
    }
  })

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

/**
 * Codex owns its own resume state too: the thread id lives inside the opaque cursor, the driver decides
 * whether that thread is worth reattaching, and a thread the engine has lost comes back as a recoverable
 * resume miss instead of "Codex session failed to start".
 */
describe('Codex resume cursor', () => {
  it('only calls a thread resumable once it has completed a turn', () => {
    expect(codexResumeCursor('t1', 0)).toEqual({
      engine: 'codex',
      resumable: false,
      data: { threadId: 't1', turns: 0 },
    })
    expect(codexResumeCursor('t1', 2).resumable).toBe(true)
  })

  it('refuses a cursor that is not this driver\'s', () => {
    expect(parseCodexResumeCursor(codexResumeCursor('t1', 1))).toEqual({ threadId: 't1', turns: 1 })
    expect(parseCodexResumeCursor({ engine: 'claude', resumable: true, data: { sessionId: 's1', turns: 1 } })).toBeNull()
    expect(codexThreadId(codexResumeCursor('t7', 1))).toBe('t7')
    expect(codexThreadId(undefined)).toBeUndefined()
  })

  it('resumes the thread named by the cursor and publishes the cursor it will hand back', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      resumeCursor: codexResumeCursor('thread-9', 3),
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'ResumeCursorUpdated')).toBe(true))
    const resume = child.requests.find((r) => r.method === 'thread/resume')
    expect(resume?.params.threadId).toBe('thread-9')
    expect(child.requests.some((r) => r.method === 'thread/start')).toBe(false)
    expect(events.find((e) => e.type === 'ResumeCursorUpdated')).toMatchObject({
      cursor: { engine: 'codex', resumable: true, data: { threadId: 'thread-9', turns: 3 } },
    })

    await session.dispose()
  })

  it('starts a fresh thread when the cursor has no completed turn behind it', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      // Codex hands out a thread id during initialization, before the user has said anything.
      resumeCursor: codexResumeCursor('thread-empty', 0),
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))
    expect(child.requests.some((r) => r.method === 'thread/start')).toBe(true)
    expect(child.requests.some((r) => r.method === 'thread/resume')).toBe(false)

    await session.dispose()
  })

  it('reports a thread the engine has lost as a recoverable resume miss', async () => {
    const child = new FakeCodexProcess()
    child.failMethods.add('thread/resume')
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'koda-session',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
      resumeCursor: codexResumeCursor('thread-gone', 5),
    })

    await vi.waitFor(() => expect(events.some((event) => event.type === 'EngineError')).toBe(true))
    const errors = events.filter((e): e is Extract<EngineEvent, { type: 'EngineError' }> => e.type === 'EngineError')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ sessionId: 'koda-session', category: 'resumeMiss', fatal: false })
    expect(events.some((e) => e.type === 'SessionStarted')).toBe(false)

    await session.dispose()
  })
})

/**
 * Same losslessness contract as the Claude driver, on a different wire: the JSON-RPC notification a
 * normalized event came from rides along, and a notification with no mapping is written to the
 * session's dev log instead of falling out of the `default` arm.
 */
describe('Codex driver: lossless events', () => {
  beforeEach(() => resetUnmappedLogCounts())

  it('flattens Codex ids so a child can be joined without reparsing the payload', () => {
    expect(codexIds({ threadId: 'child-a', turn: { id: 'turn-1' }, item: { id: 'item-1' } })).toEqual({
      threadId: 'child-a',
      turnId: 'turn-1',
      itemId: 'item-1',
    })
    expect(codexIds({})).toBeUndefined()
  })

  it('carries the native notification and ids on every translated event', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'codex-raw',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    child.notify('item/completed', {
      threadId: 'parent-thread',
      item: { type: 'agentMessage', id: 'answer-1', text: 'done' },
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'AssistantBlock')).toBe(true))

    expect(events.find((event) => event.type === 'AssistantBlock')?.raw).toMatchObject({
      source: 'codex',
      method: 'item/completed',
      ids: { threadId: 'parent-thread', itemId: 'answer-1' },
    })
    // Koda-minted events are distinguishable: no native message means Koda said it, not the engine.
    expect(events.find((event) => event.type === 'ResumeCursorUpdated')?.raw).toBeUndefined()

    await session.dispose()
  })

  it('logs an unmapped notification instead of dropping it', async () => {
    const child = new FakeCodexProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    // The log is append-only across runs by design, so this case owns its file before the driver writes.
    rmSync(unmappedLogPath('codex-unmapped'), { force: true })
    const session = startCodexSession((event) => events.push(event), {
      sessionId: 'codex-unmapped',
      cwd: '/tmp/project',
      binaryPath: '/fake/codex',
      decide: async () => ({ kind: 'allow' }),
    })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'SessionStarted')).toBe(true))

    child.notify('thread/somethingNew', { threadId: 'parent-thread', detail: 'a shape Koda has no card for' })
    // Deliberate ignores stay out of the log: a reasoning item is already carried by its deltas.
    child.notify('item/completed', { threadId: 'parent-thread', item: { type: 'reasoning', id: 'r-1' } })
    await flushUnmappedLog()
    expect(existsSync(unmappedLogPath('codex-unmapped'))).toBe(true)

    const lines = readFileSync(unmappedLogPath('codex-unmapped'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.method)).toEqual(['thread/somethingNew'])
    expect(lines[0]).toMatchObject({
      source: 'codex',
      ids: { threadId: 'parent-thread' },
      payload: { detail: 'a shape Koda has no card for' },
    })

    await session.dispose()
  })
})
