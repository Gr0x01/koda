import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { checkpoint } from '../safety-git/checkpoint'
import { ensureRepo } from '../safety-git/repo'
import { loadRemoteReplay, purgeRemoteReplayProject } from '../remote-replay-store'
import { purgeProjectSessions, saveProjectSessions } from '../session-store'
import { addSessionToWindow, registerWindow, unregisterWindow } from '../window-registry'
import { reconcileCompletionState } from '../completion-state'
import {
  MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS,
  TURN_REJECTED_STOP_REASON,
  type EngineEvent,
  type RemoteTerminalAttention,
  type ReplayEntry,
} from '@shared/ipc'
import { IpcChannels } from '@shared/channels'
import { latestReplayTurnFailure, transcriptFromReplay, turnFailureOf } from '@shared/delegation'
import { EngineSessionManager } from './sessions'
import { updateSettings } from '../settings'

describe('live safety-handle maintenance', () => {
  it('makes an explicit diff receipt carry this turn safety baseline', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'koda-present-diff-')))
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
    const checkpointId = 'c'.repeat(40)
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      diffBaselines: Map<string, string>
      send: ReturnType<typeof vi.fn>
      presentFile: (sessionId: string, args: { path: string; view: 'diff' }) => Promise<unknown>
    }
    const sessionId = 'present-diff-session'
    try {
      mgr.projectDirs.set(sessionId, cwd)
      mgr.send = vi.fn()
      await expect(mgr.presentFile(sessionId, { path: 'a.ts', view: 'diff' })).rejects.toThrow(
        'this turn has no safety checkpoint',
      )

      mgr.diffBaselines.set(sessionId, checkpointId)
      await expect(mgr.presentFile(sessionId, { path: 'a.ts', view: 'diff' })).resolves.toMatchObject({
        kind: 'present-file',
        path: 'a.ts',
        view: 'diff',
        checkpointId,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('remaps every live owner and re-emits projected receipts after a store rewrite', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'koda-live-safety-remap-')))
    const oldId = 'a'.repeat(40)
    const newId = 'b'.repeat(40)
    type Receipt =
      | { kind: 'present-file'; id: string; sessionId: string; path: string; view: 'diff'; checkpointId: string }
      | { kind: 'turn-changes'; id: string; sessionId: string; checkpointId: string; files: []; complete: true; overlapObserved: false }
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      diffBaselines: Map<string, string>
      completionTurns: Map<string, { cwd: string; safetyCommit: string | null }>
      projectMutationScopes: Set<{ cwd: string; sessionId: string; checkpointId: string }>
      stageReceipts: Map<string, Receipt[]>
      send: ReturnType<typeof vi.fn>
      remapLiveSafetyHandles: (cwd: string, remap: Map<string, string>) => void
    }
    const sessionId = 'remap-session'
    try {
      mgr.projectDirs.set(sessionId, cwd)
      mgr.diffBaselines.set(sessionId, oldId)
      mgr.completionTurns.set(sessionId, { cwd, safetyCommit: oldId })
      const scope = { cwd, sessionId, checkpointId: oldId }
      mgr.projectMutationScopes.add(scope)
      mgr.stageReceipts.set(sessionId, [
        { kind: 'present-file', id: 'present-old', sessionId, path: 'a.ts', view: 'diff', checkpointId: oldId },
        { kind: 'turn-changes', id: 'turn-old', sessionId, checkpointId: oldId, files: [], complete: true, overlapObserved: false },
      ])
      mgr.send = vi.fn()

      mgr.remapLiveSafetyHandles(cwd, new Map([[oldId, newId]]))

      expect(mgr.diffBaselines.get(sessionId)).toBe(newId)
      expect(mgr.completionTurns.get(sessionId)?.safetyCommit).toBe(newId)
      expect(scope.checkpointId).toBe(newId)
      expect(mgr.stageReceipts.get(sessionId)).toEqual([
        expect.objectContaining({ kind: 'present-file', checkpointId: newId }),
        expect.objectContaining({ kind: 'turn-changes', checkpointId: newId }),
      ])
      expect(mgr.send).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('completion project-mutation boundary', () => {
  it('marks the owning turn as mutating and every other writer as overlapping', () => {
    type Turn = {
      cwd: string
      safetyCommit: string
      userGit: { kind: 'repo'; dirty: string[] }
      mutationSeen: boolean
      overlappingWriters: boolean
    }
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      working: Set<string>
      completionTurns: Map<string, Turn>
      completionOverlaps: Set<string>
      noteProjectMutation: (cwd: string, owner: string | 'external') => void
    }
    const turn = (cwd: string): Turn => ({
      cwd,
      safetyCommit: 'base',
      userGit: { kind: 'repo', dirty: [] },
      mutationSeen: false,
      overlappingWriters: false,
    })
    mgr.projectDirs.set('owner', '/tmp/project')
    mgr.projectDirs.set('other', '/tmp/project')
    mgr.projectDirs.set('late', '/tmp/project')
    mgr.working.add('owner')
    mgr.working.add('other')
    mgr.working.add('late')
    mgr.completionTurns.set('owner', turn('/tmp/project'))
    mgr.completionTurns.set('other', turn('/tmp/project'))

    mgr.noteProjectMutation('/tmp/project', 'owner')

    expect(mgr.completionTurns.get('owner')).toMatchObject({ mutationSeen: true, overlappingWriters: false })
    expect(mgr.completionTurns.get('other')).toMatchObject({ mutationSeen: false, overlappingWriters: true })
    expect(mgr.completionOverlaps.has('late')).toBe(true)
  })

  it('treats a human edit as an overlapping writer for every live turn', () => {
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      working: Set<string>
      completionTurns: Map<string, { overlappingWriters: boolean }>
      noteProjectMutation: (cwd: string, owner: 'external') => void
    }
    mgr.projectDirs.set('agent', '/tmp/project')
    mgr.working.add('agent')
    mgr.completionTurns.set('agent', { overlappingWriters: false })

    mgr.noteProjectMutation('/tmp/project', 'external')

    expect(mgr.completionTurns.get('agent')?.overlappingWriters).toBe(true)
  })

  it('holds the project chain through a deferred human write before a turn boundary can start', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      refreshCompletionStatesLocked: (cwd: string) => Promise<void>
      withExternalProjectMutation: <T>(
        cwd: string,
        options: { checkpointLabel?: string; refreshOwnership?: boolean },
        mutate: (checkpointed: boolean) => T | Promise<T>,
      ) => Promise<T>
      runExclusive: <T>(cwd: string, work: () => Promise<T>) => Promise<T>
    }
    mgr.refreshCompletionStatesLocked = vi.fn().mockResolvedValue(undefined)
    const events: string[] = []
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })

    const externalWrite = mgr.withExternalProjectMutation('/tmp/project', {}, async () => {
      events.push('write:start')
      markWriteStarted()
      await writeGate
      events.push('write:end')
    })
    await writeStarted
    const nextTurnBoundary = mgr.runExclusive('/tmp/project', async () => {
      events.push('turn:baseline')
    })

    await Promise.resolve()
    expect(events).toEqual(['write:start'])
    releaseWrite()
    await Promise.all([externalWrite, nextTurnBoundary])
    expect(events).toEqual(['write:start', 'write:end', 'turn:baseline'])
  })

  it('reports an overlapping writer to the scheduler without warning the user', async () => {
    type Scope = { cwd: string; sessionId: string; checkpointId: string }
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      working: Set<string>
      completionStates: Map<string, { state: string; reason?: string }>
      safeCheckpointResult: (cwd: string, label: string) => Promise<{ id: string } | null>
      noteProjectMutation: (cwd: string, owner: string) => void
      beginProjectMutationScope: (sessionId: string, label: string) => Promise<Scope | null>
      finishProjectMutationScope: <T>(
        scope: Scope,
        mutate: () => T,
      ) => Promise<{ overlapObserved: boolean; result: T }>
    }
    mgr.sessions.set('dream', {})
    mgr.projectDirs.set('dream', '/tmp/koda-dream-owned-project')
    mgr.projectDirs.set('other', '/tmp/koda-dream-owned-project')
    mgr.safeCheckpointResult = vi.fn().mockResolvedValue({ id: 'before-dream' })

    const scope = await mgr.beginProjectMutationScope('dream', 'before overnight memory tidy')
    expect(scope).not.toBeNull()
    mgr.working.add('other')
    mgr.noteProjectMutation('/tmp/koda-dream-owned-project', 'other')

    const digestWrite = vi.fn()
    const finished = await mgr.finishProjectMutationScope(scope!, digestWrite)

    expect(finished.overlapObserved).toBe(true)
    expect(digestWrite).toHaveBeenCalledTimes(1)
    // The overlap is scheduler evidence, not a badge: ordinary parallel sessions must not raise a
    // Needs check the user can neither act on nor clear.
    expect(mgr.completionStates.get('dream')).toBeUndefined()
  })

  it('rejects a second same-session turn until scheduler finalization is done', async () => {
    type Scope = {
      cwd: string
      sessionId: string
      checkpointId: string
      ambiguous: boolean
      turnStarted: boolean
    }
    const mgr = new EngineSessionManager() as unknown as {
      projectMutationScopes: Set<Scope>
      sendTurn: (sessionId: string, text: string) => Promise<void>
    }
    mgr.projectMutationScopes.add({
      cwd: '/tmp/koda-dream-finalizing-project',
      sessionId: 'dream',
      checkpointId: 'before-dream',
      ambiguous: false,
      turnStarted: true,
    })

    await expect(mgr.sendTurn('dream', 'human follow-up')).rejects.toThrow('still finishing')
  })

  it('lets only the exact scheduler scope start the reserved turn, once', () => {
    type Scope = {
      cwd: string
      sessionId: string
      checkpointId: string
      ambiguous: boolean
      turnStarted: boolean
    }
    const mgr = new EngineSessionManager() as unknown as {
      projectMutationScopes: Set<Scope>
      claimProjectMutationScopeTurn: (
        sessionId: string,
        internal: { logicalContinuation?: 'broker-recovery'; projectMutationScope?: Scope },
      ) => void
    }
    const scope: Scope = {
      cwd: '/tmp/koda-dream-reserved-project',
      sessionId: 'dream',
      checkpointId: 'before-dream',
      ambiguous: false,
      turnStarted: false,
    }
    mgr.projectMutationScopes.add(scope)

    expect(() =>
      mgr.claimProjectMutationScopeTurn('dream', { projectMutationScope: scope }),
    ).not.toThrow()
    expect(scope.turnStarted).toBe(true)
    expect(() => mgr.claimProjectMutationScopeTurn('dream', {})).toThrow('still finishing')
    expect(() =>
      mgr.claimProjectMutationScopeTurn('dream', { logicalContinuation: 'broker-recovery' }),
    ).not.toThrow()
  })

  it('defers turn completion until the scheduler lands cleanup and its digest', async () => {
    type Scope = { cwd: string; sessionId: string; checkpointId: string }
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      working: Set<string>
      safeCheckpointResult: (cwd: string, label: string) => Promise<{ id: string } | null>
      finishCompletionTurn: ReturnType<typeof vi.fn>
      beginProjectMutationScope: (sessionId: string, label: string) => Promise<Scope | null>
      finishProjectMutationScope: (
        scope: Scope,
        mutate: () => Promise<void>,
      ) => Promise<unknown>
      forward: (event: unknown) => unknown
    }
    mgr.projectDirs.set('dream', '/tmp/koda-dream-finalization-project')
    mgr.working.add('dream')
    mgr.safeCheckpointResult = vi.fn().mockResolvedValue({ id: 'before-dream' })
    const scope = await mgr.beginProjectMutationScope('dream', 'before overnight memory tidy')
    mgr.finishCompletionTurn = vi.fn()

    mgr.forward({ type: 'TurnComplete', sessionId: 'dream', stopReason: 'success' })
    expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()

    await mgr.finishProjectMutationScope(scope!, async () => {})
    expect(mgr.finishCompletionTurn).toHaveBeenCalledTimes(1)
    expect(mgr.finishCompletionTurn).toHaveBeenCalledWith('dream')
  })

  // The engine backgrounds delegates, so their file writes land AFTER the parent turn ends. Closing
  // the boundary at TurnComplete left those writes with no owner and made every other live session in
  // the tree the one that got flagged.
  it('defers turn completion until the last backgrounded delegate reports back', () => {
    const mgr = new EngineSessionManager() as unknown as {
      working: Set<string>
      finishCompletionTurn: ReturnType<typeof vi.fn>
      forward: (event: unknown) => unknown
    }
    mgr.working.add('fan-out')
    mgr.finishCompletionTurn = vi.fn()

    mgr.forward({ type: 'SubagentStarted', sessionId: 'fan-out', toolUseId: 'a', subagentType: 'koda:scout', description: 'one' })
    mgr.forward({ type: 'SubagentStarted', sessionId: 'fan-out', toolUseId: 'b', subagentType: 'koda:scout', description: 'two' })
    mgr.forward({ type: 'TurnComplete', sessionId: 'fan-out', stopReason: 'success' })
    expect(mgr.working.has('fan-out')).toBe(false)
    expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()

    mgr.forward({ type: 'SubagentCompleted', sessionId: 'fan-out', toolUseId: 'a', outcome: 'completed' })
    expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()

    mgr.forward({ type: 'SubagentCompleted', sessionId: 'fan-out', toolUseId: 'b', outcome: 'completed' })
    expect(mgr.finishCompletionTurn).toHaveBeenCalledTimes(1)
    expect(mgr.finishCompletionTurn).toHaveBeenCalledWith('fan-out')
  })

  it('retains turn A completion ownership when turn B starts before its delegate settles', async () => {
    type Boundary = {
      cwd: string
      safetyCommit: string
      userGit: { kind: 'repo'; dirty: string[] }
      mutationSeen: boolean
      overlappingWriters: boolean
    }
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, { sendTurn: ReturnType<typeof vi.fn> }>
      projectDirs: Map<string, string>
      working: Set<string>
      completionTurns: Map<string, Boundary>
      diffBaselines: Map<string, string>
      safeCheckpointResult: ReturnType<typeof vi.fn>
      finishCompletionTurn: ReturnType<typeof vi.fn>
      sendTurn: (sessionId: string, text: string) => Promise<void>
      forward: (event: unknown) => unknown
    }
    const sessionId = 'fan-out-follow-up'
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'koda-completion-follow-up-')))
    const boundary: Boundary = {
      cwd,
      safetyCommit: 'before-turn-a',
      userGit: { kind: 'repo', dirty: [] },
      mutationSeen: true,
      overlappingWriters: false,
    }
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true) })
    mgr.projectDirs.set(sessionId, cwd)
    mgr.completionTurns.set(sessionId, boundary)
    mgr.safeCheckpointResult = vi.fn().mockResolvedValue({ id: 'before-turn-b' })
    mgr.finishCompletionTurn = vi.fn()

    try {
      mgr.working.add(sessionId)
      mgr.forward({
        type: 'SubagentStarted',
        sessionId,
        toolUseId: 'delegate-a',
        subagentType: 'koda:scout',
        description: 'background work from turn A',
      })
      mgr.forward({ type: 'TurnComplete', sessionId, stopReason: 'success' })

      await mgr.sendTurn(sessionId, 'turn B follow-up')
      expect(mgr.safeCheckpointResult).toHaveBeenCalledWith(cwd, 'turn B follow-up')
      expect(mgr.diffBaselines.get(sessionId)).toBe('before-turn-b')
      expect(mgr.completionTurns.get(sessionId)).toBe(boundary)

      mgr.forward({ type: 'TurnComplete', sessionId, stopReason: 'success' })
      expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()

      mgr.forward({
        type: 'SubagentCompleted',
        sessionId,
        toolUseId: 'delegate-a',
        outcome: 'completed',
      })
      expect(mgr.completionTurns.get(sessionId)).toBe(boundary)
      expect(mgr.finishCompletionTurn).toHaveBeenCalledTimes(1)
      expect(mgr.finishCompletionTurn).toHaveBeenCalledWith(sessionId)
    } finally {
      purgeRemoteReplayProject(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps completion ownership open until a workflow observer can no longer see late writers', () => {
    const mgr = new EngineSessionManager() as unknown as {
      workflowWatchers: Map<
        string,
        { sessionId: string; watcher: { isLive: () => boolean; activeAgentIds: () => string[] } }
      >
      finishCompletionTurn: ReturnType<typeof vi.fn>
      maybeFinishCompletionTurn: (sessionId: string) => void
    }
    mgr.workflowWatchers.set('review', {
      sessionId: 'workflow',
      // Quiet-completed for the UI, but the observer still owns the possible-writer boundary.
      watcher: { isLive: () => false, activeAgentIds: () => [] },
    })
    mgr.finishCompletionTurn = vi.fn()

    mgr.maybeFinishCompletionTurn('workflow')
    expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()

    mgr.workflowWatchers.delete('review')
    mgr.maybeFinishCompletionTurn('workflow')
    expect(mgr.finishCompletionTurn).toHaveBeenCalledWith('workflow')
  })

  it('does not reconcile a delegate finishing under a still-live parent turn', () => {
    const mgr = new EngineSessionManager() as unknown as {
      working: Set<string>
      finishCompletionTurn: ReturnType<typeof vi.fn>
      forward: (event: unknown) => unknown
    }
    mgr.working.add('live')
    mgr.finishCompletionTurn = vi.fn()

    mgr.forward({ type: 'SubagentStarted', sessionId: 'live', toolUseId: 'a', subagentType: 'koda:scout', description: 'one' })
    mgr.forward({ type: 'SubagentCompleted', sessionId: 'live', toolUseId: 'a', outcome: 'completed' })

    expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()
  })

  it('treats the old child TurnComplete during broker recovery as transport-only', () => {
    const mgr = new EngineSessionManager() as unknown as {
      working: Set<string>
      recoveringBroker: Set<string>
      turnEndWaiters: Map<string, () => void>
      finishCompletionTurn: ReturnType<typeof vi.fn>
      forward: (event: unknown) => unknown
    }
    const ended = vi.fn()
    mgr.working.add('recovering')
    mgr.recoveringBroker.add('recovering')
    mgr.turnEndWaiters.set('recovering', ended)
    mgr.finishCompletionTurn = vi.fn()

    expect(mgr.forward({ type: 'TurnComplete', sessionId: 'recovering', stopReason: 'error' })).toBeUndefined()
    expect(mgr.working.has('recovering')).toBe(true)
    expect(mgr.finishCompletionTurn).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    expect(mgr.turnEndWaiters.has('recovering')).toBe(true)

    mgr.recoveringBroker.delete('recovering')
    mgr.forward({ type: 'TurnComplete', sessionId: 'recovering', stopReason: 'success' })
    expect(mgr.working.has('recovering')).toBe(false)
    expect(mgr.finishCompletionTurn).toHaveBeenCalledWith('recovering')
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('keeps a recovering writer visible to overlap tracking after its old child closes', () => {
    type Boundary = { cwd: string; overlappingWriters: boolean; mutationSeen: boolean }
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      working: Set<string>
      recoveringBroker: Set<string>
      completionTurns: Map<string, Boundary>
      handleClose: (id: string) => void
      noteProjectMutation: (cwd: string, owner: string) => void
    }
    const cwd = '/tmp/koda-broker-recovery-overlap'
    mgr.sessions.set('recovering', {})
    mgr.projectDirs.set('recovering', cwd)
    mgr.projectDirs.set('other', cwd)
    mgr.working.add('recovering')
    mgr.working.add('other')
    mgr.recoveringBroker.add('recovering')
    mgr.completionTurns.set('recovering', { cwd, overlappingWriters: false, mutationSeen: true })

    mgr.handleClose('recovering')
    expect(mgr.working.has('recovering')).toBe(true)

    mgr.noteProjectMutation(cwd, 'other')
    expect(mgr.completionTurns.get('recovering')?.overlappingWriters).toBe(true)
  })
})

