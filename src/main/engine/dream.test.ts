import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnedCompletionCommitResult } from '../completion-state'
import type { EngineSessionManager } from './sessions'

// DreamScheduler.dreamProject calls these for real; stubbed so the wiring test below runs no git and
// touches no disk. Module-wide for this file, but the pure-function tests below never call either.
const {
  checkpointMock,
  sandboxCreateMock,
  sandboxRemoveMock,
  atomicWriteMock,
  powerSaveStartMock,
  powerSaveStopMock,
} = vi.hoisted(() => ({
  checkpointMock: vi.fn().mockResolvedValue({ id: undefined }),
  sandboxCreateMock: vi.fn().mockResolvedValue('/tmp/koda-rem-sandbox'),
  sandboxRemoveMock: vi.fn().mockResolvedValue(undefined),
  atomicWriteMock: vi.fn(),
  powerSaveStartMock: vi.fn().mockReturnValue(1),
  powerSaveStopMock: vi.fn(),
}))
vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('electron')>()),
  powerSaveBlocker: { start: powerSaveStartMock, stop: powerSaveStopMock },
}))
vi.mock('../safety-git/sandbox', () => ({
  createCheckpointSandbox: sandboxCreateMock,
  removeCheckpointSandbox: sandboxRemoveMock,
}))
vi.mock('../atomic-write', () => ({ writeFileAtomic: atomicWriteMock }))

import {
  digestEntry,
  DreamScheduler,
  dreamSessionName,
  eligibleProjects,
  inDreamHours,
  msUntilNightOpen,
  nightKey,
  NO_REM_PROBLEM,
  QUIET_NIGHT,
  remDigestEntry,
  remFocus,
  remPrompt,
  remSessionName,
  upsertDigest,
  upsertRemDigest,
} from './dream'

const H = 3_600_000
const NOW = 1_000_000_000_000

function passingOwnership(cwd: string, sessionId = 's1') {
  const scope = { cwd, sessionId, checkpointId: 'before-tidy' }
  return {
    beginProjectMutationScope: vi.fn().mockResolvedValue(scope),
    finishProjectMutationScope: vi.fn(
      async (
        _scope: typeof scope,
        mutate: () => Promise<unknown>,
        version?: { message: string; pathPrefix: string },
      ) => ({
        overlapObserved: false,
        result: await mutate(),
        ...(version
          ? {
              commit: {
                kind: 'committed' as const,
                sha: 'dream123',
                paths: ['.koda/memory/dream-digest.md'],
              },
            }
          : {}),
      }),
    ),
    withExternalProjectMutation: vi.fn(
      async (_project: string, _options: unknown, mutate: (checkpointed: boolean) => unknown) => mutate(true),
    ),
  }
}

function activity(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries))
}

const hasMemory = () => true
const notBusy = () => false

describe('eligibleProjects', () => {
  it('picks a project that settled past the quiet window with new material', () => {
    const acts = activity({ '/a': NOW - 3 * H })
    expect(eligibleProjects(acts, {}, NOW, hasMemory, notBusy)).toEqual(['/a'])
  })

  it('skips a project still inside the quiet window', () => {
    const acts = activity({ '/a': NOW - 1 * H })
    expect(eligibleProjects(acts, {}, NOW, hasMemory, notBusy)).toEqual([])
  })

  it('skips a project with no new material since its last dream', () => {
    const acts = activity({ '/a': NOW - 8 * H })
    const lastDream = { '/a': NOW - 7 * H } // dreamed AFTER the last activity
    expect(eligibleProjects(acts, lastDream, NOW, hasMemory, notBusy)).toEqual([])
  })

  it('enforces the 6h floor even with new material', () => {
    const acts = activity({ '/a': NOW - 3 * H })
    const lastDream = { '/a': NOW - 4 * H } // activity after the dream, but dreamed too recently
    expect(eligibleProjects(acts, lastDream, NOW, hasMemory, notBusy)).toEqual([])
  })

  it('caps at three projects, deepest-churn (most recent activity) first', () => {
    const acts = activity({
      '/a': NOW - 3 * H,
      '/b': NOW - 4 * H,
      '/c': NOW - 5 * H,
      '/d': NOW - 6 * H,
    })
    expect(eligibleProjects(acts, {}, NOW, hasMemory, notBusy)).toEqual(['/a', '/b', '/c'])
  })

  it('skips projects without a memory tree and projects with a busy session', () => {
    const acts = activity({ '/a': NOW - 3 * H, '/b': NOW - 3 * H, '/c': NOW - 3 * H })
    const memory = (cwd: string) => cwd !== '/b'
    const busy = (cwd: string) => cwd === '/c'
    expect(eligibleProjects(acts, {}, NOW, memory, busy)).toEqual(['/a'])
  })

  it('force skips the timing gates but never the memory or busy checks', () => {
    // Inside quiet, floor unexpired, and no new material — every timing gate would block.
    const acts = activity({ '/a': NOW - 1 * H, '/b': NOW - 1 * H, '/c': NOW - 1 * H })
    const lastDream = { '/a': NOW - 0.5 * H }
    const memory = (cwd: string) => cwd !== '/b'
    const busy = (cwd: string) => cwd === '/c'
    expect(eligibleProjects(acts, lastDream, NOW, memory, busy, true)).toEqual(['/a'])
    expect(eligibleProjects(acts, lastDream, NOW, memory, busy)).toEqual([])
  })
})

