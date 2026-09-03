import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TURN_REJECTED_STOP_REASON, type ArchivedSessionMeta, type DocShelf } from '@shared/ipc'
import { turnFailureOf } from '@shared/delegation'
// Imported before `window` exists on purpose: the module's boot-time git refresh is behind a
// `typeof window !== 'undefined'` guard, so the store loads clean in the node lane and the fake bridge
// below is installed per test.
import {
  computeSessionChanges,
  setNotifyEnabled,
  setNotifyOk,
  stageVisible,
  statusOf,
  useWorkspace,
  type SessionState,
} from './store'
import { busyActivity } from './activity'
import { registerFileWriter } from './file-writer-registry'

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
      return true
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
    // Naming is fire-and-forget on the turn path; the tests here care about activity, not the name.
    nameSession: async () => ({ title: '', overview: '' }),
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

describe('computeSessionChanges — completion evidence wins over transcript guesses', () => {
  it('uses exact completed-turn paths, keeps live legacy fallback, and does not resurrect cleared work', () => {
    const cleared = session('cleared')
    cleared.items = [
      { id: 1, kind: 'tool', toolUseId: 't1', name: 'Edit', input: { file_path: '/tmp/project/a.ts' } },
    ]
    const exact = session('exact')
    const live = session('live')
    live.busy = true
    live.items = [
      { id: 2, kind: 'tool', toolUseId: 't2', name: 'Write', input: { file_path: '/tmp/project/c.ts' } },
    ]
    const sessions = { cleared, exact, live }
    const result = computeSessionChanges(
      sessions,
      ['exact', 'cleared', 'live'],
      [
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'modified' },
        { path: 'c.ts', status: 'added' },
      ],
      {
        cleared: { sessionId: 'cleared', state: 'none', paths: [], mixedPaths: [] },
        exact: { sessionId: 'exact', state: 'loose-ends', paths: ['b.ts'], mixedPaths: [] },
      },
    )

    expect(result.countBySession).toEqual({ exact: 1, live: 1 })
    expect(result.groups.map((group) => [group.sessionId, group.files.map((file) => file.path)])).toEqual([
      ['exact', ['b.ts']],
      ['live', ['c.ts']],
      [null, ['a.ts']],
    ])
  })

  it('never lets restored history reclaim dirt, but attributes edits from the current busy turn', () => {
    const idle = session('idle')
    idle.items = [
      { id: 1, kind: 'tool', toolUseId: 'old', name: 'Edit', input: { file_path: '/tmp/project/old.ts' } },
    ]
    const busy = session('busy')
    busy.busy = true
    busy.items = [
      { id: 2, kind: 'tool', toolUseId: 'prior', name: 'Edit', input: { file_path: '/tmp/project/prior.ts' } },
      { id: 3, kind: 'user', text: 'start the next turn' },
      { id: 4, kind: 'tool', toolUseId: 'new', name: 'Edit', input: { file_path: '/tmp/project/new.ts' } },
    ]
    const result = computeSessionChanges(
      { idle, busy },
      ['busy', 'idle'],
      [
        { path: 'old.ts', status: 'modified' },
        { path: 'prior.ts', status: 'modified' },
        { path: 'new.ts', status: 'modified' },
      ],
    )
    expect(result.groups.map((group) => [group.sessionId, group.files.map((file) => file.path)])).toEqual([
      ['busy', ['new.ts']],
      [null, ['old.ts', 'prior.ts']],
    ])
  })

  it('matches collapsed untracked directories while keeping the exact owned-file count', () => {
    const exact = session('exact')
    const result = computeSessionChanges(
      { exact },
      ['exact'],
      [{ path: 'notes/', status: 'untracked' }],
      {
        exact: {
          sessionId: 'exact',
          state: 'loose-ends',
          paths: ['notes/a.md', 'notes/b.md'],
          mixedPaths: [],
        },
      },
    )
    expect(result.groups[0]).toMatchObject({ sessionId: 'exact', files: [{ path: 'notes/' }] })
    expect(result.countBySession).toEqual({ exact: 2 })
  })

  it('does not render a stale exact claim when that path is absent from current Git status', () => {
    const exact = session('exact')
    const result = computeSessionChanges(
      { exact },
      ['exact'],
      [{ path: 'manual.ts', status: 'modified' }],
      {
        exact: { sessionId: 'exact', state: 'loose-ends', paths: ['clean-now.ts'], mixedPaths: [] },
      },
    )
    expect(result.groups).toEqual([
      { sessionId: null, label: 'Loose changes', files: [{ path: 'manual.ts', status: 'modified' }] },
    ])
    expect(result.countBySession).toEqual({})
  })
})

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
    protectedArchived: [],
    starredDocs: [],
    legacyKeptDocsImported: [],
    legacyKeptDocPathChanges: [],
    docRefRepairs: {},
    legacyKeptDocsMigrationComplete: false,
    archiveLoadFailed: false,
    archiveWriteFailed: false,
    archiveRestoreFailed: false,
    rateLimits: {},
    completionBySession: {},
  })
})

describe('new-session model and reasoning posture', () => {
  it('hydrates a fresh desktop session from main’s canonical provider, model, and reasoning posture', async () => {
    const startSession = vi.fn(async () => ({
      sessionId: 'fresh',
      cwd: '/tmp/project',
      engineId: 'codex' as const,
      model: 'gpt-current',
      effort: 'max',
    }))
    const setApprovalMode = vi.fn(async () => {})
    installBridge({ startSession, setApprovalMode })
    useWorkspace.setState({ defaultApprovalMode: 'auto' })

    await useWorkspace.getState().startSession()

    expect(startSession).toHaveBeenCalledWith({})
    expect(useWorkspace.getState().sessions.fresh).toMatchObject({
      engineId: 'codex',
      model: 'gpt-current',
      effort: 'max',
    })
  })

  it('passes an explicit one-start posture through for a conversation handoff', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'fresh', cwd: '/tmp/project' }))
    installBridge({ startSession, setApprovalMode: async () => {} })

    await useWorkspace
      .getState()
      .startSession({ engineId: 'claude', model: 'opus', effort: 'high' })

    expect(startSession).toHaveBeenCalledWith({
      engineId: 'claude',
      model: 'opus',
      effort: 'high',
    })
    expect(useWorkspace.getState().sessions.fresh).toMatchObject({
      engineId: 'claude',
      model: 'opus',
      effort: 'high',
    })
  })

  it('adopts a phone-originated provider, model, and effort in the open desktop session', () => {
    const current = session('current')
    current.model = 'sonnet'
    current.effort = 'low'
    useWorkspace.setState({ sessions: { current }, order: ['current'], activeId: 'current' })

    useWorkspace.getState().applyEngineEvent({
      type: 'ModelEffortChanged',
      sessionId: 'current',
      engineId: 'codex',
      model: 'gpt-current',
      effort: 'high',
    })

    expect(useWorkspace.getState().sessions.current).toMatchObject({
      engineId: 'codex',
      model: 'gpt-current',
      effort: 'high',
    })
  })
})