describe('turn admission authority', () => {
  type SessionStub = {
    sendTurn: ReturnType<typeof vi.fn>
    dispose?: ReturnType<typeof vi.fn>
    interrupt?: ReturnType<typeof vi.fn>
    stopTask?: ReturnType<typeof vi.fn>
  }
  type AdmissionManager = {
    sessions: Map<string, SessionStub>
    projectDirs: Map<string, string>
    working: Set<string>
    terminalAttention: Map<string, RemoteTerminalAttention>
    turnAdmissions: Map<string, { generation: number; cancelled: boolean }>
    acceptedTurns: Map<string, { generation: number; session: SessionStub }>
    processReplacements: Map<string, { generation: number }>
    activeSubagents: Map<string, Map<string, { taskId?: string }>>
    broker: { ensureListening: ReturnType<typeof vi.fn> }
    lastActivityAt: Map<string, number>
    diffBaselines: Map<string, string>
    completionTurns: Map<string, unknown>
    pendingTurns: Map<string, unknown>
    maybeFinishCompletionTurn: ReturnType<typeof vi.fn>
    gate: { pendingRequests: ReturnType<typeof vi.fn> }
    sessionModelEffort: Map<string, { model?: string; effort?: string }>
    sessionEngines: Map<string, 'claude' | 'codex'>
    spawnedWith: Map<string, { model?: string; effort?: string; engineId: 'claude' | 'codex' }>
    safeCheckpointResult: ReturnType<typeof vi.fn>
    start: (opts: {
      sessionId: string
      cwd: string
      model?: string
      effort?: string
      engineId: 'claude' | 'codex'
    }) => Promise<{ sessionId: string; cwd: string }>
    dispose: (sessionId: string) => Promise<void>
    handleClose: (sessionId: string) => void
    forgetSession: (sessionId: string) => void
    forward: (event: unknown) => unknown
    remoteTerminalAttention: (sessionId: string) => RemoteTerminalAttention | undefined
    setSessionApprovalMode: (sessionId: string, mode: 'ask' | 'plan') => void
    setSessionModelEffort: (
      sessionId: string,
      opts: { model?: string; effort?: string; engineId?: 'claude' | 'codex' },
    ) => void
    interrupt: (sessionId: string) => Promise<void>
    sendTurn: (
      sessionId: string,
      text: string,
      images?: undefined,
      origin?: 'local' | 'remote',
      internal?: { logicalContinuation?: 'broker-recovery' | 'resume-miss' },
    ) => Promise<void>
  }

  function admissionManager(): { mgr: AdmissionManager; send: ReturnType<typeof vi.fn> } {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const send = vi.fn(() => true)
    mgr.sessions.set('chat', { sendTurn: send })
    return { mgr, send }
  }

  it('rejects a stale head before it mutates or sends into an active parent turn', async () => {
    const { mgr, send } = admissionManager()
    mgr.working.add('chat')

    await expect(mgr.sendTurn('chat', 'second top-level turn')).rejects.toThrow(
      'already running',
    )
    expect(send).not.toHaveBeenCalled()
    expect(mgr.lastActivityAt.has('chat')).toBe(false)
  })

  it('rejects a top-level send while the session still owes a human answer', async () => {
    const { mgr, send } = admissionManager()
    mgr.gate.pendingRequests = vi.fn(() => [{ requestId: 'question' }])

    await expect(mgr.sendTurn('chat', 'skip the question')).rejects.toThrow(
      'waiting for your answer',
    )
    expect(send).not.toHaveBeenCalled()
    expect(mgr.lastActivityAt.has('chat')).toBe(false)
  })

  it('allows broker recovery to continue the same logical turn', async () => {
    const { mgr, send } = admissionManager()
    mgr.working.add('chat')

    await mgr.sendTurn('chat', 'resume safely', undefined, 'local', {
      logicalContinuation: 'broker-recovery',
    })

    expect(send).toHaveBeenCalledWith('resume safely', undefined)
  })

  it('keeps one admission authoritative across drift realignment teardown and its awaited start', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const cwd = '/tmp/koda-admission-realignment'
    const replacementSend = vi.fn(() => true)
    const oldDispose = vi.fn(async () => mgr.handleClose(sessionId))
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true), dispose: oldDispose })
    mgr.projectDirs.set(sessionId, cwd)
    mgr.sessionModelEffort.set(sessionId, { model: 'new-model', effort: 'high' })
    mgr.sessionEngines.set(sessionId, 'claude')
    mgr.spawnedWith.set(sessionId, { model: 'old-model', effort: 'low', engineId: 'claude' })
    mgr.safeCheckpointResult = vi.fn().mockResolvedValue(null)
    mgr.gate.pendingRequests = vi.fn(() => [])

    let markStartEntered!: () => void
    let releaseStart!: () => void
    const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve })
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async (opts) => {
      // Match production start(): dispose the old child first, then await replacement startup.
      await mgr.dispose(sessionId)
      markStartEntered()
      await startGate
      mgr.sessionModelEffort.set(sessionId, { model: opts.model, effort: opts.effort })
      mgr.sessionEngines.set(sessionId, opts.engineId)
      mgr.spawnedWith.set(sessionId, {
        model: opts.model,
        effort: opts.effort,
        engineId: opts.engineId,
      })
      mgr.sessions.set(sessionId, { sendTurn: replacementSend })
      mgr.projectDirs.set(sessionId, cwd)
      return { sessionId, cwd }
    })

    const firstSend = mgr.sendTurn(sessionId, 'first turn')
    await startEntered

    expect(oldDispose).toHaveBeenCalledTimes(1)
    expect(mgr.turnAdmissions.has(sessionId)).toBe(true)
    await expect(mgr.sendTurn(sessionId, 'racing second turn')).rejects.toThrow('already running')
    expect(() =>
      mgr.setSessionModelEffort(sessionId, { model: 'third-model', effort: 'medium' }),
    ).toThrow('already starting')
    expect(() => mgr.setSessionApprovalMode(sessionId, 'plan')).toThrow('already starting')

    releaseStart()
    await firstSend

    expect(replacementSend).toHaveBeenCalledTimes(1)
    expect(replacementSend).toHaveBeenCalledWith('first turn', undefined)
    expect(mgr.turnAdmissions.has(sessionId)).toBe(false)
    expect(mgr.working.has(sessionId)).toBe(true)
  })

  it('refuses to send when replacement actuals drift from intent before startup settles', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const cwd = '/tmp/koda-admission-intent-race'
    const replacementSend = vi.fn(() => true)
    const oldDispose = vi.fn(async () => mgr.handleClose(sessionId))
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true), dispose: oldDispose })
    mgr.projectDirs.set(sessionId, cwd)
    mgr.sessionModelEffort.set(sessionId, { model: 'intended-model', effort: 'high' })
    mgr.sessionEngines.set(sessionId, 'claude')
    mgr.spawnedWith.set(sessionId, { model: 'old-model', effort: 'low', engineId: 'claude' })
    mgr.gate.pendingRequests = vi.fn(() => [])

    let markReplacementReady!: () => void
    let releaseStart!: () => void
    const replacementReady = new Promise<void>((resolve) => { markReplacementReady = resolve })
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async (opts) => {
      await mgr.dispose(sessionId)
      mgr.sessionModelEffort.set(sessionId, { model: opts.model, effort: opts.effort })
      mgr.sessionEngines.set(sessionId, opts.engineId)
      mgr.spawnedWith.set(sessionId, {
        model: opts.model,
        effort: opts.effort,
        engineId: opts.engineId,
      })
      mgr.sessions.set(sessionId, { sendTurn: replacementSend })
      mgr.projectDirs.set(sessionId, cwd)
      markReplacementReady()
      await startGate
      return { sessionId, cwd }
    })

    const sending = mgr.sendTurn(sessionId, 'must use the intended model')
    await replacementReady
    // Public posture mutation is fenced by the admission. Simulate a future/internal intent writer to
    // pin the final verify-don't-trust check independently of that public guard.
    mgr.sessionModelEffort.set(sessionId, { model: 'newer-intent', effort: 'high' })
    releaseStart()

    await expect(sending).rejects.toThrow('settings changed while its engine was starting')
    expect(replacementSend).not.toHaveBeenCalled()
    expect(mgr.working.has(sessionId)).toBe(false)
    expect(mgr.turnAdmissions.has(sessionId)).toBe(false)
  })

  it('honors Stop while drift realignment is awaiting its replacement child', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const cwd = '/tmp/koda-admission-stop-start'
    const replacementSend = vi.fn(() => true)
    const oldDispose = vi.fn(async () => mgr.handleClose(sessionId))
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true), dispose: oldDispose })
    mgr.projectDirs.set(sessionId, cwd)
    mgr.sessionModelEffort.set(sessionId, { model: 'new-model', effort: 'high' })
    mgr.sessionEngines.set(sessionId, 'claude')
    mgr.spawnedWith.set(sessionId, { model: 'old-model', effort: 'low', engineId: 'claude' })

    let markStartEntered!: () => void
    let releaseStart!: () => void
    const startEntered = new Promise<void>((resolve) => { markStartEntered = resolve })
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async (opts) => {
      await mgr.dispose(sessionId)
      markStartEntered()
      await startGate
      mgr.sessionModelEffort.set(sessionId, { model: opts.model, effort: opts.effort })
      mgr.sessionEngines.set(sessionId, opts.engineId)
      mgr.spawnedWith.set(sessionId, {
        model: opts.model,
        effort: opts.effort,
        engineId: opts.engineId,
      })
      mgr.sessions.set(sessionId, { sendTurn: replacementSend, interrupt: vi.fn() })
      mgr.projectDirs.set(sessionId, cwd)
      return { sessionId, cwd }
    })

    const sending = mgr.sendTurn(sessionId, 'do not start after Stop')
    await startEntered
    await mgr.interrupt(sessionId)
    expect(mgr.turnAdmissions.get(sessionId)?.cancelled).toBe(true)

    releaseStart()
    await expect(sending).rejects.toThrow('stopped before it reached the engine')

    expect(replacementSend).not.toHaveBeenCalled()
    expect(mgr.turnAdmissions.has(sessionId)).toBe(false)
    expect(mgr.working.has(sessionId)).toBe(false)
  })

  it('cancels a deferred checkpoint send and does not poison the next admission generation', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const cwd = '/tmp/koda-admission-stop-checkpoint'
    const send = vi.fn(() => true)
    const interrupt = vi.fn()
    mgr.sessions.set(sessionId, { sendTurn: send, interrupt })
    mgr.projectDirs.set(sessionId, cwd)

    let markCheckpointEntered!: () => void
    let releaseCheckpoint!: () => void
    const checkpointEntered = new Promise<void>((resolve) => { markCheckpointEntered = resolve })
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve })
    mgr.safeCheckpointResult = vi.fn()
      .mockImplementationOnce(async () => {
        markCheckpointEntered()
        await checkpointGate
        return { id: 'cancelled-baseline' }
      })
      .mockResolvedValue(null)

    const first = mgr.sendTurn(sessionId, 'cancel during checkpoint')
    await checkpointEntered
    await mgr.interrupt(sessionId)
    expect(interrupt).not.toHaveBeenCalled()
    expect(mgr.turnAdmissions.get(sessionId)?.cancelled).toBe(true)

    releaseCheckpoint()
    await expect(first).rejects.toThrow('stopped before it reached the engine')
    expect(send).not.toHaveBeenCalled()
    expect(mgr.working.has(sessionId)).toBe(false)
    expect(mgr.diffBaselines.has(sessionId)).toBe(false)
    expect(mgr.completionTurns.has(sessionId)).toBe(false)

    // The cancelled token belonged only to generation one. A clean successor must be admitted and sent.
    await mgr.sendTurn(sessionId, 'next generation')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('next generation', undefined)
    expect(mgr.turnAdmissions.has(sessionId)).toBe(false)
    await mgr.interrupt(sessionId)
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('rechecks cancellation at the final pre-send boundary', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const send = vi.fn(() => true)
    const engineInterrupt = vi.fn()
    mgr.sessions.set(sessionId, { sendTurn: send, interrupt: engineInterrupt })

    let stopped!: Promise<void>
    const pending = mgr.pendingTurns
    const setPending = pending.set.bind(pending)
    pending.set = vi.fn((id, turn) => {
      const result = setPending(id, turn)
      // interrupt() marks the current token synchronously before its child-stop await.
      stopped = mgr.interrupt(sessionId)
      return result
    })

    await expect(mgr.sendTurn(sessionId, 'stop at the send boundary')).rejects.toThrow(
      'stopped before it reached the engine',
    )
    await stopped

    expect(send).not.toHaveBeenCalled()
    expect(engineInterrupt).not.toHaveBeenCalled()
    expect(mgr.pendingTurns.has(sessionId)).toBe(false)
    expect(mgr.working.has(sessionId)).toBe(false)
    expect(mgr.turnAdmissions.has(sessionId)).toBe(false)
  })

  it('never lets a delayed child-stop sweep interrupt a successor on the same warm process', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const send = vi.fn(() => true)
    const engineInterrupt = vi.fn()
    const stopTask = vi.fn(() => true)
    const session = { sendTurn: send, interrupt: engineInterrupt, stopTask }
    mgr.sessions.set(sessionId, session)
    mgr.activeSubagents.set(
      sessionId,
      new Map([['child-launch', { taskId: 'child-task' }]]),
    )

    await mgr.sendTurn(sessionId, 'turn A')
    const turnA = mgr.acceptedTurns.get(sessionId)
    expect(turnA?.session).toBe(session)

    // Stop parks on the child. The parent can finish naturally before that terminal row arrives.
    const stopping = mgr.interrupt(sessionId)
    expect(stopTask).toHaveBeenCalledWith('child-task')
    mgr.forward({ type: 'TurnComplete', sessionId, stopReason: 'success' })

    // Main admits B on the same warm process while A's Stop is still waiting for the child.
    await mgr.sendTurn(sessionId, 'turn B')
    expect(mgr.acceptedTurns.get(sessionId)?.generation).not.toBe(turnA?.generation)

    mgr.forward({
      type: 'SubagentCompleted',
      sessionId,
      toolUseId: 'child-launch',
      taskId: 'child-task',
      outcome: 'interrupted',
    })
    await stopping

    expect(send).toHaveBeenNthCalledWith(1, 'turn A', undefined)
    expect(send).toHaveBeenNthCalledWith(2, 'turn B', undefined)
    expect(engineInterrupt).not.toHaveBeenCalled()
    expect(mgr.working.has(sessionId)).toBe(true)
  })

  it('revalidates a real start claim after broker startup before disposing the old process', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const dispose = vi.fn().mockResolvedValue(undefined)
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true), dispose })

    let markBrokerStarted!: () => void
    let releaseBroker!: () => void
    const brokerStarted = new Promise<void>((resolve) => { markBrokerStarted = resolve })
    const brokerGate = new Promise<void>((resolve) => { releaseBroker = resolve })
    mgr.broker.ensureListening = vi.fn(async () => {
      markBrokerStarted()
      await brokerGate
    })

    const starting = mgr.start({
      sessionId,
      cwd: '/tmp/koda-real-start-revalidation',
      engineId: 'claude',
    })
    await brokerStarted
    const original = mgr.processReplacements.get(sessionId)
    expect(original).toBeDefined()

    // Model a newer lifecycle owner taking over while the old start is parked on its first await.
    // The stale start must fail before dispose() and its finally must not erase the successor's claim.
    const successor = { generation: original!.generation + 1 }
    mgr.processReplacements.set(sessionId, successor)
    releaseBroker()

    await expect(starting).rejects.toThrow('replacement is no longer current')
    expect(dispose).not.toHaveBeenCalled()
    expect(mgr.processReplacements.get(sessionId)).toBe(successor)
  })

  it('releases an owned replacement claim when real startup fails before teardown', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const dispose = vi.fn().mockResolvedValue(undefined)
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true), dispose })
    mgr.broker.ensureListening = vi.fn().mockRejectedValue(new Error('broker unavailable'))

    await expect(
      mgr.start({ sessionId, cwd: '/tmp/koda-real-start-failure', engineId: 'claude' }),
    ).rejects.toThrow('broker unavailable')

    expect(dispose).not.toHaveBeenCalled()
    expect(mgr.processReplacements.has(sessionId)).toBe(false)
  })

  it('holds a Plan respawn claim across startup so sends and model changes cannot race it', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager & {
      resumeCursors: Map<string, { engine: 'claude'; resumable: boolean; data: Record<string, unknown> }>
    }
    const sessionId = 'chat'
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true) })
    mgr.projectDirs.set(sessionId, '/tmp/koda-plan-replacement')
    mgr.resumeCursors.set(sessionId, { engine: 'claude', resumable: true, data: { sessionId } })

    let markStarted!: () => void
    let releaseStart!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async () => {
      markStarted()
      await gate
      return { sessionId, cwd: '/tmp/koda-plan-replacement' }
    })

    mgr.setSessionApprovalMode(sessionId, 'plan')
    await started

    expect(mgr.processReplacements.has(sessionId)).toBe(true)
    await expect(mgr.sendTurn(sessionId, 'must wait for Plan')).rejects.toThrow('changing settings')
    expect(() =>
      mgr.setSessionModelEffort(sessionId, { model: 'new-model', effort: 'high' }),
    ).toThrow('already changing settings')

    releaseStart()
    await vi.waitFor(() => expect(mgr.processReplacements.has(sessionId)).toBe(false))
  })

  it('holds a model respawn claim across startup so sends and Plan changes cannot race it', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager & {
      remoteEventLog: Map<string, Array<{ type: 'RemoteUserTurn'; sessionId: string; text: string }>>
      changeSessionModelEffort: (
        sessionId: string,
        opts: { model?: string; effort?: string; engineId?: 'claude' | 'codex' },
      ) => Promise<void>
    }
    const sessionId = 'chat'
    const cwd = '/tmp/koda-model-replacement'
    mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true) })
    mgr.projectDirs.set(sessionId, cwd)
    mgr.sessionModelEffort.set(sessionId, { model: 'old-model', effort: 'low' })
    mgr.sessionEngines.set(sessionId, 'claude')
    mgr.remoteEventLog.set(sessionId, [{ type: 'RemoteUserTurn', sessionId, text: 'hello' }])

    let markStarted!: () => void
    let releaseStart!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async () => {
      markStarted()
      await gate
      return { sessionId, cwd }
    })

    const changing = mgr.changeSessionModelEffort(sessionId, {
      model: 'new-model',
      effort: 'high',
    })
    await started

    expect(mgr.processReplacements.has(sessionId)).toBe(true)
    await expect(mgr.sendTurn(sessionId, 'must wait for model')).rejects.toThrow('changing settings')
    expect(() => mgr.setSessionApprovalMode(sessionId, 'plan')).toThrow('already changing settings')

    releaseStart()
    await changing
    expect(mgr.processReplacements.has(sessionId)).toBe(false)
  })

  it('releases prepared lifecycle state when the engine send throws synchronously', async () => {
    const mgr = new EngineSessionManager() as unknown as AdmissionManager
    const sessionId = 'chat'
    const failure = new Error('driver stdin failed')
    const send = vi.fn(() => { throw failure })
    mgr.sessions.set(sessionId, { sendTurn: send })
    mgr.maybeFinishCompletionTurn = vi.fn()

    await expect(mgr.sendTurn(sessionId, 'cannot be accepted')).rejects.toBe(failure)

    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.working.has(sessionId)).toBe(false)
    expect(mgr.pendingTurns.has(sessionId)).toBe(false)
    expect(mgr.turnAdmissions.has(sessionId)).toBe(false)
    expect(mgr.maybeFinishCompletionTurn).toHaveBeenCalledWith(sessionId)
  })

  it('clears an abandoned admission when the logical session truly ends', () => {
    const { mgr } = admissionManager()
    const admission = { generation: 1, cancelled: false }
    mgr.turnAdmissions.set('chat', admission)

    mgr.forgetSession('chat')

    expect(admission.cancelled).toBe(true)
    expect(mgr.turnAdmissions.has('chat')).toBe(false)
  })

  it.each(['success', 'interrupted'])('publishes a new done revision for a %s completion', (stopReason) => {
    const { mgr } = admissionManager()

    mgr.forward({ type: 'TurnComplete', sessionId: 'chat', stopReason })

    expect(mgr.remoteTerminalAttention('chat')).toEqual({
      kind: 'done',
      revision: expect.any(String),
    })
  })

  it('uses the same replay identity for the terminal fact, durable event, and live event', () => {
    const mgr = new EngineSessionManager() as unknown as {
      remoteAttached: Set<string>
      remoteEventLog: Map<string, ReplayEntry[]>
      addRemoteSink: (
        sink: (channel: string, sessionId: string, payload: unknown) => void,
      ) => () => void
      forward: (event: EngineEvent) => EngineEvent | undefined
      remoteTerminalAttention: (sessionId: string) => RemoteTerminalAttention | undefined
    }
    const sink = vi.fn()
    mgr.remoteAttached.add('chat')
    mgr.addRemoteSink(sink)

    const forwarded = mgr.forward({
      type: 'TurnComplete',
      sessionId: 'chat',
      stopReason: 'success',
    })

    expect(forwarded).toMatchObject({ replaySeq: 1 })
    expect(mgr.remoteEventLog.get('chat')?.at(-1)).toEqual(forwarded)
    expect(
      sink.mock.calls.find(([channel]) => channel === IpcChannels.engineEvent)?.[2],
    ).toEqual(forwarded)
    expect(mgr.remoteTerminalAttention('chat')).toEqual({ kind: 'done', revision: '1' })
  })

  it.each([
    [
      'fatal',
      { type: 'EngineError', sessionId: 'chat', message: 'engine exited', fatal: true },
      'error',
    ],
    [
      'api error',
      {
        type: 'EngineError',
        sessionId: 'chat',
        message: 'rate limited',
        fatal: false,
        category: 'apiError',
      },
      'error',
    ],
    [
      'turn rejection',
      {
        type: 'EngineError',
        sessionId: 'chat',
        message: 'not accepted',
        fatal: false,
        category: 'turnRejected',
      },
      TURN_REJECTED_STOP_REASON,
    ],
  ])('keeps a noteworthy %s ahead of its compatibility completion', (_name, event, stopReason) => {
    const { mgr } = admissionManager()
    mgr.forward(event)
    const error = mgr.remoteTerminalAttention('chat')

    mgr.forward({ type: 'TurnComplete', sessionId: 'chat', stopReason })

    expect(error).toEqual({ kind: 'error', revision: expect.any(String) })
    expect(mgr.remoteTerminalAttention('chat')).toEqual(error)
  })

  it('does not invent done attention for a compatibility turn rejection without its error edge', () => {
    const { mgr } = admissionManager()

    mgr.forward({
      type: 'TurnComplete',
      sessionId: 'chat',
      stopReason: TURN_REJECTED_STOP_REASON,
    })

    expect(mgr.remoteTerminalAttention('chat')).toBeUndefined()
  })

  it('publishes a fresh done revision when a settled workflow follows the acknowledged parent turn', () => {
    const { mgr } = admissionManager()
    mgr.forward({ type: 'TurnComplete', sessionId: 'chat', stopReason: 'success' })
    const acknowledgedParent = mgr.remoteTerminalAttention('chat')

    mgr.forward({
      type: 'WorkflowCompleted',
      sessionId: 'chat',
      runId: 'review',
      agentCount: 2,
    })

    expect(acknowledgedParent).toEqual({ kind: 'done', revision: expect.any(String) })
    const workflowDone = mgr.remoteTerminalAttention('chat')
    expect(workflowDone).toEqual({
      kind: 'done',
      revision: expect.any(String),
    })
    expect(workflowDone?.revision).not.toBe(acknowledgedParent?.revision)
  })

  it('keeps terminal error attention dominant over a later workflow completion', () => {
    const { mgr } = admissionManager()
    mgr.forward({
      type: 'EngineError',
      sessionId: 'chat',
      message: 'request failed',
      fatal: false,
      category: 'apiError',
    })
    const error = mgr.remoteTerminalAttention('chat')

    mgr.forward({
      type: 'WorkflowCompleted',
      sessionId: 'chat',
      runId: 'review',
      agentCount: 2,
    })

    expect(mgr.remoteTerminalAttention('chat')).toEqual(error)
  })

  it('clears terminal attention only after the engine accepts a new human turn', async () => {
    const { mgr } = admissionManager()
    mgr.forward({
      type: 'EngineError',
      sessionId: 'chat',
      message: 'turn rejected',
      fatal: false,
      category: 'turnRejected',
    })

    await mgr.sendTurn('chat', 'try again')

    expect(mgr.remoteTerminalAttention('chat')).toBeUndefined()
  })

  it('forgets terminal attention when the logical session truly ends', () => {
    const { mgr } = admissionManager()
    mgr.forward({ type: 'TurnComplete', sessionId: 'chat', stopReason: 'success' })

    mgr.forgetSession('chat')

    expect(mgr.remoteTerminalAttention('chat')).toBeUndefined()
  })
})

