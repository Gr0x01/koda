/**
 * "What changed since this checkpoint" — the diff that makes recovery non-scary. For a checkpoint
 * the user is eyeing, show exactly what going back would undo: the changes between that checkpoint
 * and the CURRENT working tree.
 *
 * Why the working tree, not HEAD: safety checkpoints land BEFORE each turn/tool, so the last edit of
 * every turn is uncommitted — diffing against HEAD would hide the most recent (most likely-to-undo)
 * change. And `restore` itself snapshots the present (`add -A`) before rewinding, so "checkpoint →
 * working tree" is precisely what it reverts.
 *
 * Read-only: a throwaway GIT_INDEX_FILE captures the working tree (`add -A` into a scratch index)
 * without touching the real index or the tree. `add -A` honors info/exclude, so node_modules/.koda
 * stay out — same as a checkpoint.
 */
import { rm, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { runGit, safetyGitDir } from './repo'

/** Cap a single file side so a giant file can't blow up the IPC payload or the diff editor. */
const MAX_FILE_BYTES = 1_000_000

export interface ChangedFile {
  /** Project-relative POSIX path (git's output). */
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  /** Git couldn't line-count it (binary) — the per-file diff view shows a notice instead. */
  binary: boolean
}

export interface CheckpointChanges {
  files: ChangedFile[]
  /** True when the list was clipped (huge change set). */
  truncated: boolean
}

/** Cap the file list so a massive revert preview can't bloat the payload. */
const MAX_CHANGED_FILES = 500

function statusOf(letter: string): ChangedFile['status'] {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  return 'modified' // M, and renames/copies which we split via --no-renames into add+delete
}

/**
 * The changed-file list between `checkpointId` and the current working tree. Builds a scratch index
 * = the working tree, then diffs the checkpoint against it. `--no-renames` so a rename reads as a
 * delete + an add (clearer for a non-engineer than an "R" with a rename arrow).
 */
export async function checkpointChanges(
  projectDir: string,
  checkpointId: string,
): Promise<CheckpointChanges> {
  const tmpIndex = join(safetyGitDir(projectDir), `changes-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    // Seed the scratch index from the checkpoint, then `add -A` refreshes it to mirror the working
    // tree (new files become adds, missing files become deletes). Seeding matters: files tracked by
    // the store but ignored by a later .gitignore (a real proxmox case — .env.local, tmp/) stay
    // tracked and refresh from disk; an empty index would drop them (`add -A` skips ignored
    // untracked files) and report them as phantom deletions against every checkpoint.
    await runGit(projectDir, ['read-tree', checkpointId], { extraEnv: env })
    await runGit(projectDir, ['add', '-A'], { extraEnv: env })

    // name-status for the A/M/D letter, numstat for the +/- counts — both checkpoint → scratch index.
    const base = ['diff', '--cached', '--no-renames', '-z', checkpointId]
    const [{ stdout: ns }, { stdout: num }] = await Promise.all([
      runGit(projectDir, [...base, '--name-status'], { extraEnv: env }),
      runGit(projectDir, [...base, '--numstat'], { extraEnv: env }),
    ])

    // numstat -z: "adds\tdels\tpath\0" per file; binary files report "-\t-\t". Index by path.
    const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
    for (const rec of num.split('\0')) {
      if (!rec) continue
      const [a, d, ...rest] = rec.split('\t')
      const path = rest.join('\t')
      if (!path) continue
      const binary = a === '-' || d === '-'
      counts.set(path, { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary })
    }

    // name-status -z: "STATUS\0path\0" pairs (no rename pairs — we passed --no-renames).
    const tokens = ns.split('\0')
    const files: ChangedFile[] = []
    let total = 0
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const letter = tokens[i]?.[0]
      const path = tokens[i + 1]
      if (!letter || !path) continue
      total++
      if (files.length >= MAX_CHANGED_FILES) continue
      const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
      files.push({ path, status: statusOf(letter), additions: c.additions, deletions: c.deletions, binary: c.binary })
    }
    return { files, truncated: total > files.length }
  } finally {
    await rm(tmpIndex, { force: true })
  }
}

export interface CheckpointFileDiff {
  before: string
  after: string
  binary: boolean
  truncated: boolean
}

/** Read a blob at a ref; '' when the path doesn't exist there (added/deleted on one side). */
async function showBlob(projectDir: string, ref: string, relPath: string): Promise<string> {
  try {
    const { stdout } = await runGit(projectDir, ['show', `${ref}:${relPath}`])
    return stdout
  } catch {
    return ''
  }
}

/**
 * The before/after pair for one changed file: `before` = its content at the checkpoint, `after` =
 * its CURRENT on-disk content. Drives the recovery diff view. Size-capped + binary-guarded like the
 * live-edits diff; a NUL in either side marks it binary (the view shows a notice instead).
 */
export async function checkpointFileDiff(
  projectDir: string,
  checkpointId: string,
  relPath: string,
): Promise<CheckpointFileDiff> {
  const before = await showBlob(projectDir, checkpointId, relPath)
  let after = ''
  // Contain the after-side disk read to the project root: `relPath` normally comes from git's own
  // diff output (always inside the repo), but never trust it — a `..` must not read outside root.
  // (`git show` self-protects on the before side.) projectDir is already realpath'd upstream.
  const abs = resolve(projectDir, relPath)
  if (abs === projectDir || abs.startsWith(projectDir + sep)) {
    try {
      after = await readFile(abs, 'utf8')
    } catch {
      // Deleted in the working tree (going back would re-create it) — after stays ''.
    }
  }
  const binary = before.includes('\0') || after.includes('\0')
  const cap = (s: string): { s: string; cut: boolean } =>
    s.length > MAX_FILE_BYTES ? { s: s.slice(0, MAX_FILE_BYTES), cut: true } : { s, cut: false }
  const b = cap(before)
  const a = cap(after)
  return { before: b.s, after: a.s, binary, truncated: b.cut || a.cut }
}
