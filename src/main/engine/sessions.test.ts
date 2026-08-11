import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { loadRemoteReplay, purgeRemoteReplayProject } from '../remote-replay-store'
import { purgeProjectSessions, saveProjectSessions } from '../session-store'
import { addSessionToWindow, registerWindow, unregisterWindow } from '../window-registry'
import { EngineSessionManager } from './sessions'

describe('hidden read-only Dream session', () => {
  it('marks REM read-only without exposing it for live adoption', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      start: (args: unknown) => Promise<{ sessionId: string }>
      gate: { setReadOnly: (id: string, on: boolean) => void }
      remoteAttached: Set<string>
      hiddenDreamSessions: Set<string>
      startDreamSession: (
        cwd: string,
        label: string,
        options: { visible?: boolean; readOnly?: boolean },
      ) => Promise<{ sessionId: string }>
    }
    mgr.start = vi.fn().mockResolvedValue({ sessionId: 'rem-hidden' })
    const readOnly = vi.spyOn(mgr.gate, 'setReadOnly')

    await mgr.startDreamSession('/tmp/koda-rem-hidden', 'Dream REM', {
      visible: false,
      readOnly: true,
    })

    expect(readOnly).toHaveBeenCalledWith('rem-hidden', true)
    expect(mgr.remoteAttached.has('rem-hidden')).toBe(false)
    expect(mgr.hiddenDreamSessions.has('rem-hidden')).toBe(true)
  })
})

/**
 * recoverBroker respawns a session in place (dispose + --resume) to reconnect a dropped broker
 * connection. adapter.ts only spawns `--permission-mode plan` when `planMode` is passed, so a
 * session parked in Plan posture that broker-recovers without it comes back able to write — with
 * its approval-mode entry wiped too (the gate.cancelSession/forgetSession conflation this debt
 * pass fixes). This pins that the respawn is asked for with the session's REAL posture.
 *
 * EngineSessionManager is Electron-coupled and normally spawns the real engine binary — too heavy
 * to exercise end to end here. `start()` is mocked out and the private maps are seeded directly via
 * `as any`, isolating the one thing under test: what recoverBroker reads and passes.
 */
describe('recoverBroker: plan posture survives the respawn', () => {
  it('reads the gate\'s real mode and asks the respawn for planMode: true', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      gate: { setSessionMode: (id: string, mode: string) => void }
      start: (...args: unknown[]) => Promise<{ sessionId: string; cwd: string }>
      recoverBroker: (sessionId: string) => Promise<void>
    }
    const sessionId = 'sess-plan'
    mgr.sessions.set(sessionId, {}) // recoverBroker only checks `.has`; the fake child is never touched
    mgr.projectDirs.set(sessionId, '/tmp/koda-test-project')
    mgr.gate.setSessionMode(sessionId, 'plan')

    const startSpy = vi.fn().mockResolvedValue({ sessionId, cwd: '/tmp/koda-test-project' })
    mgr.start = startSpy

    await mgr.recoverBroker(sessionId)

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: sessionId, planMode: true, abandonActiveSubagents: true }),
    )
  })

  it('does not force plan mode when the session is not in Plan posture', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      gate: { setSessionMode: (id: string, mode: string) => void }
      start: (...args: unknown[]) => Promise<{ sessionId: string; cwd: string }>
      recoverBroker: (sessionId: string) => Promise<void>
    }
    const sessionId = 'sess-auto'
    mgr.sessions.set(sessionId, {})
    mgr.projectDirs.set(sessionId, '/tmp/koda-test-project')
    mgr.gate.setSessionMode(sessionId, 'auto')

    const startSpy = vi.fn().mockResolvedValue({ sessionId, cwd: '/tmp/koda-test-project' })
    mgr.start = startSpy

    await mgr.recoverBroker(sessionId)

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: false, abandonActiveSubagents: true }),
    )
  })
})

/**
 * W4: `adoptHeadlessForWindow` reads the gate's real posture (so the tab pill shows what's actually
 * enforced) but historically never PINNED it — a dream/phone session with no explicit `modes` entry
 * rode the fallback default, so a LATER Settings default-mode change silently re-postured its
 * enforcement while the already-shown pill kept reading the old value (display-more-restrictive-than-
 * enforced — the dangerous direction). Fixed by pinning via the same same-value `setSessionApprovalMode`
 * push `startSession`/reattach already use.
 */