describe('pre-start rejection compatibility terminal', () => {
  it('does not consume first-turn naming evidence before the user retries', () => {
    const mgr = new EngineSessionManager() as unknown as {
      remoteFirstPrompt: Map<string, { prompt: string; cwd: string }>
      remoteLastReply: Map<string, string>
      forward: (event: unknown) => unknown
    }
    mgr.remoteFirstPrompt.set('chat', { prompt: 'build the feature', cwd: '/tmp/project' })
    mgr.remoteLastReply.set('chat', 'partial reply')

    mgr.forward({
      type: 'EngineError',
      sessionId: 'chat',
      message: 'turn failed before it started',
      fatal: false,
      category: 'turnRejected',
    })
    mgr.forward({
      type: 'TurnComplete',
      sessionId: 'chat',
      stopReason: TURN_REJECTED_STOP_REASON,
    })

    expect(mgr.remoteFirstPrompt.get('chat')).toEqual({
      prompt: 'build the feature',
      cwd: '/tmp/project',
    })
    expect(mgr.remoteLastReply.get('chat')).toBe('partial reply')
  })
})

describe('remote turn attachment provenance', () => {
  type HeldTurn = {
    engineText: string
    inlineImages?: Array<{ mediaType: string; dataBase64: string; name?: string }>
    visible: {
      text: string
      attachments?: Array<{ mediaType: string; dataBase64: string; name?: string }>
      origin: 'local' | 'remote'
      attemptId?: string
      clientTurnId?: string
    }
  }
  type RemotePayload = {
    replaySeq?: number
    attemptId?: string
    clientTurnId?: string
    attachments?: Array<{ mediaType: string; dataBase64: string; name?: string }>
    failed: boolean
  }
  type ProvenanceManager = {
    sessions: Map<
      string,
      {
        sendTurn: ReturnType<typeof vi.fn>
        dispose?: ReturnType<typeof vi.fn>
        interrupt?: ReturnType<typeof vi.fn>
      }
    >
    projectDirs: Map<string, string>
    working: Set<string>
    acceptedTurns: Map<string, { generation: number; cancelled: boolean; session: unknown }>
    pendingTurns: Map<string, HeldTurn>
    pendingWorkflowResults: Map<string, string[]>
    pendingRestoreNotices: Map<string, string>
    armedRestoreNotices: Map<string, string>
    turnReplies: Map<string, string>
    completionTurns: Map<string, unknown>
    remoteAttached: Set<string>
    remoteEventLog: Map<string, ReplayEntry[]>
    remoteTurnPayloads: Map<string, RemotePayload>
    acceptedRemoteAttempts: Map<
      string,
      Map<string, { clientTurnId?: string; fingerprint: string; state: 'running' | 'complete' }>
    >
    activeRemoteAttemptIds: Map<string, string>
    recoveringBroker: Set<string>
    resumeAfterReconnect: Map<string, number | undefined>
    resumeMissRecovery: Set<string>
    sessionGenerations: Map<string, symbol>
    safeCheckpointResult: ReturnType<typeof vi.fn>
    forward: (event: EngineEvent) => unknown
    forwardProcessEvent: (event: EngineEvent, processGeneration?: symbol) => unknown
    handleClose: (sessionId: string, processGeneration?: symbol) => void
    interrupt: (sessionId: string) => Promise<void>
    stopDelegatedChildren: (sessionId: string, session?: unknown) => Promise<void>
    dispose: (sessionId: string) => Promise<void>
    start: (opts: { sessionId: string; cwd: string }) => Promise<{ sessionId: string; cwd: string }>
    recoverBroker: (sessionId: string) => Promise<void>
    recoverResumeMiss: (sessionId: string) => Promise<void>
    sendTurn: (
      sessionId: string,
      text: string,
      images?: Array<{ mediaType: string; dataBase64: string; name?: string }>,
      origin?: 'local' | 'remote',
      identity?: { attemptId?: string; clientTurnId?: string },
    ) => Promise<{ status: 'accepted' | 'already-running' | 'already-complete' }>
  }

  const image = { mediaType: 'image/png', dataBase64: 'AAAA' }

  it('keeps successful headless replay provenance-only while sending exact bytes to the engine', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('headless', { sendTurn: send })
    mgr.remoteAttached.add('headless')

    await mgr.sendTurn('headless', '', [image], 'remote')

    expect(mgr.remoteEventLog.get('headless')?.[0]).toEqual({
      type: 'RemoteUserTurn',
      sessionId: 'headless',
      text: '',
      hadAttachments: true,
      attachments: [{ mediaType: 'image/png' }],
      hadImages: true,
      replaySeq: 1,
    })
    expect(send).toHaveBeenCalledWith('', [image])
  })

  it('forwards a captioned local turn provenance to its owner for optimistic-row stamping', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    const win = {
      id: 817_206,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    registerWindow(win as never, '/tmp/koda-provenance-window')
    addSessionToWindow(win.id, 'owned')
    mgr.sessions.set('owned', { sendTurn: send })
    mgr.remoteAttached.add('owned')
    try {
      await mgr.sendTurn('owned', 'inspect this', [image], 'local')

      expect(mgr.remoteEventLog.get('owned')?.[0]).toMatchObject({
        type: 'RemoteUserTurn',
        text: 'inspect this',
        hadAttachments: true,
        attachments: [{ mediaType: 'image/png' }],
        hadImages: true,
      })
      expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.sessionRemoteUserTurn, {
        sessionId: 'owned',
        text: 'inspect this',
        hadAttachments: true,
        attachments: [{ mediaType: 'image/png' }],
        hadImages: true,
        images: [image],
        replaySeq: 1,
        append: false,
      })
    } finally {
      unregisterWindow(win.id)
    }
  })

  it('publishes retained PDF bytes to an owning renderer before the terminal failure', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    const win = {
      id: 817_208,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    const document = {
      mediaType: 'application/pdf',
      name: 'brief.pdf',
      dataBase64: 'UERG',
    }
    registerWindow(win as never, '/tmp/koda-pdf-retry-owner')
    addSessionToWindow(win.id, 'owned-pdf')
    mgr.sessions.set('owned-pdf', { sendTurn: send })
    mgr.remoteAttached.add('owned-pdf')
    try {
      await mgr.sendTurn('owned-pdf', 'inspect the brief', [document], 'remote', {
        attemptId: 'attempt-pdf',
        clientTurnId: 'logical-pdf',
      })

      const beforeFailure = win.webContents.send.mock.calls.filter(
        ([channel]) => channel === IpcChannels.sessionRemoteUserTurn,
      )
      expect(beforeFailure).toHaveLength(1)
      expect(beforeFailure[0][1]).not.toHaveProperty('images')

      mgr.forward({
        type: 'EngineError',
        sessionId: 'owned-pdf',
        message: 'turn rejected',
        fatal: false,
        category: 'turnRejected',
      })

      const calls = win.webContents.send.mock.calls
      const promotedIndex = calls.findIndex(
        ([channel, payload]) =>
          channel === IpcChannels.sessionRemoteUserTurn &&
          (payload as { images?: unknown[] }).images?.length === 1,
      )
      const failureIndex = calls.findIndex(
        ([channel, payload]) =>
          channel === IpcChannels.engineEvent &&
          (payload as { type?: string }).type === 'EngineError',
      )
      expect(promotedIndex).toBeGreaterThanOrEqual(0)
      expect(failureIndex).toBeGreaterThan(promotedIndex)
      expect(calls[promotedIndex][1]).toMatchObject({
        sessionId: 'owned-pdf',
        text: 'inspect the brief',
        clientTurnId: 'logical-pdf',
        hadAttachments: true,
        attachments: [{ mediaType: 'application/pdf', name: 'brief.pdf' }],
        hadImages: false,
        images: [document],
        replaySeq: 1,
        append: false,
      })
    } finally {
      unregisterWindow(win.id)
    }
  })

  it('keeps an accepted remote turn live when its owner window disappears during publication', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    const win = {
      id: 817_207,
      isDestroyed: () => false,
      webContents: { send: vi.fn(() => { throw new Error('renderer closed') }) },
    }
    registerWindow(win as never, '/tmp/koda-provenance-window-race')
    addSessionToWindow(win.id, 'owned-remote')
    mgr.sessions.set('owned-remote', { sendTurn: send })
    mgr.remoteAttached.add('owned-remote')
    const identity = { attemptId: 'attempt-owner-race', clientTurnId: 'logical-owner-race' }
    try {
      await expect(
        mgr.sendTurn('owned-remote', 'keep running', [image], 'remote', identity),
      ).resolves.toEqual({ status: 'accepted' })

      expect(send).toHaveBeenCalledTimes(1)
      expect(mgr.working.has('owned-remote')).toBe(true)
      expect(mgr.pendingTurns.get('owned-remote')).toEqual({
        engineText: 'keep running',
        inlineImages: [image],
        visible: {
          text: 'keep running',
          attachments: [image],
          origin: 'remote',
          attemptId: identity.attemptId,
          clientTurnId: identity.clientTurnId,
        },
      })
      expect(
        mgr.acceptedRemoteAttempts.get('owned-remote')?.get(identity.attemptId),
      ).toMatchObject({ clientTurnId: identity.clientTurnId, state: 'running' })
      expect(mgr.remoteEventLog.get('owned-remote')?.[0]).toMatchObject({
        type: 'RemoteUserTurn',
        text: 'keep running',
        clientTurnId: identity.clientTurnId,
      })
    } finally {
      unregisterWindow(win.id)
    }
  })

  it('deduplicates a lost ack while running and after completion without a second engine send', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('headless', { sendTurn: send })
    mgr.remoteAttached.add('headless')
    const identity = { attemptId: 'attempt-a', clientTurnId: 'logical-a' }

    await expect(mgr.sendTurn('headless', 'ship it', undefined, 'remote', identity)).resolves.toEqual({
      status: 'accepted',
    })
    await expect(mgr.sendTurn('headless', 'ship it', undefined, 'remote', identity)).resolves.toEqual({
      status: 'already-running',
    })
    await expect(
      mgr.sendTurn('headless', 'different message', undefined, 'remote', {
        attemptId: 'attempt-a',
        clientTurnId: 'logical-b',
      }),
    ).rejects.toThrow('different message')
    expect(send).toHaveBeenCalledTimes(1)

    mgr.forward({ type: 'TurnComplete', sessionId: 'headless', stopReason: 'success' })
    await expect(mgr.sendTurn('headless', 'ship it', undefined, 'remote', identity)).resolves.toEqual({
      status: 'already-complete',
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('binds an accepted attempt id to immutable text and ordered exact attachment payload', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('headless', { sendTurn: send })
    mgr.remoteAttached.add('headless')
    const identity = { attemptId: 'attempt-a', clientTurnId: 'logical-a' }
    const attachments = [
      { mediaType: 'application/pdf', name: 'brief.pdf', dataBase64: 'UERG' },
      { mediaType: 'image/png', name: 'screen.png', dataBase64: 'UE5H' },
    ]

    await expect(
      mgr.sendTurn('headless', 'inspect these', attachments, 'remote', identity),
    ).resolves.toEqual({ status: 'accepted' })
    await expect(
      mgr.sendTurn(
        'headless',
        'inspect these',
        attachments.map((attachment) => ({ ...attachment })),
        'remote',
        identity,
      ),
    ).resolves.toEqual({ status: 'already-running' })

    await expect(
      mgr.sendTurn('headless', 'inspect something else', attachments, 'remote', identity),
    ).rejects.toThrow('different message or attachment payload')
    await expect(
      mgr.sendTurn('headless', 'inspect these', [...attachments].reverse(), 'remote', identity),
    ).rejects.toThrow('different message or attachment payload')
    await expect(
      mgr.sendTurn(
        'headless',
        'inspect these',
        [{ ...attachments[0], dataBase64: 'changed' }, attachments[1]],
        'remote',
        identity,
      ),
    ).rejects.toThrow('different message or attachment payload')

    expect(send).toHaveBeenCalledTimes(1)
    const accepted = mgr.acceptedRemoteAttempts.get('headless')?.get('attempt-a')
    expect(accepted?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(accepted ?? {}).sort()).toEqual(['clientTurnId', 'fingerprint', 'state'])
  })

  it('keeps an attempt retryable when admission rejects it before the engine', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('headless', { sendTurn: send })
    mgr.remoteAttached.add('headless')
    mgr.working.add('headless')
    const identity = { attemptId: 'attempt-a', clientTurnId: 'logical-a' }

    await expect(
      mgr.sendTurn('headless', 'ship it', undefined, 'remote', identity),
    ).rejects.toThrow('already running')
    mgr.working.delete('headless')
    await expect(mgr.sendTurn('headless', 'ship it', undefined, 'remote', identity)).resolves.toEqual({
      status: 'accepted',
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps failed A authoritative when Stop cancels retry B during its deferred preflight', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('headless', { sendTurn: send })
    mgr.remoteAttached.add('headless')
    const attachment = {
      mediaType: 'application/pdf',
      name: 'brief.pdf',
      dataBase64: 'UERG',
    }

    await mgr.sendTurn('headless', 'inspect', [attachment], 'remote', {
      attemptId: 'attempt-a',
      clientTurnId: 'logical-a',
    })
    mgr.forward({
      type: 'EngineError',
      sessionId: 'headless',
      message: 'attempt A failed',
      fatal: false,
      category: 'turnRejected',
    })
    const failedA = mgr.remoteTurnPayloads.get('headless')
    expect(failedA).toMatchObject({
      attemptId: 'attempt-a',
      clientTurnId: 'logical-a',
      attachments: [attachment],
      failed: true,
    })

    let markCheckpointStarted!: () => void
    let releaseCheckpoint!: () => void
    const checkpointStarted = new Promise<void>((resolve) => { markCheckpointStarted = resolve })
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve })
    mgr.projectDirs.set('headless', '/tmp/koda-remote-retry-preflight')
    mgr.safeCheckpointResult = vi.fn(async () => {
      markCheckpointStarted()
      await checkpointGate
      return { id: 'before-retry-b' }
    })

    const retryB = mgr.sendTurn('headless', 'inspect', [attachment], 'remote', {
      attemptId: 'attempt-b',
      clientTurnId: 'logical-a',
    })
    await checkpointStarted
    await mgr.interrupt('headless')
    releaseCheckpoint()
    await expect(retryB).rejects.toThrow('stopped before it reached the engine')

    expect(send).toHaveBeenCalledTimes(1)
    expect(mgr.remoteTurnPayloads.get('headless')).toBe(failedA)
    const afterStop = mgr.remoteEventLog.get('headless') ?? []
    expect(afterStop.filter((entry) => entry.type === 'RemoteUserTurn')).toHaveLength(1)
    expect(latestReplayTurnFailure(afterStop)?.target).toMatchObject({
      text: 'inspect',
      clientTurnId: 'logical-a',
      images: [attachment],
    })

    // The same unaccepted transport attempt can retry. Only its real engine acceptance supersedes A.
    mgr.projectDirs.delete('headless')
    await expect(
      mgr.sendTurn('headless', 'inspect', [attachment], 'remote', {
        attemptId: 'attempt-b',
        clientTurnId: 'logical-a',
      }),
    ).resolves.toEqual({ status: 'accepted' })
    expect(send).toHaveBeenCalledTimes(2)
    const afterAcceptance = mgr.remoteEventLog.get('headless') ?? []
    expect(afterAcceptance.filter((entry) => entry.type === 'RemoteUserTurn')).toHaveLength(2)
    expect(
      afterAcceptance
        .filter((entry) => entry.type === 'RemoteUserTurn')
        .every((entry) => entry.images === undefined),
    ).toBe(true)
    expect(latestReplayTurnFailure(afterAcceptance)).toBeUndefined()
    expect(mgr.remoteTurnPayloads.get('headless')).toMatchObject({
      attemptId: 'attempt-b',
      clientTurnId: 'logical-a',
      attachments: [attachment],
      failed: false,
    })
  })

  it('lets an accepted desktop follow-up supersede a failed phone payload', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('shared', { sendTurn: send })
    mgr.remoteAttached.add('shared')
    const attachment = {
      mediaType: 'application/pdf',
      name: 'failed-phone.pdf',
      dataBase64: 'UERG',
    }

    await mgr.sendTurn('shared', 'phone attempt', [attachment], 'remote', {
      attemptId: 'attempt-phone',
      clientTurnId: 'logical-phone',
    })
    mgr.forward({
      type: 'EngineError',
      sessionId: 'shared',
      message: 'phone attempt failed',
      fatal: false,
      category: 'turnRejected',
    })
    expect(mgr.remoteTurnPayloads.get('shared')).toMatchObject({
      attachments: [attachment],
      failed: true,
    })
    expect(latestReplayTurnFailure(mgr.remoteEventLog.get('shared') ?? [])?.target).toMatchObject({
      images: [attachment],
    })

    await expect(mgr.sendTurn('shared', 'desktop follow-up', undefined, 'local')).resolves.toEqual({
      status: 'accepted',
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(mgr.remoteTurnPayloads.has('shared')).toBe(false)
    const afterDesktopAcceptance = mgr.remoteEventLog.get('shared') ?? []
    expect(
      afterDesktopAcceptance
        .filter((entry) => entry.type === 'RemoteUserTurn')
        .every((entry) => entry.images === undefined),
    ).toBe(true)
    expect(latestReplayTurnFailure(afterDesktopAcceptance)).toBeUndefined()

    mgr.forward({ type: 'TurnComplete', sessionId: 'shared', stopReason: 'success' })
    expect(mgr.remoteTurnPayloads.has('shared')).toBe(false)
  })

  it('promotes bounded PDF/CSV bytes only for failure and strips them after a successful retry', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    mgr.sessions.set('headless', { sendTurn: vi.fn(() => true) })
    mgr.remoteAttached.add('headless')
    const documents = [
      { mediaType: 'application/pdf', name: 'report.pdf', dataBase64: 'UERG' },
      { mediaType: 'text/csv', name: 'rows.csv', dataBase64: 'Q1NW' },
    ]

    await mgr.sendTurn('headless', 'inspect', documents, 'remote', {
      attemptId: 'attempt-a',
      clientTurnId: 'logical-a',
    })
    expect(mgr.remoteEventLog.get('headless')?.[0]).not.toHaveProperty('images')
    mgr.forward({
      type: 'EngineError',
      sessionId: 'headless',
      message: 'provider rejected the turn',
      fatal: false,
      category: 'turnRejected',
    })
    expect(mgr.remoteEventLog.get('headless')?.[0]).toMatchObject({ images: documents })

    await mgr.sendTurn('headless', 'inspect', documents, 'remote', {
      attemptId: 'attempt-b',
      clientTurnId: 'logical-a',
    })
    mgr.forward({ type: 'TurnComplete', sessionId: 'headless', stopReason: 'success' })
    const userRows = mgr.remoteEventLog
      .get('headless')
      ?.filter((entry) => entry.type === 'RemoteUserTurn') ?? []
    expect(userRows).toHaveLength(2)
    expect(userRows.every((entry) => entry.images === undefined)).toBe(true)
  })

  it('keeps only the latest exact copy across repeated failures of one logical turn', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    mgr.sessions.set('headless', { sendTurn: vi.fn(() => true) })
    mgr.remoteAttached.add('headless')
    const document = [{ mediaType: 'application/pdf', name: 'report.pdf', dataBase64: 'UERG' }]

    for (const attemptId of ['attempt-a', 'attempt-b', 'attempt-c']) {
      await mgr.sendTurn('headless', 'inspect', document, 'remote', {
        attemptId,
        clientTurnId: 'logical-a',
      })
      mgr.forward({
        type: 'EngineError',
        sessionId: 'headless',
        message: `${attemptId} failed`,
        fatal: false,
        category: 'turnRejected',
      })
    }

    const exactRows = mgr.remoteEventLog
      .get('headless')
      ?.filter((entry) => entry.type === 'RemoteUserTurn' && entry.images !== undefined) ?? []
    expect(exactRows).toHaveLength(1)
    expect(exactRows[0]).toMatchObject({ clientTurnId: 'logical-a', images: document })
  })

  it('keeps oversize failure provenance without exact bytes', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    mgr.sessions.set('headless', { sendTurn: vi.fn(() => true) })
    mgr.remoteAttached.add('headless')
    await mgr.sendTurn(
      'headless',
      'inspect',
      [{
        mediaType: 'application/pdf',
        name: 'large.pdf',
        dataBase64: 'A'.repeat(MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS + 1),
      }],
      'remote',
      { attemptId: 'attempt-a', clientTurnId: 'logical-a' },
    )
    mgr.forward({
      type: 'EngineError',
      sessionId: 'headless',
      message: 'too large to retain',
      fatal: false,
      category: 'turnRejected',
    })

    expect(mgr.remoteEventLog.get('headless')?.[0]).toMatchObject({
      hadAttachments: true,
      attachments: [{ mediaType: 'application/pdf', name: 'large.pdf' }],
    })
    expect(mgr.remoteEventLog.get('headless')?.[0]).not.toHaveProperty('images')
  })

  it('settles accepted receipts even when the attachment-payload cap evicts that active turn', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    for (let index = 0; index < 17; index++) {
      const sessionId = `headless-${index}`
      mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true) })
      mgr.remoteAttached.add(sessionId)
      await mgr.sendTurn(sessionId, 'inspect', [image], 'remote', {
        attemptId: `attempt-${index}`,
        clientTurnId: `logical-${index}`,
      })
    }
    expect(mgr.remoteTurnPayloads.size).toBe(16)

    mgr.forward({ type: 'TurnComplete', sessionId: 'headless-0', stopReason: 'success' })
    await expect(
      mgr.sendTurn('headless-0', 'inspect', [image], 'remote', {
        attemptId: 'attempt-0',
        clientTurnId: 'logical-0',
      }),
    ).resolves.toEqual({ status: 'already-complete' })
  })

  it('settles an accepted remote attempt as a retryable terminal failure when its driver crashes', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const send = vi.fn(() => true)
    mgr.sessions.set('headless', { sendTurn: send })
    mgr.remoteAttached.add('headless')
    const document = {
      mediaType: 'application/pdf',
      name: 'brief.pdf',
      dataBase64: 'UERG',
    }
    const identity = { attemptId: 'attempt-a', clientTurnId: 'logical-a' }

    await mgr.sendTurn('headless', 'inspect', [document], 'remote', identity)
    mgr.handleClose('headless')

    expect(mgr.working.has('headless')).toBe(false)
    expect(mgr.activeRemoteAttemptIds.has('headless')).toBe(false)
    expect(mgr.acceptedRemoteAttempts.get('headless')?.get('attempt-a')?.state).toBe('complete')
    const replay = mgr.remoteEventLog.get('headless') ?? []
    const failure = latestReplayTurnFailure(replay)
    expect(failure?.error).toMatchObject({
      type: 'EngineError',
      fatal: true,
      message: 'The engine process stopped before this turn finished.',
    })
    expect(failure?.target).toMatchObject({
      text: 'inspect',
      clientTurnId: 'logical-a',
      images: [document],
    })
    await expect(
      mgr.sendTurn('headless', 'inspect', [document], 'remote', identity),
    ).resolves.toEqual({ status: 'already-complete' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not report intentional dispose or broker recovery as an accepted-turn crash', async () => {
    const disposed = new EngineSessionManager() as unknown as ProvenanceManager
    const disposedSession = {
      sendTurn: vi.fn(() => true),
      dispose: vi.fn(async () => disposed.handleClose('disposed')),
    }
    disposed.sessions.set('disposed', disposedSession)
    disposed.remoteAttached.add('disposed')
    await disposed.sendTurn('disposed', 'keep this logical turn', undefined, 'remote', {
      attemptId: 'attempt-dispose',
      clientTurnId: 'logical-dispose',
    })

    await disposed.dispose('disposed')

    expect(
      disposed.remoteEventLog.get('disposed')?.some((entry) => entry.type === 'EngineError'),
    ).toBe(false)
    expect(
      disposed.acceptedRemoteAttempts.get('disposed')?.get('attempt-dispose')?.state,
    ).toBe('running')

    const recovering = new EngineSessionManager() as unknown as ProvenanceManager
    recovering.sessions.set('recovering', { sendTurn: vi.fn(() => true) })
    recovering.remoteAttached.add('recovering')
    await recovering.sendTurn('recovering', 'continue after reconnect', undefined, 'remote', {
      attemptId: 'attempt-recovery',
      clientTurnId: 'logical-recovery',
    })
    recovering.recoveringBroker.add('recovering')

    recovering.handleClose('recovering')

    expect(
      recovering.remoteEventLog.get('recovering')?.some((entry) => entry.type === 'EngineError'),
    ).toBe(false)
    expect(
      recovering.acceptedRemoteAttempts.get('recovering')?.get('attempt-recovery')?.state,
    ).toBe('running')

    const resumeMiss = new EngineSessionManager() as unknown as ProvenanceManager
    resumeMiss.sessions.set('resume-miss', { sendTurn: vi.fn(() => true) })
    resumeMiss.remoteAttached.add('resume-miss')
    await resumeMiss.sendTurn('resume-miss', 'replay me after restart', undefined, 'remote', {
      attemptId: 'attempt-resume-miss',
      clientTurnId: 'logical-resume-miss',
    })
    resumeMiss.resumeMissRecovery.add('resume-miss')

    resumeMiss.handleClose('resume-miss')

    expect(
      resumeMiss.remoteEventLog.get('resume-miss')?.some((entry) => entry.type === 'EngineError'),
    ).toBe(false)
    expect(
      resumeMiss.acceptedRemoteAttempts.get('resume-miss')?.get('attempt-resume-miss')?.state,
    ).toBe('running')
  })

  it('continues a remote attachment resume miss under its original replay and retry identity', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const sessionId = 'resume-miss-attachment'
    const cwd = '/tmp/koda-resume-miss-attachment'
    const attachment = {
      mediaType: 'image/png',
      name: 'screen.png',
      dataBase64: 'UE5H',
    }
    const identity = {
      attemptId: 'attempt-resume-miss-attachment',
      clientTurnId: 'logical-resume-miss-attachment',
    }
    const firstSend = vi.fn(() => true)
    const replacementSend = vi.fn(() => true)
    const oldSession = {
      sendTurn: firstSend,
      dispose: vi.fn(async () => mgr.handleClose(sessionId)),
    }
    mgr.sessions.set(sessionId, oldSession)
    mgr.remoteAttached.add(sessionId)
    mgr.pendingWorkflowResults.set(sessionId, ['Background review result for the engine only.'])

    await mgr.sendTurn(sessionId, 'inspect this', [attachment], 'remote', identity)

    const held = mgr.pendingTurns.get(sessionId)
    expect(held).toEqual({
      engineText: 'Background review result for the engine only.\n\ninspect this',
      inlineImages: [attachment],
      visible: {
        text: 'inspect this',
        attachments: [attachment],
        origin: 'remote',
        attemptId: identity.attemptId,
        clientTurnId: identity.clientTurnId,
      },
    })
    const boundary = { cwd }
    mgr.projectDirs.set(sessionId, cwd)
    mgr.completionTurns.set(sessionId, boundary)
    mgr.turnReplies.set(sessionId, 'partial answer from the stale child')
    mgr.start = vi.fn(async () => {
      await mgr.dispose(sessionId)
      mgr.sessions.set(sessionId, { sendTurn: replacementSend })
      mgr.projectDirs.set(sessionId, cwd)
      return { sessionId, cwd }
    })

    await mgr.recoverResumeMiss(sessionId)

    expect(replacementSend).toHaveBeenCalledWith(held?.engineText, [attachment])
    expect(mgr.pendingTurns.get(sessionId)).toBe(held)
    expect(mgr.working.has(sessionId)).toBe(true)
    expect(mgr.completionTurns.get(sessionId)).toBe(boundary)
    expect(mgr.turnReplies.get(sessionId)).toBe('partial answer from the stale child')
    expect(mgr.acceptedTurns.get(sessionId)?.session).toBe(mgr.sessions.get(sessionId))
    expect(
      (mgr.remoteEventLog.get(sessionId) ?? []).filter((entry) => entry.type === 'RemoteUserTurn'),
    ).toHaveLength(1)

    // Avoid kicking off completion reconciliation against this synthetic cwd; the assertion above proves
    // recovery retained the boundary, while this terminal now exercises durable retry reconstruction.
    mgr.completionTurns.delete(sessionId)
    mgr.forward({
      type: 'EngineError',
      sessionId,
      message: 'the clean replacement rejected the turn',
      fatal: false,
      category: 'turnRejected',
    })

    const replay = mgr.remoteEventLog.get(sessionId) ?? []
    const transcript = transcriptFromReplay(replay) as Array<Record<string, unknown>>
    const userRows = transcript.filter((row) => row.kind === 'user')
    expect(userRows).toHaveLength(1)
    expect(userRows[0]).toMatchObject({
      text: 'inspect this',
      clientTurnId: identity.clientTurnId,
      attachments: [{ mediaType: 'image/png', name: 'screen.png' }],
      images: [attachment],
    })
    expect(turnFailureOf(userRows[0])?.target).toMatchObject({
      text: 'inspect this',
      clientTurnId: identity.clientTurnId,
      attachments: [{ mediaType: 'image/png', name: 'screen.png' }],
      images: [attachment],
    })
    expect(latestReplayTurnFailure(replay)?.target).toMatchObject({
      text: 'inspect this',
      clientTurnId: identity.clientTurnId,
      images: [attachment],
    })
  })

  it('honors Stop while a resume-miss replacement is still starting', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const sessionId = 'resume-miss-stop-gap'
    const cwd = '/tmp/koda-resume-miss-stop-gap'
    const oldSession = { sendTurn: vi.fn(() => true), interrupt: vi.fn() }
    const replacementSend = vi.fn(() => true)
    const accepted = { generation: 41, cancelled: false, session: oldSession }
    const held: HeldTurn = {
      engineText: 'continue after the missing thread',
      visible: {
        text: 'continue',
        origin: 'remote',
        attemptId: 'attempt-stop-gap',
        clientTurnId: 'logical-stop-gap',
      },
    }
    mgr.sessions.set(sessionId, oldSession)
    mgr.projectDirs.set(sessionId, cwd)
    mgr.working.add(sessionId)
    mgr.acceptedTurns.set(sessionId, accepted)
    mgr.pendingTurns.set(sessionId, held)
    const restoreNotice = 'Reread the restored files before making more changes.'
    mgr.pendingRestoreNotices.set(sessionId, restoreNotice)
    mgr.armedRestoreNotices.set(sessionId, restoreNotice)
    const forwarded: EngineEvent[] = []
    const forward = mgr.forward.bind(mgr)
    mgr.forward = vi.fn((event) => {
      forwarded.push(event)
      return forward(event)
    })

    let enteredStart!: () => void
    let releaseStart!: () => void
    const startEntered = new Promise<void>((resolve) => { enteredStart = resolve })
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async () => {
      // Model the real replacement gap: the old child is gone before the new child is installed.
      mgr.sessions.delete(sessionId)
      enteredStart()
      await startGate
      mgr.sessions.set(sessionId, { sendTurn: replacementSend, interrupt: vi.fn() })
      mgr.projectDirs.set(sessionId, cwd)
      return { sessionId, cwd }
    })

    const recovering = mgr.recoverResumeMiss(sessionId)
    await startEntered
    await mgr.interrupt(sessionId)
    expect(accepted.cancelled).toBe(true)

    releaseStart()
    await recovering

    expect(replacementSend).not.toHaveBeenCalled()
    expect(forwarded).toEqual([
      { type: 'TurnComplete', sessionId, stopReason: 'interrupted' },
    ])
    expect(mgr.working.has(sessionId)).toBe(false)
    expect(mgr.acceptedTurns.has(sessionId)).toBe(false)
    expect(mgr.pendingTurns.has(sessionId)).toBe(false)
    expect(mgr.pendingRestoreNotices.get(sessionId)).toBe(restoreNotice)
    expect(mgr.armedRestoreNotices.has(sessionId)).toBe(false)

    // The stopped replacement never read the restore instruction. Its next genuine turn still must.
    mgr.projectDirs.delete(sessionId)
    await mgr.sendTurn(sessionId, 'next message')
    expect(replacementSend).toHaveBeenCalledTimes(1)
    expect(replacementSend).toHaveBeenCalledWith(`${restoreNotice}\n\nnext message`, undefined)
  })

  it('a delayed Stop follows the same logical generation but never reaches its successor', async () => {
    const stopAcrossReplacement = async (replacementGeneration: number) => {
      const mgr = new EngineSessionManager() as unknown as ProvenanceManager
      const sessionId = `delayed-stop-${replacementGeneration}`
      const oldSession = { sendTurn: vi.fn(() => true), interrupt: vi.fn() }
      const replacementInterrupt = vi.fn()
      const accepted = { generation: 7, cancelled: false, session: oldSession }
      mgr.sessions.set(sessionId, oldSession)
      mgr.acceptedTurns.set(sessionId, accepted)

      let enteredSweep!: () => void
      let releaseSweep!: () => void
      const sweepEntered = new Promise<void>((resolve) => { enteredSweep = resolve })
      const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve })
      mgr.stopDelegatedChildren = vi.fn(async () => {
        enteredSweep()
        await sweepGate
      })

      const stopping = mgr.interrupt(sessionId)
      await sweepEntered
      expect(accepted.cancelled).toBe(true)
      const replacement = {
        sendTurn: vi.fn(() => true),
        interrupt: replacementInterrupt,
      }
      mgr.sessions.set(sessionId, replacement)
      mgr.acceptedTurns.set(sessionId, {
        generation: replacementGeneration,
        cancelled: replacementGeneration === accepted.generation,
        session: replacement,
      })
      releaseSweep()
      await stopping
      return replacementInterrupt
    }

    expect(await stopAcrossReplacement(7)).toHaveBeenCalledTimes(1)
    expect(await stopAcrossReplacement(8)).not.toHaveBeenCalled()
  })

  it('ignores a stale close after a replacement generation is installed under the same id', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const successor = { sendTurn: vi.fn(() => true) }
    const oldGeneration = Symbol('old')
    const successorGeneration = Symbol('successor')
    mgr.sessions.set('replaced', successor)
    mgr.sessionGenerations.set('replaced', successorGeneration)
    mgr.remoteAttached.add('replaced')
    await mgr.sendTurn('replaced', 'successor turn', undefined, 'remote', {
      attemptId: 'attempt-successor',
      clientTurnId: 'logical-successor',
    })

    mgr.handleClose('replaced', oldGeneration)

    expect(mgr.sessions.get('replaced')).toBe(successor)
    expect(mgr.sessionGenerations.get('replaced')).toBe(successorGeneration)
    expect(mgr.working.has('replaced')).toBe(true)
    expect(mgr.activeRemoteAttemptIds.get('replaced')).toBe('attempt-successor')
    expect(
      mgr.remoteEventLog.get('replaced')?.some((entry) => entry.type === 'EngineError'),
    ).toBe(false)
    await expect(
      mgr.sendTurn('replaced', 'successor turn', undefined, 'remote', {
        attemptId: 'attempt-successor',
        clientTurnId: 'logical-successor',
      }),
    ).resolves.toEqual({ status: 'already-running' })
    expect(successor.sendTurn).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale TurnComplete after successor B is accepted under the same id', async () => {
    const mgr = new EngineSessionManager() as unknown as ProvenanceManager
    const successor = { sendTurn: vi.fn(() => true) }
    const oldGeneration = Symbol('old')
    const successorGeneration = Symbol('successor')
    mgr.sessions.set('replaced-event', successor)
    mgr.sessionGenerations.set('replaced-event', successorGeneration)
    mgr.remoteAttached.add('replaced-event')
    await mgr.sendTurn('replaced-event', 'successor B', [image], 'remote', {
      attemptId: 'attempt-successor-b',
      clientTurnId: 'logical-successor-b',
    })
    const acceptedB = mgr.acceptedTurns.get('replaced-event')
    const pendingB = mgr.pendingTurns.get('replaced-event')
    const payloadB = mgr.remoteTurnPayloads.get('replaced-event')

    mgr.forwardProcessEvent(
      { type: 'TurnComplete', sessionId: 'replaced-event', stopReason: 'stale A ended' },
      oldGeneration,
    )

    expect(mgr.sessions.get('replaced-event')).toBe(successor)
    expect(mgr.sessionGenerations.get('replaced-event')).toBe(successorGeneration)
    expect(mgr.working.has('replaced-event')).toBe(true)
    expect(mgr.acceptedTurns.get('replaced-event')).toBe(acceptedB)
    expect(acceptedB?.session).toBe(successor)
    expect(mgr.pendingTurns.get('replaced-event')).toBe(pendingB)
    expect(mgr.remoteTurnPayloads.get('replaced-event')).toBe(payloadB)
    expect(payloadB).toMatchObject({
      attemptId: 'attempt-successor-b',
      clientTurnId: 'logical-successor-b',
      attachments: [image],
      failed: false,
    })
    expect(
      mgr.acceptedRemoteAttempts.get('replaced-event')?.get('attempt-successor-b')?.state,
    ).toBe('running')
    expect(
      mgr.remoteEventLog
        .get('replaced-event')
        ?.some((entry) => entry.type === 'TurnComplete'),
    ).toBe(false)
  })
})

