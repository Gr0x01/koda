import type { ChangedFile, TaskCompletionState } from '@shared/ipc'
import { checkpointChanges } from './safety-git/changes'
import {
  commitPaths,
  completionGitSnapshot,
  completionStatusForPaths,
  detectRepo,
  type CompletionGitSnapshot,
} from './user-git'

export interface CompletionTurnBoundary {
  cwd: string
  safetyCommit: string | null
  userGit: CompletionGitSnapshot
  mutationSeen: boolean
  /** Another live turn wrote in this tree during this one. Attribution evidence for the scheduler,
   *  never a completion reason: two sessions in one project is how Koda is actually used, so badging
   *  it produced a warning that was always on and had no resolving action. Both turns claim what
   *  changed in their own window instead, and the Changes view names the other toucher. */
  overlappingWriters: boolean
}

export type CompletionOwnedPaths = Map<string, { mixed: boolean }>

interface CompletionEvidence {
  changes: typeof checkpointChanges
  statusForPaths: typeof completionStatusForPaths
  snapshot: typeof completionGitSnapshot
}

const liveEvidence: CompletionEvidence = {
  changes: checkpointChanges,
  statusForPaths: completionStatusForPaths,
  snapshot: completionGitSnapshot,
}

export type OwnedCompletionCommitResult =
  | { kind: 'committed'; sha: string; paths: string[] }
  | { kind: 'no-changes' }
  | { kind: 'not-versioned'; paths: string[] }
  | {
      kind: 'needs-attention'
      reason:
        | 'overlap'
        | 'mixed-paths'
        | 'outside-scope'
        | 'evidence-failed'
        | 'unsupported-repository'
        | 'git-failed'
        | 'post-commit-dirty'
      paths: string[]
      message?: string
      sha?: string
    }

interface OwnedCompletionCommitEvidence {
  completion: CompletionEvidence
  detectRepo: typeof detectRepo
  commitPaths: typeof commitPaths
  statusForPaths: typeof completionStatusForPaths
}

const liveCommitEvidence: OwnedCompletionCommitEvidence = {
  completion: liveEvidence,
  detectRepo,
  commitPaths,
  statusForPaths: completionStatusForPaths,
}

export type CompletionUncertainty = NonNullable<TaskCompletionState['reason']>

function pathList(owned: CompletionOwnedPaths): string[] {
  return [...owned.keys()].sort()
}

function mixedPathList(owned: CompletionOwnedPaths): string[] {
  return [...owned]
    .filter(([, metadata]) => metadata.mixed)
    .map(([path]) => path)
    .sort()
}

function needsCheck(
  sessionId: string,
  owned: CompletionOwnedPaths,
  reason: CompletionUncertainty,
): TaskCompletionState {
  return {
    sessionId,
    state: 'needs-check',
    paths: pathList(owned),
    mixedPaths: mixedPathList(owned),
    reason,
  }
}

/**
 * Turn evidence → passive completion truth. Safety-git answers what changed inside the turn boundary;
 * user Git answers which task paths are still loose. The aggregate worktree never enters the result.
 * The map is copied so callers can keep the previous state until this reconciliation finishes.
 */
export async function reconcileCompletionState(
  sessionId: string,
  boundary: CompletionTurnBoundary,
  priorOwned: CompletionOwnedPaths = new Map(),
  evidence: CompletionEvidence = liveEvidence,
  priorUncertainty?: CompletionUncertainty,
): Promise<{
  state: TaskCompletionState
  owned: CompletionOwnedPaths
  unresolvedReason?: CompletionUncertainty
  /** Exact safety-baseline observation before user-Git pruning. This survives an agent committing its
   * work during the turn, which is precisely when completion state correctly becomes `none`. */
  turnChanges: { files: ChangedFile[]; complete: boolean }
}> {
  const owned = new Map(priorOwned)
  let unresolvedReason = priorUncertainty
  const turnChanges: { files: ChangedFile[]; complete: boolean } = {
    files: [],
    complete: !boundary.mutationSeen,
  }

  if (boundary.mutationSeen) {
    if (!boundary.safetyCommit) unresolvedReason = 'checkpoint-failed'
    else {
      try {
        const changed = await evidence.changes(boundary.cwd, boundary.safetyCommit)
        turnChanges.files = changed.files
        turnChanges.complete = !changed.truncated
        if (changed.truncated) unresolvedReason = 'git-probe-failed'
        else {
          const dirtyBefore = boundary.userGit.kind === 'repo' ? boundary.userGit.dirty : []
          const wasDirtyBefore = (path: string): boolean =>
            dirtyBefore.some((dirty) => dirty === path || (dirty.endsWith('/') && path.startsWith(dirty)))
          for (const file of changed.files) {
            const prior = owned.get(file.path)
            owned.set(file.path, { mixed: (prior?.mixed ?? false) || wasDirtyBefore(file.path) })
          }
          if (changed.files.length > 0 && boundary.userGit.kind === 'unknown')
            unresolvedReason = 'git-probe-failed'
        }
      } catch {
        unresolvedReason = 'git-probe-failed'
      }
    }
  }

  let status: CompletionGitSnapshot | undefined
  if (owned.size > 0) {
    try {
      status = await evidence.statusForPaths(boundary.cwd, [...owned.keys()])
    } catch {
      status = { kind: 'unknown' }
    }
    if (status.kind === 'unknown') unresolvedReason ??= 'git-probe-failed'
    else if (status.kind === 'repo') {
      const loose = new Set(status.dirty)
      for (const path of [...owned.keys()]) if (!loose.has(path)) owned.delete(path)
    }
  }

  // Uncertain evidence is sticky: a later read-only turn must not make "Needs check" disappear. A
  // verifiably clean whole tree is the explicit resolution — there can be no remaining loose task
  // work to attribute. Anything else keeps the original reason until the user cleans or commits it.
  if (unresolvedReason) {
    let project: CompletionGitSnapshot
    try {
      project = await evidence.snapshot(boundary.cwd)
    } catch {
      project = { kind: 'unknown' }
    }
    if (project.kind === 'repo' && project.dirty.length === 0) {
      owned.clear()
    } else {
      return {
        state: needsCheck(sessionId, owned, unresolvedReason),
        owned,
        unresolvedReason,
        turnChanges,
      }
    }
  }

  if (owned.size === 0)
    return { state: { sessionId, state: 'none', paths: [], mixedPaths: [] }, owned, turnChanges }

  if (status?.kind === 'not-repo') {
    return {
      state: { sessionId, state: 'unversioned', paths: pathList(owned), mixedPaths: [] },
      owned,
      turnChanges,
    }
  }

  const paths = pathList(owned)
  return {
    state: {
      sessionId,
      state: paths.length ? 'loose-ends' : 'none',
      paths,
      mixedPaths: paths.filter((path) => owned.get(path)?.mixed),
    },
    owned,
    turnChanges,
  }
}

