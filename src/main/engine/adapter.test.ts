import { EventEmitter } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '@shared/ipc'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}))

import {
  claudeIds,
  claudeMethod,
  claudeResumeCursor,
  isBackgroundSubagentLaunchResult,
  parseClaudeResumeCursor,
  startClaudeSession,
  taskNotificationToCompletion,
} from './adapter'
import { flushUnmappedLog, resetUnmappedLogCounts, unmappedLogPath } from './unmapped-log'

/** The long-lived `claude -p` child, reduced to the three pipes the driver actually drives. */
class FakeClaudeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** Every line the driver wrote — the control channel a stop/interrupt is proved on. */
  readonly writes: Array<Record<string, any>> = []
  readonly stdin = new Writable({
    write: (chunk, _e, done) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        try {
          this.writes.push(JSON.parse(line))
        } catch {
          /* the driver only writes JSON lines */
        }
      }
      done()
    },
  })
  readonly kill = vi.fn(() => true)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => spawnMock.mockReset())

describe('background subagent notifications', () => {
  it('does not mistake Claude\'s async launch receipt for the child result', () => {
    expect(
      isBackgroundSubagentLaunchResult(
        'Async agent launched successfully.\nThe agent is working in the background. You will be notified automatically when it completes.',
      ),
    ).toBe(true)
    expect(isBackgroundSubagentLaunchResult('The child inspected the adapter and found no issue.')).toBe(false)
  })

  it('recognizes a resume receipt by resumedAgentId across CLI phrasings', () => {
    // 2.1.236 dropped the "in the background" phrasing; the field is the stable signal.
    expect(
      isBackgroundSubagentLaunchResult(
        JSON.stringify({
          success: true,
          message: 'Resuming agent a293f15',
          resumedAgentId: 'a293f15998f7b6c95',
          pin: { id: 'a293f15998f7b6c95', name: 'a293f15998f7b6c95', ref: '1080f6' },
        }),
      ),
    ).toBe(true)
    expect(
      isBackgroundSubagentLaunchResult(
        JSON.stringify({
          success: true,
          message: 'Agent had no active task; resumed from transcript in the background.',
          resumedAgentId: 'agent-a',
        }),
      ),
    ).toBe(true)
    expect(isBackgroundSubagentLaunchResult(JSON.stringify({ success: true, message: 'Message delivered' }))).toBe(false)
  })

  it('turns a completed task notification into the child result Koda persists', () => {
    expect(
      taskNotificationToCompletion('s1', 'tool-1', {
        status: 'completed',
        task_id: 'task-1',
        summary: '**Outcome** — found it',
        usage: { total_tokens: 123, tool_uses: 2, duration_ms: 456 },
      }),
    ).toEqual({
      type: 'SubagentCompleted',
      sessionId: 's1',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      resultText: '**Outcome** — found it',
      outcome: 'completed',
      isError: false,
      usage: { totalTokens: 123, toolUses: 2, durationMs: 456 },
    })
  })

  it('keeps a targeted stop distinct from a failed child', () => {
    const event = taskNotificationToCompletion('s1', 'tool-1', {
      status: 'stopped',
      task_id: 'task-1',
      summary: 'Stopped by the user',
    })
    expect(event.outcome).toBe('interrupted')
    expect(event.isError).toBe(false)
  })
})