describe('remote session labels', () => {
  type LabelManager = {
    sessions: Map<string, { sendTurn: ReturnType<typeof vi.fn> }>
    projectDirs: Map<string, string>
    remoteEventLog: Map<string, ReplayEntry[]>
    sendTurn: (sessionId: string, text: string) => Promise<unknown>
    titleRemoteSession: (sessionId: string, cwd: string, text: string) => void
    nameSession: ReturnType<typeof vi.fn>
    remoteSessionList: () => Array<{ id: string; label: string }>
  }

  it('uses an accepted Mac prompt before the session has ever been remote-attached', async () => {
    const mgr = new EngineSessionManager() as unknown as LabelManager
    const cwd = mkdtempSync(join(tmpdir(), 'koda-live-session-label-'))
    const sessionId = 'live-mac-session'
    try {
      mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true) })
      await mgr.sendTurn(sessionId, 'Restore the missing session names in previews')
      mgr.projectDirs.set(sessionId, cwd)

      expect(mgr.remoteEventLog.has(sessionId)).toBe(false)
      expect(mgr.remoteSessionList()).toContainEqual(
        expect.objectContaining({
          id: sessionId,
          label: 'Restore the missing session names in pre…',
        }),
      )
    } finally {
      purgeProjectSessions(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('replaces project-name placeholders but keeps a real persisted session name', () => {
    const mgr = new EngineSessionManager() as unknown as LabelManager
    const cwd = mkdtempSync(join(tmpdir(), 'koda-persisted-session-label-'))
    const sessionId = 'named-phone-session'
    try {
      saveProjectSessions(cwd, {
        version: 3,
        activeId: sessionId,
        sessions: [
          {
            id: sessionId,
            label: basename(cwd),
            cwd,
            userNamed: false,
            items: [{ kind: 'user', text: 'Recover a useful title from the saved conversation' }],
          },
        ],
      })
      mgr.sessions.set(sessionId, { sendTurn: vi.fn(() => true) })
      mgr.projectDirs.set(sessionId, cwd)

      expect(mgr.remoteSessionList()).toContainEqual(
        expect.objectContaining({
          id: sessionId,
          label: 'Recover a useful title from the saved co…',
        }),
      )

      mgr.nameSession = vi.fn().mockRejectedValue(new Error('skip generated refinement'))
      mgr.titleRemoteSession(sessionId, cwd, 'Name this phone-started conversation')
      expect(mgr.remoteSessionList()).toContainEqual(
        expect.objectContaining({ id: sessionId, label: 'Name this phone-started conversation' }),
      )

      saveProjectSessions(cwd, {
        version: 3,
        activeId: sessionId,
        sessions: [
          {
            id: sessionId,
            label: 'Session naming fix',
            cwd,
            userNamed: false,
            items: [{ kind: 'user', text: 'This fallback should not replace the real name' }],
          },
        ],
      })

      expect(mgr.remoteSessionList()).toContainEqual(
        expect.objectContaining({ id: sessionId, label: 'Session naming fix' }),
      )
    } finally {
      purgeProjectSessions(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('phone-started session titles', () => {
  it('records a new phone session as phone-origin independently of remote attachment', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      startedFromRemote: Set<string>
      remoteProjectList: () => Array<{ path: string }>
      start: (opts: Record<string, unknown>) => Promise<{ sessionId: string }>
      attachRemote: (sessionId: string) => void
      notifyDesktopOfHeadless: (cwd: string) => void
      startNewRemote: (projectPath: string) => Promise<{ sessionId: string }>
    }
    mgr.remoteProjectList = vi.fn(() => [{ path: '/tmp/project' }])
    mgr.start = vi.fn(async () => ({ sessionId: 'phone-new' }))
    mgr.attachRemote = vi.fn()
    mgr.notifyDesktopOfHeadless = vi.fn()

    await mgr.startNewRemote('/tmp/project')

    expect(mgr.startedFromRemote.has('phone-new')).toBe(true)
    expect(mgr.attachRemote).toHaveBeenCalledWith('phone-new')
  })

  it('does not mistake a desktop session joined by phone for an idempotent phone start', async () => {
    const desktopId = '2fe14ca1-f908-444a-915f-64c90a520d9c'
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      remoteAttached: Set<string>
      remoteProjectList: () => Array<{ path: string }>
      start: (opts: Record<string, unknown>) => Promise<{ sessionId: string }>
      attachRemote: (sessionId: string) => void
      notifyDesktopOfHeadless: (cwd: string) => void
      startNewRemote: (projectPath: string, sessionId?: string) => Promise<{ sessionId: string }>
    }
    mgr.sessions.set(desktopId, {})
    mgr.projectDirs.set(desktopId, '/tmp/project')
    mgr.remoteAttached.add(desktopId)
    mgr.remoteProjectList = vi.fn(() => [{ path: '/tmp/project' }])
    mgr.start = vi.fn(async () => ({ sessionId: 'phone-fresh' }))
    mgr.attachRemote = vi.fn()
    mgr.notifyDesktopOfHeadless = vi.fn()

    await expect(mgr.startNewRemote('/tmp/project', desktopId)).resolves.toEqual({
      sessionId: 'phone-fresh',
    })
  })

  it('treats a persisted phone placeholder as unnamed when the first text arrives windowless', async () => {
    type RemoteTitleHarness = {
      titleRemoteSession: (sessionId: string, cwd: string, text: string) => void
      projectStore: (cwd: string) => {
        sessions: Array<{ id: string; label?: string; userNamed?: boolean }>
      }
      persistRemoteTitle: (...args: unknown[]) => void
      nameSession: (req: unknown) => Promise<{ title: string; overview: string }>
      takenRemoteTitles: (cwd: string, excludeId: string) => string[]
    }
    const mgr = new EngineSessionManager() as unknown as RemoteTitleHarness
    mgr.projectStore = vi.fn(() => ({
      sessions: [{ id: 'phone', label: 'From your phone', userNamed: false }],
    }))
    mgr.persistRemoteTitle = vi.fn()
    mgr.takenRemoteTitles = vi.fn(() => [])
    mgr.nameSession = vi.fn(async () => ({
      title: 'Phone Session Naming',
      overview: '',
    }))

    mgr.titleRemoteSession('phone', '/tmp/project', 'fix the phone session naming')

    expect(mgr.persistRemoteTitle).toHaveBeenCalledWith('/tmp/project', 'phone', 'fix the phone session naming')
    expect(mgr.nameSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'initial',
        evidence: 'fix the phone session naming',
      }),
    )
    await vi.waitFor(() =>
      expect(mgr.persistRemoteTitle).toHaveBeenLastCalledWith(
        '/tmp/project',
        'phone',
        'Phone Session Naming',
        false,
        '',
      ),
    )
  })
})

describe('hidden read-only Dream session', () => {
  it('marks REM read-only without exposing it for live adoption', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      start: (args: { sessionId?: string }) => Promise<{ sessionId: string }>
      gate: { setReadOnly: (id: string, on: boolean) => void }
      remoteAttached: Set<string>
      hiddenDreamSessions: Set<string>
      persistRemoteTitle: (...args: unknown[]) => void
      startDreamSession: (
        cwd: string,
        label: string,
        options: { visible?: boolean; readOnly?: boolean },
      ) => Promise<{ sessionId: string }>
    }
    mgr.start = vi.fn(async ({ sessionId }) => ({ sessionId: sessionId! }))
    mgr.persistRemoteTitle = vi.fn()
    const readOnly = vi.spyOn(mgr.gate, 'setReadOnly')

    const started = await mgr.startDreamSession('/tmp/koda-rem-hidden', 'Dream REM', {
      visible: false,
      readOnly: true,
    })

    expect(readOnly).toHaveBeenCalledWith(started.sessionId, true)
    expect(mgr.remoteAttached.has(started.sessionId)).toBe(false)
    expect(mgr.hiddenDreamSessions.has(started.sessionId)).toBe(true)
    expect(mgr.persistRemoteTitle).not.toHaveBeenCalled()
  })

  it('keeps a tidy out of both live discovery and persisted hydration until reveal', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      start: (args: { sessionId?: string }) => Promise<{ sessionId: string }>
      attachRemote: (id: string) => void
      notifyDesktopOfHeadless: (cwd: string) => void
      remoteAttached: Set<string>
      deferredDreamVisibility: Set<string>
      startDreamSession: (
        cwd: string,
        label: string,
        options: { memoryOnly?: boolean; deferVisibility?: boolean },
      ) => Promise<{ sessionId: string }>
      revealDreamSession: (id: string) => void
      loadSessionsForProject: (cwd: string) => { sessions: Array<{ id: string; label: string }> } | null
    }
    const cwd = mkdtempSync(join(tmpdir(), 'koda-dream-deferred-'))
    mgr.start = vi.fn(async ({ sessionId }) => ({ sessionId: sessionId! }))
    const attachRemote = vi.spyOn(mgr, 'attachRemote')
    mgr.notifyDesktopOfHeadless = vi.fn()
    try {
      const started = await mgr.startDreamSession(cwd, 'Dream · 2026-08-11', {
        memoryOnly: true,
        deferVisibility: true,
      })
      const id = started.sessionId

      expect(mgr.deferredDreamVisibility.has(id)).toBe(true)
      expect(mgr.remoteAttached.has(id)).toBe(true)
      expect(attachRemote).toHaveBeenCalledWith(id)
      expect(mgr.notifyDesktopOfHeadless).not.toHaveBeenCalled()
      expect(mgr.loadSessionsForProject(cwd)?.sessions ?? []).toEqual([])

      // The real start() owns these maps; the focused fake supplies them before exercising reveal.
      mgr.sessions.set(id, {})
      mgr.projectDirs.set(id, cwd)
      mgr.revealDreamSession(id)

      expect(mgr.deferredDreamVisibility.has(id)).toBe(false)
      expect(attachRemote).toHaveBeenCalledTimes(2)
      expect(mgr.notifyDesktopOfHeadless).toHaveBeenCalledWith(cwd)
      expect(mgr.loadSessionsForProject(cwd)?.sessions).toContainEqual(
        expect.objectContaining({ id, label: 'Dream · 2026-08-11' }),
      )
    } finally {
      purgeProjectSessions(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('lets a live project window adopt the locked Dream label and complete replay without a competing store write', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, { sendTurn: ReturnType<typeof vi.fn> }>
      projectDirs: Map<string, string>
      start: (args: { sessionId?: string }) => Promise<{ sessionId: string }>
      safeCheckpointResult: ReturnType<typeof vi.fn>
      startDreamSession: (
        cwd: string,
        label: string,
        options: { memoryOnly?: boolean; deferVisibility?: boolean },
      ) => Promise<{ sessionId: string }>
      sendTurn: (id: string, text: string) => Promise<void>
      forward: (event: unknown) => unknown
      revealDreamSession: (id: string) => void
      loadSessionsForProject: (cwd: string) => { sessions: Array<{ id: string }> } | null
      remoteSessionList: () => Array<{ id: string; label: string }>
      renameRemote: (id: string, label: string) => void
      adoptHeadlessForWindow: (
        windowId: number,
        cwd: string,
      ) => Array<{
        id: string
        label?: string
        userNamed?: boolean
        events: Array<{ type: string; text?: string; markdown?: string }>
      }>
    }
    const cwd = mkdtempSync(join(tmpdir(), 'koda-dream-window-adoption-'))
    const windowId = 817_205
    const win = {
      id: windowId,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    // Production window registration stores a realpath-resolved project root.
    registerWindow(win as never, realpathSync(cwd))
    mgr.start = vi.fn(async ({ sessionId }) => ({ sessionId: sessionId! }))
    mgr.safeCheckpointResult = vi.fn().mockResolvedValue(null)
    try {
      const { sessionId } = await mgr.startDreamSession(cwd, 'Dream · 2026-08-11', {
        memoryOnly: true,
        deferVisibility: true,
      })
      mgr.sessions.set(sessionId, { sendTurn: vi.fn() })
      mgr.projectDirs.set(sessionId, cwd)

      await mgr.sendTurn(sessionId, 'Tidy the project memory.')
      mgr.forward({ type: 'AssistantBlock', sessionId, markdown: 'Memory tidy complete.' })
      mgr.revealDreamSession(sessionId)

      // Main did not race the open renderer for ownership of the whole session-store blob.
      expect(mgr.loadSessionsForProject(cwd)?.sessions ?? []).toEqual([])
      const adopted = mgr.adoptHeadlessForWindow(windowId, cwd)
      expect(adopted).toHaveLength(1)
      expect(adopted[0]).toMatchObject({
        id: sessionId,
        label: 'Dream · 2026-08-11',
        userNamed: true,
      })
      expect(adopted[0].events).toEqual([
        expect.objectContaining({ type: 'RemoteUserTurn', text: 'Tidy the project memory.' }),
        expect.objectContaining({ type: 'AssistantBlock', markdown: 'Memory tidy complete.' }),
      ])
      // Adoption is not a persistence acknowledgement. Keep the pending lock across a renderer
      // reload so a crash between IPC return and the renderer's store write cannot lose the title.
      expect(mgr.adoptHeadlessForWindow(windowId, cwd)[0]).toMatchObject({
        label: 'Dream · 2026-08-11',
        userNamed: true,
      })

      // Once the renderer durably persists a user rename, it acknowledges ownership and supersedes
      // the provisional dated lock for both phone lists and later renderer adoption.
      saveProjectSessions(cwd, {
        version: 3,
        activeId: sessionId,
        sessions: [
          {
            id: sessionId,
            label: 'Dream notes I renamed',
            cwd,
            userNamed: true,
            items: [],
          },
        ],
      })
      expect(mgr.remoteSessionList()).toContainEqual(
        expect.objectContaining({ id: sessionId, label: 'Dream notes I renamed' }),
      )
      expect(mgr.adoptHeadlessForWindow(windowId, cwd)[0]).toMatchObject({
        label: 'Dream notes I renamed',
        userNamed: true,
      })

      // The windowless phone rename path owns the store directly and must also keep the old pending
      // Dream label from resurfacing on the next window adoption.
      unregisterWindow(windowId)
      mgr.renameRemote(sessionId, 'Dream notes from phone')
      registerWindow(win as never, realpathSync(cwd))
      expect(mgr.adoptHeadlessForWindow(windowId, cwd)[0]).toMatchObject({
        label: 'Dream notes from phone',
        userNamed: true,
      })
    } finally {
      unregisterWindow(windowId)
      purgeRemoteReplayProject(cwd)
      purgeProjectSessions(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('leaves no persisted row when a deferred tidy ends before reveal', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, { dispose: () => Promise<void> }>
      projectDirs: Map<string, string>
      start: (args: { sessionId?: string }) => Promise<{ sessionId: string }>
      deferredDreamVisibility: Set<string>
      startDreamSession: (
        cwd: string,
        label: string,
        options: { memoryOnly?: boolean; deferVisibility?: boolean },
      ) => Promise<{ sessionId: string }>
      dispose: (id: string) => Promise<void>
      forgetSession: (id: string) => void
      loadSessionsForProject: (cwd: string) => { sessions: Array<{ id: string }> } | null
    }
    const cwd = mkdtempSync(join(tmpdir(), 'koda-dream-aborted-'))
    mgr.start = vi.fn(async ({ sessionId }) => ({ sessionId: sessionId! }))
    try {
      const { sessionId } = await mgr.startDreamSession(cwd, 'Dream · 2026-08-11', {
        memoryOnly: true,
        deferVisibility: true,
      })
      mgr.sessions.set(sessionId, { dispose: vi.fn().mockResolvedValue(undefined) })
      mgr.projectDirs.set(sessionId, cwd)

      await mgr.dispose(sessionId)
      mgr.forgetSession(sessionId)

      expect(mgr.deferredDreamVisibility.has(sessionId)).toBe(false)
      expect(mgr.loadSessionsForProject(cwd)?.sessions ?? []).toEqual([])
    } finally {
      purgeProjectSessions(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('releases the hidden identity and start metadata when both engine starts fail', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      dreamSessions: Set<string>
      deferredDreamVisibility: Set<string>
      start: (args: { cwd?: string; sessionId?: string }) => Promise<{ sessionId: string }>
      startDreamSession: (
        cwd: string,
        label: string,
        options: { memoryOnly?: boolean; deferVisibility?: boolean },
      ) => Promise<{ sessionId: string }>
    }
    mgr.start = vi.fn(async ({ cwd, sessionId }) => {
      mgr.projectDirs.set(sessionId!, cwd!) // mirror the intent maps a real partial start may leave
      throw new Error('engine unavailable')
    })

    await expect(
      mgr.startDreamSession('/tmp/koda-dream-start-failure', 'Dream · 2026-08-11', {
        memoryOnly: true,
        deferVisibility: true,
      }),
    ).rejects.toThrow('engine unavailable')

    expect(mgr.start).toHaveBeenCalledTimes(2)
    expect(mgr.dreamSessions.size).toBe(0)
    expect(mgr.deferredDreamVisibility.size).toBe(0)
    expect(mgr.projectDirs.size).toBe(0)
  })
})

/**
 * recoverBroker respawns a session in place (dispose + reattach) to reconnect a dropped broker
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
  it('honors Stop while the replacement is starting and never auto-resumes that generation', async () => {
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<
        string,
        {
          sendTurn: ReturnType<typeof vi.fn>
          interrupt?: ReturnType<typeof vi.fn>
        }
      >
      projectDirs: Map<string, string>
      working: Set<string>
      acceptedTurns: Map<string, { generation: number; cancelled: boolean; session: unknown }>
      pendingTurns: Map<
        string,
        { engineText: string; visible: { text: string; origin: 'local' | 'remote' } }
      >
      resumeAfterReconnect: Map<string, number | undefined>
      forward: (event: EngineEvent) => unknown
      start: (opts: { sessionId: string; cwd: string }) => Promise<{ sessionId: string; cwd: string }>
      recoverBroker: (sessionId: string) => Promise<void>
      interrupt: (sessionId: string) => Promise<void>
    }
    const sessionId = 'sess-broker-stop-gap'
    const cwd = '/tmp/koda-broker-stop-gap'
    const oldSession = { sendTurn: vi.fn(() => true), interrupt: vi.fn() }
    const replacementSend = vi.fn(() => true)
    const accepted = { generation: 73, cancelled: false, session: oldSession }
    mgr.sessions.set(sessionId, oldSession)
    mgr.projectDirs.set(sessionId, cwd)
    mgr.working.add(sessionId)
    mgr.acceptedTurns.set(sessionId, accepted)
    mgr.pendingTurns.set(sessionId, {
      engineText: 'continue after reconnect',
      visible: { text: 'continue', origin: 'local' },
    })

    const forwarded: EngineEvent[] = []
    const forward = mgr.forward.bind(mgr)
    mgr.forward = vi.fn((event) => {
      forwarded.push(event)
      return forward(event)
    })
    let enteredStart!: () => void
    let releaseStart!: () => void
    const startEntered = new Promise<void>((resolve) => { enteredStart = resolve })
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    mgr.start = vi.fn(async () => {
      mgr.sessions.delete(sessionId)
      enteredStart()
      await startGate
      mgr.sessions.set(sessionId, { sendTurn: replacementSend, interrupt: vi.fn() })
      mgr.projectDirs.set(sessionId, cwd)
      return { sessionId, cwd }
    })

    const recovering = mgr.recoverBroker(sessionId)
    await startEntered
    await mgr.interrupt(sessionId)
    expect(accepted.cancelled).toBe(true)

    releaseStart()
    await recovering

    expect(replacementSend).not.toHaveBeenCalled()
    expect(mgr.resumeAfterReconnect.has(sessionId)).toBe(false)
    expect(forwarded).toContainEqual({
      type: 'TurnComplete',
      sessionId,
      stopReason: 'interrupted',
    })
    expect(mgr.working.has(sessionId)).toBe(false)
    expect(mgr.acceptedTurns.has(sessionId)).toBe(false)
    expect(mgr.pendingTurns.has(sessionId)).toBe(false)
  })

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
      expect.objectContaining({ sessionId, planMode: true, abandonActiveDelegation: true }),
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
      expect.objectContaining({ planMode: false, abandonActiveDelegation: true }),
    )
  })

  it('keeps the pre-drop mutation boundary and live diff baseline through auto-continuation', async () => {
    type Boundary = {
      cwd: string
      safetyCommit: string
      userGit: { kind: 'repo'; dirty: string[] }
      mutationSeen: boolean
      overlappingWriters: boolean
    }
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, { sendTurn: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>
      projectDirs: Map<string, string>
      completionTurns: Map<string, Boundary>
      diffBaselines: Map<string, string>
      turnReplies: Map<string, string>
      safeCheckpointResult: ReturnType<typeof vi.fn>
      start: (...args: unknown[]) => Promise<{ sessionId: string; cwd: string }>
      dispose: (sessionId: string) => Promise<void>
      recoverBroker: (sessionId: string) => Promise<void>
      forward: (event: unknown) => unknown
    }
    const sessionId = 'sess-recover-completion'
    const cwd = '/tmp/koda-recover-completion'
    const engineSend = vi.fn()
    const engineDispose = vi.fn().mockResolvedValue(undefined)
    const boundary: Boundary = {
      cwd,
      safetyCommit: 'pre-human-turn',
      userGit: { kind: 'repo', dirty: [] },
      mutationSeen: true, // the pre-drop write already crossed the broker boundary
      overlappingWriters: false,
    }
    mgr.sessions.set(sessionId, { sendTurn: engineSend, dispose: engineDispose })
    mgr.projectDirs.set(sessionId, cwd)
    mgr.completionTurns.set(sessionId, boundary)
    mgr.diffBaselines.set(sessionId, 'pre-human-turn')
    mgr.turnReplies.set(sessionId, 'Work completed before the broker drop.')
    mgr.safeCheckpointResult = vi.fn()
    mgr.start = vi.fn(async () => {
      // Exercise the real broker-recovery teardown. It clears process-owned state while retaining the
      // reply accumulated by this still-live logical turn.
      await mgr.dispose(sessionId)
      mgr.sessions.set(sessionId, { sendTurn: engineSend, dispose: engineDispose })
      mgr.projectDirs.set(sessionId, cwd)
      return { sessionId, cwd }
    })

    await mgr.recoverBroker(sessionId)
    expect(engineDispose).toHaveBeenCalledTimes(1)
    expect(mgr.diffBaselines.get(sessionId)).toBe('pre-human-turn')

    mgr.forward({
      type: 'SessionStarted',
      sessionId,
      model: 'test-model',
      tools: [],
      cwd,
    })
    await vi.waitFor(() => expect(engineSend).toHaveBeenCalledTimes(1))

    expect(mgr.completionTurns.get(sessionId)).toBe(boundary)
    expect(mgr.completionTurns.get(sessionId)).toMatchObject({
      safetyCommit: 'pre-human-turn',
      mutationSeen: true,
    })
    expect(mgr.diffBaselines.get(sessionId)).toBe('pre-human-turn')
    expect(mgr.turnReplies.get(sessionId)).toBe('Work completed before the broker drop.')
    expect(mgr.safeCheckpointResult).not.toHaveBeenCalled()

    // No post-reconnect write is needed: reconciliation still compares the final tree to the original
    // human-turn checkpoint and therefore keeps the pre-drop path loose.
    const completion = await reconcileCompletionState(sessionId, boundary, new Map(), {
      changes: async (_project, checkpointId) => {
        expect(checkpointId).toBe('pre-human-turn')
        return {
          files: [
            {
              path: 'src/pre-drop.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
          truncated: false,
        }
      },
      statusForPaths: async () => ({ kind: 'repo', dirty: ['src/pre-drop.ts'] }),
      snapshot: async () => ({ kind: 'repo', dirty: ['src/pre-drop.ts'] }),
    })
    expect(completion.state).toMatchObject({
      state: 'loose-ends',
      paths: ['src/pre-drop.ts'],
    })
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
      workflowWatchers: Map<
        string,
        {
          sessionId: string
          watcher: { activeAgentIds: () => string[]; isLive: () => boolean }
        }
      >
      sessionCapabilities: Map<string, Record<string, unknown>>
      adoptHeadlessForWindow: (
        requestedWindowId: number,
        requestedProjectPath: string,
      ) => Array<{
          id: string
          fromRemote?: boolean
          working?: boolean
          activeSubagentToolUseIds?: string[]
          activeWorkflows?: Array<{ runId: string; runningAgentIds: string[] }>
          capabilities?: { tools: string[] }
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
      mgr.workflowWatchers.set('review', {
        sessionId: 'local-live',
        watcher: { activeAgentIds: () => ['critic'], isLive: () => true },
      })
      mgr.sessionCapabilities.set('local-live', {
        engine: 'codex',
        cwd: projectPath,
        observedAt: 123,
        source: 'native-probe',
        capabilities: [],
        tools: ['mcp__koda_broker__capabilities'],
        skills: ['koda:code-work'],
        agents: [],
        plugins: ['koda'],
        mcpServers: [],
      })

      expect(mgr.adoptHeadlessForWindow(windowId, projectPath)).toEqual([
        expect.objectContaining({
          id: 'local-live',
          fromRemote: false,
          working: true,
          activeSubagentToolUseIds: ['agent-1'],
          activeWorkflows: [{ runId: 'review', runningAgentIds: ['critic'] }],
          capabilities: expect.objectContaining({
            tools: ['mcp__koda_broker__capabilities'],
          }),
        }),
      ])
    } finally {
      unregisterWindow(windowId)
    }
  })

  it('reports phone origin separately from remote survival', () => {
    const projectPath = '/tmp/koda-origin-contract-project'
    const windowId = 817_205
    const win = {
      id: windowId,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    registerWindow(win as never, projectPath)
    addSessionToWindow(windowId, 'desktop-live')
    const mgr = new EngineSessionManager() as unknown as {
      sessions: Map<string, unknown>
      projectDirs: Map<string, string>
      remoteAttached: Set<string>
      startedFromRemote: Set<string>
      adoptHeadlessForWindow: (
        requestedWindowId: number,
        requestedProjectPath: string,
      ) => Array<{ id: string; fromRemote?: boolean }>
    }
    try {
      mgr.sessions.set('desktop-live', {})
      mgr.projectDirs.set('desktop-live', projectPath)
      // A phone may join this desktop-created session; that only changes its survival policy.
      mgr.remoteAttached.add('desktop-live')
      mgr.sessions.set('phone-live', {})
      mgr.projectDirs.set('phone-live', projectPath)
      mgr.remoteAttached.add('phone-live')
      mgr.startedFromRemote.add('phone-live')

      const adopted = mgr.adoptHeadlessForWindow(windowId, projectPath)
      expect(adopted.find((session) => session.id === 'desktop-live')?.fromRemote).toBe(false)
      expect(adopted.find((session) => session.id === 'phone-live')?.fromRemote).toBe(true)
    } finally {
      unregisterWindow(windowId)
    }
  })
})

describe('remote replay identity after an archive restore', () => {
  it('replaces stale advertised tools when a runtime snapshot becomes empty', () => {
    const mgr = new EngineSessionManager() as unknown as {
      advertisedTools: Map<string, string[]>
      sessionCapabilities: Map<string, { tools: string[] }>
      forward: (event: Record<string, unknown>) => Record<string, unknown> | undefined
    }
    mgr.advertisedTools.set('session', ['mcp__koda_broker__capabilities'])

    mgr.forward({
      type: 'SessionCapabilitiesUpdated',
      sessionId: 'session',
      snapshot: {
        engine: 'codex',
        cwd: '/tmp/project',
        observedAt: Date.now(),
        source: 'native-probe',
        capabilities: [],
        tools: [],
        skills: [],
        agents: [],
        plugins: [],
        mcpServers: [],
      },
    })

    expect(mgr.advertisedTools.get('session')).toEqual([])
    expect(mgr.sessionCapabilities.get('session')?.tools).toEqual([])
  })

  it('keeps runtime capability snapshots out of durable replay', () => {
    const mgr = new EngineSessionManager() as unknown as {
      remoteAttached: Set<string>
      remoteEventLog: Map<string, unknown[]>
      bufferRemoteEvent: (event: Record<string, unknown>) => Record<string, unknown>
    }
    mgr.remoteAttached.add('remote')
    const event = {
      type: 'SessionCapabilitiesUpdated',
      sessionId: 'remote',
      snapshot: {
        engine: 'codex',
        cwd: '/tmp/project',
        observedAt: Date.now(),
        source: 'native-probe',
        capabilities: [],
        tools: ['mcp__koda_broker__capabilities'],
        skills: ['koda:code-work'],
        agents: [],
        plugins: ['koda'],
        mcpServers: [],
      },
    }

    expect(mgr.bufferRemoteEvent(event)).toBe(event)
    expect(mgr.remoteEventLog.has('remote')).toBe(false)
  })

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
      startedFromRemote: Set<string>
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
    expect(mgr.startedFromRemote.has('restored')).toBe(true)
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
        version: 3,
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

  it('bounds top-level and delegated tool results after durable replay is folded in', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'koda-replay-output-bound-'))
    const mgr = new EngineSessionManager() as unknown as {
      remoteEventLog: Map<string, Array<Record<string, unknown>>>
      loadSessionsForProject: (path: string) => {
        sessions: Array<{ id: string; items: Array<Record<string, unknown>> }>
      } | null
    }
    const oversized = `early-marker-${'x'.repeat(3_000)}-latest-marker`
    try {
      saveProjectSessions(projectPath, {
        version: 3,
        activeId: 'top',
        sessions: [
          { id: 'top', label: 'Top level', cwd: projectPath, items: [] },
          { id: 'delegated', label: 'Delegated', cwd: projectPath, items: [] },
        ],
      })
      mgr.remoteEventLog.set('top', [
        { type: 'ToolRequested', sessionId: 'top', id: 'tool-1', name: 'Bash', input: {} },
        { type: 'ToolResult', sessionId: 'top', id: 'tool-1', output: oversized, isError: false },
      ])
      mgr.remoteEventLog.set('delegated', [
        {
          type: 'SubagentStarted',
          sessionId: 'delegated',
          toolUseId: 'agent-1',
          subagentType: 'worker',
          description: 'Inspect output',
        },
        {
          type: 'ToolRequested',
          sessionId: 'delegated',
          id: 'child-tool-1',
          name: 'Bash',
          input: {},
          parentToolUseId: 'agent-1',
        },
        {
          type: 'ToolResult',
          sessionId: 'delegated',
          id: 'child-tool-1',
          output: oversized,
          isError: false,
          parentToolUseId: 'agent-1',
        },
      ])

      const restored = mgr.loadSessionsForProject(projectPath)?.sessions ?? []
      const topResult = restored
        .find((session) => session.id === 'top')
        ?.items.find((item) => item.kind === 'tool')?.result
      const delegated = restored.find((session) => session.id === 'delegated')?.items[0]
      const childResult = (delegated?.children as Array<Record<string, unknown>> | undefined)?.find(
        (item) => item.kind === 'tool',
      )?.result

      for (const result of [topResult, childResult]) {
        expect(result).toBeTypeOf('string')
        expect(result).toHaveLength(2_000)
        expect(result).toContain('latest-marker')
        expect(result).not.toContain('early-marker')
      }
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
      forgetSession: (id: string) => void
      disposeForWindow: (id: string) => Promise<void>
      disposeAll: () => Promise<void>
      disposeHeadlessRemote: () => Promise<void>
      reapDreamSessions: () => Promise<void>
      archiveRemote: (id: string, projectPath: string) => Promise<void>
      interrupt: (id: string) => void
      projectStore: (cwd: string) => unknown
      workflowWatchers: Map<string, { sessionId: string; watcher: { stop: ReturnType<typeof vi.fn> } }>
      remoteEventLog: Map<string, unknown[]>
      forward: (event: unknown) => unknown
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

  it('a throwing dispose cannot leave a workflow watcher that recreates forgotten replay', async () => {
    const { mgr } = mgrWithSpies()
    const stop = vi.fn(() => {
      // WorkflowWatcher.stop() publishes this synchronously when an observed member never settled.
      mgr.forward({
        type: 'WorkflowObservationEnded',
        sessionId: 's1',
        runId: 'review',
        unresolvedAgentIds: ['critic'],
      })
    })
    mgr.workflowWatchers.set('review', { sessionId: 's1', watcher: { stop } })
    mgr.dispose = vi.fn().mockRejectedValue(new Error('boom'))

    await expect(mgr.disposeForWindow('s1')).rejects.toThrow('boom')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(mgr.workflowWatchers.has('review')).toBe(false)
    expect(mgr.remoteEventLog.has('s1')).toBe(false)

    // Repeated true-end cleanup is harmless and cannot republish the terminal observer event.
    mgr.forgetSession('s1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(mgr.remoteEventLog.has('s1')).toBe(false)
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
    mgr.projectStore = vi.fn().mockReturnValue({ version: 3, activeId: null, sessions: [] })
    mgr.dispose = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(mgr.archiveRemote('s1', '/tmp/koda-test-project')).rejects.toThrow('boom')
    expect(forgetSpy).toHaveBeenCalledWith('s1')
  })
})

describe('delegated children survive posture changes and targeted stops', () => {
  type FakeSession = { stopTask?: (taskId: string) => boolean; interrupt?: () => void }
  type FakeWorkflowWatcher = {
    activeAgentIds: () => string[]
    isLive: () => boolean
    stop: ReturnType<typeof vi.fn>
  }
  type DelegationManager = {
    sessions: Map<string, FakeSession>
    activeSubagents: Map<string, Map<string, { taskId?: string }>>
    workflowWatchers: Map<string, { sessionId: string; watcher: FakeWorkflowWatcher }>
    sessionModelEffort: Map<string, { model?: string; effort?: string }>
    projectDirs: Map<string, string>
    working: Set<string>
    broker: { ensureListening: () => Promise<void> }
    gate: {
      setSessionMode: (id: string, mode: 'ask' | 'plan') => void
      getSessionMode: (id: string) => string
      pendingRequests: (id: string) => unknown[]
    }
    start: (opts: { sessionId: string; cwd: string }) => Promise<{ sessionId: string; cwd: string }>
    setSessionApprovalMode: (id: string, mode: 'ask' | 'plan') => void
    setSessionModelEffort: (id: string, opts: { model?: string; effort?: string }) => void
    changeSessionModelEffort: (id: string, opts: { model?: string; effort?: string }) => Promise<void>
    getSessionModelEffort: (id: string) => { model?: string; effort?: string }
    stopSubagent: (id: string, taskId: string) => void
    interrupt: (id: string) => Promise<void>
    sessionEngines: Map<string, string>
    trackSubagentLifecycle: (event: {
      type: 'SubagentStarted' | 'SubagentProgress'
      sessionId: string
      toolUseId: string
      taskId?: string
      subagentType?: string
      description?: string
    }) => void
    markActiveDelegationUnknown: (id: string) => void
    isWorking: (id: string) => boolean
    forward: (event: unknown) => unknown
    remoteEventLog: Map<string, Array<{ type: string; runId?: string }>>
  }

  function manager(): DelegationManager {
    return new EngineSessionManager() as unknown as DelegationManager
  }

  function workflowWatcher(opts: { live?: boolean; agents?: string[] } = {}): FakeWorkflowWatcher {
    return {
      activeAgentIds: () => opts.agents ?? [],
      isLive: () => opts.live ?? true,
      stop: vi.fn(),
    }
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

  it('refuses to replace an engine while its workflow observer can still catch a late wave', async () => {
    const mgr = manager()
    mgr.broker.ensureListening = vi.fn(async () => {})
    mgr.sessions.set('s1', {})
    // Quiet-completed is not launcher work, but teardown can still cut off a late workflow writer.
    mgr.workflowWatchers.set('review', {
      sessionId: 's1',
      watcher: workflowWatcher({ live: false }),
    })

    expect(mgr.isWorking('s1')).toBe(false)
    await expect(mgr.start({ sessionId: 's1', cwd: '/tmp/koda-test-project' })).rejects.toThrow(
      'Delegated work is still running',
    )
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

  it('blocks Plan and model mutations while the parent turn is still running', () => {
    const mgr = manager()
    mgr.gate.setSessionMode('s1', 'ask')
    mgr.sessionModelEffort.set('s1', { model: 'before', effort: 'low' })
    mgr.working.add('s1')

    expect(() => mgr.setSessionApprovalMode('s1', 'plan')).toThrow('A turn is still running')
    expect(() => mgr.setSessionModelEffort('s1', { model: 'after', effort: 'high' })).toThrow(
      'A turn is still running',
    )
    expect(mgr.gate.getSessionMode('s1')).toBe('ask')
    expect(mgr.getSessionModelEffort('s1')).toMatchObject({ model: 'before', effort: 'low' })
  })

  it('rejects a remote model respawn before changing intent or replacing the live process', async () => {
    const mgr = manager()
    mgr.projectDirs.set('s1', '/tmp/koda-test-project')
    mgr.sessionModelEffort.set('s1', { model: 'before', effort: 'low' })
    mgr.working.add('s1')
    mgr.start = vi.fn()

    await expect(mgr.changeSessionModelEffort('s1', { model: 'after', effort: 'high' })).rejects.toThrow(
      'A turn is still running',
    )
    expect(mgr.start).not.toHaveBeenCalled()
    expect(mgr.getSessionModelEffort('s1')).toMatchObject({ model: 'before', effort: 'low' })
  })

  it('blocks Plan and model mutations while an answer is pending', () => {
    const mgr = manager()
    mgr.gate.setSessionMode('s1', 'ask')
    mgr.sessionModelEffort.set('s1', { model: 'before', effort: 'low' })
    mgr.gate.pendingRequests = vi.fn(() => [{}])

    expect(() => mgr.setSessionApprovalMode('s1', 'plan')).toThrow('waiting for your answer')
    expect(() => mgr.setSessionModelEffort('s1', { model: 'after', effort: 'high' })).toThrow(
      'waiting for your answer',
    )
    expect(mgr.gate.getSessionMode('s1')).toBe('ask')
    expect(mgr.getSessionModelEffort('s1')).toMatchObject({ model: 'before', effort: 'low' })
  })

  it('reports actual workflow activity after the parent turn ends', () => {
    const mgr = manager()
    mgr.workflowWatchers.set('review', {
      sessionId: 's1',
      watcher: workflowWatcher({ agents: ['critic'] }),
    })
    expect(mgr.isWorking('s1')).toBe(true)
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

  it('does not resurrect a completed child from a late progress notification', () => {
    const mgr = manager()
    mgr.forward({
      type: 'SubagentStarted',
      sessionId: 's1',
      toolUseId: 'agent-1',
      taskId: 'task-1',
      subagentType: 'scout',
      description: 'Inspect',
    })
    mgr.forward({
      type: 'SubagentCompleted',
      sessionId: 's1',
      toolUseId: 'agent-1',
      taskId: 'task-1',
      outcome: 'completed',
    })
    mgr.forward({
      type: 'SubagentProgress',
      sessionId: 's1',
      toolUseId: 'agent-1',
      taskId: 'task-1',
      status: 'completed',
    })

    expect(mgr.activeSubagents.has('s1')).toBe(false)
  })

  it('marks every delegated protocol unknown when infrastructure recovery abandons its process', () => {
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
    const watcher = workflowWatcher({ agents: ['critic'] })
    mgr.workflowWatchers.set('review', { sessionId: 's1', watcher })

    mgr.markActiveDelegationUnknown('s1')

    expect(forward).toHaveBeenCalledTimes(2)
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SubagentCompleted', toolUseId: 'agent-1', outcome: 'unknown' }),
    )
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SubagentCompleted', toolUseId: 'agent-2', outcome: 'unknown' }),
    )
    expect(watcher.stop).toHaveBeenCalledTimes(1)
    expect(mgr.workflowWatchers.has('review')).toBe(false)
  })

  it('buffers workflow lifecycle replay even before a remote head attaches', () => {
    const mgr = manager()
    mgr.forward({ type: 'WorkflowStarted', sessionId: 's1', runId: 'review', name: 'Review' })
    mgr.forward({
      type: 'WorkflowAgent',
      sessionId: 's1',
      runId: 'review',
      agentId: 'critic',
      status: 'running',
    })
    mgr.forward({ type: 'WorkflowCompleted', sessionId: 's1', runId: 'review', agentCount: 1 })

    expect(mgr.remoteEventLog.get('s1')?.map((event) => event.type)).toEqual([
      'WorkflowStarted',
      'WorkflowAgent',
      'WorkflowCompleted',
    ])
  })

  /**
   * Interrupt discipline. A delegated child outlives its parent's interrupt on BOTH engines (a Claude
   * task keeps running after the control_request; a Codex child is its own thread), so the stop button
   * must reach the children first — otherwise the user watches the parent stop while children keep
   * spending quota and touching files. The ordering lives here, above the drivers, which is why one
   * flat-delegation test proves it for both: the manager is handed each engine's session in turn and
   * must behave identically. The bounds keep a silent child from holding the button hostage.
   */
  describe.each(['claude', 'codex'] as const)('stopping a turn on %s', (engineId) => {
    function sessionWithTwoChildren(mgr: DelegationManager): string[] {
      const order: string[] = []
      mgr.sessionEngines.set('s1', engineId)
      mgr.activeSubagents.set(
        's1',
        new Map([
          ['agent-1', { toolUseId: 'agent-1', taskId: 'task-1' }],
          ['agent-2', { toolUseId: 'agent-2', taskId: 'task-2' }],
        ]) as never,
      )
      mgr.sessions.set('s1', {
        stopTask: (taskId: string) => {
          order.push(`stop:${taskId}`)
          return true
        },
        interrupt: () => order.push('interrupt'),
      })
      return order
    }

    it('stops both live children before interrupting the parent turn', async () => {
      const mgr = manager()
      const order = sessionWithTwoChildren(mgr)
      const session = mgr.sessions.get('s1') as FakeSession
      const stop = session.stopTask!
      // A real driver answers a stop with the child's own terminal event; that is what releases the
      // sweep, so the fake echoes one back through the same forward() the drivers use.
      session.stopTask = (taskId: string) => {
        const accepted = stop(taskId)
        const toolUseId = taskId === 'task-1' ? 'agent-1' : 'agent-2'
        mgr.forward({ type: 'SubagentCompleted', sessionId: 's1', toolUseId, taskId, outcome: 'interrupted' })
        return accepted
      }

      await mgr.interrupt('s1')

      expect(order).toEqual(['stop:task-1', 'stop:task-2', 'interrupt'])
    })

    it('interrupts the parent anyway when a child never confirms it stopped', async () => {
      vi.useFakeTimers()
      try {
        const mgr = manager()
        const order = sessionWithTwoChildren(mgr)

        const stopped = mgr.interrupt('s1')
        // Both stops went out immediately; the parent is still running while the sweep waits.
        expect(order).toEqual(['stop:task-1', 'stop:task-2'])

        await vi.advanceTimersByTimeAsync(3_000)
        await stopped

        expect(order).toEqual(['stop:task-1', 'stop:task-2', 'interrupt'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('releases every overlapping stop sweep from one child terminal event', async () => {
      // Two Stops can overlap on the same child (the button pressed twice, a window close racing a
      // remote stop). Fake timers make the regression visible: with only one resolver per child the
      // second sweep replaced the first's, and the first could then only finish by its 3s bound —
      // which never arrives here — while its stale timeout deleted the newer sweep's waiter.
      vi.useFakeTimers()
      try {
        const mgr = manager()
        const order: string[] = []
        mgr.sessionEngines.set('s1', engineId)
        mgr.activeSubagents.set('s1', new Map([['agent-1', { toolUseId: 'agent-1', taskId: 'task-1' }]]) as never)
        mgr.sessions.set('s1', {
          stopTask: (taskId: string) => {
            order.push(`stop:${taskId}`)
            return true
          },
          interrupt: () => order.push('interrupt'),
        })

        const first = mgr.interrupt('s1')
        const second = mgr.interrupt('s1')
        expect(order).toEqual(['stop:task-1', 'stop:task-1'])

        mgr.forward({
          type: 'SubagentCompleted',
          sessionId: 's1',
          toolUseId: 'agent-1',
          taskId: 'task-1',
          outcome: 'interrupted',
        })
        await Promise.all([first, second])

        expect(order).toEqual(['stop:task-1', 'stop:task-1', 'interrupt', 'interrupt'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('interrupts immediately when there is no delegated work to stop', async () => {
      const mgr = manager()
      const order: string[] = []
      mgr.sessionEngines.set('s1', engineId)
      mgr.sessions.set('s1', {
        stopTask: () => {
          order.push('stop')
          return true
        },
        interrupt: () => order.push('interrupt'),
      })

      await mgr.interrupt('s1')

      expect(order).toEqual(['interrupt'])
    })
  })
})

/**
 * A resume miss used to be fatal: the driver's raw "No conversation found" line was rewritten into
 * "start a new chat" and the session was over. It is now a recovery — the same session continues under
 * the same id on a clean engine conversation, says so once, and the turn the dead child swallowed is
 * sent again. Same isolation as the recoverBroker tests: `start`/`sendTurn` are mocked and the private
 * maps are seeded, so only the recovery's own decisions are under test.
 */
describe('resume miss recovers instead of ending the session', () => {
  type MissTurn = {
    engineText: string
    inlineImages?: unknown[]
    visible: {
      text: string
      attachments?: unknown[]
      origin: 'local' | 'remote'
      attemptId?: string
      clientTurnId?: string
    }
  }
  type MissManager = {
    sessions: Map<string, unknown>
    projectDirs: Map<string, string>
    resumeCursors: Map<string, { engine: string; resumable: boolean; data: Record<string, unknown> }>
    pendingTurns: Map<string, MissTurn>
    working: Set<string>
    start: (...args: unknown[]) => Promise<{ sessionId: string; cwd: string }>
    sendTurn: (...args: unknown[]) => Promise<void>
    forward: (event: Record<string, unknown>) => unknown
    recoverResumeMiss: (sessionId: string) => Promise<void>
  }
  const seed = (): MissManager => {
    const mgr = new EngineSessionManager() as unknown as MissManager
    mgr.projectDirs.set('sess', '/tmp/koda-resume-miss')
    mgr.resumeCursors.set('sess', { engine: 'claude', resumable: true, data: { sessionId: 'sess', turns: 4 } })
    mgr.start = vi.fn().mockResolvedValue({ sessionId: 'sess', cwd: '/tmp/koda-resume-miss' })
    mgr.sendTurn = vi.fn().mockResolvedValue(undefined)
    return mgr
  }
  const held = (): MissTurn => ({
    engineText: 'fix the header',
    visible: { text: 'fix the header', origin: 'local' },
  })

  it('restarts the session clean, notices it once, and resends the swallowed turn', async () => {
    const mgr = seed()
    mgr.working.add('sess')
    mgr.pendingTurns.set('sess', held())
    const notices: string[] = []
    mgr.forward = vi.fn((event) => {
      if (event.type === 'EngineError') notices.push(String(event.message))
      return undefined
    })

    await mgr.recoverResumeMiss('sess')

    // Clean restart under the SAME id: no cursor is passed, and the dead one is gone.
    expect(mgr.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess', abandonActiveDelegation: true }))
    expect((mgr.start as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('resumeCursor')
    expect(mgr.resumeCursors.has('sess')).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/fresh conversation/)
    expect(mgr.sendTurn).toHaveBeenCalledWith(
      'sess',
      'fix the header',
      undefined,
      'local',
      { logicalContinuation: 'resume-miss' },
    )
    // The hold is NOT cleared by recovery itself — the real resend overwrites it and only the
    // turn's genuine TurnComplete discharges it (the mock here does neither).
    expect(mgr.pendingTurns.get('sess')).toEqual(held())
  })

  it('keeps the held turn when the clean replacement dies before accepting the resend', async () => {
    const mgr = seed()
    mgr.working.add('sess')
    mgr.pendingTurns.set('sess', held())
    mgr.sendTurn = vi.fn().mockRejectedValue(new Error('engine session is not running'))
    mgr.forward = vi.fn(() => undefined)

    await mgr.recoverResumeMiss('sess')

    // A second engine failure mid-recovery must not silently discard the user's message.
    expect(mgr.pendingTurns.get('sess')).toEqual(held())
  })

  it('stops showing the session as working when there was no turn to replay', async () => {
    const mgr = seed()
    mgr.working.add('sess')
    mgr.forward = vi.fn(() => undefined)

    await mgr.recoverResumeMiss('sess')

    expect(mgr.sendTurn).not.toHaveBeenCalled()
    expect(mgr.working.has('sess')).toBe(false)
  })

  it('only recovers once when the same session misses twice', async () => {
    const mgr = seed()
    mgr.forward = vi.fn(() => undefined)
    let release!: () => void
    mgr.start = vi.fn(
      () =>
        new Promise<{ sessionId: string; cwd: string }>((resolve) => {
          release = () => resolve({ sessionId: 'sess', cwd: '/tmp/koda-resume-miss' })
        }),
    )

    const first = mgr.recoverResumeMiss('sess')
    await mgr.recoverResumeMiss('sess')
    release()
    await first

    expect(mgr.start).toHaveBeenCalledTimes(1)
  })

  it('routes the driver signal into recovery and never forwards it to a surface', () => {
    const mgr = seed()
    const recover = vi.fn().mockResolvedValue(undefined)
    mgr.recoverResumeMiss = recover

    const out = mgr.forward({
      type: 'EngineError',
      sessionId: 'sess',
      message: 'the engine no longer holds this conversation',
      fatal: false,
      category: 'resumeMiss',
    })

    expect(out).toBeUndefined()
    expect(recover).toHaveBeenCalledWith('sess')
  })
})

describe('restore notice', () => {
  type RestoreManager = {
    sessions: Map<string, { sendTurn: ReturnType<typeof vi.fn> }>
    projectDirs: Map<string, string>
    safeCheckpointResult: ReturnType<typeof vi.fn>
    restoreProjectCheckpoint: (projectDir: string, checkpointId: string) => Promise<{ id: string }>
    restoreCheckpoint: (sessionId: string, checkpointId: string) => Promise<{ id: string }>
    sendTurn: (sessionId: string, text: string) => Promise<void>
    forward: (event: unknown) => unknown
  }

  /** A real safety store with two points, so the restore under test is the production one. */
  async function projectWithCheckpoint(): Promise<{ cwd: string; targetId: string }> {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'koda-restore-notice-')))
    await ensureRepo(cwd)
    writeFileSync(join(cwd, 'notes.md'), 'the login page\n')
    const target = await checkpoint(cwd, "before: 'add a login page'")
    writeFileSync(join(cwd, 'notes.md'), 'work done after the checkpoint\n')
    await checkpoint(cwd, 'later work')
    return { cwd, targetId: target.id }
  }

  function restoreManager(): RestoreManager {
    const mgr = new EngineSessionManager() as unknown as RestoreManager
    mgr.safeCheckpointResult = vi.fn().mockResolvedValue(null)
    return mgr
  }

  it('rides ahead of the next turn of every live session in the restored project', async () => {
    const { cwd, targetId } = await projectWithCheckpoint()
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'koda-restore-elsewhere-')))
    try {
      const mgr = restoreManager()
      const affected = vi.fn((..._args: unknown[]) => true)
      const unaffected = vi.fn((..._args: unknown[]) => true)
      mgr.sessions.set('in-project', { sendTurn: affected })
      mgr.projectDirs.set('in-project', cwd)
      mgr.sessions.set('other-project', { sendTurn: unaffected })
      mgr.projectDirs.set('other-project', elsewhere)

      await mgr.restoreProjectCheckpoint(cwd, targetId)
      await mgr.sendTurn('in-project', 'carry on with the header')

      const sent = affected.mock.calls[0][0] as string
      expect(sent).toContain("This project's files were restored to the checkpoint from")
      expect(sent).toContain("before: 'add a login page'")
      expect(sent).toMatch(/\b20\d\d\b/) // the checkpoint's time is stated, not just "earlier"
      expect(sent).toContain('Re-read a file before you edit it')
      expect(sent.endsWith('carry on with the header')).toBe(true)

      // One notice per restore: once the carrying turn genuinely completes, the next is the user's words alone.
      mgr.forward({ type: 'TurnComplete', sessionId: 'in-project', stopReason: 'success' })
      await mgr.sendTurn('in-project', 'and now the footer')
      expect(affected.mock.calls[1][0]).toBe('and now the footer')

      // A session in another project never saw the restore and must not be told it did.
      await mgr.sendTurn('other-project', 'unrelated work')
      expect(unaffected.mock.calls[0][0]).toBe('unrelated work')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('leaves the session that drove the restore to its tool result, and still warns its siblings', async () => {
    const { cwd, targetId } = await projectWithCheckpoint()
    try {
      const mgr = restoreManager()
      const driver = vi.fn((..._args: unknown[]) => true)
      const sibling = vi.fn((..._args: unknown[]) => true)
      mgr.sessions.set('driver', { sendTurn: driver })
      mgr.projectDirs.set('driver', cwd)
      mgr.sessions.set('sibling', { sendTurn: sibling })
      mgr.projectDirs.set('sibling', cwd)

      await mgr.restoreCheckpoint('driver', targetId)

      await mgr.sendTurn('driver', 'thanks, continue')
      expect(driver.mock.calls[0][0]).toBe('thanks, continue')

      await mgr.sendTurn('sibling', 'keep refactoring')
      expect(sibling.mock.calls[0][0] as string).toContain('Re-read a file before you edit it')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('survives a refused send and rides the next turn the engine accepts', async () => {
    const { cwd, targetId } = await projectWithCheckpoint()
    try {
      const mgr = restoreManager()
      // First send is refused (dead child, unwritable stdin); the retry is accepted.
      const flaky = vi.fn((..._args: unknown[]) => true).mockReturnValueOnce(false)
      mgr.sessions.set('in-project', { sendTurn: flaky })
      mgr.projectDirs.set('in-project', cwd)

      await mgr.restoreProjectCheckpoint(cwd, targetId)
      await expect(mgr.sendTurn('in-project', 'carry on with the header')).rejects.toThrow(
        'did not accept',
      )
      await mgr.sendTurn('in-project', 'still there?')

      // The refused turn carried the notice but the engine never took it; the accepted turn carries it again.
      expect(flaky.mock.calls[1][0] as string).toContain('Re-read a file before you edit it')
      expect((flaky.mock.calls[1][0] as string).endsWith('still there?')).toBe(true)

      // Once the accepted turn completes, it is consumed for good.
      mgr.forward({ type: 'TurnComplete', sessionId: 'in-project', stopReason: 'success' })
      await mgr.sendTurn('in-project', 'and the footer')
      expect(flaky.mock.calls[2][0]).toBe('and the footer')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps riding every send until a turn that carried it completes', async () => {
    const { cwd, targetId } = await projectWithCheckpoint()
    try {
      const mgr = restoreManager()
      const send = vi.fn((..._args: unknown[]) => true)
      mgr.sessions.set('in-project', { sendTurn: send })
      mgr.projectDirs.set('in-project', cwd)

      await mgr.restoreProjectCheckpoint(cwd, targetId)
      await mgr.sendTurn('in-project', 'carry on')
      // The engine accepted the turn, then the child died before finishing it.
      mgr.forward({ type: 'EngineError', sessionId: 'in-project', message: 'engine exited', fatal: true })

      await mgr.sendTurn('in-project', 'picking back up')
      expect(send.mock.calls[1][0] as string).toContain('Re-read a file before you edit it')

      // A Codex turn/start rejection, a Claude stdin failure, a broker-recovery respawn — no failure
      // mode needs its own handling: the notice was never removed, so the next send just carries it.
      mgr.forward({
        type: 'EngineError',
        sessionId: 'in-project',
        message: 'turn failed: stream closed',
        fatal: false,
        category: 'turnRejected',
      })
      await mgr.sendTurn('in-project', 'third try')
      expect(send.mock.calls[2][0] as string).toContain('Re-read a file before you edit it')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is discharged by a genuine TurnComplete and never resurrected by a later failure', async () => {
    const { cwd, targetId } = await projectWithCheckpoint()
    try {
      const mgr = restoreManager()
      const send = vi.fn((..._args: unknown[]) => true)
      mgr.sessions.set('in-project', { sendTurn: send })
      mgr.projectDirs.set('in-project', cwd)

      await mgr.restoreProjectCheckpoint(cwd, targetId)
      await mgr.sendTurn('in-project', 'carry on')
      mgr.forward({ type: 'TurnComplete', sessionId: 'in-project', stopReason: 'success' })
      // A crash on some LATER turn must not replay a notice the agent already read.
      mgr.forward({ type: 'EngineError', sessionId: 'in-project', message: 'engine exited', fatal: true })

      await mgr.sendTurn('in-project', 'next task')
      expect(send.mock.calls[1][0]).toBe('next task')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * Posture delivery per engine (T3 plan A4). Claude has native modes, so crossing the plan boundary
 * still respawns with `--permission-mode plan`. Codex declares `planMode: 'turnText'`: its driver
 * carries the mode in each turn's text, so the manager must hand the live session the new posture and
 * NOT tear the process down — a respawn there would throw away the warm thread for text that rides
 * the next turn anyway.
 */
describe('changing posture mid-thread', () => {
  type PostureManager = {
    sessions: Map<string, { setApprovalMode?: (mode: string) => void }>
    sessionEngines: Map<string, string>
    projectDirs: Map<string, string>
    resumeCursors: Map<string, { engine: string; resumable: boolean; data: unknown }>
    sessionModelEffort: Map<string, { model?: string; effort?: string }>
    gate: { getSessionMode: (id: string) => string }
    start: (opts: Record<string, unknown>) => Promise<{ sessionId: string; cwd: string }>
    forward: (event: unknown) => unknown
    setSessionApprovalMode: (id: string, mode: 'auto' | 'plan') => void
  }

  function liveSession(engineId: 'claude' | 'codex') {
    const mgr = new EngineSessionManager() as unknown as PostureManager
    const setApprovalMode = vi.fn()
    const start = vi.fn().mockResolvedValue({ sessionId: 's1', cwd: '/tmp/koda-test-project' })
    mgr.sessions.set('s1', { ...(engineId === 'codex' ? { setApprovalMode } : {}) })
    mgr.sessionEngines.set('s1', engineId)
    mgr.projectDirs.set('s1', '/tmp/koda-test-project')
    mgr.resumeCursors.set('s1', { engine: engineId, resumable: true, data: {} })
    mgr.start = start
    mgr.forward = vi.fn()
    return { mgr, setApprovalMode, start }
  }

  it('hands Codex the new posture and keeps the process (mode rides the next turn)', () => {
    const { mgr, setApprovalMode, start } = liveSession('codex')
    mgr.setSessionApprovalMode('s1', 'plan')
    expect(setApprovalMode).toHaveBeenCalledWith('plan')
    expect(start).not.toHaveBeenCalled()
    expect(mgr.gate.getSessionMode('s1')).toBe('plan')

    // And back again, still on the same process.
    mgr.setSessionApprovalMode('s1', 'auto')
    expect(setApprovalMode).toHaveBeenLastCalledWith('auto')
    expect(start).not.toHaveBeenCalled()
  })

  it('releases the steered-turn pin at TurnComplete, so the new posture starts there', () => {
    const mgr = new EngineSessionManager() as unknown as PostureManager & {
      gate: { pinTurnMode: (id: string, mode: string | null) => void }
      forward: (event: unknown) => unknown
    }
    const pinTurnMode = vi.fn()
    mgr.gate.pinTurnMode = pinTurnMode
    mgr.forward({ type: 'TurnComplete', sessionId: 's1', stopReason: 'success' })
    expect(pinTurnMode).toHaveBeenCalledWith('s1', null)
  })

  it('still respawns Claude, whose plan mode is a spawn-time engine flag', () => {
    const { mgr, start } = liveSession('claude')
    mgr.setSessionApprovalMode('s1', 'plan')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', planMode: true }))
  })
})

describe('an ask runs on the engine of the chat it was launched from', () => {
  // The Library's ask names a chat and main reads the engine off it. Resolving app-wide instead refused
  // an ask launched from a Claude chat because a DIFFERENT session had been switched to Codex, and ran
  // Claude for an ask launched from a Codex chat. In either direction the engine and billing owner on
  // screen were not the ones main used.
  it('reads a chat engine live or from its store, and resolves nothing for a chat it cannot see', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'koda-ask-engine-')))
    const mgr = new EngineSessionManager() as unknown as {
      sessionEngines: Map<string, 'claude' | 'codex'>
      sessionEngine: (cwd: string, sessionId: string) => 'claude' | 'codex' | undefined
    }
    try {
      saveProjectSessions(cwd, {
        version: 3,
        activeId: 'claude-chat',
        sessions: [
          { id: 'claude-chat', label: 'Claude work', cwd, engineId: 'claude', items: [] },
          { id: 'codex-chat', label: 'Codex work', cwd, engineId: 'codex', items: [] },
          { id: 'legacy-chat', label: 'Before multi-engine', cwd, items: [] },
        ],
      })

      // A chat restored from disk that has not run yet still knows its own engine.
      expect(mgr.sessionEngine(cwd, 'claude-chat')).toBe('claude')
      expect(mgr.sessionEngine(cwd, 'codex-chat')).toBe('codex')
      expect(mgr.sessionEngine(cwd, 'legacy-chat')).toBe('claude')

      // A live session's current engine outranks whatever was last persisted for it.
      mgr.sessionEngines.set('claude-chat', 'codex')
      expect(mgr.sessionEngine(cwd, 'claude-chat')).toBe('codex')

      // An id main cannot place resolves to nothing, so the runner falls back to the user's last
      // explicit choice rather than guessing an engine for a chat it never found.
      expect(mgr.sessionEngine(cwd, 'no-such-chat')).toBeUndefined()
    } finally {
      purgeProjectSessions(cwd)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects a hot snapshot when a whole engine event can land during its write', () => {
    const cwd = '/tmp/koda-ask-snapshot'
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      working: Set<string>
      engineEventAt: Map<string, number>
      hotSessionSnapshotComplete: (projectPath: string, savedAt: number | undefined) => boolean
    }
    mgr.projectDirs.set('chat', cwd)

    expect(mgr.hotSessionSnapshotComplete(cwd, undefined)).toBe(false)
    mgr.engineEventAt.set('chat', 99)
    expect(mgr.hotSessionSnapshotComplete(cwd, 100)).toBe(true)

    // The renderer stamped the snapshot at 100, then the background turn began and ended in the same
    // millisecond while saveSessions was writing. It is idle now, but that event is absent from the
    // captured blob, so equality must be stale too.
    mgr.engineEventAt.set('chat', 100)
    expect(mgr.hotSessionSnapshotComplete(cwd, 100)).toBe(false)

    mgr.engineEventAt.set('chat', 90)
    mgr.working.add('chat')
    expect(mgr.hotSessionSnapshotComplete(cwd, 100)).toBe(false)
  })

  it('rejects a hot snapshot while a subagent can write and until its terminal event is captured', () => {
    const cwd = '/tmp/koda-ask-snapshot-subagent'
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      activeSubagents: Map<string, Map<string, unknown>>
      engineEventAt: Map<string, number>
      forward: (event: unknown) => unknown
      hotSessionSnapshotComplete: (projectPath: string, savedAt: number | undefined) => boolean
    }
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(101)
      // Keep the project mapping absent while forwarding so this unit test exercises in-memory
      // lifecycle state without creating a durable remote-replay sidecar under /tmp.
      mgr.forward({
        type: 'SubagentStarted',
        sessionId: 'chat',
        toolUseId: 'reviewer',
        subagentType: 'koda:reviewer',
        description: 'Review the change',
      })
      mgr.projectDirs.set('chat', cwd)

      // Even a snapshot started after the Start event is uncertifiable while the child can write.
      expect(mgr.hotSessionSnapshotComplete(cwd, 102)).toBe(false)

      mgr.projectDirs.delete('chat')
      now.mockReturnValue(103)
      mgr.forward({
        type: 'SubagentCompleted',
        sessionId: 'chat',
        toolUseId: 'reviewer',
        outcome: 'completed',
      })
      mgr.projectDirs.set('chat', cwd)

      expect(mgr.activeSubagents.has('chat')).toBe(false)
      expect(mgr.engineEventAt.get('chat')).toBe(103)
      // Ownership ended, but the renderer's earlier snapshot still omits the terminal row update.
      expect(mgr.hotSessionSnapshotComplete(cwd, 102)).toBe(false)
      expect(mgr.hotSessionSnapshotComplete(cwd, 104)).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('rejects a hot snapshot while a quiet workflow observer can still catch a late writer', () => {
    const cwd = '/tmp/koda-ask-snapshot-workflow'
    const mgr = new EngineSessionManager() as unknown as {
      projectDirs: Map<string, string>
      workflowWatchers: Map<
        string,
        { sessionId: string; watcher: { isLive: () => boolean; activeAgentIds: () => string[] } }
      >
      engineEventAt: Map<string, number>
      forward: (event: unknown) => unknown
      hotSessionSnapshotComplete: (projectPath: string, savedAt: number | undefined) => boolean
    }
    const now = vi.spyOn(Date, 'now').mockReturnValue(101)
    try {
      mgr.workflowWatchers.set('review', {
        sessionId: 'chat',
        // Settled for the UI, but still a potential writer owner until its late-wave watch ends.
        watcher: { isLive: () => false, activeAgentIds: () => [] },
      })
      mgr.forward({
        type: 'WorkflowCompleted',
        sessionId: 'chat',
        runId: 'review',
        agentCount: 2,
      })
      mgr.projectDirs.set('chat', cwd)

      // The current snapshot includes completion, but the lingering observer could still append a
      // late wave, so it cannot certify the corpus yet.
      expect(mgr.hotSessionSnapshotComplete(cwd, 102)).toBe(false)

      mgr.workflowWatchers.delete('review')
      expect(mgr.hotSessionSnapshotComplete(cwd, 102)).toBe(true)
      // A snapshot from before the last workflow lifecycle event remains stale after ownership ends.
      expect(mgr.engineEventAt.get('chat')).toBe(101)
      expect(mgr.hotSessionSnapshotComplete(cwd, 100)).toBe(false)
    } finally {
      now.mockRestore()
    }
  })
})

describe('proposeVersionMessage evidence ordering', () => {
  type ProposeHarness = {
    sessionEngines: Map<string, string>
    proposeVersionMessage: (req: {
      cwd: string
      status: { files: never[]; truncated: boolean }
      readEvidence: () => Promise<{ files: never[]; truncated: boolean; diff: string; recentSubjects: string[] }>
    }) => Promise<{ source: string }>
  }

  afterEach(() => updateSettings({ textGenerationModel: { provider: 'apple' } }))

  it('floors before reading evidence when plain local text is selected', async () => {
    updateSettings({ textGenerationModel: { provider: 'plain' } })
    const mgr = new EngineSessionManager() as unknown as ProposeHarness
    const readEvidence = vi.fn()
    const res = await mgr.proposeVersionMessage({
      cwd: '/nonexistent',
      status: { files: [], truncated: false },
      readEvidence,
    })
    expect(res.source).toBe('fallback')
    // The whole point of the gate order: a no-AI choice must not pay to read a diff it will not use.
    expect(readEvidence).not.toHaveBeenCalled()
  })

  it('reads evidence for the on-device writer', async () => {
    updateSettings({ textGenerationModel: { provider: 'apple' } })
    const mgr = new EngineSessionManager() as unknown as ProposeHarness
    const readEvidence = vi
      .fn()
      .mockResolvedValue({ files: [], truncated: false, diff: '', recentSubjects: [] })
    const res = await mgr.proposeVersionMessage({
      cwd: '/nonexistent',
      status: { files: [], truncated: false },
      readEvidence,
    })
    expect(readEvidence).toHaveBeenCalledOnce()
    // Empty diff floors inside generateVersionMessage without spawning — no engine child in tests.
    expect(res.source).toBe('fallback')
  })
})