describe('DreamScheduler completion stamp', () => {
  it('advances the project only after finalization and records a successful commit', async () => {
    const cwd = process.cwd()
    const sessions = {
      remoteSessionList: vi.fn().mockReturnValue([]),
      isWorking: vi.fn().mockReturnValue(false),
      reapDreamSessions: vi.fn().mockResolvedValue(undefined),
    }
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)
    const state = { lastDream: {} as Record<string, number>, lastCommit: {} as Record<string, string> }
    const internals = scheduler as unknown as {
      activity: Map<string, number>
      loadState: () => typeof state
      dreamProject: (project: string, includeRem: boolean, forceRem: boolean) => Promise<{ commitSha?: string }>
      fire: (force: boolean) => Promise<void>
    }
    internals.activity.set(cwd, Date.now())
    internals.loadState = vi.fn().mockReturnValue(state)
    internals.dreamProject = vi
      .fn()
      .mockRejectedValueOnce(new Error('commit failed'))
      .mockResolvedValueOnce({ commitSha: 'dream123' })

    await internals.fire(true)
    expect(state.lastDream[cwd]).toBeUndefined()
    expect(state.lastCommit[cwd]).toBeUndefined()

    await internals.fire(true)
    expect(state.lastDream[cwd]).toEqual(expect.any(Number))
    expect(state.lastCommit[cwd]).toBe('dream123')
  })
})

// Local-time constructors keep these deterministic in any timezone.
describe('night window', () => {
  it('opens at 21:00 and covers the pre-noon tail of a long night', () => {
    expect(inDreamHours(new Date(2026, 7, 4, 21, 0))).toBe(true)
    expect(inDreamHours(new Date(2026, 7, 5, 5, 30))).toBe(true)
    expect(inDreamHours(new Date(2026, 7, 5, 11, 59))).toBe(true)
    expect(inDreamHours(new Date(2026, 7, 5, 12, 0))).toBe(false) // noon: the tail is over
    expect(inDreamHours(new Date(2026, 7, 5, 16, 30))).toBe(false) // afternoon break
    expect(inDreamHours(new Date(2026, 7, 5, 20, 59))).toBe(false)
  })

  it('a late-night fire and the prior evening share one night key', () => {
    expect(nightKey(new Date(2026, 7, 4, 22, 0))).toBe(nightKey(new Date(2026, 7, 5, 5, 30)))
    // ...but the NEXT evening is a fresh night.
    expect(nightKey(new Date(2026, 7, 5, 21, 0))).not.toBe(nightKey(new Date(2026, 7, 5, 5, 30)))
  })

  it('night keys roll over month boundaries', () => {
    expect(nightKey(new Date(2026, 8, 1, 3, 0))).toBe(nightKey(new Date(2026, 7, 31, 23, 0)))
  })

  it('parks a daytime fire at the coming 21:00, and a post-9pm one at tomorrow', () => {
    expect(msUntilNightOpen(new Date(2026, 7, 5, 16, 0))).toBe(5 * H)
    expect(msUntilNightOpen(new Date(2026, 7, 5, 22, 0))).toBe(23 * H)
  })
})