describe('Claude driver: delegated task ownership', () => {
  it('keeps a child command inside its owning agent card', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((event) => events.push(event), {
      sessionId: 'nested-command',
      cwd: '/tmp/koda-delegation-test',
    })

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'agent-parent',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'child-command',
              name: 'Bash',
              input: { command: 'npm run typecheck', description: 'Full typecheck' },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        parent_tool_use_id: 'agent-parent',
        tool_use_id: 'child-command',
        task_id: 'background-command',
        description: 'Full typecheck',
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        parent_tool_use_id: 'agent-parent',
        tool_use_id: 'child-command',
        task_id: 'background-command',
        status: 'completed',
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'user',
        parent_tool_use_id: 'agent-parent',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'child-command', content: 'typecheck passed' },
          ],
        },
      })}\n`,
    )
    await tick()

    expect(events.filter((event) => event.type.startsWith('Subagent'))).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ToolRequested',
        id: 'child-command',
        parentToolUseId: 'agent-parent',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ToolResult',
        id: 'child-command',
        parentToolUseId: 'agent-parent',
      }),
    )
  })

  it('keeps a resumed agent live until its task notification and closes the SendMessage tool', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((event) => events.push(event), {
      sessionId: 'resumed-agent',
      cwd: '/tmp/koda-delegation-test',
    })

    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'send-followup',
        task_id: 'agent-a',
        subagent_type: 'koda:worker',
        description: 'Phase A',
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'send-followup',
              name: 'SendMessage',
              input: { recipient: 'agent-a', summary: 'Finish Phase A', message: 'Please finish.' },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'send-followup',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Agent had no active task; resumed from transcript in the background. You will be notified when it finishes.',
                    resumedAgentId: 'agent-a',
                  }),
                },
              ],
            },
          ],
        },
      })}\n`,
    )
    await tick()

    expect(events).toContainEqual(expect.objectContaining({ type: 'ToolResult', id: 'send-followup' }))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'SubagentProgress', toolUseId: 'send-followup' }),
    )
    expect(events.some((event) => event.type === 'SubagentCompleted')).toBe(false)

    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'send-followup',
        task_id: 'agent-a',
        status: 'completed',
        summary: 'Phase A finished',
      })}\n`,
    )
    await tick()

    expect(events.at(-1)).toMatchObject({
      type: 'SubagentCompleted',
      toolUseId: 'send-followup',
      taskId: 'agent-a',
      outcome: 'completed',
    })
  })

  // The dogfood-observed 2026-08-30 sequence that left "Agent still working…" forever: task_started
  // outran the receipt, the receipt said only "Resuming agent <id>", and the stop notification then
  // hit the foreground branch, which waits for a tool_result a SendMessage card never gets.
  it('closes a stopped resumed agent whose receipt used the 2.1.236 phrasing', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((event) => events.push(event), {
      sessionId: 'resumed-agent-stopped',
      cwd: '/tmp/koda-delegation-test',
    })

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'send-correction',
              name: 'SendMessage',
              input: { to: 'a293f15', summary: 'Redo insurance analysis', message: 'Major correction.' },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'send-correction',
        task_id: 'a293f15',
        task_type: 'local_agent',
        subagent_type: 'general-purpose',
        description: 'Research pregnancy travel insurance',
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'send-correction',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Resuming agent a293f15',
                    resumedAgentId: 'a293f15',
                    pin: { id: 'a293f15', name: 'a293f15', ref: '1080f6' },
                  }),
                },
              ],
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'send-correction',
        task_id: 'a293f15',
        status: 'stopped',
      })}\n`,
    )
    await tick()

    expect(events.at(-1)).toMatchObject({
      type: 'SubagentCompleted',
      toolUseId: 'send-correction',
      taskId: 'a293f15',
      outcome: 'interrupted',
    })
  })
})

/**
 * Resume state is the driver's, not the shared layer's: this driver decides from its OWN cursor
 * whether to spawn `--resume` or clean, and it reports a resume miss (the engine no longer holds the
 * conversation) as a recoverable signal rather than the fatal that used to end the chat.
 */
describe('Claude resume cursor', () => {
  it('only calls a conversation resumable once it has completed a turn', () => {
    expect(claudeResumeCursor('s1', 0)).toEqual({
      engine: 'claude',
      resumable: false,
      data: { sessionId: 's1', turns: 0 },
    })
    expect(claudeResumeCursor('s1', 3).resumable).toBe(true)
  })

  it('refuses a cursor that is not this driver\'s, or not this conversation\'s', () => {
    expect(parseClaudeResumeCursor(claudeResumeCursor('s1', 2), 's1')).toEqual({ sessionId: 's1', turns: 2 })
    expect(parseClaudeResumeCursor({ engine: 'codex', resumable: true, data: { threadId: 't1' } }, 's1')).toBeNull()
    expect(parseClaudeResumeCursor(claudeResumeCursor('other', 2), 's1')).toBeNull()
    expect(parseClaudeResumeCursor({ engine: 'claude', resumable: true, data: { junk: 1 } }, 's1')).toBeNull()
    expect(parseClaudeResumeCursor(undefined, 's1')).toBeNull()
  })
})

