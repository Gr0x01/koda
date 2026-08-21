import { describe, expect, it, vi } from 'vitest'
import {
  commitOwnedCompletion,
  reconcileCompletionState,
  type CompletionTurnBoundary,
} from './completion-state'

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

function commitEvidence(
  paths: string[],
  options: {
    after?: string[]
    statusKind?: 'repo' | 'not-repo'
    repo?: {
      isRepo: boolean
      isSubdir: boolean
      branch: string | null
      defaultBranch?: string | null
      isLinkedWorktree?: boolean | null
    }
    commitError?: Error
  } = {},
) {
  const statusForPaths =
    options.statusKind === 'not-repo'
      ? vi.fn().mockResolvedValue({ kind: 'not-repo' as const })
      : vi
          .fn()
          .mockResolvedValueOnce({ kind: 'repo' as const, dirty: paths })
          .mockResolvedValue({ kind: 'repo' as const, dirty: options.after ?? [] })
  const commit = options.commitError
    ? vi.fn().mockRejectedValue(options.commitError)
    : vi.fn().mockResolvedValue({ sha: 'abc1234' })
  return {
    completion: {
      changes: vi.fn(async () => changed(paths)),
      statusForPaths,
      snapshot: vi.fn(async () =>
        options.statusKind === 'not-repo'
          ? ({ kind: 'not-repo' as const })
          : ({ kind: 'repo' as const, dirty: paths }),
      ),
    },
    detectRepo: vi.fn(async () => ({
      isRepo: true,
      repoRoot: '/project',
      isSubdir: false,
      branch: 'main',
      defaultBranch: 'main',
      isLinkedWorktree: false,
      ...options.repo,
    })),
    commitPaths: commit,
    statusForPaths,
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

  it('retains exact turn evidence even when user Git pruning says the work is already committed', async () => {
    const result = await reconcileCompletionState(
      's1',
      boundary(),
      new Map(),
      evidence(['committed.ts'], []),
    )
    expect(result.state.state).toBe('none')
    expect(result.turnChanges).toMatchObject({
      complete: true,
      files: [{ path: 'committed.ts', status: 'modified' }],
    })
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

describe('commitOwnedCompletion', () => {
  const options = {
    message: 'Dream: tidy project memory (2026-08-18)',
    pathPrefix: '.koda/memory',
    author: 'Koda Dream <dream@koda.local>',
    overlapObserved: false,
  }

  it('commits only clean, owned paths inside the declared Dream subtree', async () => {
    const deps = commitEvidence([
      '.koda/memory/active-context.md',
      '.koda/memory/dream-digest.md',
    ])

    const result = await commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, deps)

    expect(result).toEqual({
      kind: 'committed',
      sha: 'abc1234',
      paths: ['.koda/memory/active-context.md', '.koda/memory/dream-digest.md'],
    })
    expect(deps.commitPaths).toHaveBeenCalledWith(
      '/project',
      ['.koda/memory/active-context.md', '.koda/memory/dream-digest.md'],
      options.message,
      { author: 'Koda Dream <dream@koda.local>' },
    )
  })

  it('commits from whatever named branch the canonical checkout is on', async () => {
    const path = '.koda/memory/dream-digest.md'
    const featureBranch = commitEvidence([path], {
      repo: { isRepo: true, isSubdir: false, branch: 'feature', defaultBranch: 'main' },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, featureBranch),
    ).resolves.toMatchObject({ kind: 'committed', sha: 'abc1234' })

    // A repository whose trunk is named neither main nor master still has one canonical checkout.
    const noTrunk = commitEvidence([path], {
      repo: { isRepo: true, isSubdir: false, branch: 'trunk', defaultBranch: null },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, noTrunk),
    ).resolves.toMatchObject({ kind: 'committed', sha: 'abc1234' })
  })

  it('refuses to sweep a pre-existing edit into the unattended commit', async () => {
    const path = '.koda/memory/active-context.md'
    const deps = commitEvidence([path])

    const result = await commitOwnedCompletion(
      'dream',
      boundary({ userGit: { kind: 'repo', dirty: [path] } }),
      options,
      new Map(),
      undefined,
      deps,
    )

    expect(result).toEqual({ kind: 'needs-attention', reason: 'mixed-paths', paths: [path] })
    expect(deps.commitPaths).not.toHaveBeenCalled()
  })

  it('refuses an overlap or any changed path outside Dream memory', async () => {
    const memory = commitEvidence(['.koda/memory/active-context.md'])
    await expect(
      commitOwnedCompletion(
        'dream',
        boundary(),
        { ...options, overlapObserved: true },
        new Map(),
        undefined,
        memory,
      ),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'overlap' })
    expect(memory.commitPaths).not.toHaveBeenCalled()

    const outside = commitEvidence(['src/main/index.ts'])
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, outside),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'outside-scope' })
    expect(outside.commitPaths).not.toHaveBeenCalled()
  })

  it('leaves the work visible when Git cannot commit or a hook dirties it again', async () => {
    const path = '.koda/memory/dream-digest.md'
    const failed = commitEvidence([path], { commitError: new Error('signing failed') })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, failed),
    ).resolves.toMatchObject({
      kind: 'needs-attention',
      reason: 'git-failed',
      message: 'signing failed',
    })

    const dirtied = commitEvidence([path], { after: [path] })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, dirtied),
    ).resolves.toEqual({
      kind: 'needs-attention',
      reason: 'post-commit-dirty',
      paths: [path],
      sha: 'abc1234',
    })
  })

  it('does not initialize or claim a parent repository', async () => {
    const path = '.koda/memory/dream-digest.md'
    const unversioned = commitEvidence([path], {
      statusKind: 'not-repo',
      repo: { isRepo: false, isSubdir: false, branch: null },
    })
    await expect(
      commitOwnedCompletion(
        'dream',
        boundary({ userGit: { kind: 'not-repo' } }),
        options,
        new Map(),
        undefined,
        unversioned,
      ),
    ).resolves.toEqual({ kind: 'not-versioned', paths: [path] })

    const unversionedOutside = commitEvidence(['src/main/index.ts'], {
      statusKind: 'not-repo',
    })
    await expect(
      commitOwnedCompletion(
        'dream',
        boundary({ userGit: { kind: 'not-repo' } }),
        options,
        new Map(),
        undefined,
        unversionedOutside,
      ),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'outside-scope' })

    const vanished = commitEvidence([path], {
      repo: { isRepo: false, isSubdir: false, branch: null },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, vanished),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'evidence-failed' })

    const nested = commitEvidence([path], {
      repo: { isRepo: true, isSubdir: true, branch: 'main' },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, nested),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'unsupported-repository' })

    const detached = commitEvidence([path], {
      repo: { isRepo: true, isSubdir: false, branch: null, defaultBranch: 'main' },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, detached),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'unsupported-repository' })

    const linkedWorktree = commitEvidence([path], {
      repo: {
        isRepo: true,
        isSubdir: false,
        branch: 'feature',
        defaultBranch: 'main',
        isLinkedWorktree: true,
      },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, linkedWorktree),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'unsupported-repository' })

    // A failed worktree probe must refuse, never read as canonical.
    const probeFailed = commitEvidence([path], {
      repo: {
        isRepo: true,
        isSubdir: false,
        branch: 'feature',
        defaultBranch: 'main',
        isLinkedWorktree: null,
      },
    })
    await expect(
      commitOwnedCompletion('dream', boundary(), options, new Map(), undefined, probeFailed),
    ).resolves.toMatchObject({ kind: 'needs-attention', reason: 'unsupported-repository' })
    expect(probeFailed.commitPaths).not.toHaveBeenCalled()
    expect(unversioned.commitPaths).not.toHaveBeenCalled()
    expect(unversioned.detectRepo).not.toHaveBeenCalled()
    expect(unversionedOutside.commitPaths).not.toHaveBeenCalled()
    expect(vanished.commitPaths).not.toHaveBeenCalled()
    expect(nested.commitPaths).not.toHaveBeenCalled()
    expect(detached.commitPaths).not.toHaveBeenCalled()
    expect(linkedWorktree.commitPaths).not.toHaveBeenCalled()
  })
})