/**
 * Turn ownership evidence -> one safe automatic user-Git commit. This is deliberately stricter than
 * the manual Save action: an unattended owner may commit only paths it positively changed, that were
 * clean at its boundary, inside its declared subtree, with no Koda-observed competing writer. It
 * never initializes Git, commits from a parent repository, or guesses through failed evidence.
 */
export async function commitOwnedCompletion(
  sessionId: string,
  boundary: CompletionTurnBoundary,
  options: { message: string; pathPrefix: string; overlapObserved: boolean; author?: string },
  priorOwned: CompletionOwnedPaths = new Map(),
  priorUncertainty?: CompletionUncertainty,
  evidence: OwnedCompletionCommitEvidence = liveCommitEvidence,
): Promise<OwnedCompletionCommitResult> {
  const reconciled = await reconcileCompletionState(
    sessionId,
    boundary,
    priorOwned,
    evidence.completion,
    priorUncertainty,
  )
  const { state } = reconciled
  const paths = state.paths

  if (state.state === 'needs-check')
    return { kind: 'needs-attention', reason: 'evidence-failed', paths }
  if (paths.length === 0) return { kind: 'no-changes' }
  if (options.overlapObserved)
    return { kind: 'needs-attention', reason: 'overlap', paths }

  const prefix = options.pathPrefix.replace(/^\.\/+|\/+$/g, '')
  if (!prefix || paths.some((path) => path !== prefix && !path.startsWith(`${prefix}/`)))
    return { kind: 'needs-attention', reason: 'outside-scope', paths }

  if (state.state === 'unversioned') {
    // "No repository" is a supported outcome only when it was also true at the boundary. A repo
    // disappearing (or Git becoming unreadable) during finalization is failed evidence, not consent
    // to call a versioned Dream finished without its commit.
    if (boundary.userGit.kind === 'not-repo') return { kind: 'not-versioned', paths }
    return { kind: 'needs-attention', reason: 'evidence-failed', paths }
  }
  if (state.mixedPaths.length > 0)
    return { kind: 'needs-attention', reason: 'mixed-paths', paths }

  const repo = await evidence.detectRepo(boundary.cwd)
  if (!repo.isRepo)
    return { kind: 'needs-attention', reason: 'evidence-failed', paths }
  // Project memory is project-global, so Dream may finalize it only from the exact repository root of
  // the canonical checkout, on whatever named branch is checked out there. A linked worktree, a
  // detached or unborn checkout, or an enclosing repository is not a lane an unattended process may
  // claim — and a worktree probe that failed (null) refuses rather than reading as canonical.
  if (repo.isSubdir || !repo.branch || repo.isLinkedWorktree !== false)
    return { kind: 'needs-attention', reason: 'unsupported-repository', paths }

  let sha: string
  try {
    ;({ sha } = await evidence.commitPaths(boundary.cwd, paths, options.message, {
      author: options.author,
    }))
  } catch (err) {
    return {
      kind: 'needs-attention',
      reason: 'git-failed',
      paths,
      message: err instanceof Error ? err.message : 'git commit failed',
    }
  }

  const after = await evidence.statusForPaths(boundary.cwd, paths)
  if (after.kind !== 'repo')
    return { kind: 'needs-attention', reason: 'evidence-failed', paths, sha }
  if (after.dirty.length > 0)
    return {
      kind: 'needs-attention',
      reason: 'post-commit-dirty',
      paths: after.dirty,
      sha,
    }
  return { kind: 'committed', sha, paths }
}