describe('Claude driver: spawn shape and resume miss', () => {
  it('reattaches on a resumable cursor and publishes the cursor it will hand back', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((e) => events.push(e), {
      sessionId: 'sess-1',
      cwd: '/tmp/koda-resume-test',
      resumeCursor: claudeResumeCursor('sess-1', 1),
    })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--resume')
    expect(args).not.toContain('--session-id')

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', tools: [], cwd: '/tmp/koda-resume-test' })}\n`)
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
    await tick()

    const cursors = events.filter((e) => e.type === 'ResumeCursorUpdated')
    expect(cursors.at(0)).toMatchObject({ cursor: { engine: 'claude', resumable: true, data: { turns: 1 } } })
    // The completed turn moves the cursor on, so the next reattach carries an honest count.
    expect(cursors.at(-1)).toMatchObject({ cursor: { data: { sessionId: 'sess-1', turns: 2 } } })
  })

  it('spawns clean when the cursor has no completed turn to reattach to', () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    startClaudeSession(() => {}, { sessionId: 'sess-2', resumeCursor: claudeResumeCursor('sess-2', 0) })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--session-id')
    expect(args).not.toContain('--resume')
  })

  it('turns the engine\'s "no conversation" exit into a recoverable resume miss', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((e) => events.push(e), { sessionId: 'gone', resumeCursor: claudeResumeCursor('gone', 4) })
    child.stderr.write('No conversation found with session ID: gone\n')
    await tick()
    child.emit('close', 1)
    await tick()

    const errors = events.filter((e): e is Extract<EngineEvent, { type: 'EngineError' }> => e.type === 'EngineError')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ sessionId: 'gone', category: 'resumeMiss', fatal: false })
  })

  it('still reports an ordinary crash as fatal', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((e) => events.push(e), { sessionId: 'boom', resumeCursor: claudeResumeCursor('boom', 4) })
    child.stderr.write('something else went wrong\n')
    await tick()
    child.emit('close', 1)
    await tick()

    const errors = events.filter((e): e is Extract<EngineEvent, { type: 'EngineError' }> => e.type === 'EngineError')
    expect(errors).toHaveLength(1)
    expect(errors[0].fatal).toBe(true)
    expect(errors[0].category).toBeUndefined()
  })
})

describe('Claude capability attestation', () => {
  it('waits through Koda MCP pending state despite an unrelated failed server, then publishes once', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startClaudeSession((event) => events.push(event), {
      sessionId: 'capabilities-claude',
      cwd: '/tmp/capabilities-project',
      mcpConfigJson: '{}',
      browserWired: true,
    })
    const base = {
      type: 'system',
      subtype: 'init',
      model: 'sonnet',
      cwd: '/tmp/capabilities-project',
      skills: ['koda:code-work', 'koda:memory', 'koda:browser-verify'],
      agents: ['koda:code-reviewer'],
      plugins: [{ name: 'koda' }],
    }
    child.stdout.write(`${JSON.stringify({
      ...base,
      tools: ['Read'],
      mcp_servers: [
        { name: 'koda_broker', status: 'pending' },
        { name: 'inherited_database', status: 'failed' },
      ],
    })}\n`)
    await tick()
    expect(events.filter((event) => event.type === 'SessionCapabilitiesUpdated')).toHaveLength(0)

    const ready = {
      ...base,
      tools: [
        'Read',
        'mcp__koda_broker__capabilities',
        'mcp__koda_broker__preview',
        'mcp__playwright__browser_navigate',
      ],
      mcp_servers: [
        { name: 'koda_broker', status: 'connected' },
        { name: 'playwright', status: 'connected' },
        { name: 'inherited_database', status: 'failed' },
      ],
    }
    child.stdout.write(`${JSON.stringify(ready)}\n${JSON.stringify(ready)}\n`)
    await tick()

    const updates = events.filter(
      (event): event is Extract<EngineEvent, { type: 'SessionCapabilitiesUpdated' }> =>
        event.type === 'SessionCapabilitiesUpdated',
    )
    expect(updates).toHaveLength(1)
    expect(updates[0].snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'ready'],
      ['playbooks', 'ready'],
      ['browser-testing', 'ready'],
    ])
    expect(updates[0].snapshot.source).toBe('engine-init')

    await session.dispose()
  })

  it('does not attest a loaded playbook that Koda denied for this spawn', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    const session = startClaudeSession((event) => events.push(event), {
      sessionId: 'capabilities-disabled-skill',
      cwd: '/tmp/capabilities-project',
      playbooksExpected: false,
      extraDisallowedTools: ['Skill(memory)'],
    })
    child.stdout.write(`${JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'sonnet',
      cwd: '/tmp/capabilities-project',
      tools: ['Read'],
      skills: ['koda:memory'],
    })}\n`)
    await tick()

    const update = events.find(
      (event): event is Extract<EngineEvent, { type: 'SessionCapabilitiesUpdated' }> =>
        event.type === 'SessionCapabilitiesUpdated',
    )
    expect(update?.snapshot.skills).toEqual([])
    expect(update?.snapshot.capabilities.find((entry) => entry.id === 'playbooks')?.status).toBe('disabled')

    await session.dispose()
  })
})