describe('adoptHeadlessForWindow pins the gate posture (W4)', () => {
  it('creates an explicit per-session entry immune to a later default-mode change', () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      remoteAttached: Set<string>
      gate: { setDefaultMode: (mode: string) => void; getSessionMode: (id: string) => string }
      adoptHeadlessForWindow: (windowId: number, projectPath: string) => Array<{ id: string; approvalMode: string }>
    }
    const sessionId = 'sess-dream'
    mgr.sessions.set(sessionId, {})
    mgr.projectDirs.set(sessionId, '/tmp/koda-test-project')
    mgr.remoteAttached.add(sessionId)
    // The posture in effect when this session started (a dream, or a phone kickoff) — never explicitly
    // set on the session itself.
    mgr.gate.setDefaultMode('ask')

    const adopted = mgr.adoptHeadlessForWindow(1, '/tmp/koda-test-project')
    expect(adopted).toHaveLength(1)
    expect(adopted[0].approvalMode).toBe('ask')

    // The user relaxes the default afterward — an un-pinned session would silently follow it into a
    // more permissive enforcement while its already-shown tab pill keeps reading the old posture.
    mgr.gate.setDefaultMode('auto')
    expect(mgr.gate.getSessionMode(sessionId)).toBe('ask') // pinned — did not drift with the default
  })

  it('returns a live local session to the same BrowserWindow after its renderer reloads', () => {
    const projectPath = '/tmp/koda-renderer-reload-project'
    const windowId = 817_204
    const win = {
      id: windowId,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    registerWindow(win as never, projectPath)
    addSessionToWindow(windowId, 'local-live')
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      working: Set<string>
      activeSubagents: Map<string, Map<string, Record<string, unknown>>>
      adoptHeadlessForWindow: (
        requestedWindowId: number,
        requestedProjectPath: string,
      ) => Array<{
        id: string
        working?: boolean
        activeSubagentToolUseIds?: string[]
      }>
    }
    try {
      mgr.sessions.set('local-live', {})
      mgr.projectDirs.set('local-live', projectPath)
      mgr.working.add('local-live')
      mgr.activeSubagents.set(
        'local-live',
        new Map([
          [
            'agent-1',
            {
              type: 'SubagentStarted',
              sessionId: 'local-live',
              toolUseId: 'agent-1',
              taskId: 'task-1',
              subagentType: 'koda:scout',
              description: 'Inspect',
            },
          ],
        ]),
      )

      expect(mgr.adoptHeadlessForWindow(windowId, projectPath)).toEqual([
        expect.objectContaining({
          id: 'local-live',
          working: true,
          activeSubagentToolUseIds: ['agent-1'],
        }),
      ])
    } finally {
      unregisterWindow(windowId)
    }
  })
})