describe('deleteEntry writer boundary', () => {
  it('waits for the live writer before asking main to delete', async () => {
    const order: string[] = []
    const gate: { release: (() => void) | null } = { release: null }
    const deletePath = vi.fn(async () => void order.push('delete'))
    installBridge({ deletePath })
    const path = '/tmp/project/Documents/note.md'
    const unregister = registerFileWriter(path, path, async () => {
      order.push('flush:start')
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
      order.push('flush:end')
    })

    try {
      const deleting = useWorkspace.getState().deleteEntry(path, { document: true })
      await vi.waitFor(() => expect(order).toEqual(['flush:start']))
      expect(deletePath).not.toHaveBeenCalled()

      gate.release?.()
      await expect(deleting).resolves.toEqual({ ok: true })
      expect(order).toEqual(['flush:start', 'flush:end', 'delete'])
      expect(deletePath).toHaveBeenCalledWith({ path, document: true })
    } finally {
      unregister()
    }
  })

  it('returns its own error and never calls main when the latest editor write fails', async () => {
    const deletePath = vi.fn(async () => {})
    installBridge({ deletePath })
    const path = '/tmp/project/Documents/note.md'
    const unregister = registerFileWriter(path, path, async () => {
      throw new Error('disk full')
    })

    try {
      const result = await useWorkspace.getState().deleteEntry(path, { document: true })
      expect(result).toEqual({
        ok: false,
        error: "Couldn't save the latest edits, so nothing was deleted.",
      })
      expect(useWorkspace.getState().treeError).toBe(result.ok ? null : result.error)
      expect(deletePath).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('returns the filesystem error when main refuses the delete', async () => {
    installBridge({
      deletePath: async () => {
        throw new Error("Couldn't make an undo point, so nothing was deleted.")
      },
    })

    const result = await useWorkspace
      .getState()
      .deleteEntry('/tmp/project/Documents/note.md', { document: true })
    expect(result).toEqual({
      ok: false,
      error: "Couldn't make an undo point, so nothing was deleted.",
    })
  })

  it('flushes and closes a lexical surface when deleting its canonical file identity', async () => {
    const deletePath = vi.fn(async () => {})
    installBridge({ deletePath })
    const canonicalPath = '/tmp/project/Documents/note.md'
    const surfacePath = '/tmp/project/linked-docs/NOTE.md'
    const otherPath = '/tmp/project/src/app.ts'
    useWorkspace.setState({
      editors: {
        a: {
          surfaces: [
            { path: surfacePath, title: 'NOTE.md', view: 'doc', rev: 0 },
            { path: otherPath, title: 'app.ts', view: 'file', rev: 0 },
          ],
          activeSurfaceId: surfacePath,
          pinned: false,
        },
      },
    })
    const flush = vi.fn(async () => {})
    const unregister = registerFileWriter(canonicalPath, surfacePath, flush)

    try {
      await expect(
        useWorkspace.getState().deleteEntry(canonicalPath, { document: true }),
      ).resolves.toEqual({ ok: true })
      expect(flush).toHaveBeenCalledOnce()
      expect(deletePath).toHaveBeenCalledWith({ path: canonicalPath, document: true })
      expect(useWorkspace.getState().editors.a).toMatchObject({
        surfaces: [{ path: otherPath }],
        activeSurfaceId: otherPath,
      })
    } finally {
      unregister()
    }
  })
})

describe('pre-start rejection compatibility terminal', () => {
  it('keeps the error as the only attention signal when the legacy unlock arrives', () => {
    const notifications: string[] = []
    const originalNotification = globalThis.Notification
    class FakeNotification {
      onclick: (() => void) | null = null
      constructor(_title: string, options?: { body?: string }) {
        if (options?.body) notifications.push(options.body)
      }
    }
    ;(globalThis as unknown as { Notification: typeof FakeNotification }).Notification = FakeNotification
    setNotifyOk(true)
    setNotifyEnabled(true)
    try {
      const a = { ...session('a'), busy: true }
      useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

      useWorkspace.getState().applyEngineEvent({
        type: 'EngineError',
        sessionId: 'a',
        message: 'turn failed before it started',
        fatal: false,
        category: 'turnRejected',
      })
      useWorkspace.getState().applyEngineEvent({
        type: 'TurnComplete',
        sessionId: 'a',
        stopReason: TURN_REJECTED_STOP_REASON,
      })

      expect(notifications).toEqual(['a hit an error'])
      expect(useWorkspace.getState().sessions.a).toMatchObject({
        busy: false,
        error: { message: 'turn failed before it started', fatal: false },
      })
    } finally {
      setNotifyOk(false)
      if (originalNotification) globalThis.Notification = originalNotification
      else Reflect.deleteProperty(globalThis, 'Notification')
    }
  })

  it('persists and restores the exact failed image turn before replaySeq moves past it', async () => {
    const sendTurn = vi.fn(async () => {})
    installBridge({ sendTurn })
    const a = { ...session('a'), busy: true }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect this',
      10,
      true,
      true,
      [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
    )

    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'turn rejected',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 11,
      raw: { source: 'codex', method: 'turn/start', payload: { internal: 'not durable' } },
    })

    const liveUser = useWorkspace.getState().sessions.a.items[0]
    expect(turnFailureOf(liveUser)).toMatchObject({
      error: { message: 'turn rejected', category: 'turnRejected', replaySeq: 11 },
      target: {
        userId: liveUser.id,
        replaySeq: 10,
        text: 'inspect this',
        hadImages: true,
        images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
      },
    })
    expect(turnFailureOf(liveUser)?.error).not.toHaveProperty('raw')

    await useWorkspace.getState().archiveSession('a')
    expect(turnFailureOf(bodies.a?.[0])).toEqual(turnFailureOf(liveUser))
    await useWorkspace.getState().restoreArchived('a')
    expect(useWorkspace.getState().sessions.a.error).toEqual({ message: 'turn rejected', fatal: false })

    useWorkspace.setState((state) => ({
      sessions: { ...state.sessions, a: { ...state.sessions.a, live: true } },
    }))
    useWorkspace.getState().retryLastTurn('a')
    await delay()
    expect(sendTurn).toHaveBeenCalledWith({
      sessionId: 'a',
      text: 'inspect this',
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }],
    })
  })

  it('promotes a live PDF payload before failure so Retry keeps the document', async () => {
    const sendTurn = vi.fn(async () => {})
    installBridge({ sendTurn })
    const a = { ...session('a'), busy: true, live: true }
    const pdf = { mediaType: 'application/pdf', name: 'brief.pdf', dataBase64: 'UERG' }
    const provenance = [{ mediaType: pdf.mediaType, name: pdf.name }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect the brief',
      10,
      true,
      false,
      undefined,
      'logical-pdf',
      true,
      provenance,
    )
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect the brief',
      10,
      false,
      false,
      [pdf],
      'logical-pdf',
      true,
      provenance,
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'PDF turn rejected',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 11,
    })

    expect(turnFailureOf(useWorkspace.getState().sessions.a.items[0])?.target).toMatchObject({
      clientTurnId: 'logical-pdf',
      hadAttachments: true,
      attachments: provenance,
      images: [pdf],
    })
    useWorkspace.getState().retryLastTurn('a')
    await delay()

    expect(sendTurn).toHaveBeenCalledWith({
      sessionId: 'a',
      text: 'inspect the brief',
      images: [pdf],
    })
    expect(useWorkspace.getState().sessions.a.items.at(-1)).toMatchObject({
      kind: 'user',
      text: 'inspect the brief',
      hadAttachments: true,
      attachments: provenance,
      files: ['brief.pdf'],
      images: [pdf],
    })
  })

  it('never retries a remembered image caption after its bytes were lost', () => {
    const sendTurn = vi.fn(async () => {})
    installBridge({ sendTurn })
    const a = session('a')
    a.live = true
    a.items = [{ id: 1, kind: 'user', text: '(image)', hadImages: true }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'process exited',
      fatal: true,
    })

    useWorkspace.getState().retryLastTurn('a')

    expect(sendTurn).not.toHaveBeenCalled()
    expect(useWorkspace.getState().sessions.a.error?.message).toContain('images')
  })

  it('never retries remembered document provenance after its bytes were lost', () => {
    const sendTurn = vi.fn(async () => {})
    installBridge({ sendTurn })
    const a = { ...session('a'), busy: true, live: true }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect the brief',
      10,
      true,
      false,
      undefined,
      'logical-pdf',
      true,
      [{ mediaType: 'application/pdf', name: 'brief.pdf' }],
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'process exited',
      fatal: true,
      replaySeq: 11,
    })

    useWorkspace.getState().retryLastTurn('a')

    expect(sendTurn).not.toHaveBeenCalled()
    expect(useWorkspace.getState().sessions.a.error?.message).toContain('attachments')
  })
})

describe('a refused send surfaces as the composer banner', () => {
  it('routes a sendTurn rejection into the session error banner and frees the composer', async () => {
    // Main is the final admission boundary; a stranded approval that outlived its turn, or a race, can
    // make it refuse a send. That rejection used to be an invisible unhandledrejection. It must instead
    // show as the calm banner, carrying the actual refusal text (with the Electron IPC wrapper stripped).
    const sendTurn = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'send-turn': Error: This session is waiting for your answer. Resolve it before sending another message.",
      )
    })
    installBridge({ sendTurn })
    const a = { ...session('a'), live: true }
    // activeId stays null so the setup EngineError's attention path short-circuits before it touches
    // `document` (absent in the node lane) — matching the sibling turn-rejection tests above.
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    // A failed text turn gives retryLastTurn a target to re-send through dispatchTurn — the path that
    // ends in window.koda.sendTurn. append=true so a real user row is created for the failure to target.
    useWorkspace.getState().applyRemoteUserTurn('a', 'send this again', 10, true, false, undefined)
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'first failure',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 11,
    })

    useWorkspace.getState().retryLastTurn('a')
    await vi.waitFor(() =>
      expect(useWorkspace.getState().sessions.a.error?.message).toBe(
        'This session is waiting for your answer. Resolve it before sending another message.',
      ),
    )
    expect(sendTurn).toHaveBeenCalled()
    // Composer is usable again — the optimistic turn was ended, not left spinning.
    expect(useWorkspace.getState().sessions.a.busy).toBe(false)
    // The optimistic user item stays — the user's words are not lost.
    expect(useWorkspace.getState().sessions.a.items.some((it) => it.kind === 'user' && it.text === 'send this again')).toBe(true)

    // The refusal must leave a retry TARGET, not just a banner: the refused dispatch appended a fresh
    // user row, which supersedes the older failure, so unless the refusal attaches its own TurnFailure
    // envelope to that row, "Try again" finds nothing, clears the banner, and silently sends nothing.
    const callsAfterRefusal = sendTurn.mock.calls.length
    useWorkspace.getState().retryLastTurn('a')
    await vi.waitFor(() => expect(sendTurn.mock.calls.length).toBe(callsAfterRefusal + 1))
  })
})

describe('delegated work opens the Agents stage', () => {
  it('adds and selects Agents when the active chat launches a subagent', () => {
    const a = session('a')
    useWorkspace.setState({
      sessions: { a },
      order: ['a'],
      activeId: 'a',
      editors: {
        a: {
          surfaces: [{ path: '/tmp/project/notes.md', title: 'notes.md', view: 'file', rev: 0 }],
          activeSurfaceId: '/tmp/project/notes.md',
          pinned: false,
          stageShown: false,
        },
      },
    })

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentStarted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      taskId: 'task-1',
      subagentType: 'Codex',
      description: 'Inspect the renderer',
    })

    const state = useWorkspace.getState()
    const editor = state.editors.a
    expect(editor.surfaces.map((surface) => surface.kind ?? 'file')).toEqual(['file', 'agents'])
    expect(editor.activeSurfaceId).toBe(editor.surfaces[1].path)
    expect(editor.stageShown).toBeUndefined()
    expect(stageVisible(state)).toBe(true)

    useWorkspace.getState().selectSurface('/tmp/project/notes.md')
    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentStarted',
      sessionId: 'a',
      toolUseId: 'tool-2',
      subagentType: 'Codex',
      description: 'Inspect the lifecycle',
    })

    const settledEditor = useWorkspace.getState().editors.a
    expect(settledEditor.surfaces.map((surface) => surface.kind ?? 'file')).toEqual(['file', 'agents'])
    expect(settledEditor.activeSurfaceId).toBe('/tmp/project/notes.md')
  })

  it('adds Agents without stealing a pinned active surface', () => {
    const a = session('a')
    useWorkspace.setState({
      sessions: { a },
      order: ['a'],
      activeId: 'a',
      editors: {
        a: {
          surfaces: [{ path: '/tmp/project/notes.md', title: 'notes.md', view: 'file', rev: 0 }],
          activeSurfaceId: '/tmp/project/notes.md',
          pinned: true,
        },
      },
    })

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentStarted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      subagentType: 'Codex',
      description: 'Inspect the renderer',
    })

    const editor = useWorkspace.getState().editors.a
    expect(editor.surfaces.map((surface) => surface.kind ?? 'file')).toEqual(['file', 'agents'])
    expect(editor.activeSurfaceId).toBe('/tmp/project/notes.md')
    expect(editor.pinned).toBe(true)
  })

  it('fronts a background workflow and opens its Agents tab', () => {
    const a = session('a')
    const b = session('b')
    useWorkspace.setState({
      sessions: { a, b },
      order: ['a', 'b'],
      activeId: 'a',
      editors: {
        a: { surfaces: [], activeSurfaceId: null, pinned: false, stageShown: false },
        b: { surfaces: [], activeSurfaceId: null, pinned: false, stageShown: false },
      },
    })

    useWorkspace.getState().applyEngineEvent({
      type: 'WorkflowStarted',
      sessionId: 'b',
      runId: 'review',
      name: 'Parallel review',
    })

    const state = useWorkspace.getState()
    expect(state.activeId).toBe('b')
    expect(stageVisible(state)).toBe(true)
    expect(state.editors.a.surfaces).toEqual([])
    expect(state.editors.b.surfaces).toEqual([
      expect.objectContaining({ kind: 'agents', title: 'Agents' }),
    ])
    expect(state.editors.b.activeSurfaceId).toBe(state.editors.b.surfaces[0].path)
    expect(state.editors.b.stageShown).toBeUndefined()
  })

  it('fronts a background session and shows the preview its agent pushed', () => {
    const a = session('a')
    const b = { ...session('b'), attention: true }
    useWorkspace.setState({
      sessions: { a, b },
      order: ['a', 'b'],
      activeId: 'a',
      editors: {
        a: { surfaces: [], activeSurfaceId: null, pinned: false },
        b: {
          surfaces: [{ path: '/tmp/project/notes.md', title: 'notes.md', view: 'file', rev: 0 }],
          activeSurfaceId: '/tmp/project/notes.md',
          pinned: true,
          stageShown: false,
        },
      },
    })

    useWorkspace
      .getState()
      .openPreview('http://localhost:5173', { respectPin: true, sessionId: 'b' })

    const state = useWorkspace.getState()
    const editor = state.editors.b
    expect(state.activeId).toBe('b')
    expect(state.sessions.b.attention).toBe(false)
    expect(stageVisible(state)).toBe(true)
    expect(editor.surfaces.map((surface) => surface.kind ?? 'file')).toEqual(['file', 'preview'])
    expect(editor.activeSurfaceId).toBe(editor.surfaces[1].path)
    expect(editor.pinned).toBe(false)
    expect(editor.stageShown).toBeUndefined()
  })
})

