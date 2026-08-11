import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedSessionMeta } from '@shared/ipc'
// Imported before `window` exists on purpose: the module's boot-time git refresh is behind a
// `typeof window !== 'undefined'` guard, so the store loads clean in the node lane and the fake bridge
// below is installed per test.
import { useWorkspace, type SessionState } from './store'
import { sessionForHydration } from './useEngineBridge'

// The three moves between the hot session store and the cold archive index (archive / reopen / delete)
// are a read-modify-write of ONE list across an awaited disk write. Two of them can be asked for at the
// same moment — the phone forwards an archive while ⌘W archives another session, or the user clicks
// Restore and Delete in quick succession — and before `queueArchiveMove` both read the same base list,
// so the second write landed over the first in the file AND in memory. One chat then left the sidebar
// having never reached the index, its transcript orphaned in `.bodies/`.
//
// These tests drive the real store actions against a fake `window.koda` whose index write takes a turn
// of the event loop to answer, which is the whole gap the bug lived in.

/** Every index write the fake bridge accepted, in order. The last one is what's "on disk". */
let saved: ArchivedSessionMeta[][]
let bodies: Record<string, unknown[] | null>
let deletedBodies: string[]

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function installBridge(overrides: Record<string, unknown> = {}): void {
  saved = []
  bodies = {}
  deletedBodies = []
  const koda = {
    saveArchived: async (list: ArchivedSessionMeta[]) => {
      // The answer arrives a tick later, exactly like a real IPC round trip. Snapshot the array: the
      // caller owns it and the point of the test is which list reached the file.
      await delay()
      saved.push([...list])
      return true
    },
    writeArchivedBody: async (id: string, items: unknown[]) => {
      await delay()
      bodies[id] = items
    },
    loadArchivedBody: async (id: string) => {
      await delay()
      return bodies[id] ?? null
    },
    deleteArchivedBody: async (id: string) => {
      deletedBodies.push(id)
      delete bodies[id]
    },
    disposeSession: async () => {},
    stopSubagent: async () => {},
    ...overrides,
  }
  ;(globalThis as unknown as { window: unknown }).window = { koda }
}

function session(id: string): SessionState {
  return {
    id,
    label: id,
    userNamed: false,
    cwd: '/tmp/project',
    items: [],
    streaming: '',
    busy: false,
    errored: false,
    draft: '',
    attachments: [],
    live: false,
    attention: false,
    approvalMode: 'ask',
    engineId: 'claude',
    spendUsd: 0,
    byModel: {},
  }
}

function archivedMeta(id: string): ArchivedSessionMeta {
  return {
    id,
    label: id,
    cwd: '/tmp/project',
    approvalMode: 'ask',
    engineId: 'claude',
    archivedAt: Date.now(),
    preview: [],
    maxItemId: 0,
  }
}

const ids = (list: ArchivedSessionMeta[]): string[] => list.map((m) => m.id).sort()

beforeEach(() => {
  installBridge()
  useWorkspace.setState({
    sessions: {},
    order: [],
    activeId: null,
    editors: {},
    pending: [],
    archived: [],
    archiveLoadFailed: false,
    archiveWriteFailed: false,
    archiveRestoreFailed: false,
    rateLimits: {},
  })
})