describe('remote replay identity after an archive restore', () => {
  it('seeds the next sequence from the restored persisted cursor when the sidecar is gone', () => {
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      remoteReplaySeq: Map<string, number>
      projectStore: (cwd: string) => { sessions: Array<{ id: string; replaySeq?: number }> }
      attachRemote: (sessionId: string) => void
    }
    mgr.projectDirs.set('restored', '/tmp/koda-restored-project')
    mgr.projectStore = vi.fn(() => ({ sessions: [{ id: 'restored', replaySeq: 12 }] }))

    mgr.attachRemote('restored')

    expect(mgr.remoteReplaySeq.get('restored')).toBe(12)
  })

  it('passes the persisted cursor into a sticky phone resume before the engine can emit', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      remoteAttached: Set<string>
      remoteHistory: () => Array<{ id: string; projectPath: string }>
      projectStore: (cwd: string) => {
        sessions: Array<{ id: string; replaySeq?: number; items: unknown[] }>
      }
      start: (opts: Record<string, unknown>) => Promise<{ sessionId: string; cwd: string }>
      attachRemote: (sessionId: string) => void
      resumeRemote: (sessionId: string, projectPath: string) => Promise<{ sessionId: string }>
    }
    mgr.remoteAttached.add('restored')
    mgr.remoteHistory = vi.fn(() => [{ id: 'restored', projectPath: '/tmp/koda-restored-project' }])
    mgr.projectStore = vi.fn(() => ({
      sessions: [{ id: 'restored', replaySeq: 50, items: [{}] }],
    }))
    mgr.start = vi.fn(async () => ({ sessionId: 'restored', cwd: '/tmp/koda-restored-project' }))
    mgr.attachRemote = vi.fn()

    await mgr.resumeRemote('restored', '/tmp/koda-restored-project')

    expect(mgr.start).toHaveBeenCalledWith(expect.objectContaining({ replaySeq: 50 }))
  })

  it('durably backfills a child that was already running when the phone attached', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'koda-late-attach-'))
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      remoteEventLog: Map<string, Array<{ type: string; toolUseId?: string }>>
      projectStore: (cwd: string) => { sessions: unknown[] }
      trackSubagentLifecycle: (event: {
        type: 'SubagentStarted'
        sessionId: string
        toolUseId: string
        taskId: string
        subagentType: string
        description: string
        prompt: string
      }) => void
      attachRemote: (sessionId: string) => void
    }
    try {
      mgr.projectDirs.set('live', projectPath)
      mgr.projectStore = vi.fn(() => ({ sessions: [] }))
      mgr.trackSubagentLifecycle({
        type: 'SubagentStarted',
        sessionId: 'live',
        toolUseId: 'agent-1',
        taskId: 'task-1',
        subagentType: 'scout',
        description: 'Inspect the code',
        prompt: 'Read the requested files.',
      })

      mgr.attachRemote('live')

      expect(mgr.remoteEventLog.get('live')).toContainEqual(
        expect.objectContaining({ type: 'SubagentStarted', toolUseId: 'agent-1', taskId: 'task-1' }),
      )
      expect(loadRemoteReplay(projectPath, 'live', 'live')).toContainEqual(
        expect.objectContaining({ type: 'SubagentStarted', toolUseId: 'agent-1', taskId: 'task-1' }),
      )
    } finally {
      purgeRemoteReplayProject(projectPath)
      rmSync(projectPath, { recursive: true, force: true })
    }
  })

  it('persists a local child result and folds it into the transcript after an app restart', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'koda-local-delegation-'))
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      remoteEventLog: Map<string, unknown[]>
      bufferRemoteEvent: (event: Record<string, unknown>) => Record<string, unknown>
      loadSessionsForProject: (path: string) => {
        sessions: Array<{ id: string; replaySeq?: number; items: Array<Record<string, unknown>> }>
      } | null
    }
    try {
      mgr.projectDirs.set('local', projectPath)
      const started = mgr.bufferRemoteEvent({
        type: 'SubagentStarted',
        sessionId: 'local',
        toolUseId: 'agent-1',
        taskId: 'task-1',
        subagentType: 'koda:worker',
        description: 'Make the focused change',
      })
      expect(started.replaySeq).toBe(1)
      saveProjectSessions(projectPath, {
        version: 2,
        activeId: 'local',
        sessions: [
          {
            id: 'local',
            label: 'Local session',
            cwd: projectPath,
            replaySeq: 1,
            items: [
              {
                id: 1,
                kind: 'subagent',
                toolUseId: 'agent-1',
                taskId: 'task-1',
                subagentType: 'koda:worker',
                description: 'Make the focused change',
                status: 'running',
                children: [],
                replaySeq: 1,
              },
            ],
          },
        ],
      })
      mgr.bufferRemoteEvent({
        type: 'SubagentCompleted',
        sessionId: 'local',
        toolUseId: 'agent-1',
        taskId: 'task-1',
        outcome: 'completed',
        resultText: 'The candidate is ready.',
      })

      // A new main process has no in-memory log; force the same disk-only path here.
      mgr.remoteEventLog.clear()
      const restored = mgr.loadSessionsForProject(projectPath)?.sessions[0]
      expect(restored?.replaySeq).toBe(2)
      expect(restored?.items[0]).toMatchObject({
        kind: 'subagent',
        toolUseId: 'agent-1',
        status: 'completed',
        resultText: 'The candidate is ready.',
      })
    } finally {
      purgeProjectSessions(projectPath)
      rmSync(projectPath, { recursive: true, force: true })
    }
  })
})