describe('session name', () => {
  it('says Dream and stamps the LOCAL date', () => {
    expect(dreamSessionName(new Date(2026, 7, 6, 0, 16))).toBe('Dream · 2026-08-06')
    expect(remSessionName(new Date(2026, 7, 6, 0, 16))).toBe('Dream REM · 2026-08-06')
    // A 21:30 fire is that evening's dream — UTC would have stamped it tomorrow.
    expect(dreamSessionName(new Date(2026, 7, 5, 21, 30))).toBe('Dream · 2026-08-05')
  })
})

describe('digest', () => {
  const night = new Date(2026, 7, 7, 23, 5)

  it('a quiet night is one dated line — only the EXACT token counts', () => {
    expect(digestEntry(night, QUIET_NIGHT)).toBe('## 2026-08-07 — quiet night, nothing to tidy')
    expect(digestEntry(night, `  ${QUIET_NIGHT}\n`)).toBe('## 2026-08-07 — quiet night, nothing to tidy')
    // A near-miss (token combined with content) records in full — the Hermes never-combine rule.
    const combined = `I considered saying ${QUIET_NIGHT} but I struck two lines.`
    expect(digestEntry(night, combined)).toContain(combined)
  })

  it('an interrupted or silent turn still leaves an honest dated trace', () => {
    expect(digestEntry(night, undefined)).toBe(
      '## 2026-08-07 — no summary (the turn ended without a final message)',
    )
    expect(digestEntry(night, '   ')).toContain('no summary')
    // Interrupted: mid-work narration is labeled as such, never presented as a summary —
    // and it wins even over a trailing quiet token (the turn was cut, so "quiet" is unproven).
    expect(digestEntry(night, 'Now folding the relay note…', true)).toContain(
      'interrupted at the cap; last notes, not a summary',
    )
    expect(digestEntry(night, QUIET_NIGHT, true)).toContain('interrupted')
  })

  it('a forced same-night re-run appends a second dated entry (deliberate, dev-menu only)', () => {
    const first = upsertDigest('', digestEntry(night, 'Run one.'))
    const twice = upsertDigest(first, digestEntry(night, 'Run two.'))
    expect(twice.match(/## 2026-08-07/g)).toHaveLength(2)
    expect(twice.indexOf('Run two.')).toBeLessThan(twice.indexOf('Run one.'))
  })

  it('a real summary is dated and capped', () => {
    expect(digestEntry(night, 'Struck 3 shipped lines.\nFolded relay note.')).toBe(
      '## 2026-08-07\nStruck 3 shipped lines.\nFolded relay note.',
    )
    expect(digestEntry(night, 'x'.repeat(3000)).length).toBeLessThan(2100)
  })

  it('upsert prepends newest-first and preserves legacy pre-header content', () => {
    const first = upsertDigest('', digestEntry(night, 'Night one.'))
    expect(first.startsWith('# Dream digest')).toBe(true)
    const second = upsertDigest(first, digestEntry(new Date(2026, 7, 8, 23, 5), 'Night two.'))
    expect(second.indexOf('2026-08-08')).toBeLessThan(second.indexOf('2026-08-07'))
    expect(second.match(/# Dream digest/g)).toHaveLength(1)
    // Phase-1 launchd content (no header) is pushed below, never rewritten.
    const legacy = upsertDigest('old launchd entry 08-03', digestEntry(night, 'New entry.'))
    expect(legacy).toContain('old launchd entry 08-03')
    expect(legacy.indexOf('New entry.')).toBeLessThan(legacy.indexOf('old launchd entry'))
  })
})

describe('REM focus and brief', () => {
  const night = new Date(2026, 7, 10, 23, 5)

  it('reads the one explicit focus line and ignores ordinary context', () => {
    expect(remFocus('**REM focus (RB, 2026-08-10):** Rebuild the Gauntlet from its failures.')).toBe(
      'Rebuild the Gauntlet from its failures.',
    )
    expect(remFocus('- **REM focus:** Test the smallest recipe.')).toBe('Test the smallest recipe.')
    expect(remFocus('## Open questions\n1. Safety git')).toBeUndefined()
  })

  it('requires three distinct mechanisms, a falsifiable move, and read-only output', () => {
    const prompt = remPrompt('Rebuild the Gauntlet')
    expect(prompt).toContain('<rem-focus>Rebuild the Gauntlet</rem-focus>')
    expect(prompt).toContain('distant analogy')
    expect(prompt).toContain('constraint inversion')
    expect(prompt).toContain('recombination')
    expect(prompt).toContain('falsify')
    expect(prompt).toContain('remain read-only')
    expect(prompt).toContain('## Waking decision')
    expect(remPrompt()).toContain(NO_REM_PROBLEM)
  })

  it('labels interruptions and containment failures visibly', () => {
    expect(remDigestEntry(night, 'Partial thought', true)).toContain('interrupted at the cap')
    expect(remDigestEntry(night, 'Unsafe thought', false, false)).toContain('CONTAINMENT FAILED')
    expect(remDigestEntry(night, undefined)).toContain('no brief')
  })

  it('prepends REM entries newest-first under one header', () => {
    const first = upsertRemDigest('', remDigestEntry(night, 'First brief'))
    const second = upsertRemDigest(
      first,
      remDigestEntry(new Date(2026, 7, 11, 23, 5), 'Second brief'),
    )
    expect(second.match(/# REM digest/g)).toHaveLength(1)
    expect(second.indexOf('Second brief')).toBeLessThan(second.indexOf('First brief'))
  })
})

/**
 * The dream marks its session unattended so a forced ask is denied instead of hanging on a prompt no
 * window shows (gate.ts UNATTENDED_REASON). Nothing else ever clears it short of the engine dying, so
 * the flag's owner has to be the function that owns the unattended TURN — dreamProject, right after
 * its turn ends. Clearing any earlier (e.g. at adoption/notifyDesktopOfHeadless, which can fire WHILE
 * the dream is still running) would reopen the exact hole the flag exists to close.
 */
describe('DreamScheduler.dreamProject: unattended flag lifecycle', () => {
  // Still working through the first two polls, then two consecutive not-working reads (the W2
  // fail-safe) before it's trusted as done — so the wait spans real "in flight" time instead of
  // finishing on waitForTurnEnd's very first or second check. `awaitTurnEnd` hangs forever here: no
  // TurnComplete/fatal-error event ever fires in this fake, so completion rides the isWorking poll only.
  function fakeSessions() {
    const isWorking = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)
    return {
      isWorking,
      lastEngineEventAt: vi.fn().mockReturnValue(Date.now()),
      interrupt: vi.fn(),
      startDreamSession: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      sendTurn: vi.fn().mockResolvedValue('sent'),
      lastAssistantReply: vi.fn().mockReturnValue('did stuff'),
      clearUnattended: vi.fn(),
      revealDreamSession: vi.fn(),
      awaitTurnEnd: vi.fn().mockReturnValue(new Promise(() => {})),
      ...passingOwnership('/tmp/koda-test-project'),
    }
  }

  it('clears the flag only after the turn has ended, not before', async () => {
    vi.useFakeTimers()
    try {
      const sessions = fakeSessions()
      const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)
      const promise = (
        scheduler as unknown as { dreamProject: (cwd: string) => Promise<void> }
      ).dreamProject('/tmp/koda-test-project')
      // waitForTurnEnd's unconditional settle delay, then its first poll — still "working" per the mock.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sessions.clearUnattended).not.toHaveBeenCalled()
      // The remaining polls (15s each: working, working, not-working, not-working — two in a row to
      // trust it) until waitForTurnEnd finally returns.
      await vi.advanceTimersByTimeAsync(45_000)
      await promise
      expect(sessions.clearUnattended).toHaveBeenCalledWith('s1')
      expect(sessions.clearUnattended).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  /** CRITICAL: line 320's old bare-statement clear ran only after both awaits succeeded. A freshly
   *  spawned dream child that's already dead (auth expiry, an engine update mid-flight, a bad flag)
   *  throws out of `sendTurn`/`require`, skipping it — but `startDreamSession` already persisted the
   *  session as listed and resumable, so it's the exact "morning tab auto-denies everything, telling
   *  the model the user withheld consent, while the user watches" bug this feature exists to fix. */
  it('clears the flag even when the turn throws (fail-safe, not sequential)', async () => {
    const sessions = {
      isWorking: vi.fn().mockReturnValue(false),
      lastEngineEventAt: vi.fn().mockReturnValue(Date.now()),
      interrupt: vi.fn(),
      startDreamSession: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      sendTurn: vi.fn().mockRejectedValue(new Error('unknown session')),
      lastAssistantReply: vi.fn().mockReturnValue(undefined),
      clearUnattended: vi.fn(),
      revealDreamSession: vi.fn(),
      awaitTurnEnd: vi.fn().mockReturnValue(new Promise(() => {})),
      ...passingOwnership('/tmp/koda-test-project'),
    }
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)
    await expect(
      (
        scheduler as unknown as { dreamProject: (cwd: string) => Promise<void> }
      ).dreamProject('/tmp/koda-test-project'),
    ).rejects.toThrow('unknown session')
    expect(sessions.clearUnattended).toHaveBeenCalledWith('s1')
  })
})

describe('DreamScheduler.dreamProject: REM lifecycle', () => {
  beforeEach(() => {
    checkpointMock.mockReset().mockResolvedValue({ id: undefined })
    sandboxCreateMock.mockReset().mockResolvedValue('/tmp/koda-rem-sandbox')
    sandboxRemoveMock.mockReset().mockResolvedValue(undefined)
    atomicWriteMock.mockReset()
  })

  function remSessions() {
    const cwd = '/tmp/koda-rem-project'
    const scope = { cwd, sessionId: 's-tidy', checkpointId: 'before-tidy' }
    return {
      isWorking: vi.fn().mockReturnValue(false),
      lastEngineEventAt: vi.fn().mockReturnValue(Date.now()),
      interrupt: vi.fn(),
      startDreamSession: vi.fn()
        .mockResolvedValueOnce({ sessionId: 's-tidy' })
        .mockResolvedValueOnce({ sessionId: 's-rem' }),
      sendTurn: vi.fn().mockResolvedValue('sent'),
      lastAssistantReply: vi.fn().mockReturnValueOnce('Tidy complete.').mockReturnValueOnce('REM brief.'),
      clearUnattended: vi.fn(),
      revealDreamSession: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      forgetSession: vi.fn(),
      awaitTurnEnd: vi.fn().mockReturnValue(Promise.resolve()),
      remoteRateLimits: vi.fn().mockReturnValue({}),
      beginProjectMutationScope: vi.fn(async () => {
        try {
          const pre = await checkpointMock(cwd, 'before overnight memory tidy')
          return pre?.id ? { ...scope, checkpointId: pre.id } : null
        } catch {
          return null
        }
      }),
      finishProjectMutationScope: vi.fn(
        async (
          _active: typeof scope,
          mutate: () => Promise<unknown>,
          version?: { message: string; pathPrefix: string },
        ): Promise<{
          overlapObserved: boolean
          result: unknown
          commit?: OwnedCompletionCommitResult
        }> => ({
          overlapObserved: false,
          result: await mutate(),
          ...(version
            ? {
                commit: {
                  kind: 'committed' as const,
                  sha: 'dream123',
                  paths: ['.koda/memory/dream-digest.md'],
                },
              }
            : {}),
        }),
      ),
      checkpointProjectForSession: vi.fn(async () => {
        try {
          return await checkpointMock(cwd, 'before overnight REM')
        } catch {
          return null
        }
      }),
      withExternalProjectMutation: vi.fn(
        async (_project: string, _options: unknown, mutate: (checkpointed: boolean) => unknown) => mutate(true),
      ),
    }
  }

  it('uses a memory-only tidy gate and finalizes its digest through the owned scope', async () => {
    checkpointMock.mockResolvedValueOnce({ id: 'before-tidy' })
    const sessions = remSessions()
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    await (
      scheduler as unknown as { dreamProject: (cwd: string) => Promise<void> }
    ).dreamProject('/tmp/koda-rem-project')

    expect(sessions.startDreamSession).toHaveBeenNthCalledWith(
      1,
      '/tmp/koda-rem-project',
      expect.stringContaining('Dream'),
      { deferVisibility: true, memoryOnly: true },
    )
    expect(sessions.sendTurn.mock.calls[0][4]).toEqual({
      projectMutationScope: expect.objectContaining({ sessionId: 's-tidy' }),
    })
    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('dream-digest.md'))).toBe(true)
  })

  it('lands the digest but refuses to finish when manager-observed ownership overlaps', async () => {
    checkpointMock.mockResolvedValueOnce({ id: 'before-tidy' })
    const sessions = remSessions()
    sessions.finishProjectMutationScope.mockImplementation(async (_scope, mutate, version) => ({
      overlapObserved: true,
      result: await mutate(),
      ...(version
        ? {
            commit: {
              kind: 'needs-attention' as const,
              reason: 'overlap' as const,
              paths: ['.koda/memory/dream-digest.md'],
            },
          }
        : {}),
    }))
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    await expect(
      (
        scheduler as unknown as { dreamProject: (cwd: string) => Promise<void> }
      ).dreamProject('/tmp/koda-rem-project'),
    ).rejects.toThrow('overlap')

    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('dream-digest.md'))).toBe(true)
  })

  it('tears down the never-used tidy session when its baseline cannot be made', async () => {
    checkpointMock.mockResolvedValueOnce({ id: undefined })
    const sessions = remSessions()
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    await expect(
      (
        scheduler as unknown as { dreamProject: (cwd: string) => Promise<void> }
      ).dreamProject('/tmp/koda-rem-project'),
    ).rejects.toThrow('safety checkpoint')

    expect(sessions.sendTurn).not.toHaveBeenCalled()
    expect(sessions.dispose).toHaveBeenCalledWith('s-tidy')
    expect(sessions.forgetSession).toHaveBeenCalledWith('s-tidy')
    expect(sessions.revealDreamSession).not.toHaveBeenCalled()
    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('dream-digest.md'))).toBe(false)
  })

  it('runs REM in a read-only disposable snapshot and writes both digests', async () => {
    checkpointMock
      .mockResolvedValueOnce({ id: 'before-tidy' })
      .mockResolvedValueOnce({ id: 'before-rem' })
    const sessions = remSessions()
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    await (
      scheduler as unknown as { dreamProject: (cwd: string, includeRem: boolean) => Promise<void> }
    ).dreamProject('/tmp/koda-rem-project', true)

    expect(sessions.sendTurn).toHaveBeenCalledTimes(2)
    expect(sessions.sendTurn.mock.calls[1][1]).toContain('generative REM half')
    expect(sandboxCreateMock).toHaveBeenCalledWith('/tmp/koda-rem-project', 'before-rem')
    expect(sessions.startDreamSession).toHaveBeenNthCalledWith(
      2,
      '/tmp/koda-rem-sandbox',
      expect.stringContaining('Dream REM'),
      { readOnly: true, visible: false },
    )
    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('rem-digest.md'))).toBe(true)
    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('dream-digest.md'))).toBe(true)
    expect(sessions.clearUnattended).toHaveBeenCalledWith('s-tidy')
    expect(sessions.revealDreamSession).toHaveBeenCalledWith('s-tidy')
    expect(sessions.dispose).toHaveBeenCalledWith('s-rem')
    expect(sandboxRemoveMock).toHaveBeenCalledWith('/tmp/koda-rem-sandbox')
    expect(sessions.dispose.mock.invocationCallOrder[0]).toBeLessThan(sandboxRemoveMock.mock.invocationCallOrder[0])
    const remWriteIndex = atomicWriteMock.mock.calls.findIndex(([path]) => String(path).endsWith('rem-digest.md'))
    expect(sandboxRemoveMock.mock.invocationCallOrder[0]).toBeLessThan(
      atomicWriteMock.mock.invocationCallOrder[remWriteIndex],
    )
    expect(sandboxRemoveMock.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.finishProjectMutationScope.mock.invocationCallOrder[0],
    )
    expect(sessions.finishProjectMutationScope).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-tidy' }),
      expect.any(Function),
      {
        message: expect.stringMatching(/^Dream: tidy project memory \(\d{4}-\d{2}-\d{2}\)$/),
        pathPrefix: '.koda/memory',
        author: 'Koda Dream <dream@koda.local>',
      },
    )
    expect(atomicWriteMock.mock.invocationCallOrder[remWriteIndex]).toBeLessThan(
      sessions.revealDreamSession.mock.invocationCallOrder[0],
    )
  })

  it('refuses the REM turn when its paralysis checkpoint is unavailable', async () => {
    checkpointMock
      .mockResolvedValueOnce({ id: 'before-tidy' })
      .mockRejectedValueOnce(new Error('checkpoint unavailable'))
    const sessions = remSessions()
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    await (
      scheduler as unknown as { dreamProject: (cwd: string, includeRem: boolean) => Promise<void> }
    ).dreamProject('/tmp/koda-rem-project', true)

    expect(sessions.sendTurn).toHaveBeenCalledTimes(1)
    expect(sandboxCreateMock).not.toHaveBeenCalled()
    const remWrite = atomicWriteMock.mock.calls.find(([path]) => String(path).endsWith('rem-digest.md'))
    expect(remWrite?.[1]).toContain('could not make the safety checkpoint')
  })

  it('returns a REM digest payload without writing the live project outside finalization', async () => {
    const sessions = remSessions()
    sessions.remoteRateLimits.mockReturnValue({ claude: { five_hour: { usedPercent: 80 } } })
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    const result = await (
      scheduler as unknown as {
        runRem: (cwd: string, night: Date, owner: string, force: boolean) => Promise<{
          reply?: string
          successful: boolean
        }>
      }
    ).runRem('/tmp/koda-rem-project', new Date(2026, 7, 10, 23, 5), 's-tidy', false)

    expect(result).toMatchObject({
      reply: 'REM skipped — the current plan window was over 60% used.',
      successful: true,
    })
    expect(sessions.withExternalProjectMutation).not.toHaveBeenCalled()
    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('rem-digest.md'))).toBe(false)
  })

  it('tears down an interrupted REM engine before deleting its sandbox', async () => {
    checkpointMock.mockResolvedValueOnce({ id: 'before-rem' })
    const sessions = remSessions()
    // This test calls REM directly, so its first and only session is the reserved REM session.
    sessions.startDreamSession.mockReset().mockResolvedValue({ sessionId: 's-rem' })
    sessions.lastAssistantReply.mockReset().mockReturnValue('Partial REM notes.')
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)
    vi.spyOn(
      scheduler as unknown as { waitForTurnEnd: (id: string, cap?: number) => Promise<'completed' | 'interrupted'> },
      'waitForTurnEnd',
    ).mockResolvedValue('interrupted')

    await (
      scheduler as unknown as { runRem: (cwd: string, night: Date, owner: string, force: boolean) => Promise<void> }
    ).runRem('/tmp/koda-rem-project', new Date(2026, 7, 10, 23, 5), 's-tidy', true)

    expect(sessions.dispose).toHaveBeenCalledWith('s-rem')
    expect(sessions.forgetSession).toHaveBeenCalledWith('s-rem')
    expect(sessions.dispose.mock.invocationCallOrder[0]).toBeLessThan(sandboxRemoveMock.mock.invocationCallOrder[0])
  })

  it('cleans the snapshot when the hidden REM session cannot start', async () => {
    checkpointMock.mockResolvedValue({ id: 'before-rem' })
    const sessions = remSessions()
    sessions.startDreamSession.mockReset().mockRejectedValue(new Error('engine unavailable'))
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    await (
      scheduler as unknown as { runRem: (cwd: string, night: Date, owner: string, force: boolean) => Promise<void> }
    ).runRem('/tmp/koda-rem-project', new Date(2026, 7, 10, 23, 5), 's-tidy', true)

    expect(sandboxRemoveMock).toHaveBeenCalledWith('/tmp/koda-rem-sandbox')
    expect(sessions.sendTurn).not.toHaveBeenCalled()
  })

  it('returns failed containment when the disposable snapshot cannot be removed', async () => {
    checkpointMock.mockResolvedValue({ id: 'before-rem' })
    sandboxRemoveMock.mockRejectedValue(new Error('busy sandbox'))
    const sessions = remSessions()
    sessions.startDreamSession.mockReset().mockResolvedValue({ sessionId: 's-rem' })
    sessions.lastAssistantReply.mockReset().mockReturnValue('REM brief.')
    const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)

    const result = await (
      scheduler as unknown as {
        runRem: (cwd: string, night: Date, owner: string, force: boolean) => Promise<{
          containmentHeld: boolean
          successful: boolean
        }>
      }
    ).runRem('/tmp/koda-rem-project', new Date(2026, 7, 10, 23, 5), 's-tidy', true)

    expect(result).toMatchObject({ containmentHeld: false, successful: false })
    expect(atomicWriteMock.mock.calls.some(([path]) => String(path).endsWith('rem-digest.md'))).toBe(false)
  })
})