describe('archive moves under interleaving', () => {
  it('two archives asked for at once both reach the index and the store', async () => {
    useWorkspace.setState({
      sessions: { a: session('a'), b: session('b') },
      order: ['a', 'b'],
      activeId: 'a',
    })
    const { archiveSession } = useWorkspace.getState()

    // Both in flight before either write is answered — the phone forwarding an archive of `a` while the
    // user hits ⌘W on `b`.
    await Promise.all([archiveSession('a'), archiveSession('b')])

    expect(ids(saved[saved.length - 1])).toEqual(['a', 'b']) // the file holds both
    expect(ids(useWorkspace.getState().archived)).toEqual(['a', 'b']) // and so does memory
    expect(useWorkspace.getState().order).toEqual([])
    // Neither transcript was left orphaned: every body written belongs to a row in the index.
    expect(Object.keys(bodies).sort()).toEqual(['a', 'b'])
  })

  it('preserves replay identity through archive, restore, and the next headless turn', async () => {
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          events: [
            { type: 'RemoteUserTurn', sessionId: 'a', text: 'before archive', replaySeq: 12 },
            { type: 'RemoteUserTurn', sessionId: 'a', text: 'after restore', replaySeq: 13 },
          ],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })
    const a = session('a')
    a.replaySeq = 12
    a.items = [{ id: 1, kind: 'user', text: 'before archive', replaySeq: 12 }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    await useWorkspace.getState().archiveSession('a')
    expect(useWorkspace.getState().archived[0].replaySeq).toBe(12)
    await useWorkspace.getState().restoreArchived('a')
    expect(useWorkspace.getState().sessions.a.replaySeq).toBe(12)

    await useWorkspace.getState().adoptHeadless()
    const restored = useWorkspace.getState().sessions.a
    expect(restored.replaySeq).toBe(13)
    expect(restored.items.map((item) => item.kind === 'user' && item.text)).toEqual([
      'before archive',
      'after restore',
    ])
  })

  it('advances the restored cursor when archive-body loading already folded in a replay tail', async () => {
    const meta = archivedMeta('a')
    meta.replaySeq = 12
    bodies.a = [
      { id: 1, kind: 'user', text: 'archived', replaySeq: 12 },
      { id: 2, kind: 'assistant', markdown: 'late durable reply', replaySeq: 13 },
    ]
    useWorkspace.setState({ archived: [meta] })

    await useWorkspace.getState().restoreArchived('a')

    expect(useWorkspace.getState().sessions.a.replaySeq).toBe(13)
    useWorkspace.getState().applyRemoteUserTurn('a', 'next phone turn', 14, true)
    const restored = useWorkspace.getState().sessions.a
    expect(restored.replaySeq).toBe(14)
    expect(restored.items).toContainEqual(
      expect.objectContaining({ kind: 'user', text: 'next phone turn', replaySeq: 14 }),
    )
  })

  it('a delete and an archive at once keep the delete and record the archive', async () => {
    useWorkspace.setState({
      sessions: { b: session('b') },
      order: ['b'],
      activeId: 'b',
      archived: [archivedMeta('old')],
    })
    const { archiveSession, deleteArchived } = useWorkspace.getState()

    // Archive first: it has a body write to get through before it reads the list, which is exactly the
    // window in which the delete's write lands and gets read back over. Reversed, the delete happens to
    // finish first and the bug hides.
    await Promise.all([archiveSession('b'), deleteArchived('old')])

    expect(ids(saved[saved.length - 1])).toEqual(['b'])
    expect(ids(useWorkspace.getState().archived)).toEqual(['b'])
    expect(deletedBodies).toEqual(['old'])
  })

  it('a reopen and an archive at once keep both halves', async () => {
    bodies['old'] = []
    useWorkspace.setState({
      sessions: { b: session('b') },
      order: ['b'],
      activeId: 'b',
      archived: [archivedMeta('old')],
    })
    const { archiveSession, restoreArchived } = useWorkspace.getState()

    await Promise.all([restoreArchived('old'), archiveSession('b')])

    // `old` came back to the hot store, `b` left it — the index must show exactly that swap.
    expect(ids(saved[saved.length - 1])).toEqual(['b'])
    expect(ids(useWorkspace.getState().archived)).toEqual(['b'])
    expect(useWorkspace.getState().order).toEqual(['old'])
  })

  it('a refused index write leaves the session in the sidebar and raises the banner', async () => {
    installBridge({ saveArchived: async () => false })
    useWorkspace.setState({ sessions: { a: session('a') }, order: ['a'], activeId: 'a' })

    await useWorkspace.getState().archiveSession('a')

    expect(useWorkspace.getState().order).toEqual(['a'])
    expect(useWorkspace.getState().archived).toEqual([])
    expect(useWorkspace.getState().archiveWriteFailed).toBe(true)
  })
})