/**
 * cancelSession vs forgetSession is a five-review-round-running seam (gate.ts docstrings) with nothing
 * pinning which end site calls which. This spies on the gate to assert: `handleClose` (an
 * engine-PROCESS exit) calls only `cancelSession`; every true end site calls `forgetSession`, and does
 * so even when `dispose` throws (W5 — none of the five sessions.ts sites awaited dispose then forgot
 * sequentially with no `finally`, so a throwing dispose used to skip it entirely).
 */
describe('the six forgetSession sites: pinned + fail-safe under a throwing dispose (W5)', () => {
  function mgrWithSpies() {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      remoteAttached: Set<string>
      dreamSessions: Set<string>
      working: Set<string>
      gate: { cancelSession: (id: string) => void; forgetSession: (id: string) => void }
      dispose: (id: string) => Promise<void>
      handleClose: (id: string) => void
      disposeForWindow: (id: string) => Promise<void>
      disposeAll: () => Promise<void>
      disposeHeadlessRemote: () => Promise<void>
      reapDreamSessions: () => Promise<void>
      archiveRemote: (id: string, projectPath: string) => Promise<void>
      interrupt: (id: string) => void
      projectStore: (cwd: string) => unknown
    }
    const cancelSpy = vi.spyOn(mgr.gate, 'cancelSession')
    const forgetSpy = vi.spyOn(mgr.gate, 'forgetSession')
    return { mgr, cancelSpy, forgetSpy }
  }

  it('handleClose (an engine-process exit) calls cancelSession, never forgetSession', () => {
    const { mgr, cancelSpy, forgetSpy } = mgrWithSpies()
    mgr.sessions.set('s1', {})
    mgr.handleClose('s1')
    expect(cancelSpy).toHaveBeenCalledWith('s1')
    expect(forgetSpy).not.toHaveBeenCalled()
  })

  it('disposeForWindow forgets the session even when dispose throws', async () => {
    const { mgr, forgetSpy } = mgrWithSpies()
    mgr.dispose = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(mgr.disposeForWindow('s1')).rejects.toThrow('boom')
    expect(forgetSpy).toHaveBeenCalledWith('s1')
  })

  it('disposeAll forgets each session even when its dispose throws', async () => {
    const { mgr, forgetSpy } = mgrWithSpies()
    mgr.projectDirs.set('s1', '/tmp/koda-test-project')
    mgr.dispose = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(mgr.disposeAll()).rejects.toThrow()
    expect(forgetSpy).toHaveBeenCalledWith('s1')
  })

  it('disposeHeadlessRemote forgets an ended session even when dispose throws', async () => {
    const { mgr, forgetSpy } = mgrWithSpies()
    mgr.remoteAttached.add('s1')
    mgr.dispose = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(mgr.disposeHeadlessRemote()).rejects.toThrow('boom')
    expect(forgetSpy).toHaveBeenCalledWith('s1')
  })

  it('reapDreamSessions forgets an idle, un-adopted dream session', async () => {
    const { mgr, forgetSpy } = mgrWithSpies()
    mgr.dreamSessions.add('s1')
    mgr.dispose = vi.fn().mockResolvedValue(undefined)
    await mgr.reapDreamSessions()
    expect(forgetSpy).toHaveBeenCalledWith('s1')
  })

  it('archiveRemote (ending a live session) forgets it even when dispose throws', async () => {
    const { mgr, forgetSpy } = mgrWithSpies()
    mgr.sessions.set('s1', {})
    mgr.projectDirs.set('s1', '/tmp/koda-test-project')
    mgr.projectStore = vi.fn().mockReturnValue({ version: 2, activeId: null, sessions: [] })
    mgr.dispose = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(mgr.archiveRemote('s1', '/tmp/koda-test-project')).rejects.toThrow('boom')
    expect(forgetSpy).toHaveBeenCalledWith('s1')
  })
})

