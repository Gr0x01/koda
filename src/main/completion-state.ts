import type { TaskCompletionState } from '@shared/ipc'
import { checkpointChanges } from './safety-git/changes'
import {
  completionGitSnapshot,
  completionStatusForPaths,
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
}> {
  const owned = new Map(priorOwned)
  let unresolvedReason = priorUncertainty

  if (boundary.mutationSeen) {
    if (!boundary.safetyCommit) unresolvedReason = 'checkpoint-failed'
    else {
      try {
        const changed = await evidence.changes(boundary.cwd, boundary.safetyCommit)
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
      }
    }
  }

  if (owned.size === 0)
    return { state: { sessionId, state: 'none', paths: [], mixedPaths: [] }, owned }

  if (status?.kind === 'not-repo') {
    return {
      state: { sessionId, state: 'unversioned', paths: pathList(owned), mixedPaths: [] },
      owned,
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
  }
}