/**
 * W2: `handleClose` deletes `working` on EVERY engine exit, including a mid-turn broker-recovery
 * respawn — the new child only re-sets it once its first delta lands. A poll landing in that gap must
 * not read as "the turn is over" (that clears `unattended` and hands the dream turn to
 * `resumeAfterReconnect` with nobody enforcing the caps below). Requiring two consecutive not-working
 * reads is the fix; this proves a single lone `false` mid-respawn does NOT end the wait early.
 */
describe('DreamScheduler.waitForTurnEnd: a respawn dip does not end the turn early (W2)', () => {
  function fakeSessions(pattern: boolean[]) {
    const isWorking = vi.fn()
    for (const v of pattern) isWorking.mockImplementationOnce(() => v)
    isWorking.mockReturnValue(pattern[pattern.length - 1]) // steady state after the scripted sequence
    return {
      isWorking,
      lastEngineEventAt: vi.fn().mockReturnValue(Date.now()),
      interrupt: vi.fn(),
      awaitTurnEnd: vi.fn().mockReturnValue(new Promise(() => {})), // no real TurnComplete in this fake
    }
  }

  it('a lone false reading (respawn gap) does not resolve; two in a row does', async () => {
    vi.useFakeTimers()
    try {
      // working, DIP (old child just exited), working again (new child resumed), then really done.
      const sessions = fakeSessions([true, false, true, false, false])
      const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)
      let resolved = false
      const promise = (
        scheduler as unknown as { waitForTurnEnd: (id: string) => Promise<'completed' | 'interrupted'> }
      )
        .waitForTurnEnd('s1')
        .then((r) => {
          resolved = true
          return r
        })
      await vi.advanceTimersByTimeAsync(5_000) // settle; poll #1 fires (true)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000) // poll #2 fires (false) — the lone dip; must NOT trust it alone
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000) // poll #3 fires (true) — respawn resumed, streak resets
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000) // poll #4 fires (false)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000) // poll #5 fires (false) — two in a row now
      expect(await promise).toBe('completed')
      expect(sessions.interrupt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * W3: a clean finish should clear `unattended` the moment the turn genuinely ends, not up to two
 * extra 15s poll ticks later (the tab unlocks its composer on the same TurnComplete, so every tick
 * spent confirming an already-real completion is a tick the adopted tab looks answerable while every
 * forced ask still auto-denies). `awaitTurnEnd` — fired only by a real TurnComplete/fatal error —
 * should end the wait immediately even if the `isWorking` poll hasn't caught up yet.
 */
describe('DreamScheduler.waitForTurnEnd: a genuine finish beats the poll (W3)', () => {
  it('resolves as soon as the turn-end event fires, without waiting on isWorking', async () => {
    vi.useFakeTimers()
    try {
      let resolveEnded: () => void = () => {}
      const ended = new Promise<void>((r) => {
        resolveEnded = r
      })
      const sessions = {
        isWorking: vi.fn().mockReturnValue(true), // never reports done on its own in this fake
        lastEngineEventAt: vi.fn().mockReturnValue(Date.now()),
        interrupt: vi.fn(),
        awaitTurnEnd: vi.fn().mockReturnValue(ended),
      }
      const scheduler = new DreamScheduler(sessions as unknown as EngineSessionManager)
      const promise = (
        scheduler as unknown as { waitForTurnEnd: (id: string) => Promise<'completed' | 'interrupted'> }
      ).waitForTurnEnd('s1')
      await vi.advanceTimersByTimeAsync(5_000) // the settle sleep; now parked on the first 15s poll sleep
      resolveEnded() // the real TurnComplete/fatal-error signal
      expect(await promise).toBe('completed')
      expect(sessions.interrupt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
