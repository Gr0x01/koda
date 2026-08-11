/**
 * Checkpoints — the undo stack's entries. Created deterministically by Koda (not the engine):
 * before each risky tool call (broker-wired, elsewhere) and at turn boundaries. Labels come from
 * data Koda already holds (the user's turn prompt) — no model call.
 */
import { runGit } from './repo'

export interface Checkpoint {
  /** Commit SHA — the stable handle for restore. */
  id: string
  /** Human-terms label, from the user's turn prompt: powers "go back to before the login page". */
  label: string
  /** Unix seconds. */
  createdAt: number
  /** Set once the on-device model has rewritten `label` into a final, standalone phrase. */
  humanized?: boolean
  /**
   * How this point reads in the timeline. 'moment' = a turn boundary / manual edit / recovery marker
   * the user navigates by (labelled from their own words). 'step' = a per-tool safety snapshot, one
   * before each mutating tool — kept for fine-grained restore but hidden from the user timeline, where
   * dozens of "before Edit: …" would be noise. Derived from the raw subject (see checkpointKind).
   */
  kind?: 'moment' | 'step'
}

/**
 * A per-tool snapshot's subject is machine-shaped: "before Edit: …", "before Bash: npm test",
 * "before mcp__x: …" (see broker/policy.ts checkpointLabel). A turn/edit/recovery moment is the
 * user's own words. Classify from the RAW subject so points made before `kind` existed bucket too,
 * and so the on-device labeler is never handed the thin per-tool text it can only flatten to
 * "Editing the file".
 */
const STEP_SUBJECT = /^before (?:mcp__[\w-]+|[A-Z][A-Za-z0-9]*)(?::|$)/

export function checkpointKind(label: string): 'moment' | 'step' {
  return STEP_SUBJECT.test(label) ? 'step' : 'moment'
}

export interface CheckpointResult extends Checkpoint {
  /** True when nothing changed since the last checkpoint — `id` points at the existing tip. */
  skipped: boolean
}

/** Current tip, or null when there are no commits yet (first checkpoint). */
export async function headSha(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectDir, ['rev-parse', '--verify', 'HEAD'])
    return stdout.trim()
  } catch {
    return null
  }
}

async function commitTime(projectDir: string, sha: string): Promise<number> {
  const { stdout } = await runGit(projectDir, ['show', '-s', '--format=%ct', sha])
  return Number(stdout.trim())
}

/**
 * The disposable per-tool snapshot lane. Steps live OFF `master` (which is the browsable moment
 * timeline) so retention can drop aged steps without rewriting the timeline (prune.ts, dual-git.md
 * §6.1). It's still a normal linear chain, just under its own ref that HEAD never points at.
 */
const STEPS_REF = 'refs/koda/steps'

/** Current tip of a ref, or null when it doesn't exist yet. */
async function refTip(projectDir: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectDir, ['rev-parse', '--verify', `${ref}^{commit}`])
    return stdout.trim()
  } catch {
    return null
  }
}

async function treeOfCommit(projectDir: string, sha: string): Promise<string> {
  const { stdout } = await runGit(projectDir, ['rev-parse', `${sha}^{tree}`])
  return stdout.trim()
}

/**
 * Snapshot the working tree under `label`. When nothing changed since the last checkpoint we
 * skip the commit and point at the prior one — an empty commit would only clutter the recovery
 * timeline a non-engineer reads (so no `--allow-empty`).
 *
 * Two lanes: a 'moment' (turn/edit/recovery) commits to `master` (HEAD) as always; a 'step' (per-tool
 * snapshot) commits to `refs/koda/steps` via `commit-tree`, leaving HEAD/master untouched so the
 * browsable timeline never carries the fine-grained noise and retention can prune steps cheaply.
 */
export async function checkpoint(projectDir: string, label: string): Promise<CheckpointResult> {
  // Collapse to a single line so the commit subject (%s) is the full label and the log parses cleanly.
  const subject = label.replace(/\s+/g, ' ').trim() || 'checkpoint'

  await runGit(projectDir, ['add', '-A'])

  if (checkpointKind(subject) === 'step') return commitStep(projectDir, subject)

  const prior = await headSha(projectDir)
  if (prior) {
    // `diff --cached --quiet` exits 0 = nothing staged, 1 = staged changes. Only exit 1 means
    // "commit"; any other code is a real git failure and must propagate, not be read as changes.
    let hasChanges = false
    try {
      await runGit(projectDir, ['diff', '--cached', '--quiet'])
    } catch (err) {
      if ((err as { code?: number }).code === 1) hasChanges = true
      else throw err
    }
    if (!hasChanges) {
      return { id: prior, label: subject, createdAt: await commitTime(projectDir, prior), skipped: true }
    }
  }

  // A brand-new EMPTY project stages nothing, and a plain `commit` refuses an empty first commit —
  // which made the very first checkpoint of every fresh intake project fail (both fresh health
  // projects, 2026-08-02). One --allow-empty ROOT commit gives the timeline its anchor; with a
  // prior commit the no-change case above has already returned, so this can never litter the
  // timeline with empty commits.
  await runGit(projectDir, ['commit', '--quiet', ...(prior ? [] : ['--allow-empty']), '--message', subject])
  const id = (await headSha(projectDir))!
  return { id, label: subject, createdAt: await commitTime(projectDir, id), skipped: false }
}

/**
 * Commit a step onto `refs/koda/steps` without moving HEAD. The steps lane is a chain independent of
 * master (the first step is parentless) so `git log refs/koda/steps` — and retention's step-trim —
 * never walk into a moment: the lanes share objects, not history. Skips when the tree is unchanged
 * since the last snapshot of EITHER lane (so a tool that touched nothing doesn't record a redundant
 * step identical to the current moment). `git add -A` has already staged the working tree, so
 * `write-tree` captures the exact same content a moment would.
 */
async function commitStep(projectDir: string, subject: string): Promise<CheckpointResult> {
  const { stdout: treeOut } = await runGit(projectDir, ['write-tree'])
  const tree = treeOut.trim()
  const stepsTip = await refTip(projectDir, STEPS_REF)
  const unchangedBase = stepsTip ?? (await headSha(projectDir))
  if (unchangedBase && (await treeOfCommit(projectDir, unchangedBase)) === tree) {
    return {
      id: unchangedBase,
      label: subject,
      createdAt: await commitTime(projectDir, unchangedBase),
      skipped: true,
    }
  }
  const { stdout } = await runGit(projectDir, [
    'commit-tree',
    tree,
    ...(stepsTip ? ['-p', stepsTip] : []),
    '-m',
    subject,
  ])
  const id = stdout.trim()
  await runGit(projectDir, ['update-ref', STEPS_REF, id])
  return { id, label: subject, createdAt: await commitTime(projectDir, id), skipped: false }
}

/**
 * The recovery timeline, newest first. Empty when no checkpoint has been taken yet.
 * NUL-delimited so labels (arbitrary user text) can't break the parse.
 */
export async function listCheckpoints(projectDir: string): Promise<Checkpoint[]> {
  if (!(await headSha(projectDir))) return []
  const { stdout } = await runGit(projectDir, ['log', '--format=%H%x00%ct%x00%s'])
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, ct, label] = line.split('\0')
      return { id, label, createdAt: Number(ct), kind: checkpointKind(label) }
    })
}