/**
 * The typed vocabulary stays small, so nothing native may be lost: every translated event carries the
 * engine's own message, and a message this driver has no mapping for lands in the session's dev log
 * rather than in a `default: break`.
 */
describe('Claude driver: lossless events', () => {
  beforeEach(() => resetUnmappedLogCounts())

  it('names an engine message the way the engine does', () => {
    expect(claudeMethod({ type: 'system', subtype: 'task_progress' })).toBe('system/task_progress')
    // A result's subtype is the stop reason, not a message kind — qualifying it would mint a method per outcome.
    expect(claudeMethod({ type: 'result', subtype: 'success' })).toBe('result')
    expect(claudeIds({ type: 'system', subtype: 'task_progress', tool_use_id: 'tool-1', task_id: 'task-1' })).toEqual({
      toolUseId: 'tool-1',
      taskId: 'task-1',
    })
  })

  it('carries the native message and ids on every translated event', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((e) => events.push(e), { sessionId: 'raw-1', cwd: '/tmp/koda-raw-test' })
    const native = {
      type: 'assistant',
      uuid: 'msg-uuid',
      message: { id: 'msg_01', content: [{ type: 'text', text: 'hello' }] },
    }
    child.stdout.write(`${JSON.stringify(native)}\n`)
    await tick()

    const block = events.find((e) => e.type === 'AssistantBlock')
    expect(block?.raw).toEqual({
      source: 'claude',
      method: 'assistant',
      ids: { uuid: 'msg-uuid', messageId: 'msg_01' },
      payload: native,
    })
  })

  it('leaves the envelope off an event Koda minted itself', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    startClaudeSession((e) => events.push(e), { sessionId: 'raw-2', cwd: '/tmp/koda-raw-test' })
    child.emit('error', new Error('spawn failed'))
    await tick()

    // No native message means Koda said it — the reader can tell the two apart.
    expect(events.find((e) => e.type === 'EngineError')?.raw).toBeUndefined()
  })

  it('logs an unmapped engine message instead of dropping it', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const events: EngineEvent[] = []
    // The log is append-only across runs by design, so this case owns its file before the driver writes.
    rmSync(unmappedLogPath('unmapped-claude'), { force: true })
    startClaudeSession((e) => events.push(e), { sessionId: 'unmapped-claude', cwd: '/tmp/koda-raw-test' })
    child.stdout.write(`${JSON.stringify({ type: 'engine_bump_novelty', task_id: 'task-9', detail: 'something new' })}\n`)
    // A deliberate ignore (our own control ack) must NOT show up as news.
    child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success' } })}\n`)
    await tick()
    // The log write is queued off the parse path, so settle it before reading.
    await flushUnmappedLog()

    const lines = readFileSync(unmappedLogPath('unmapped-claude'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.method)).toEqual(['engine_bump_novelty'])
    expect(lines[0]).toMatchObject({
      sessionId: 'unmapped-claude',
      source: 'claude',
      ids: { taskId: 'task-9' },
      payload: { detail: 'something new' },
    })
    // Nothing was invented upward — an unmapped message is evidence, not a transcript row.
    expect(events.some((e) => e.type === 'AssistantBlock')).toBe(false)
  })
})

/**
 * Interrupt discipline — the driver half. The session manager orders children before the parent; this
 * pins that the two verbs are genuinely separate on Claude's control channel.
 */
describe('Claude driver: child stop and parent interrupt are separate verbs', () => {
  it('stops named tasks, then interrupts the parent turn', async () => {
    const child = new FakeClaudeProcess()
    spawnMock.mockReturnValue(child)
    const session = startClaudeSession(() => {}, { sessionId: 'stop-1', cwd: '/tmp/koda-raw-test' })
    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', tools: [], cwd: '/tmp/koda-raw-test' })}\n`,
    )
    await tick()

    expect(session.stopTask?.('task-a')).toBe(true)
    expect(session.stopTask?.('task-b')).toBe(true)
    session.interrupt()
    await tick()

    expect(child.writes.map((w) => [w.request?.subtype, w.request?.task_id])).toEqual([
      ['stop_task', 'task-a'],
      ['stop_task', 'task-b'],
      ['interrupt', undefined],
    ])
  })
})