describe('workflow observer lifecycle', () => {
  it('atomically marks the coordinator and unresolved members unknown when observation ends', () => {
    const a = session('a')
    a.items = [
      {
        id: 1,
        kind: 'workflow',
        runId: 'review',
        name: 'Review',
        status: 'running',
        agents: [
          { agentId: 'live', status: 'running' },
          { agentId: 'done', status: 'done', result: 'finished' },
        ],
      },
    ]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    useWorkspace.getState().applyEngineEvent({
      type: 'WorkflowObservationEnded',
      sessionId: 'a',
      runId: 'review',
      unresolvedAgentIds: ['live'],
    })

    expect(useWorkspace.getState().sessions.a.items[0]).toMatchObject({
      kind: 'workflow',
      status: 'unknown',
      agents: [
        { agentId: 'live', status: 'unknown' },
        { agentId: 'done', status: 'done', result: 'finished' },
      ],
    })
    expect(useWorkspace.getState().sessions.a.attention).toBe(false)
  })

  it('does not raise finished attention while a workflow member is still running', () => {
    const a = session('a')
    a.items = [
      {
        id: 1,
        kind: 'workflow',
        runId: 'review',
        name: 'Review',
        status: 'running',
        agents: [{ agentId: 'live', status: 'running' }],
      },
    ]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    useWorkspace.getState().applyEngineEvent({
      type: 'WorkflowCompleted',
      sessionId: 'a',
      runId: 'review',
      agentCount: 1,
    })

    expect(useWorkspace.getState().sessions.a.items[0]).toMatchObject({
      kind: 'workflow',
      status: 'completed',
      agents: [{ agentId: 'live', status: 'running' }],
    })
    expect(useWorkspace.getState().sessions.a.attention).toBe(false)
  })
})

describe('session start notice', () => {
  const started = (model: string) =>
    useWorkspace.getState().applyEngineEvent({
      type: 'SessionStarted',
      sessionId: 'a',
      model,
      tools: [],
      cwd: '/tmp/project',
    })
  const notices = () =>
    useWorkspace.getState().sessions.a.items.filter((item) => item.kind === 'notice')

  it('stays silent on the first start even though lazy init lands after the first user message', () => {
    const a = session('a')
    a.items = [{ id: 1, kind: 'user', text: 'hello' }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    started('claude-fable-5')

    expect(notices()).toHaveLength(0)
    expect(useWorkspace.getState().sessions.a.activeModel).toBe('claude-fable-5')
  })

  it('banners only a restart under a conversation the engine already started once', () => {
    const a = session('a')
    a.items = [{ id: 1, kind: 'user', text: 'hello' }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    started('claude-fable-5')
    started('claude-fable-5')

    expect(notices()).toEqual([expect.objectContaining({ text: 'continuing on Fable 5' })])
  })
})

describe('session capability degradation', () => {
  const snapshot = (status: 'ready' | 'degraded') => ({
    engine: 'codex' as const,
    cwd: '/tmp/project',
    observedAt: Date.now(),
    source: 'native-probe' as const,
    capabilities: [
      { id: 'koda-tools' as const, label: 'Koda tools', status },
      { id: 'playbooks' as const, label: 'Koda playbooks', status: 'ready' as const },
      { id: 'browser-testing' as const, label: 'Browser testing', status: 'disabled' as const },
    ],
    tools: status === 'ready' ? ['mcp__koda_broker__capabilities'] : [],
    skills: ['koda:code-work'],
    agents: [],
    plugins: ['koda'],
    mcpServers: [],
  })

  it('stores runtime truth and surfaces each degraded shape only once', () => {
    useWorkspace.setState({ sessions: { a: session('a') }, order: ['a'], activeId: 'a' })
    const apply = (status: 'ready' | 'degraded') =>
      useWorkspace.getState().applyEngineEvent({
        type: 'SessionCapabilitiesUpdated',
        sessionId: 'a',
        snapshot: snapshot(status),
      })

    apply('degraded')
    apply('degraded')
    expect(useWorkspace.getState().sessions.a.capabilities?.capabilities[0].status).toBe('degraded')
    expect(
      useWorkspace.getState().sessions.a.items.filter(
        (item) => item.kind === 'notice' && item.text.includes("Koda abilities didn't load"),
      ),
    ).toHaveLength(1)

    apply('ready')
    expect(useWorkspace.getState().sessions.a.capabilities?.capabilities[0].status).toBe('ready')
    expect(
      useWorkspace.getState().sessions.a.items.filter(
        (item) => item.kind === 'notice' && item.text.includes("Koda abilities didn't load"),
      ),
    ).toHaveLength(0)
  })

  it('shows a degraded snapshot when a phone-started session is adopted', async () => {
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'phone',
          cwd: '/tmp/project',
          engineId: 'codex',
          approvalMode: 'ask',
          fromRemote: true,
          capabilities: snapshot('degraded'),
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const adopted = useWorkspace.getState().sessions.phone
    expect(adopted.capabilities?.capabilities[0].status).toBe('degraded')
    expect(
      adopted.items.filter(
        (item) => item.kind === 'notice' && item.text.includes("Koda abilities didn't load"),
      ),
    ).toHaveLength(1)
  })

  it('uses the phone fallback only for a session main identifies as phone-origin', async () => {
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'desktop-reload',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          label: 'From your phone',
          userNamed: false,
          fromRemote: false,
          events: [],
        },
        {
          id: 'phone',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          fromRemote: true,
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    expect(useWorkspace.getState().sessions['desktop-reload']).toMatchObject({
      label: 'New session',
      fromRemote: undefined,
    })
    expect(useWorkspace.getState().sessions.phone).toMatchObject({
      label: 'From your phone',
      fromRemote: true,
    })
  })

  it('repairs an existing desktop row poisoned by the old phone fallback without needing a prompt', async () => {
    const desktop = { ...session('desktop-reload'), label: 'From your phone' }
    useWorkspace.setState({
      sessions: { 'desktop-reload': desktop },
      order: ['desktop-reload'],
      activeId: 'desktop-reload',
    })
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'desktop-reload',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          label: 'From your phone',
          userNamed: false,
          fromRemote: false,
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    expect(useWorkspace.getState().sessions['desktop-reload'].label).toBe('New session')
  })

  it('preserves an intentional matching name despite desktop origin', async () => {
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'desktop-manual',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          label: 'From your phone',
          userNamed: true,
          fromRemote: false,
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    expect(useWorkspace.getState().sessions['desktop-manual']).toMatchObject({
      label: 'From your phone',
      userNamed: true,
    })
  })

  it('replaces a persisted phone placeholder when replay reveals the first real prompt', async () => {
    const nameSession = vi.fn(async () => ({
      title: 'Phone Session Naming',
      overview: 'Keeps a phone-started session named after its real work.',
    }))
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'phone',
          cwd: '/tmp/project',
          engineId: 'codex',
          approvalMode: 'ask',
          label: 'From your phone',
          userNamed: false,
          events: [
            {
              type: 'RemoteUserTurn',
              sessionId: 'phone',
              text: 'fix the phone session naming',
              replaySeq: 1,
            },
          ],
        },
      ],
      nameSession,
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()
    await vi.waitFor(() => expect(useWorkspace.getState().sessions.phone.label).toBe('Phone Session Naming'))

    expect(nameSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'initial',
        evidence: 'fix the phone session naming',
      }),
    )
  })

  it('repairs an inactive phone placeholder from its persisted first prompt during hydration', () => {
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'phone',
      sessions: [
        {
          id: 'phone',
          label: 'From your phone',
          userNamed: false,
          cwd: '/tmp/project',
          items: [{ id: 1, kind: 'user', text: 'fix the phone session naming' }],
        },
      ],
    })

    expect(useWorkspace.getState().sessions.phone.label).toBe('fix the phone session naming')
  })

  it('does not repair a persisted phone placeholder from an image-only replay sentinel', () => {
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'phone',
      sessions: [
        {
          id: 'phone',
          label: 'From your phone',
          userNamed: false,
          cwd: '/tmp/project',
          items: [{ id: 1, kind: 'user', text: '(image)' }],
        },
      ],
    })

    expect(useWorkspace.getState().sessions.phone.label).toBe('From your phone')
  })

  it('does not name an adopted phone session from an image-only replay sentinel', async () => {
    const nameSession = vi.fn(async () => ({ title: 'Wrong Image Title', overview: '' }))
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'phone',
          cwd: '/tmp/project',
          engineId: 'codex',
          approvalMode: 'ask',
          label: 'From your phone',
          userNamed: false,
          events: [
            {
              type: 'RemoteUserTurn',
              sessionId: 'phone',
              text: '(image)',
              replaySeq: 1,
            },
          ],
        },
      ],
      nameSession,
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    expect(useWorkspace.getState().sessions.phone.label).toBe('From your phone')
    expect(nameSession).not.toHaveBeenCalled()
  })

  it('repairs a hydrated live placeholder after headless replay reveals its first prompt', async () => {
    const nameSession = vi.fn(async () => ({
      title: 'Phone Session Naming',
      overview: 'Keeps restored phone sessions named after their work.',
    }))
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'phone',
      sessions: [
        {
          id: 'phone',
          label: 'From your phone',
          userNamed: false,
          cwd: '/tmp/project',
          items: [],
        },
      ],
    })
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'phone',
          cwd: '/tmp/project',
          engineId: 'codex',
          approvalMode: 'ask',
          label: 'From your phone',
          userNamed: false,
          events: [
            {
              type: 'RemoteUserTurn',
              sessionId: 'phone',
              text: 'fix the phone session naming',
              replaySeq: 1,
            },
          ],
        },
      ],
      nameSession,
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()
    await vi.waitFor(() => expect(useWorkspace.getState().sessions.phone.label).toBe('Phone Session Naming'))
    expect(nameSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'initial', evidence: 'fix the phone session naming' }),
    )
  })

  it('restores runtime truth after a renderer reload without duplicating its persisted warning', async () => {
    const warning = "Some Koda abilities didn't load: Koda tools. You can keep chatting; start a new session to retry them."
    const restored = session('a')
    restored.items = [{ id: 1, kind: 'notice', text: warning }]
    useWorkspace.setState({ sessions: { a: restored }, order: ['a'], activeId: 'a' })
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'codex',
          approvalMode: 'ask',
          working: false,
          capabilities: snapshot('degraded'),
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const adopted = useWorkspace.getState().sessions.a
    expect(adopted.capabilities?.capabilities[0].status).toBe('degraded')
    expect(adopted.items.filter((item) => item.kind === 'notice' && item.text === warning)).toHaveLength(1)
  })

  it('removes a persisted warning when main reports that the adopted session recovered', async () => {
    const warning = "Some Koda abilities didn't load: Koda tools. You can keep chatting; start a new session to retry them."
    const restored = session('a')
    restored.items = [{ id: 1, kind: 'notice', text: warning }]
    useWorkspace.setState({ sessions: { a: restored }, order: ['a'], activeId: 'a' })
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'codex',
          approvalMode: 'ask',
          working: false,
          capabilities: snapshot('ready'),
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const adopted = useWorkspace.getState().sessions.a
    expect(adopted.capabilities?.capabilities[0].status).toBe('ready')
    expect(adopted.items.filter((item) => item.kind === 'notice' && item.text === warning)).toHaveLength(0)
  })
})

