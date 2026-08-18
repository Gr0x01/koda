import { describe, expect, it, vi } from 'vitest'
import { reconcileCompletionState, type CompletionTurnBoundary } from './completion-state'

const changed = (paths: string[]) => ({
  files: paths.map((path) => ({
    path,
    status: 'modified' as const,
    additions: 1,
    deletions: 0,
    binary: false,
  })),
  truncated: false,
})

function boundary(overrides: Partial<CompletionTurnBoundary> = {}): CompletionTurnBoundary {
  return {
    cwd: '/project',
    safetyCommit: 'before-turn',
    userGit: { kind: 'repo', dirty: [] },
    mutationSeen: true,
    overlappingWriters: false,
    ...overrides,
  }
}

function evidence(paths: string[], dirty: string[] | 'not-repo' = paths) {
  return {
    changes: vi.fn(async () => changed(paths)),
    statusForPaths: vi.fn(async () =>
      dirty === 'not-repo' ? ({ kind: 'not-repo' as const }) : ({ kind: 'repo' as const, dirty }),
    ),
    snapshot: vi.fn(async () =>
      dirty === 'not-repo' ? ({ kind: 'not-repo' as const }) : ({ kind: 'repo' as const, dirty }),
    ),
  }
}

describe('reconcileCompletionState', () => {
  it('stays silent when the tree was already dirty and this turn made no mutation', async () => {
    const result = await reconcileCompletionState(
      's1',
      boundary({ mutationSeen: false, userGit: { kind: 'repo', dirty: ['unrelated.ts'] } }),
      new Map(),
      evidence([], []),
    )
    expect(result.state).toEqual({ sessionId: 's1', state: 'none', paths: [], mixedPaths: [] })
  })

  it('reports only task-owned paths that remain loose', async () => {
    const result = await reconcileCompletionState('s1', boundary(), new Map(), evidence(['task.ts'], ['task.ts']))
    expect(result.state).toEqual({
      sessionId: 's1',
      state: 'loose-ends',
      paths: ['task.ts'],
      mixedPaths: [],
    })
  })

  it('marks a task edit to an already-dirty file as mixed, including collapsed untracked dirs', async () => {
    const result = await reconcileCompletionState(
      's1',
      boundary({ userGit: { kind: 'repo', dirty: ['src/mixed.ts', 'notes/'] } }),
      new Map(),
      evidence(['src/mixed.ts', 'notes/draft.md']),
    )
    expect(result.state).toMatchObject({
      state: 'loose-ends',
      mixedPaths: ['notes/draft.md', 'src/mixed.ts'],
    })
  })

  it('clears task paths once they are committed or otherwise no longer loose', async () => {
    const prior = new Map([['task.ts', { mixed: false }]])
    const result = await reconcileCompletionState(
      's1',
      boundary({ mutationSeen: false }),
      prior,
      evidence([], []),
    )
    expect(result.state.state).toBe('none')
    expect(result.owned.size).toBe(0)
  })

  it('reports changed files truthfully when the project has no user Git', async () => {
    const result = await reconcileCompletionState(
      's1',
      boundary({ userGit: { kind: 'not-repo' } }),
      new Map(),
      evidence(['draft.md'], 'not-repo'),
    )
    expect(result.state).toEqual({
      sessionId: 's1',
      state: 'unversioned',
      paths: ['draft.md'],
      mixedPaths: [],
    })
  })

  it('refuses an ownership claim when the turn has no recovery point', async () => {
    const result = await reconcileCompletionState(
      's1',
      boundary({ safetyCommit: null }),
      new Map(),
      evidence(['task.ts']),
    )
    expect(result.state).toMatchObject({ state: 'needs-check', reason: 'checkpoint-failed' })
    expect(result.unresolvedReason).toBe('checkpoint-failed')
  })

  // A concurrent writer is ordinary parallel work, not a fault. It used to raise a permanent badge
  // that the user had no way to clear and nothing to inspect behind.
  it('claims its own window normally when another writer overlapped the turn', async () => {
    const result = await reconcileCompletionState(
      's1',
      boundary({ overlappingWriters: true }),
      new Map(),
      evidence(['task.ts']),
    )
    expect(result.state).toMatchObject({ state: 'loose-ends', paths: ['task.ts'] })
    expect(result.unresolvedReason).toBeUndefined()
  })

  it('keeps unresolved evidence across a later read-only turn until the whole tree is clean', async () => {
    const uncertain = await reconcileCompletionState(
      's1',
      boundary({ safetyCommit: null }),
      new Map(),
      evidence([], ['unknown-change.ts']),
    )
    const stillUncertain = await reconcileCompletionState(
      's1',
      boundary({ mutationSeen: false }),
      uncertain.owned,
      evidence([], ['unknown-change.ts']),
      uncertain.unresolvedReason,
    )
    expect(stillUncertain.state).toMatchObject({ state: 'needs-check', reason: 'checkpoint-failed' })

    const resolved = await reconcileCompletionState(
      's1',
      boundary({ mutationSeen: false }),
      stillUncertain.owned,
      evidence([], []),
      stillUncertain.unresolvedReason,
    )
    expect(resolved.state).toEqual({ sessionId: 's1', state: 'none', paths: [], mixedPaths: [] })
    expect(resolved.unresolvedReason).toBeUndefined()
  })
})
