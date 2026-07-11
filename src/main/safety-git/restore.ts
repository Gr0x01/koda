/**
 * Recovery — bring the working tree back to a past checkpoint. Forward-only: we snapshot the
 * present first, materialize the target tree, then record THAT as a new checkpoint. The branch ref
 * never moves backward, so the timeline keeps every entry and an undo is itself undoable
 * (dual-git.md §2).
 */
import { rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runGit } from './repo'
import { checkpoint, type Checkpoint } from './checkpoint'

/** Tracked paths in a tree-ish, NUL-delimited so paths with spaces survive. */
async function lsTree(projectDir: string, ref: string): Promise<Set<string>> {
  const { stdout } = await runGit(projectDir, ['ls-tree', '-r', '--name-only', '-z', ref])
  return new Set(stdout.split('\0').filter((p) => p.length > 0))
}

export async function restore(projectDir: string, checkpointId: string): Promise<Checkpoint> {
  // 1. Make the present recoverable before we touch anything.
  await checkpoint(projectDir, 'before recovery')

  // 2. Restore tracked files to the target's content. `checkout <id> -- .` only WRITES files
  //    present in the target; it won't delete files created afterward (handled next).
  await runGit(projectDir, ['checkout', checkpointId, '--', '.'])

  // 3. Remove exactly the files that exist now but not in the target (HEAD − target). Computed
  //    from the trees, not `git clean`: clean would also delete excluded files (a later .env,
  //    node_modules) that live in neither tree and aren't ours to touch.
  const [headFiles, targetFiles] = await Promise.all([
    lsTree(projectDir, 'HEAD'),
    lsTree(projectDir, checkpointId),
  ])
  const removedDirs = new Set<string>()
  for (const file of headFiles) {
    if (!targetFiles.has(file)) {
      await unlink(join(projectDir, file)).catch(() => {}) // already gone is fine
      // Record every ancestor up to the project root — a deep removal can empty a whole chain.
      for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) removedDirs.add(dir)
    }
  }

  // Prune dirs left empty by those removals — git tracks files, not dirs, so checkout won't.
  // Deepest-first; rmdir no-ops on a still-populated dir, so we never touch dirs holding
  // excluded content (node_modules etc., which were never in headFiles).
  for (const dir of [...removedDirs].sort((a, b) => b.length - a.length)) {
    await rmdir(join(projectDir, dir)).catch(() => {})
  }

  // 4. Record the materialized tree as the new tip (now byte-identical to the target).
  const { id, label, createdAt } = await checkpoint(
    projectDir,
    `recovered to ${checkpointId.slice(0, 8)}`,
  )
  return { id, label, createdAt }
}