describe('approval catch-up', () => {
  it('deduplicates a request received through both the live push and reload catch-up read', () => {
    const req = { sessionId: 'a', requestId: 'tool-1', toolName: 'Bash', input: { command: 'npm test' } }
    useWorkspace.getState().addPending(req)
    useWorkspace.getState().addPending(req)
    expect(useWorkspace.getState().pending).toEqual([req])
  })
})

describe('account usage ownership', () => {
  const info = (rateLimitType: string, usedPercent: number) => ({
    rateLimitType,
    usedPercent,
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
    status: 'allowed',
  })

  it('replaces an engine map with main\'s reconciled snapshot', () => {
    useWorkspace.setState({
      rateLimits: { claude: { stale: info('stale', 90) } },
    })

    useWorkspace.getState().applyEngineEvent({
      type: 'RateLimitUpdate',
      sessionId: 'account-usage',
      engine: 'claude',
      info: info('five_hour', 42),
      reconciledWindows: { five_hour: info('five_hour', 42) },
    })

    expect(useWorkspace.getState().rateLimits.claude).toEqual({ five_hour: info('five_hour', 42) })
  })

  it('hydrates main\'s global bootstrap but does not persist it back into the project', () => {
    useWorkspace.getState().hydrate({
      version: 2,
      activeId: null,
      sessions: [],
      rateLimits: { claude: { stale: info('stale', 90) } },
    })

    expect(useWorkspace.getState().rateLimits).toEqual({ claude: { stale: info('stale', 90) } })
    expect(useWorkspace.getState().persistBlob()).not.toHaveProperty('rateLimits')
  })
})

