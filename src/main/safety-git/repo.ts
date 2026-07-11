/**
 * Safety-git store mechanics — a separate git-dir Koda manages over the project's working files,
 * independent of any user `.git`. The deterministic undo stack (dual-git.md §2): it must work
 * even when the project isn't a git repo, and must never touch the user's branches/HEAD/index.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, appendFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { log } from '../logger'

const execFileP = promisify(execFile)

/** The safety store for a project — a git-dir of our own, never the user's `.git`. */
export function safetyGitDir(projectDir: string): string {
  return join(projectDir, '.koda', 'safety.git')
}

/**
 * Run a git command against the safety store. Explicit `--git-dir`/`--work-tree` make it operate
 * over the project's files without ever seeing the user's own `.git` (git treats that as another
 * repo's git-dir and ignores it).
 *
 * Config isolation is load-bearing for a byte-exact, never-hanging undo stack: NOSYSTEM drops
 * /etc/gitconfig and GLOBAL=/dev/null drops the user's ~/.gitconfig. Without the latter a global
 * `core.autocrlf` would rewrite line endings (restore wouldn't be byte-identical) and a global
 * `core.fsmonitor` would block every command on a daemon over the work-tree. So the store reads
 * ONLY its own local config. `timeout` is a backstop so a wedged git can never stall the broker.
 * Big maxBuffer so large-tree `ls-tree`/`log` don't clip.
 *
 * NB: resolving the git binary path (a Finder-launched .app inherits no shell PATH) is a packaging
 * concern — bare `git` is correct for dev. Revisit at bundling alongside the engine path resolver.
 */
export function runGit(
  projectDir: string,
  args: string[],
  opts?: { extraEnv?: Record<string, string> },
): Promise<{ stdout: string; stderr: string }> {
  return execFileP(
    'git',
    ['--git-dir', safetyGitDir(projectDir), '--work-tree', projectDir, ...args],
    {
      cwd: projectDir,
      // extraEnv is for read-only side-paths that need a scratch index (GIT_INDEX_FILE) — it must
      // NOT override the config isolation, so it's spread first.
      env: { ...process.env, ...opts?.extraEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    },
  )
}

/** Local config isolating safety commits from the user's identity, signing, and hooks. */
const LOCAL_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['user.name', 'Koda Safety'],
  ['user.email', 'safety@koda.local'],
  // A user's global commit.gpgsign would otherwise block every checkpoint behind a key prompt.
  ['commit.gpgsign', 'false'],
  // Point hooks at an empty path so a user's global pre-commit/commit-msg can't fail (or worse,
  // side-effect on) an undo snapshot.
  ['core.hooksPath', '/dev/null'],
  // Pin line-ending handling so snapshots are byte-exact regardless of platform defaults
  // (GIT_CONFIG_GLOBAL=/dev/null already removes the user's autocrlf; this nails the default too).
  ['core.autocrlf', 'false'],
  ['core.eol', 'lf'],
]

/**
 * What undo does NOT capture. Lives in `$GIT_DIR/info/exclude` (inside our git-dir) so it's
 * invisible to the user's tree — no stray project `.gitignore`. `.koda/memory/` is deliberately
 * absent: project memory is part of what undo protects (memory.md §4-5).
 */
const EXCLUDE = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  // Never snapshot the snapshots.
  '/.koda/safety.git/',
  // Pasted-image scratch store: binary, auto-pruned, never part of the project's content (scratch.ts).
  '/.koda/scratch/',
  // Local databases (SQLite & sidecars): binary, churn every write, meaningless to diff — and
  // keeping them out means a "go back" rolls back code WITHOUT wiping the user's seeded data.
  // Sidecars are matched broadly (*-wal/*-shm/*-journal) so a stale WAL/journal can never be
  // restored next to a live DB of a different extension — a mismatch that corrupts SQLite.
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*-wal',
  '*-shm',
  '*-journal',
  // Auto-ignored by git anyway (it's a sibling git-dir); kept for clarity.
  '.git/',
  '',
].join('\n')

/**
 * Create the safety store if absent, configure isolation, and write the exclude set. Idempotent —
 * re-running on an existing store re-inits (a no-op) and re-applies config/excludes.
 */
export async function ensureRepo(projectDir: string): Promise<void> {
  // `git init` won't create parent dirs — without this it throws "Invalid path '.../.koda'".
  await mkdir(join(projectDir, '.koda'), { recursive: true })
  await runGit(projectDir, ['init', '--quiet'])
  for (const [key, value] of LOCAL_CONFIG) {
    await runGit(projectDir, ['config', key, value])
  }
  await writeFile(join(safetyGitDir(projectDir), 'info', 'exclude'), EXCLUDE, 'utf8')
  await excludeKodaFromUserGit(projectDir)
}

/**
 * Keep `.koda/` out of the USER's git. The safety store lives *inside* the project
 * (`<project>/.koda/safety.git`), so when the project is itself a git repo, that store shows up as
 * untracked — and the user-git layer (Claude commits on request, dual-git.md §3) would commit it.
 * We add `.koda/` to the user repo's `.git/info/exclude` (NOT the tracked `.gitignore` — never edit
 * the user's file). No-op when the project isn't a git repo (the case safety-git exists for).
 */
export async function excludeKodaFromUserGit(projectDir: string): Promise<void> {
  let excludePath: string
  try {
    // Only touch the user's git when projectDir IS the repo root. `--git-path` walks UP the tree,
    // so for a non-repo subdir of an enclosing repo it would resolve the PARENT's exclude and we'd
    // scribble `.koda/` into a repo the user never opened (code-reviewer Critical). `--show-toplevel`
    // pins the root; realpath both sides (macOS resolves /var → /private/var). Plain git in the
    // user's repo, NOT runGit (which targets the safety store).
    const { stdout: top } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir })
    if ((await realpath(top.trim())) !== (await realpath(projectDir))) return // nested subdir — not ours
    // `--git-path` gives the right info/exclude even for worktrees/submodules.
    const { stdout } = await execFileP('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: projectDir })
    excludePath = resolve(projectDir, stdout.trim())
  } catch {
    return // not a git repo (or bare repo: empty toplevel → realpath throws) — nothing to ignore
  }

  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch {
    /* info/exclude may not exist yet — we create it below */
  }
  if (/^\.koda\/?$/m.test(current)) return // already excluded

  try {
    await mkdir(dirname(excludePath), { recursive: true })
    const prefix = current && !current.endsWith('\n') ? '\n' : ''
    await appendFile(excludePath, `${prefix}.koda/\n`, 'utf8')
  } catch (err) {
    // Fail-soft like the rest: a convenience-exclude write failing must not abort safety-git init.
    log.warn('safety-git', 'could not update user .git/info/exclude', err instanceof Error ? err.message : err)
  }
}