describe('archive moves under interleaving', () => {
  it('persists only the tool-output tail the transcript can display, including delegated tools', async () => {
    const longResult = `old-prefix-${'x'.repeat(4_000)}-LATEST`
    const questionResult = `Your questions have been answered: "Pick one"="${'x'.repeat(3_000)}" selected`
    const a = session('a')
    a.items = [
      { id: 1, kind: 'tool', toolUseId: 'top', name: 'Bash', input: {}, result: longResult },
      {
        id: 2,
        kind: 'subagent',
        toolUseId: 'agent',
        subagentType: 'scout',
        description: 'Inspect',
        status: 'completed',
        children: [
          { id: 3, kind: 'tool', toolUseId: 'child', name: 'Read', input: {}, result: longResult },
        ],
      },
      {
        id: 4,
        kind: 'tool',
        toolUseId: 'question',
        name: 'AskUserQuestion',
        input: {},
        result: questionResult,
      },
    ]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    const persisted = useWorkspace.getState().persistBlob().sessions[0].items as typeof a.items
    expect(persisted[0]).toMatchObject({ kind: 'tool', result: expect.stringContaining('showing latest') })
    expect(persisted[0].kind === 'tool' && persisted[0].result).toHaveLength(2_000)
    const persistedAgent = persisted[1]
    expect(persistedAgent.kind).toBe('subagent')
    expect(
      persistedAgent.kind === 'subagent' &&
        persistedAgent.children[0].kind === 'tool' &&
        persistedAgent.children[0].result,
    ).toHaveLength(2_000)
    expect(persisted[2]).toMatchObject({ kind: 'tool', result: questionResult })
    // Compaction is a persistence boundary, not a mutation of the card the user is currently viewing.
    expect(useWorkspace.getState().sessions.a.items[0]).toMatchObject({ result: longResult })

    await useWorkspace.getState().archiveSession('a')
    const archivedItems = bodies.a as typeof a.items
    expect(archivedItems[0].kind === 'tool' && archivedItems[0].result).toHaveLength(2_000)
  })

  it('treats archived ids as tombstones on hydrate and collapses repeated archive rows', () => {
    const newest = { ...archivedMeta('a'), archivedAt: 30 }
    const older = { ...archivedMeta('a'), archivedAt: 20 }

    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'a',
      sessions: [
        { id: 'a', label: 'Archived but stale', cwd: '/tmp/project', items: [] },
        { id: 'b', label: 'Still live', cwd: '/tmp/project', items: [] },
      ],
      archived: [newest, older],
    })

    expect(useWorkspace.getState().order).toEqual(['b'])
    expect(useWorkspace.getState().activeId).toBe('b')
    expect(useWorkspace.getState().archived).toEqual([newest])
  })

  it('restores one exact failed PDF retry after an archived id tombstones a stale hot copy', async () => {
    const sendTurn = vi.fn(async () => {})
    installBridge({ sendTurn })
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    const pdf = { mediaType: 'application/pdf', name: 'latest.pdf', dataBase64: 'UERG' }
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect the report',
      3,
      true,
      false,
      [pdf],
      'logical-pdf',
      true,
      [{ mediaType: pdf.mediaType, name: pdf.name }],
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'PDF turn rejected',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 4,
    })
    bodies.a = useWorkspace.getState().sessions.a.items
    const meta = { ...archivedMeta('a'), archivedAt: 30, replaySeq: 4 }
    useWorkspace.setState({ sessions: {}, order: [], activeId: null })

    // A stale hot copy of an archived id must remain tombstoned; Restore then reads the cold body that
    // owns the newest logical cursor and exact retry material.
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'a',
      sessions: [
        {
          id: 'a',
          label: 'Stale hot copy',
          cwd: '/tmp/project',
          approvalMode: 'ask',
          engineId: 'claude',
          items: [{ id: 99, kind: 'user', text: 'stale', replaySeq: 1 }],
        },
      ],
      archived: [meta],
    })
    expect(useWorkspace.getState().sessions.a).toBeUndefined()

    await useWorkspace.getState().restoreArchived('a')

    const restored = useWorkspace.getState().sessions.a
    const users = restored.items.filter((item) => item.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      clientTurnId: 'logical-pdf',
      replaySeq: 3,
      files: ['latest.pdf'],
      attachments: [{ mediaType: 'application/pdf', name: 'latest.pdf' }],
      images: [pdf],
    })
    expect(turnFailureOf(users[0])?.target).toMatchObject({
      clientTurnId: 'logical-pdf',
      replaySeq: 3,
      images: [pdf],
    })
    expect(restored).toMatchObject({
      replaySeq: 4,
      error: { message: 'PDF turn rejected', fatal: false },
    })

    useWorkspace.setState((state) => ({
      sessions: { ...state.sessions, a: { ...state.sessions.a, live: true } },
    }))
    useWorkspace.getState().retryLastTurn('a')
    await delay()
    expect(sendTurn).toHaveBeenCalledWith({
      sessionId: 'a',
      text: 'inspect the report',
      images: [pdf],
    })
  })

  it('replaces an earlier archive row when a stale live copy retries', async () => {
    const earlier = { ...archivedMeta('a'), archivedAt: 1 }
    useWorkspace.setState({
      sessions: { a: session('a') },
      order: ['a'],
      activeId: 'a',
      archived: [earlier],
    })

    await useWorkspace.getState().archiveSession('a')

    expect(saved.at(-1)).toHaveLength(1)
    expect(saved.at(-1)?.[0].id).toBe('a')
    expect(saved.at(-1)?.[0].archivedAt).toBeGreaterThan(earlier.archivedAt)
  })

  it('preserves hidden recovery metadata across unrelated archives and replaces it on retry', async () => {
    const broken = { ...archivedMeta('a'), label: 'Broken archive copy' }
    useWorkspace.setState({
      sessions: { a: session('a'), b: session('b') },
      order: ['a', 'b'],
      activeId: 'a',
      protectedArchived: [broken],
    })

    await useWorkspace.getState().archiveSession('b')

    expect(ids(saved.at(-1) ?? [])).toEqual(['a', 'b'])
    expect(ids(useWorkspace.getState().archived)).toEqual(['b'])
    expect(useWorkspace.getState().protectedArchived).toEqual([broken])

    // Re-archiving the readable live fallback writes a fresh body and replaces, rather than duplicates,
    // the protected metadata for that same conversation.
    await useWorkspace.getState().archiveSession('a')

    expect(ids(saved.at(-1) ?? [])).toEqual(['a', 'b'])
    expect(ids(useWorkspace.getState().archived)).toEqual(['a', 'b'])
    expect(useWorkspace.getState().protectedArchived).toEqual([])
  })

  it('two archives asked for at once both reach the index and the store', async () => {
    useWorkspace.setState({
      sessions: { a: session('a'), b: session('b') },
      order: ['a', 'b'],
      activeId: 'a',
      completionBySession: {
        a: { sessionId: 'a', state: 'loose-ends', paths: ['a.ts'], mixedPaths: [] },
      },
    })
    const { archiveSession } = useWorkspace.getState()

    // Both in flight before either write is answered — the phone forwarding an archive of `a` while the
    // user hits ⌘W on `b`.
    await Promise.all([archiveSession('a'), archiveSession('b')])

    expect(ids(saved[saved.length - 1])).toEqual(['a', 'b']) // the file holds both
    expect(ids(useWorkspace.getState().archived)).toEqual(['a', 'b']) // and so does memory
    expect(useWorkspace.getState().order).toEqual([])
    expect(useWorkspace.getState().completionBySession).toEqual({})
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
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

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

  it('leaves project stars alone when a chat is archived, restored, or permanently deleted', async () => {
    const a = session('a')
    const starredDocs = ['Documents/brief.md', 'Documents/decisions/tiers.md']
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a', starredDocs })

    await useWorkspace.getState().archiveSession('a')
    expect(useWorkspace.getState().starredDocs).toEqual(starredDocs)

    await useWorkspace.getState().restoreArchived('a')
    expect(useWorkspace.getState().starredDocs).toEqual(starredDocs)

    await useWorkspace.getState().archiveSession('a')
    await useWorkspace.getState().deleteArchived('a')
    expect(useWorkspace.getState().starredDocs).toEqual(starredDocs)
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

  it('a refused body write leaves the only transcript hot and writes no archive metadata', async () => {
    installBridge({ writeArchivedBody: async () => false })
    const a = session('a')
    a.items = [{ id: 1, kind: 'user', text: 'irreplaceable conversation' }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    await useWorkspace.getState().archiveSession('a')

    expect(useWorkspace.getState().sessions.a.items).toEqual(a.items)
    expect(useWorkspace.getState().order).toEqual(['a'])
    expect(useWorkspace.getState().archived).toEqual([])
    expect(useWorkspace.getState().archiveWriteFailed).toBe(true)
    expect(saved).toEqual([])
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

describe('composer send preflight', () => {
  it('claims one send and preserves a newer draft while mention lookup is pending', async () => {
    let release!: (value: { docs: { rel: string; name: string; path: string }[] }) => void
    const docs = new Promise<{ docs: { rel: string; name: string; path: string }[] }>(
      (resolve) => (release = resolve),
    )
    const turns: { sessionId: string; text: string }[] = []
    installBridge({
      listDocs: () => docs,
      sendTurn: async (turn: { sessionId: string; text: string }) => void turns.push(turn),
    })
    const a = session('a')
    a.live = true
    a.draft = 'Review @brief'
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    const first = useWorkspace.getState().send()
    const duplicate = useWorkspace.getState().send()
    useWorkspace.getState().setDraft('a', 'This is my next message')
    release({
      docs: [{ rel: 'Documents/brief.md', name: 'brief.md', path: '/tmp/project/Documents/brief.md' }],
    })
    await Promise.all([first, duplicate])

    expect(turns).toEqual([
      expect.objectContaining({ sessionId: 'a', text: 'Review @Documents/brief.md' }),
    ])
    expect(useWorkspace.getState().sessions.a.draft).toBe('This is my next message')
    expect(useWorkspace.getState().sessions.a.items.filter((item) => item.kind === 'user')).toHaveLength(1)
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
      version: 3,
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

  const attachmentRetryReplay = (sessionId: string) => [
    {
      type: 'RemoteUserTurn' as const,
      sessionId,
      text: 'inspect',
      clientTurnId: 'logical-a',
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'old.pdf' }],
      hadImages: false,
      images: [{ mediaType: 'application/pdf', name: 'old.pdf', dataBase64: 'T0xE' }],
      replaySeq: 1,
    },
    {
      type: 'EngineError' as const,
      sessionId,
      message: 'first attempt failed',
      fatal: false,
      category: 'turnRejected' as const,
      replaySeq: 2,
    },
    {
      type: 'RemoteUserTurn' as const,
      sessionId,
      text: 'inspect',
      clientTurnId: 'logical-a',
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'new.pdf' }],
      hadImages: false,
      images: [{ mediaType: 'application/pdf', name: 'new.pdf', dataBase64: 'TkVX' }],
      replaySeq: 3,
    },
    {
      type: 'EngineError' as const,
      sessionId,
      message: 'retry failed',
      fatal: false,
      category: 'turnRejected' as const,
      replaySeq: 4,
    },
  ] as const

  it('carries the replay cursor across main load into boot hydration', () => {
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'a',
      sessions: [
        {
          id: 'a',
          label: 'a',
          cwd: '/tmp/project',
          replaySeq: 41,
          items: [{ id: 1, kind: 'user', text: 'persisted' }],
        },
      ],
    })
    expect(useWorkspace.getState().sessions.a.replaySeq).toBe(41)
  })

  it('restores an in-flight child as unknown instead of pretending it is still running', () => {
    useWorkspace.getState().hydrate({
      version: 3,
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
      version: 3,
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
          fromRemote: false,
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

  it('reattaches a renderer reload to the exact workflow members main still observes', async () => {
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'a',
      sessions: [
        {
          id: 'a',
          label: 'a',
          cwd: '/tmp/project',
          items: [
            {
              id: 1,
              kind: 'workflow',
              runId: 'review',
              name: 'Review',
              status: 'running',
              agents: [
                { agentId: 'critic', status: 'running' },
                { agentId: 'done', status: 'done', result: 'finished' },
              ],
            },
          ],
        },
      ],
    })
    expect(useWorkspace.getState().sessions.a.items[0]).toMatchObject({
      status: 'unknown',
      agents: [{ agentId: 'critic', status: 'unknown' }, { agentId: 'done', status: 'done' }],
    })

    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          activeWorkflows: [{ runId: 'review', runningAgentIds: ['critic'] }],
          events: [],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    expect(useWorkspace.getState().sessions.a.items[0]).toMatchObject({
      kind: 'workflow',
      runId: 'review',
      status: 'running',
      agents: [
        { agentId: 'critic', status: 'running' },
        { agentId: 'done', status: 'done', result: 'finished' },
      ],
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

  it('rebuilds a fresh attachment retry as one exact retryable logical row', async () => {
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'phone',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          label: 'Settled phone session',
          activeSubagentToolUseIds: [],
          events: attachmentRetryReplay('phone'),
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const restored = useWorkspace.getState().sessions.phone
    const users = restored.items.filter((item) => item.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 3,
      files: ['new.pdf'],
      attachments: [{ mediaType: 'application/pdf', name: 'new.pdf' }],
      images: [{ mediaType: 'application/pdf', name: 'new.pdf', dataBase64: 'TkVX' }],
    })
    expect(turnFailureOf(users[0])?.target).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 3,
      text: 'inspect',
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'new.pdf' }],
      images: [{ mediaType: 'application/pdf', name: 'new.pdf', dataBase64: 'TkVX' }],
    })
    expect(restored.label).toBe('Settled phone session')
    expect(restored.replaySeq).toBe(4)
  })

  it('reconciles an existing adoption tail without losing its newer attachment retry', async () => {
    const a = session('a')
    a.userNamed = true
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    const replay = attachmentRetryReplay('a')
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect',
      1,
      true,
      false,
      [{ mediaType: 'application/pdf', name: 'old.pdf', dataBase64: 'T0xE' }],
      'logical-a',
      true,
      [{ mediaType: 'application/pdf', name: 'old.pdf' }],
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'first attempt failed',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 2,
    })
    expect(turnFailureOf(useWorkspace.getState().sessions.a.items[0])?.target).toMatchObject({
      replaySeq: 1,
      images: [{ name: 'old.pdf', dataBase64: 'T0xE' }],
    })
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          events: replay,
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const restored = useWorkspace.getState().sessions.a
    const users = restored.items.filter((item) => item.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 3,
      files: ['new.pdf'],
      attachments: [{ mediaType: 'application/pdf', name: 'new.pdf' }],
      images: [{ mediaType: 'application/pdf', name: 'new.pdf', dataBase64: 'TkVX' }],
    })
    expect(turnFailureOf(users[0])?.target).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 3,
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'new.pdf' }],
      images: [{ mediaType: 'application/pdf', name: 'new.pdf', dataBase64: 'TkVX' }],
    })
    expect(restored.replaySeq).toBe(4)
  })

  it('preserves an exact durable attachment failure when existing adoption has no tail', async () => {
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect',
      1,
      true,
      false,
      [{ mediaType: 'application/pdf', name: 'old.pdf', dataBase64: 'T0xE' }],
      'logical-a',
      true,
      [{ mediaType: 'application/pdf', name: 'old.pdf' }],
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'first attempt failed',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 2,
    })
    useWorkspace.getState().hydrate(useWorkspace.getState().persistBlob())
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'a',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          events: attachmentRetryReplay('a').slice(0, 2),
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    const restored = useWorkspace.getState().sessions.a
    const users = restored.items.filter((item) => item.kind === 'user')
    expect(users).toHaveLength(1)
    expect(turnFailureOf(users[0])?.target).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 1,
      text: 'inspect',
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'old.pdf' }],
      images: [{ mediaType: 'application/pdf', name: 'old.pdf', dataBase64: 'T0xE' }],
    })
    expect(restored.error).toEqual({ message: 'first attempt failed', fatal: false })
    expect(restored.errored).toBe(true)
    expect(restored.replaySeq).toBe(2)
  })

  it('leaves fresh unlabeled image and attachment-only adoptions unnamed', async () => {
    const nameSession = vi.fn(async () => ({ title: 'Wrong image title', overview: '' }))
    installBridge({
      nameSession,
      adoptHeadlessSessions: async () => [
        {
          id: 'image-only',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          events: [
            {
              type: 'RemoteUserTurn' as const,
              sessionId: 'image-only',
              text: '',
              hadImages: true,
              images: [{ mediaType: 'image/png', dataBase64: 'SU1H' }],
              replaySeq: 1,
            },
          ],
        },
        {
          id: 'attachment-only',
          cwd: '/tmp/project',
          engineId: 'claude',
          approvalMode: 'ask',
          working: false,
          activeSubagentToolUseIds: [],
          events: [
            {
              type: 'RemoteUserTurn' as const,
              sessionId: 'attachment-only',
              text: '',
              hadImages: false,
              hadAttachments: true,
              attachments: [{ mediaType: 'application/pdf', name: 'brief.pdf' }],
              images: [{ mediaType: 'application/pdf', name: 'brief.pdf', dataBase64: 'UERG' }],
              replaySeq: 1,
            },
          ],
        },
      ],
      gitDetect: async () => ({ isRepo: false }),
    })

    await useWorkspace.getState().adoptHeadless()

    expect(useWorkspace.getState().sessions['image-only']).toMatchObject({
      label: 'From your phone',
      items: [{ kind: 'user', text: '(image)' }],
    })
    expect(useWorkspace.getState().sessions['attachment-only']).toMatchObject({
      label: 'From your phone',
      items: [{ kind: 'user', text: '(image)', files: ['brief.pdf'] }],
    })
    expect(nameSession).not.toHaveBeenCalled()
  })

  it('stamps a local optimistic turn instead of appending it again', () => {
    const a = session('a')
    a.items = [{ id: 1, kind: 'user', text: 'continue with this' }]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'continue with this',
      7,
      false,
      true,
      [{ mediaType: 'image/jpeg', dataBase64: 'BBBB' }],
    )

    expect(useWorkspace.getState().sessions.a.items).toEqual([
      {
        id: 1,
        kind: 'user',
        text: 'continue with this',
        replaySeq: 7,
        hadImages: true,
        images: [{ mediaType: 'image/jpeg', dataBase64: 'BBBB' }],
      },
    ])
    expect(useWorkspace.getState().sessions.a.replaySeq).toBe(7)
  })

  it('updates one owner row for an engine retry with the newest logical cursor and provenance', () => {
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect',
      7,
      true,
      false,
      undefined,
      'logical-a',
      true,
      [{ mediaType: 'text/csv', name: 'old.csv' }],
    )
    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect',
      9,
      true,
      false,
      [{ mediaType: 'application/pdf', dataBase64: 'TkVX' }],
      'logical-a',
      true,
      [{ mediaType: 'application/pdf', name: 'new.pdf' }],
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'retry rejected',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 10,
    })

    const restored = useWorkspace.getState().sessions.a
    expect(restored.items.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(restored.items[0]).toMatchObject({
      kind: 'user',
      clientTurnId: 'logical-a',
      replaySeq: 9,
      files: ['new.pdf'],
      attachments: [{ mediaType: 'application/pdf', name: 'new.pdf' }],
      images: [{ mediaType: 'application/pdf', dataBase64: 'TkVX' }],
    })
    expect(restored.replaySeq).toBe(10)
    expect(turnFailureOf(restored.items[0])?.target).toMatchObject({
      clientTurnId: 'logical-a',
      replaySeq: 9,
    })
  })

  it('does not resurrect a failed same-logical attempt after a successful retry and reopen', () => {
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect',
      7,
      true,
      false,
      undefined,
      'logical-a',
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'first attempt failed',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 8,
    })
    expect(turnFailureOf(useWorkspace.getState().sessions.a.items[0])).toBeDefined()
    expect(useWorkspace.getState().sessions.a.error).toMatchObject({
      message: 'first attempt failed',
    })

    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'inspect',
      9,
      true,
      false,
      undefined,
      'logical-a',
    )

    const retried = useWorkspace.getState().sessions.a
    expect(retried.items.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(retried.items[0]).toMatchObject({ clientTurnId: 'logical-a', replaySeq: 9 })
    expect(turnFailureOf(retried.items[0])).toBeUndefined()
    expect(retried.error).toBeUndefined()
    expect(retried.errored).toBe(false)

    useWorkspace.getState().applyEngineEvent({
      type: 'TurnComplete',
      sessionId: 'a',
      stopReason: 'success',
      replaySeq: 10,
    })
    const persisted = useWorkspace.getState().persistBlob()
    useWorkspace.getState().hydrate(persisted)

    const reopened = useWorkspace.getState().sessions.a
    expect(reopened.items.filter((item) => item.kind === 'user')).toHaveLength(1)
    expect(reopened.items[0]).toMatchObject({ clientTurnId: 'logical-a', replaySeq: 9 })
    expect(turnFailureOf(reopened.items[0])).toBeUndefined()
    expect(reopened.error).toBeUndefined()
    expect(reopened.errored).toBe(false)
  })

  it('appends an image-only phone turn with exact retry text and bytes', () => {
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      '',
      8,
      true,
      true,
      [{ mediaType: 'image/png', dataBase64: 'CCCC' }],
    )
    useWorkspace.getState().applyEngineEvent({
      type: 'EngineError',
      sessionId: 'a',
      message: 'turn rejected',
      fatal: false,
      category: 'turnRejected',
      replaySeq: 9,
    })

    const user = useWorkspace.getState().sessions.a.items[0]
    expect(user).toMatchObject({
      kind: 'user',
      text: '(image)',
      replaySeq: 8,
      hadImages: true,
      images: [{ mediaType: 'image/png', dataBase64: 'CCCC' }],
    })
    expect(turnFailureOf(user)?.target).toMatchObject({
      text: '',
      hadImages: true,
      images: [{ mediaType: 'image/png', dataBase64: 'CCCC' }],
    })
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

  // The engine backgrounds delegated tasks, so a fan-out routinely outlives the turn that spawned it.
  // Reading only `busy` settled the sidebar glyph on the finished check mid-fan-out.
  it('keeps reporting work while a backgrounded child outlives its parent turn', () => {
    const a = session('a')
    a.busy = true
    a.items = [runningChild]
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyEngineEvent({ type: 'TurnComplete', sessionId: 'a', stopReason: 'success' })

    const running = useWorkspace.getState().sessions.a
    expect(running.busy).toBe(false)
    expect(statusOf(running, [])).toBe('thinking')
    expect(busyActivity(running)).toBe('Agent still working…')

    useWorkspace.getState().applyEngineEvent({
      type: 'SubagentCompleted',
      sessionId: 'a',
      toolUseId: 'tool-1',
      outcome: 'completed',
    })
    expect(statusOf(useWorkspace.getState().sessions.a, [])).toBe('idle')
  })

  it('keeps reporting work while a background workflow outlives its parent turn', () => {
    const a = session('a')
    a.items = [
      {
        id: 1,
        kind: 'workflow',
        runId: 'review',
        name: 'Parallel review',
        // A coordinator can report completion while an observed late-wave member is still running.
        status: 'completed',
        agents: [{ agentId: 'critic', status: 'running' }],
      },
    ]

    expect(statusOf(a, [])).toBe('thinking')
    expect(busyActivity(a)).toBe('Agent still working…')
  })

  it('names how many delegates are still out', () => {
    const a = session('a')
    a.items = [runningChild, { ...runningChild, id: 2, toolUseId: 'tool-2' }]
    expect(busyActivity(a)).toBe('2 agents still working…')
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

  it('keeps a Codex session live across a Plan crossing — the mode rides the next turn', () => {
    const setApprovalMode = vi.fn(async () => {})
    installBridge({ setApprovalMode })
    const a = session('a')
    a.live = true
    a.engineId = 'codex'
    a.busy = true // no respawn to kill a turn, so a mid-turn switch is allowed on this engine
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().setSessionApprovalMode('a', 'plan')

    expect(useWorkspace.getState().sessions.a).toMatchObject({ approvalMode: 'plan', live: true })
    expect(setApprovalMode).toHaveBeenCalledWith({ sessionId: 'a', mode: 'plan' })
  })

  it('drops a Claude session live so it respawns in the engine\'s own plan mode', () => {
    const setApprovalMode = vi.fn(async () => {})
    installBridge({ setApprovalMode })
    const a = session('a')
    a.live = true
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().setSessionApprovalMode('a', 'plan')

    expect(useWorkspace.getState().sessions.a).toMatchObject({ approvalMode: 'plan', live: false })
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

// Every sidebar row reads its age off `lastActivityAt`. The label itself lives in session-map.ts
// (tested there); what matters HERE is that the stamp under it is honest — it moves when work happens,
// and never because someone looked at the thread.
describe('the sessions map observes activity', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('re-stamps a stale session when a turn arrives', () => {
    const stale = { ...session('a'), lastActivityAt: Date.now() - 9 * DAY }
    useWorkspace.setState({ sessions: { a: stale }, order: ['a'], activeId: null })

    // A turn sent from the phone is the same observed activity as one sent here.
    useWorkspace.getState().applyRemoteUserTurn('a', 'pick this back up please', 1)

    expect(useWorkspace.getState().sessions.a.lastActivityAt).toBeGreaterThan(Date.now() - 5_000)
  })

  it('re-stamps a stale session when an optimistic turn receives its replay identity', () => {
    const stale = { ...session('a'), lastActivityAt: Date.now() - 9 * DAY }
    stale.items = [{ id: 1, kind: 'user', text: 'continue here' }]
    useWorkspace.setState({ sessions: { a: stale }, order: ['a'], activeId: null })

    useWorkspace.getState().applyRemoteUserTurn('a', 'continue here', 7, false)

    expect(useWorkspace.getState().sessions.a.lastActivityAt).toBeGreaterThan(Date.now() - 5_000)
  })

  it('re-stamps a stale session when a durable retry reconciles its logical turn', () => {
    const stale = { ...session('a'), lastActivityAt: Date.now() - 9 * DAY }
    stale.items = [
      { id: 1, kind: 'user', text: 'retry this', clientTurnId: 'logical-a', replaySeq: 3 },
    ]
    useWorkspace.setState({ sessions: { a: stale }, order: ['a'], activeId: null })

    useWorkspace.getState().applyRemoteUserTurn(
      'a',
      'retry this',
      5,
      true,
      false,
      undefined,
      'logical-a',
    )

    expect(useWorkspace.getState().sessions.a.lastActivityAt).toBeGreaterThan(Date.now() - 5_000)
  })

  it('does not treat opening a session as activity — glancing is not work', () => {
    const stale = { ...session('a'), lastActivityAt: Date.now() - 9 * DAY }
    useWorkspace.setState({ sessions: { a: stale }, order: ['a'], activeId: null })

    useWorkspace.getState().selectSession('a')

    expect(useWorkspace.getState().sessions.a.lastActivityAt).toBe(stale.lastActivityAt)
  })

  it('gives every session that enters the map a stamp, so no row is left without an age', async () => {
    // A session persisted BEFORE Koda observed activity has no stamp on disk. Left blank its row would
    // read no age at all; back-dated it would print a reading Koda never took. It starts its clock at
    // hydrate instead — and a stored stamp restores verbatim, so a thread's age survives the restart.
    const quietSince = Date.now() - 9 * DAY
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: null,
      sessions: [
        { id: 'legacy', label: 'Older chat', cwd: '/tmp/project', items: [] },
        { id: 'stamped', label: 'Quiet chat', cwd: '/tmp/project', items: [], lastActivityAt: quietSince },
      ],
    })

    const { legacy, stamped } = useWorkspace.getState().sessions
    expect(legacy.lastActivityAt).toBeGreaterThan(Date.now() - 5_000)
    expect(stamped.lastActivityAt).toBe(quietSince)

    // A phone-started session adopted into this window is live right now, so adoption stamps it.
    installBridge({
      adoptHeadlessSessions: async () => [
        {
          id: 'phone',
          label: 'Started on the couch',
          cwd: '/tmp/project',
          approvalMode: 'ask',
          engineId: 'claude',
          events: [],
        },
      ],
    })
    await useWorkspace.getState().adoptHeadless()
    expect(useWorkspace.getState().sessions.phone.lastActivityAt).toBeGreaterThan(Date.now() - 5_000)
  })

  it('drops the generated overview when the user names the thread themselves', () => {
    const named = { ...session('a'), overview: 'Koda decided this thread was about the cart.' }
    useWorkspace.setState({ sessions: { a: named }, order: ['a'], activeId: 'a' })

    useWorkspace.getState().renameSession('a', 'My invoices')

    expect(useWorkspace.getState().sessions.a).toMatchObject({
      label: 'My invoices',
      userNamed: true,
      overview: undefined,
    })
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

describe('a new document records the conversation it came out of', () => {
  /** Every `fs:createFile` argument the fake bridge saw. */
  let created: { name?: string; parent?: string; source?: string }[]

  beforeEach(() => {
    created = []
    installBridge({
      createFile: async (args: { name?: string; parent?: string; source?: string }) => {
        created.push(args)
        return { path: '/tmp/project/Documents/Untitled.md' }
      },
    })
    useWorkspace.setState({ sessions: {}, order: [], activeId: null, editors: {} })
  })

  it('sends the active session as the new file’s provenance', async () => {
    useWorkspace.setState({ sessions: { a: session('a') }, order: ['a'], activeId: 'a' })

    await useWorkspace.getState().newDocument()

    expect(created).toEqual([{ source: 'a' }])
  })

  it('carries the destination folder alongside it', async () => {
    useWorkspace.setState({ sessions: { a: session('a') }, order: ['a'], activeId: 'a' })

    await useWorkspace.getState().newDocument('/tmp/project/Documents/plans')

    expect(created).toEqual([{ parent: '/tmp/project/Documents/plans', source: 'a' }])
  })

  it('sends no provenance at all when no chat is open', async () => {
    // An absent source is honest; a guessed one is a claim about where a document came from that
    // nothing backs, and it outlives every session on disk.
    await useWorkspace.getState().newDocument()

    expect(created).toEqual([{}])
  })
})

describe('starred documents — one durable project shelf', () => {
  /**
   * A stand-in for main's shelf command (doc-commands.ts): it applies the same rules — append on star,
   * drop on unstar, every touched path settled — so these tests exercise the store as the PROJECTION
   * it now is, against an owner that answers, instead of asserting a second copy of the truth.
   */
  function installShelfCommands(
    initial: DocShelf = { version: 1, starred: [], settled: [] },
    opts: { fail?: boolean } = {},
  ): { calls: Array<{ path: string; starred: boolean }>; state: DocShelf } {
    const calls: Array<{ path: string; starred: boolean }> = []
    const state: DocShelf = { ...initial, starred: [...initial.starred], settled: [...initial.settled] }
    const settle = (paths: string[]): void => {
      for (const path of paths) if (!state.settled.includes(path)) state.settled.push(path)
    }
    installBridge({
      setDocStar: async ({ path, starred }: { path: string; starred: boolean }) => {
        calls.push({ path, starred })
        await delay()
        if (opts.fail) throw new Error('refused')
        if (starred) {
          if (!state.starred.includes(path)) state.starred.push(path)
        } else {
          state.starred = state.starred.filter((entry) => entry !== path)
        }
        settle([path])
        return { ...state, starred: [...state.starred], settled: [...state.settled] }
      },
      adoptLegacyDocStars: async ({ starred, settled }: { starred: string[]; settled: string[] }) => {
        await delay()
        if (opts.fail) throw new Error('refused')
        for (const path of starred) {
          if (!state.settled.includes(path) && !state.starred.includes(path)) state.starred.push(path)
        }
        settle([...settled, ...starred])
        return { ...state, starred: [...state.starred], settled: [...state.settled] }
      },
    })
    return { calls, state }
  }

  /** The store reaches for `localStorage` by bare global, like the rest of its per-project UI keys. */
  function installStorage(seed: Record<string, string> = {}): Record<string, string> {
    const store: Record<string, string> = { ...seed }
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    }
    return store
  }

  beforeEach(() => {
    installBridge()
    installStorage()
    useWorkspace.setState({
      sessions: { a: session('a'), b: session('b') },
      order: ['a', 'b'],
      activeId: 'a',
      projectPath: '/tmp/project',
      editors: {},
      openDirs: [],
      starredDocs: [],
      legacyKeptDocsImported: [],
      legacyKeptDocPathChanges: [],
      legacyKeptDocsMigrationComplete: false,
      docShelfAdopted: false,
    })
  })

  it('stars without a chat, deduplicates paths, and appends a re-starred document at the end', () => {
    useWorkspace.setState({ sessions: {}, order: [], activeId: null })

    useWorkspace.getState().starDoc('Documents/brief.md')
    useWorkspace.getState().starDoc('Documents/brief.md')
    useWorkspace.getState().starDoc('Documents/plans/launch.md')
    expect(useWorkspace.getState().starredDocs).toEqual([
      'Documents/brief.md',
      'Documents/plans/launch.md',
    ])

    useWorkspace.getState().unstarDoc('Documents/brief.md')
    useWorkspace.getState().starDoc('Documents/brief.md')
    expect(useWorkspace.getState().starredDocs).toEqual([
      'Documents/plans/launch.md',
      'Documents/brief.md',
    ])
    expect(useWorkspace.getState().legacyKeptDocsImported).toEqual([
      'Documents/brief.md',
      'Documents/plans/launch.md',
    ])
  })

  it('does not change the shelf when chats switch or all chats close', () => {
    useWorkspace.getState().starDoc('Documents/brief.md')

    useWorkspace.getState().selectSession('b')
    useWorkspace.setState({ sessions: {}, order: [], activeId: null })

    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/brief.md'])
  })

  it('runs star and unstar as main-owned commands and takes the answer as truth', async () => {
    const shelf = installShelfCommands()

    useWorkspace.getState().starDoc('Documents/brief.md')
    // Optimistic first: the star has to land under the click, before any round trip.
    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/brief.md'])
    await delay()
    expect(shelf.calls).toEqual([{ path: 'Documents/brief.md', starred: true }])

    useWorkspace.getState().unstarDoc('Documents/brief.md')
    await delay()
    expect(shelf.calls[1]).toEqual({ path: 'Documents/brief.md', starred: false })
    expect(shelf.state.starred).toEqual([])
    expect(useWorkspace.getState().starredDocs).toEqual([])
  })

  it('projects the shelf main sends back rather than its own optimistic guess', async () => {
    // Main answers with the durable order — here a star that was already on the shelf from another
    // window. A renderer that kept its own list would show one document; the shelf holds two.
    installShelfCommands({ version: 1, starred: ['Documents/older.md'], settled: [] })

    useWorkspace.getState().starDoc('Documents/brief.md')
    await delay()

    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/older.md', 'Documents/brief.md'])
  })

  it('puts the list back when the command refuses', async () => {
    installShelfCommands(undefined, { fail: true })
    useWorkspace.getState().starDoc('Documents/brief.md')

    await delay()

    // A star nothing durable agrees with is the failure worth avoiding: the row disappears again.
    expect(useWorkspace.getState().starredDocs).toEqual([])
  })

  it('keeps working against a preload that predates the shelf command', async () => {
    installBridge() // no shelf commands at all — dev HMR pairs new renderer code with an old preload
    useWorkspace.getState().starDoc('Documents/brief.md')

    await delay()

    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/brief.md'])
    expect(useWorkspace.getState().persistBlob().starredDocs).toEqual(['Documents/brief.md'])
  })

  it('adopts a pushed shelf — an agent star, or main repairing a rename', () => {
    useWorkspace.getState().applyDocShelf({
      version: 1,
      starred: ['Documents/shipping/launch.md'],
      settled: ['Documents/plans/launch.md', 'Documents/shipping/launch.md'],
    })

    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/shipping/launch.md'])
    // The shelf's ledger joins this store's, so a legacy archive read later cannot re-add either path.
    expect(useWorkspace.getState().legacyKeptDocsImported).toEqual([
      'Documents/plans/launch.md',
      'Documents/shipping/launch.md',
    ])
  })

  it('leaves the shelf to main on a rename or delete, and still repairs the not-yet-adopted sources', () => {
    // Legacy pins are still the only durable copy until adoption is acknowledged, so a rename that
    // happens first has to reach them. The shelf itself is repaired by main, inside the same rename.
    const storage = installStorage({
      'koda:doc-pins:/tmp/project': JSON.stringify([
        'Documents/plans/launch.md',
        'Documents/other.md',
      ]),
    })

    useWorkspace.getState().notePathMoved('/tmp/project/Documents/plans', '/tmp/project/Documents/shipping')
    expect(JSON.parse(storage['koda:doc-pins:/tmp/project'])).toEqual([
      'Documents/shipping/launch.md',
      'Documents/other.md',
    ])

    useWorkspace.getState().notePathDeleted('/tmp/project/Documents/shipping/launch.md')
    expect(JSON.parse(storage['koda:doc-pins:/tmp/project'])).toEqual(['Documents/other.md'])
    expect(useWorkspace.getState().legacyKeptDocPathChanges).toEqual([
      { from: 'Documents/plans', to: 'Documents/shipping' },
      { from: 'Documents/shipping/launch.md', to: null },
    ])
    // A doc's smart artifact card keeps the portable link text, so the same rename/delete is recorded
    // as absolute repairs the card resolves through when the user opens it.
    expect(useWorkspace.getState().docRefRepairs).toEqual({
      '/tmp/project/Documents/plans': '/tmp/project/Documents/shipping',
      '/tmp/project/Documents/shipping/launch.md': null,
    })
  })

  it('replays moves and deletion tombstones over a legacy archive that becomes readable later', () => {
    useWorkspace.setState({ sessions: {}, order: [], activeId: null })
    useWorkspace.getState().notePathMoved('/tmp/project/Documents/plans', '/tmp/project/Documents/shipping')
    useWorkspace.getState().notePathDeleted('/tmp/project/Documents/gone.md')
    const afterPathChanges = useWorkspace.getState().persistBlob()

    useWorkspace.getState().hydrate({
      ...afterPathChanges,
      archived: [
        {
          ...archivedMeta('late'),
          keptDocs: [
            'Documents/plans/launch.md',
            'Documents/gone.md',
            'Documents/still-here.md',
          ],
        },
      ],
    })

    expect(useWorkspace.getState().starredDocs).toEqual([
      'Documents/shipping/launch.md',
      'Documents/still-here.md',
    ])
    expect(useWorkspace.getState().legacyKeptDocsImported).toEqual([
      'Documents/plans/launch.md',
      'Documents/gone.md',
      'Documents/still-here.md',
    ])
  })

  it('imports session shelves once in active, live, then archived order', () => {
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'b',
      starredDocs: ['Documents/existing.md'],
      legacyKeptDocsImported: [],
      sessions: [
        {
          id: 'a',
          label: 'a',
          cwd: '/tmp/project',
          items: [],
          keptDocs: ['Documents/a.md', 'Documents/shared.md'],
        },
        {
          id: 'b',
          label: 'b',
          cwd: '/tmp/project',
          items: [],
          keptDocs: ['Documents/b.md', 'Documents/shared.md'],
        },
      ],
      archived: [
        {
          ...archivedMeta('newer'),
          keptDocs: ['Documents/newer.md', 'Documents/shared.md'],
        },
        {
          ...archivedMeta('older'),
          keptDocs: ['Documents/older.md'],
        },
      ],
    })

    expect(useWorkspace.getState().starredDocs).toEqual([
      'Documents/existing.md',
      'Documents/b.md',
      'Documents/shared.md',
      'Documents/a.md',
      'Documents/newer.md',
      'Documents/older.md',
    ])
    expect(useWorkspace.getState().legacyKeptDocsImported).toEqual([
      'Documents/b.md',
      'Documents/shared.md',
      'Documents/a.md',
      'Documents/newer.md',
      'Documents/older.md',
    ])
  })

  it('does not resurrect an unstarred legacy path when another archive appears later', () => {
    useWorkspace.getState().hydrate({
      version: 3,
      activeId: 'a',
      sessions: [
        {
          id: 'a',
          label: 'a',
          cwd: '/tmp/project',
          items: [],
          keptDocs: ['Documents/brief.md'],
        },
      ],
    })
    useWorkspace.getState().unstarDoc('Documents/brief.md')
    const acknowledged = useWorkspace.getState().persistBlob()

    useWorkspace.getState().hydrate({
      ...acknowledged,
      archived: [
        {
          ...archivedMeta('late'),
          keptDocs: ['Documents/brief.md', 'Documents/new.md'],
        },
      ],
    })

    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/new.md'])
    expect(useWorkspace.getState().legacyKeptDocsImported).toEqual([
      'Documents/brief.md',
      'Documents/new.md',
    ])
  })

  it('survives a restart with no sessions', () => {
    useWorkspace.setState({ sessions: {}, order: [], activeId: null })
    useWorkspace.getState().starDoc('Documents/brief.md')
    useWorkspace.getState().starDoc('Documents/plans/launch.md')

    const blob = useWorkspace.getState().persistBlob()
    useWorkspace.setState({ starredDocs: [], legacyKeptDocsImported: [] })
    useWorkspace.getState().hydrate(blob)

    expect(useWorkspace.getState().activeId).toBeNull()
    expect(useWorkspace.getState().starredDocs).toEqual([
      'Documents/brief.md',
      'Documents/plans/launch.md',
    ])
  })

  it('hands every legacy source to main and drops them only once the shelf holds them', async () => {
    const storage = installStorage({
      'koda:doc-pins:/tmp/project': JSON.stringify(['Documents/brief.md', 'Documents/brief.md', 'Documents/old.md']),
      'koda:doc-folders-open:/tmp/project': JSON.stringify(['plans']),
    })
    const shelf = installShelfCommands()
    useWorkspace.setState({
      sessions: {},
      order: [],
      activeId: null,
      starredDocs: ['Documents/from-blob.md'],
    })

    useWorkspace.getState().adoptLegacyDocStars()
    await delay()

    // Both legacy sources — the blob's own list and the retired pane's pins — reach the shelf once.
    expect(shelf.state.starred).toEqual([
      'Documents/from-blob.md',
      'Documents/brief.md',
      'Documents/old.md',
    ])
    expect(useWorkspace.getState().starredDocs).toEqual(shelf.state.starred)
    expect(storage['koda:doc-pins:/tmp/project']).toBeUndefined()
    expect(storage['koda:doc-folders-open:/tmp/project']).toBeUndefined()
    // The blob stops carrying its copy: two lists that can disagree is what the shelf replaces.
    expect(useWorkspace.getState().persistBlob().starredDocs).toEqual([])

    // A second launch has nothing to re-add, and the shelf's ledger refuses a repeat anyway.
    useWorkspace.getState().adoptLegacyDocStars()
    await delay()
    expect(shelf.state.starred).toHaveLength(3)
  })

  it('keeps every legacy copy when the shelf command refuses', async () => {
    const storage = installStorage({
      'koda:doc-pins:/tmp/project': JSON.stringify(['Documents/brief.md', 'Documents/old.md']),
    })
    installShelfCommands(undefined, { fail: true })
    useWorkspace.setState({ starredDocs: ['Documents/from-blob.md'] })

    useWorkspace.getState().adoptLegacyDocStars()
    await delay()

    expect(storage['koda:doc-pins:/tmp/project']).toBeDefined()
    expect(useWorkspace.getState().persistBlob().starredDocs).toEqual(['Documents/from-blob.md'])
  })

  it('does not resurrect a legacy pin the user removes before adoption is acknowledged', async () => {
    installStorage({
      'koda:doc-pins:/tmp/project': JSON.stringify(['Documents/brief.md', 'Documents/old.md']),
    })
    const shelf = installShelfCommands()

    useWorkspace.getState().adoptLegacyDocStars()
    await delay()
    // Both are on the shelf; the user then takes one back off before the next launch.
    useWorkspace.getState().unstarDoc('Documents/brief.md')
    await delay()

    useWorkspace.getState().adoptLegacyDocStars()
    await delay()

    expect(shelf.state.starred).toEqual(['Documents/old.md'])
    expect(useWorkspace.getState().starredDocs).toEqual(['Documents/old.md'])
  })

  it('does not resurrect an unstarred legacy pin after a transient localStorage write failure', async () => {
    const storage = installStorage({
      'koda:doc-pins:/tmp/project': JSON.stringify(['Documents/brief.md']),
    })
    const shelf = installShelfCommands()

    let rejectWrites = true
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        if (rejectWrites) throw new Error('storage temporarily unavailable')
        storage[key] = value
      },
      removeItem: (key: string) => {
        if (rejectWrites) throw new Error('storage temporarily unavailable')
        delete storage[key]
      },
    }

    useWorkspace.getState().adoptLegacyDocStars()
    await delay()
    useWorkspace.getState().unstarDoc('Documents/brief.md')
    await delay()
    // The pin could not be rewritten, so the stale key still names a document nobody wants starred.
    expect(storage['koda:doc-pins:/tmp/project']).toBeDefined()

    rejectWrites = false
    useWorkspace.getState().adoptLegacyDocStars()
    await delay()

    expect(shelf.state.starred).toEqual([])
    expect(useWorkspace.getState().starredDocs).toEqual([])
  })
})

// The regeneration crossings (2, 5, then every 10 user messages) are a LEVEL — `shouldRegenerateName`
// answers "is the count at a crossing", not "did it just reach one". Plenty of turns finish without
// adding a user message: a doc edit pushes a `canvas` item, the fresh-chat handoff pushes a `notice`,
// an image-only turn's text is dropped by `userMessages`. Each of those re-fired naming for as long as
// the thread sat on a crossing, and each re-fire was another chance for the title to come back worded
// differently — which is what "the namer keeps firing and the name keeps changing" looked like.
describe('regeneration crossings fire on the edge, not the level', () => {
  function threadAt(count: number): SessionState {
    const s = session('a')
    s.items = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      kind: 'user' as const,
      text: `message ${i + 1}`,
    }))
    return s
  }

  const complete = (): void =>
    useWorkspace
      .getState()
      .applyEngineEvent({ type: 'TurnComplete', sessionId: 'a', stopReason: 'success' })

  it('names once per crossing, however many turns finish at that count', async () => {
    const nameSession = vi.fn(async () => ({ title: 'Photo Importer Speed', overview: '' }))
    installBridge({ nameSession })
    useWorkspace.setState({ sessions: { a: threadAt(5) }, order: ['a'], activeId: null })

    complete() // the fifth user message's own turn — the crossing
    await delay()
    expect(nameSession).toHaveBeenCalledTimes(1)
    expect(useWorkspace.getState().sessions.a.namedAtTurns).toBe(5)

    complete() // a doc edit finishing at the same count
    complete() // …and the handoff prompt
    await delay()
    expect(nameSession).toHaveBeenCalledTimes(1)
  })

  it('names again once the thread actually reaches the next crossing', async () => {
    const nameSession = vi.fn(async () => ({ title: 'Photo Importer Speed', overview: '' }))
    installBridge({ nameSession })
    const a = threadAt(5)
    a.namedAtTurns = 5
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })

    complete()
    await delay()
    expect(nameSession).not.toHaveBeenCalled()

    useWorkspace.setState({ sessions: { a: { ...threadAt(10), namedAtTurns: 5 } } })
    complete()
    await delay()
    expect(nameSession).toHaveBeenCalledTimes(1)
    expect(useWorkspace.getState().sessions.a.namedAtTurns).toBe(10)
  })

  // A spent crossing has to survive a restart, or the first doc edit after reopening re-names a thread
  // that has been sitting on 10 for a week.
  it('carries the spent crossing through persistence', () => {
    const a = threadAt(10)
    a.namedAtTurns = 10
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    expect(useWorkspace.getState().persistBlob().sessions[0].namedAtTurns).toBe(10)
  })
})