describe('background subagent lifecycle', () => {
  const runningChild = {
    id: 1,
    kind: 'subagent' as const,
    toolUseId: 'tool-1',
    taskId: 'task-1',
    subagentType: 'koda:scout',
    description: 'Inspect the adapter',
    status: 'running' as const,
    lastActivityAt: Date.now(),
    children: [],
  }

  it('carries the replay cursor across main load into boot hydration', () => {
    const loaded = sessionForHydration({
      id: 'a',
      label: 'a',
      cwd: '/tmp/project',
      replaySeq: 41,
      items: [{ id: 1, kind: 'user', text: 'persisted' }],
    })
    useWorkspace.getState().hydrate({ version: 2, activeId: 'a', sessions: [loaded] })
    expect(useWorkspace.getState().sessions.a.replaySeq).toBe(41)
  })

  it('restores an in-flight child as unknown instead of pretending it is still running', () => {
    useWorkspace.getState().hydrate({
      version: 2,
      activeId: 'a',
      sessions: [
        {
          id: 'a',
          label: 'a',
          cwd: '/tmp/project',
          replaySeq: 1,
          items: [{ ...runningChild, replaySeq: 1 }],
        },
      ],
    })
    const child = useWorkspace.getState().sessions.a.items[0]
    expect(child.kind).toBe('subagent')
    expect(child.kind === 'subagent' && child.status).toBe('unknown')
  })

  it('reattaches a same-window renderer reload to the exact child main still owns', async () => {
    useWorkspace.getState().hydrate({
      version: 2,
      activeId: 'a',
      sessions: [{ id: 'a', label: 'a', cwd: '/tmp/project', items: [runningChild] }],
    })
    expect(useWorkspace.getState().sessions.a.items[0]).toMatchObject({ status: 'unknown' })

    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'claude',
          model: 'opus',
          effort: 'high',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: ['tool-1'],
          events: [
            {
              type: 'SubagentStarted',
              sessionId: 'a',
              toolUseId: 'tool-1',
              taskId: 'task-1',
              subagentType: 'koda:scout',
              description: 'Inspect the adapter',
              replaySeq: 1,
            },
            {
              type: 'AssistantBlock',
              sessionId: 'a',
              markdown: 'live child report',
              parentToolUseId: 'tool-1',
              replaySeq: 2,
            },
          ],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const state = useWorkspace.getState()
    expect(state.order).toEqual(['a'])
    expect(state.sessions.a).toMatchObject({
      live: true,
      busy: false,
      model: 'opus',
      effort: 'high',
      replaySeq: 2,
    })
    expect(state.sessions.a.fromRemote).toBeUndefined()
    expect(state.sessions.a.items[0]).toMatchObject({
      kind: 'subagent',
      toolUseId: 'tool-1',
      status: 'running',
      children: [expect.objectContaining({ kind: 'assistant', markdown: 'live child report' })],
    })
  })

  it('uses the replay cursor to keep a legitimate repeated follow-up', async () => {
    const a = session('a')
    a.replaySeq = 4
    a.items = [
      { id: 1, kind: 'user', text: 'continue' },
      { id: 2, kind: 'user', text: 'continue', replaySeq: 4 },
    ]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          events: [
            { type: 'RemoteUserTurn', sessionId: 'a', text: 'continue', replaySeq: 4 },
            { type: 'RemoteUserTurn', sessionId: 'a', text: 'continue', replaySeq: 5 },
          ],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const restored = useWorkspace.getState().sessions.a
    expect(restored.items.filter((item) => item.kind === 'user')).toHaveLength(3)
    expect(restored.items.at(-1)).toMatchObject({ kind: 'user', text: 'continue', replaySeq: 5 })
    expect(restored.replaySeq).toBe(5)
  })

  it('stamps a local optimistic turn instead of appending it again', () => {
    const a = session('a')
    a.items = [{ id: 1, kind: 'user', text: 'continue' }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().applyRemoteUserTurn('a', 'continue', 7, false)

    expect(useWorkspace.getState().sessions.a.items).toEqual([
      { id: 1, kind: 'user', text: 'continue', replaySeq: 7 },
    ])
    expect(useWorkspace.getState().sessions.a.replaySeq).toBe(7)
  })

  it('keeps one child running until its targeted stop is confirmed', () => {
    const stopSubagent = vi.fn(async () => {})
    installBridge({ stopSubagent })
    const a = session('a')
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    useWorkspace.getState().stopSubagent('a', 'task-1')

    expect(stopSubagent).toHaveBeenCalledWith({ sessionId: 'a', taskId: 'task-1' })
    let child = useWorkspace.getState().sessions.a.items[0]
    expect(child.kind === 'subagent' && child.status).toBe('running')
    expect(child.kind === 'subagent' && child.stopRequested).toBe(true)
    expect(useWorkspace.getState().sessions.a.busy).toBe(false)

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentCompleted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      outcome: 'interrupted',
    })
    child = useWorkspace.getState().sessions.a.items[0]
    expect(child.kind === 'subagent' && child.status).toBe('interrupted')
    expect(child.kind === 'subagent' && child.stopRequested).toBeUndefined()
  })

  it('clears a pending stop when main refuses the request', async () => {
    installBridge({ stopSubagent: vi.fn(async () => Promise.reject(new Error('already finished'))) })
    const a = session('a')
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().stopSubagent('a', 'task-1')
    await delay()

    const child = useWorkspace.getState().sessions.a.items[0]
    expect(child.kind === 'subagent' && child.status).toBe('running')
    expect(child.kind === 'subagent' && child.stopRequested).toBeUndefined()
  })

  it('does not let child prose or tools re-lock a completed parent turn', () => {
    const a = session('a')
    a.busy = true
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyEngineEvent({ type: 'TurnComplete', sessionId: 'a', stopReason: 'success' })

    useWorkspace.getState().applyEngineEvent({
      type: 'AssistantBlock',
      sessionId: 'a',
      markdown: 'child report',
      parentToolUseId: 'tool-1',
    })
    useWorkspace.getState().applyEngineEvent({
      type: 'ToolRequested',
      sessionId: 'a',
      id: 'read-1',
      name: 'Read',
      input: {},
      parentToolUseId: 'tool-1',
    })

    expect(useWorkspace.getState().sessions.a.busy).toBe(false)
  })

  it('blocks respawning controls while a delegated child is still running', () => {
    const setApprovalMode = vi.fn(async () => {})
    const setModelEffort = vi.fn(async () => {})
    installBridge({ setApprovalMode, setModelEffort })
    const a = session('a')
    a.live = true
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().setSessionApprovalMode('a', 'plan')
    useWorkspace.getState().setSessionModel('a', 'opus')
    useWorkspace.getState().setSessionEffort('a', 'high')

    expect(useWorkspace.getState().sessions.a).toMatchObject({ approvalMode: 'ask', live: true })
    expect(useWorkspace.getState().sessions.a.model).toBeUndefined()
    expect(useWorkspace.getState().sessions.a.effort).toBeUndefined()
    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(setModelEffort).not.toHaveBeenCalled()
  })

  it('defers an API credential respawn until the delegated child finishes', async () => {
    installBridge({
      activateApiFallback: vi.fn(async () => ({ mode: 'auto', apiActive: true })),
    })
    const a = session('a')
    a.live = true
    a.items = [runningChild]
    useWorkspace.setState({
      sessions: { a },
      order: ['a'],
      activeId: 'a',
      billingFallbackPrompt: { resetsAt: 1234 },
    })

    await useWorkspace.getState().confirmApiFallback()
    expect(useWorkspace.getState().sessions.a.live).toBe(true)

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentCompleted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      outcome: 'completed',
    })
    expect(useWorkspace.getState().sessions.a.live).toBe(false)
  })

  it('persists a background summary after the parent turn has already ended', () => {
    const a = session('a')
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentCompleted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      outcome: 'completed',
      resultText: '**Outcome** — adapter inspected',
    })

    const child = useWorkspace.getState().sessions.a.items[0]
    expect(child.kind === 'subagent' && child.status).toBe('completed')
    expect(child.kind === 'subagent' && child.resultText).toContain('adapter inspected')
    expect(useWorkspace.getState().persistBlob().sessions[0].items).toEqual(
      useWorkspace.getState().sessions.a.items,
    )
  })

  it('renders an unobservable child as unknown rather than completed', () => {
    const a = session('a')
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentCompleted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      outcome: 'unknown',
    })

    const child = useWorkspace.getState().sessions.a.items[0]
    expect(child.kind === 'subagent' && child.status).toBe('unknown')
  })
})

describe('a reopen whose transcript cannot be read', () => {
  it('keeps the archived chat and says so, instead of failing silently', async () => {
    useWorkspace.setState({ archived: [archivedMeta('old')] }) // no body planted → the read returns null

    await useWorkspace.getState().restoreArchived('old')

    expect(useWorkspace.getState().archiveRestoreFailed).toBe(true)
    expect(ids(useWorkspace.getState().archived)).toEqual(['old']) // still listed
    expect(useWorkspace.getState().order).toEqual([]) // nothing half-opened
    expect(deletedBodies).toEqual([]) // and the file it couldn't read was not deleted
  })

  it('takes the notice back down on the next reopen that works', async () => {
    useWorkspace.setState({ archived: [archivedMeta('broken'), archivedMeta('good')] })
    bodies['good'] = []

    await useWorkspace.getState().restoreArchived('broken')
    expect(useWorkspace.getState().archiveRestoreFailed).toBe(true)

    await useWorkspace.getState().restoreArchived('good')
    expect(useWorkspace.getState().archiveRestoreFailed).toBe(false)
  })
})