describe('delegated children survive posture changes and targeted stops', () => {
  type FakeSession = { stopTask?: (taskId: string) => boolean }
  type DelegationManager = {
    sessions: Map<string, FakeSession>
    activeSubagents: Map<string, Map<string, { taskId?: string }>>
    sessionModelEffort: Map<string, { model?: string; effort?: string }>
    broker: { ensureListening: () => Promise<void> }
    gate: {
      setSessionMode: (id: string, mode: 'ask' | 'plan') => void
      getSessionMode: (id: string) => string
    }
    start: (opts: { sessionId: string; cwd: string }) => Promise<{ sessionId: string; cwd: string }>
    setSessionApprovalMode: (id: string, mode: 'ask' | 'plan') => void
    setSessionModelEffort: (id: string, opts: { model?: string; effort?: string }) => void
    getSessionModelEffort: (id: string) => { model?: string; effort?: string }
    stopSubagent: (id: string, taskId: string) => void
    trackSubagentLifecycle: (event: {
      type: 'SubagentStarted' | 'SubagentProgress'
      sessionId: string
      toolUseId: string
      taskId?: string
      subagentType?: string
      description?: string
    }) => void
    markActiveSubagentsUnknown: (id: string) => void
    forward: (event: unknown) => unknown
  }

  function manager(): DelegationManager {
    return new EngineSessionManager() as unknown as DelegationManager
  }

  it('refuses to replace an engine process that still owns a child', async () => {
    const mgr = manager()
    mgr.broker.ensureListening = vi.fn(async () => {})
    mgr.sessions.set('s1', {})
    mgr.activeSubagents.set('s1', new Map([['agent-1', { taskId: 'task-1' }]]))

    await expect(mgr.start({ sessionId: 's1', cwd: '/tmp/koda-test-project' })).rejects.toThrow(
      'Delegated work is still running',
    )
    expect(mgr.sessions.get('s1')).toBeDefined()
  })

  it('blocks Plan and model respawns without changing the stored intent', () => {
    const mgr = manager()
    mgr.gate.setSessionMode('s1', 'ask')
    mgr.sessionModelEffort.set('s1', { model: 'before', effort: 'low' })
    mgr.activeSubagents.set('s1', new Map([['agent-1', { taskId: 'task-1' }]]))

    expect(() => mgr.setSessionApprovalMode('s1', 'plan')).toThrow('Delegated work is still running')
    expect(() => mgr.setSessionModelEffort('s1', { model: 'after', effort: 'high' })).toThrow(
      'Delegated work is still running',
    )
    expect(mgr.gate.getSessionMode('s1')).toBe('ask')
    expect(mgr.getSessionModelEffort('s1')).toMatchObject({ model: 'before', effort: 'low' })
  })

  it('sends Stop only to a currently tracked task and requires adapter acceptance', () => {
    const mgr = manager()
    const stopTask = vi.fn(() => true)
    mgr.sessions.set('s1', { stopTask })
    mgr.activeSubagents.set('s1', new Map([['agent-1', { taskId: 'task-1' }]]))

    mgr.stopSubagent('s1', 'task-1')
    expect(stopTask).toHaveBeenCalledWith('task-1')
    expect(() => mgr.stopSubagent('s1', 'stale-task')).toThrow('no longer running')

    stopTask.mockReturnValue(false)
    expect(() => mgr.stopSubagent('s1', 'task-1')).toThrow('could not send the stop request')
  })

  it('keeps the launch task id when a later progress event omits it', () => {
    const mgr = manager()
    mgr.trackSubagentLifecycle({
      type: 'SubagentStarted',
      sessionId: 's1',
      toolUseId: 'agent-1',
      taskId: 'task-1',
      subagentType: 'scout',
      description: 'Inspect',
    })
    mgr.trackSubagentLifecycle({
      type: 'SubagentProgress',
      sessionId: 's1',
      toolUseId: 'agent-1',
      description: 'Reading',
    })

    expect(mgr.activeSubagents.get('s1')?.get('agent-1')).toEqual(expect.objectContaining({ taskId: 'task-1' }))
  })

  it('marks every child unknown when infrastructure recovery must abandon its process', () => {
    const mgr = manager()
    mgr.activeSubagents.set(
      's1',
      new Map([
        ['agent-1', { taskId: 'task-1' }],
        ['agent-2', { taskId: 'task-2' }],
      ]),
    )
    const forward = vi.fn()
    mgr.forward = forward

    mgr.markActiveSubagentsUnknown('s1')

    expect(forward).toHaveBeenCalledTimes(2)
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SubagentCompleted', toolUseId: 'agent-1', outcome: 'unknown' }),
    )
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SubagentCompleted', toolUseId: 'agent-2', outcome: 'unknown' }),
    )
  })
})