// Queued-send: the chip is driven ONLY by main's QueuedTurn events (never assumed locally), and a
// returned message must never overwrite or drop what the user has typed since queuing.
describe('queued-send', () => {
  it('sets the chip from main’s QueuedTurnUpdated event', () => {
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().applyEngineEvent({
      type: 'QueuedTurnUpdated',
      sessionId: 'a',
      text: 'also add tests',
      attachmentCount: 2,
      revision: 1,
    })
    expect(useWorkspace.getState().sessions.a.queuedTurn).toEqual({ text: 'also add tests', attachmentCount: 2 })
  })

  it('clears the chip on a delivered clear and leaves the composer alone', () => {
    const a = { ...session('a'), draft: 'a fresh thought', queuedTurn: { text: 'earlier', attachmentCount: 0 } }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().applyEngineEvent({ type: 'QueuedTurnCleared', sessionId: 'a', reason: 'delivered', revision: 2 })
    const s = useWorkspace.getState().sessions.a
    expect(s.queuedTurn).toBeUndefined()
    expect(s.draft).toBe('a fresh thought')
  })

  it('returns this head’s own segment text into an empty composer', () => {
    const a = { ...session('a'), queuedTurn: { text: 'q', attachmentCount: 0 } }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().applyEngineEvent({
      type: 'QueuedTurnCleared',
      sessionId: 'a',
      reason: 'returned',
      revision: 2,
      segments: [{ text: 'run the linter', origin: 'desktop' }],
    })
    const s = useWorkspace.getState().sessions.a
    expect(s.queuedTurn).toBeUndefined()
    expect(s.draft).toBe('run the linter')
    expect(s.error).toBeUndefined()
  })

  it('restores ONLY desktop-origin segments, never the phone’s (finding 8)', () => {
    const a = { ...session('a'), draft: '' }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().applyEngineEvent({
      type: 'QueuedTurnCleared',
      sessionId: 'a',
      reason: 'returned',
      revision: 2,
      segments: [
        { text: 'from the phone', origin: 'phone' },
        { text: 'from the mac', origin: 'desktop' },
      ],
    })
    // Only the desktop segment comes home to this composer; the phone's stays for the phone.
    expect(useWorkspace.getState().sessions.a.draft).toBe('from the mac')
  })

  it('folds a returned message ahead of what the user has since typed, dropping nothing', () => {
    const a = { ...session('a'), draft: 'newer text' }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().applyEngineEvent({
      type: 'QueuedTurnCleared',
      sessionId: 'a',
      reason: 'returned',
      revision: 2,
      segments: [{ text: 'older queued text', attachments: [{ mediaType: 'image/png', dataBase64: 'AAA' }], origin: 'desktop' }],
    })
    const s = useWorkspace.getState().sessions.a
    expect(s.draft).toBe('older queued text\nnewer text')
    expect(s.attachments).toEqual([{ mediaType: 'image/png', dataBase64: 'AAA' }])
  })

  it('raises the retryable banner only when the return came from a failed dispatch', () => {
    // Not the active session, so raiseAttention marks it without reaching document.hasFocus() (node lane).
    const a = { ...session('a'), queuedTurn: { text: 'q', attachmentCount: 0 } }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: null })
    useWorkspace.getState().applyEngineEvent({
      type: 'QueuedTurnCleared',
      sessionId: 'a',
      reason: 'returned',
      revision: 2,
      failed: true,
      message: 'The engine did not accept this turn. Try again.',
      segments: [{ text: 'ship it', origin: 'desktop' }],
    })
    const s = useWorkspace.getState().sessions.a
    expect(s.draft).toBe('ship it')
    expect(s.error).toEqual({ message: 'The engine did not accept this turn. Try again.', fatal: false })
    expect(s.attention).toBe(true)
  })

  it('queueSend hands the engine text + raw displayText to main and clears the composer', async () => {
    const queueTurn = vi.fn(async () => {})
    installBridge({ queueTurn })
    // A plain draft (no @mention, no active file) has engine text === display text.
    const a = { ...session('a'), busy: true, draft: 'queue me' }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    await useWorkspace.getState().queueSend()
    expect(queueTurn).toHaveBeenCalledWith({ sessionId: 'a', text: 'queue me', displayText: 'queue me' })
    expect(useWorkspace.getState().sessions.a.draft).toBe('')
  })

  it('queueSend passes all attachments through and clears them from the composer', async () => {
    const queueTurn = vi.fn(async (_args: { text: string; displayText: string; images?: unknown[] }) => {})
    // Scratch save succeeds so the image note is baked into the engine text (a live-send parity check).
    const saveScratchImage = vi.fn(async () => ({ path: '/scratch/x.png' }))
    installBridge({ queueTurn, saveScratchImage })
    const a = {
      ...session('a'),
      busy: true,
      draft: 'look at this',
      attachments: [{ mediaType: 'image/png', dataBase64: 'IMG' }],
    }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    await useWorkspace.getState().queueSend()
    const arg = queueTurn.mock.calls[0][0]
    expect(arg.displayText).toBe('look at this') // the raw words, no scratch note
    expect(arg.text).toContain('/scratch/x.png') // engine text carries the image path note
    expect(arg.images).toEqual([{ mediaType: 'image/png', dataBase64: 'IMG' }])
    const s = useWorkspace.getState().sessions.a
    expect(s.draft).toBe('')
    expect(s.attachments).toEqual([])
  })

  it('queueSend restores the draft when main refuses the queue', async () => {
    const queueTurn = vi.fn(async () => {
      throw new Error("Error invoking remote method 'engine:queueTurn': Error: nope")
    })
    installBridge({ queueTurn })
    const a = { ...session('a'), busy: true, draft: 'queue me' }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    await useWorkspace.getState().queueSend()
    const s = useWorkspace.getState().sessions.a
    expect(s.draft).toBe('queue me')
    expect(s.error).toEqual({ message: 'nope', fatal: false })
  })

  it('queueSend degrades to a no-op when the preload lacks the API (stale HMR)', async () => {
    installBridge() // no queueTurn on window.koda
    const a = { ...session('a'), busy: true, draft: 'queue me' }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    await useWorkspace.getState().queueSend()
    // The message stays in the composer rather than being silently lost.
    expect(useWorkspace.getState().sessions.a.draft).toBe('queue me')
  })

  it('cancelQueued asks main to cancel the active session’s slot', () => {
    const cancelQueuedTurn = vi.fn(async () => {})
    installBridge({ cancelQueuedTurn })
    const a = { ...session('a'), queuedTurn: { text: 'q', attachmentCount: 0 } }
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().cancelQueued()
    expect(cancelQueuedTurn).toHaveBeenCalledWith({ sessionId: 'a' })
  })

  it('applyQueuedTurns rebuilds chips from main’s reload catch-up snapshot', () => {
    const a = session('a')
    useWorkspace.setState({ sessions: { a }, order: ['a'], activeId: 'a' })
    useWorkspace.getState().applyQueuedTurns([{ sessionId: 'a', text: 'held message', attachmentCount: 2 }])
    expect(useWorkspace.getState().sessions.a.queuedTurn).toEqual({ text: 'held message', attachmentCount: 2 })
  })
})
