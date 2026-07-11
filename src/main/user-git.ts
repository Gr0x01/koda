/**
 * User-git — the user's REAL `.git`, the only layer that touches it (dual-git.md §3). Distinct from
 * safety-git in two load-bearing ways: it runs plain `git` in the project root (NO `--git-dir`
 * override, so git walks up to find `.git`), and it keeps the user's `~/.gitconfig` (identity,
 * signing, hooks) — commits must be made as the user, not "Koda Safety". The opposite of repo.ts on
 * both counts, deliberately.
 *
 * Scope is "lean & honest" (RB): detect / status / commit graph / init / commit + branch review, plus
 * the Backup pair (sync-state / push — see the Backup section at the bottom). The read/commit/push
 * surface is non-destructive by construction. The ONE destructive op — `discardBranch`,
 * below — is a deliberate, user-confirmed exception (mirrors `fs:deletePath`: a human explicitly
 * chooses it in the UI behind a confirm). Arbitrary/destructive git the *agent* runs still lands on
 * the engine's Bash path through the broker gate + tripwire; this service has no such open path.
 *
 * Every call is project-root-scoped by the caller (ipc.ts resolves it per-window). The renderer never
 * sends a path — only an optional commit message.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { excludeKodaFromUserGit } from './safety-git/repo'
import { buildGraph, type RawCommit, type GraphLayout } from './git-graph'
import { userPath } from './engine/user-path'

const execFileP = promisify(execFile)

/** Branch name we'll pass to git — strict enough to bar flag-injection (no leading '-', no spaces). */
const SAFE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

/** Cap the changed-file list so a giant working tree can't bloat the IPC payload or the panel. */
const MAX_STATUS_FILES = 200
/** Cap a single file side of a diff (same as fs-browse) so a huge file can't blow up the editor. */
const MAX_FILE_BYTES = 1_000_000

export type UserGitErrorCode =
  | 'no_identity' // user.name / user.email not configured — commit would fail cryptically
  | 'nothing_to_commit'
  | 'not_a_repo'
  | 'not_head' // rename target is no longer the latest version — renaming would rewrite history
  | 'not_clean' // restore with unsaved changes — proceeding would silently eat them
  | 'no_remote' // push with no remote configured — the renderer routes to "Publish" instead
  | 'push_rejected' // non-fast-forward: the remote has versions this checkout doesn't
  | 'push_auth' // the remote refused our credentials — needs a human/agent to sort out access
  | 'git_failed' // anything else; stderr forwarded so the user can diagnose (GPG, hooks, …)

/** A surfaceable failure the renderer pattern-matches on `code` to show specific, plain-language copy. */
export class UserGitError extends Error {
  constructor(
    message: string,
    public readonly code: UserGitErrorCode,
  ) {
    super(message)
    this.name = 'UserGitError'
  }
}

export interface StatusFile {
  /** Project-relative path. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other'
}

export interface CommitEntry {
  sha: string // short
  subject: string
  relativeDate: string // "3 days ago"
  authorName: string
}

export interface RepoInfo {
  isRepo: boolean
  /** Repo root from `--show-toplevel`; differs from the project dir when it's a subdir of a repo. */
  repoRoot: string | null
  /** True when repoRoot !== projectDir — the project sits inside a larger repo. */
  isSubdir: boolean
  /** Current branch name; null when not a repo, detached HEAD, or an empty repo (no commits yet). */
  branch: string | null
  /** The trunk ("main line"): a local branch named main, else master; null when neither exists.
   *  Lets the renderer tell the user they're on a side branch. */
  defaultBranch: string | null
}

export interface StatusResult {
  files: StatusFile[]
  /** True when the real changed count exceeded MAX_STATUS_FILES (list is clipped). */
  truncated: boolean
}

/**
 * Run plain `git` in the project root. Unlike safety-git's runGit: no git-dir override (git finds
 * `.git` itself), no GIT_CONFIG_GLOBAL wipe, and NO NOSYSTEM — this is the user's OWN git and must
 * behave exactly like it does in their terminal (identity, signing, hooks, AND the system gitconfig).
 * That system config matters: on macOS `credential.helper=osxkeychain` is set only there (Xcode/CLT),
 * so dropping it left in-app git with no way to reach the saved GitHub login → pushes failed as "bad
 * credentials." We deliberately mirror the terminal instead of sandboxing here.
 *
 * PATH caveat (same as repo.ts): a Finder-launched .app inherits no shell PATH, so bare `git` is a
 * packaging concern — resolve it alongside the engine binary path at bundling. Bare `git` is correct
 * for dev.
 */
function runUserGit(
  projectDir: string,
  args: string[],
  opts: { timeout?: number; noPrompt?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileP('git', args, {
    cwd: projectDir,
    env: {
      ...process.env,
      // A Finder-launched .app has only launchd's minimal PATH, so git can't find its credential
      // helpers (git-credential-osxkeychain lives beside git in Homebrew/CLT) — pushes then fail as
      // "bad credentials". Same chokepoint as terminal.ts/preview.ts: user tooling needs userPath().
      PATH: userPath(),
      // noPrompt (network ops): a GUI app has no terminal for git to ask credentials on — fail fast
      // with a real error instead of hanging until the timeout. Keychain/agent helpers still work.
      ...(opts.noPrompt ? { GIT_TERMINAL_PROMPT: '0' } : {}),
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 30_000,
  })
}

/** Is this project inside a git repo, and is it the repo root or a subdir of one? */
export async function detectRepo(projectDir: string): Promise<RepoInfo> {
  try {
    const { stdout } = await runUserGit(projectDir, ['rev-parse', '--show-toplevel'])
    const top = stdout.trim()
    if (!top) return { isRepo: false, repoRoot: null, isSubdir: false, branch: null, defaultBranch: null }
    // realpath both sides — macOS resolves /var → /private/var, and the project dir is already
    // realpath'd upstream (project:open), so an un-resolved toplevel would falsely read as a subdir.
    const [realTop, realProject] = await Promise.all([
      realpath(top).catch(() => top),
      realpath(projectDir).catch(() => projectDir),
    ])
    // --show-current is empty on a detached HEAD or an unborn branch (no commits) — both → null.
    let branch: string | null = null
    try {
      branch = (await runUserGit(projectDir, ['branch', '--show-current'])).stdout.trim() || null
    } catch {
      /* leave null */
    }
    let defaultBranch: string | null = null
    try {
      const names = (
        await runUserGit(projectDir, ['branch', '--list', 'main', 'master', '--format=%(refname:short)'])
      ).stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      defaultBranch = names.includes('main') ? 'main' : (names[0] ?? null)
    } catch {
      /* leave null */
    }
    return { isRepo: true, repoRoot: realTop, isSubdir: realTop !== realProject, branch, defaultBranch }
  } catch {
    return { isRepo: false, repoRoot: null, isSubdir: false, branch: null, defaultBranch: null }
  }
}

/** First index/worktree status char → our coarse, non-engineer-facing category. */
function classify(x: string, y: string): StatusFile['status'] {
  if (x === '?' && y === '?') return 'untracked'
  const code = x !== ' ' && x !== '?' ? x : y // prefer the staged side, else the worktree side
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === 'M') return 'modified'
  return 'other'
}

/**
 * Working-tree status. `--porcelain=v1 -z` is stable across git versions and NUL-safe for odd
 * filenames; `--untracked-files=normal` avoids recursing into untracked dirs (no node_modules
 * explosion when there's no .gitignore). Renames emit two NUL fields (new\0old) — we keep the new.
 */
export async function getStatus(projectDir: string): Promise<StatusResult> {
  let stdout: string
  try {
    ;({ stdout } = await runUserGit(projectDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ]))
  } catch {
    return { files: [], truncated: false } // not a repo — fail soft like detect/log
  }
  const tokens = stdout.split('\0')
  const files: StatusFile[] = []
  let total = 0
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue // skip the trailing empty token (and any stray short field)
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    if (x === 'R' || y === 'R') i++ // rename: consume the following old-path token
    total++
    if (files.length < MAX_STATUS_FILES) files.push({ path, status: classify(x, y) })
  }
  return { files, truncated: total > files.length }
}

export interface CommitGraphResult {
  /** Per-row draw instructions + lane palette (see git-graph.ts). */
  layout: GraphLayout
  /** Local branches with work not in the current branch — powers the "stranded work" banner. */
  unmergedBranches: { name: string }[]
  /** Current branch name (null on detached HEAD / unborn). */
  headBranch: string | null
  /** True when more commits exist than the cap. */
  truncated: boolean
}

const EMPTY_GRAPH: CommitGraphResult = {
  layout: { rows: [], laneCount: 0, laneKinds: {} },
  unmergedBranches: [],
  headBranch: null,
  truncated: false,
}

/** Local branches not merged into the current branch. Empty on detached HEAD or any failure. */
async function getUnmergedBranches(projectDir: string): Promise<string[]> {
  try {
    // `--format` MUST precede `--no-merged`: the latter takes an optional commit arg and would
    // otherwise swallow `--format=…` as a (malformed) object name.
    const { stdout } = await runUserGit(projectDir, [
      'branch',
      '--format=%(refname:short)',
      '--no-merged',
    ])
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The commit graph across ALL LOCAL branches (newest-first, date-ordered) — the "Versions" rail. We
 * use `--branches` (not `--all`) on purpose: surface the branches the agent left lying around, but not
 * remote-tracking noise. `%p` gives parents and `%D` the ref decorations; the pure `buildGraph` turns
 * that into lane geometry. Empty on a repo with no commits. One extra commit is fetched to detect
 * truncation without a second `rev-list`.
 */
export async function getCommitGraph(projectDir: string, limit = 50): Promise<CommitGraphResult> {
  try {
    const { stdout } = await runUserGit(projectDir, [
      'log',
      '--branches',
      '--date-order',
      `--max-count=${limit + 1}`,
      '--pretty=format:%h%x1f%p%x1f%s%x1f%cr%x1f%an%x1f%D',
    ])
    const lines = stdout.split('\n').filter((l) => l.length > 0)
    const truncated = lines.length > limit
    let headBranch: string | null = null

    const raw: RawCommit[] = lines.slice(0, limit).map((line) => {
      const [sha, parents, subject, relativeDate, authorName, decoration] = line.split('\x1f')
      const refsRaw = (decoration ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const isHead = refsRaw.some((r) => r === 'HEAD' || r.startsWith('HEAD ->'))
      for (const r of refsRaw) {
        const m = r.match(/^HEAD ->\s*(.+)$/)
        if (m) headBranch = m[1]
      }
      // Drop the bare "HEAD" marker and the "HEAD -> " prefix; keep plain branch/tag names.
      const refs = refsRaw
        .map((r) => r.replace(/^HEAD ->\s*/, ''))
        .filter((r) => r && r !== 'HEAD')
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        subject,
        relativeDate,
        authorName,
        refs,
        isHead,
      }
    })

    if (raw.length === 0) return EMPTY_GRAPH
    const unmerged = await getUnmergedBranches(projectDir)
    const layout = buildGraph(raw, {
      unmergedBranchNames: new Set(unmerged),
      headBranch,
    })
    return { layout, unmergedBranches: unmerged.map((name) => ({ name })), headBranch, truncated }
  } catch {
    // No commits yet / not a repo — fail soft like detect/status.
    return EMPTY_GRAPH
  }
}

export interface VersionListResult {
  versions: CommitEntry[] // newest first; the first entry is HEAD
  truncated: boolean
}

/**
 * A linear list of recent versions on the CURRENT branch — the phone's calm "roll back to a good
 * point" list, deliberately NOT the desktop's multi-branch lane graph (a phone can't render lanes and
 * doesn't need branch archaeology; it needs the safety net). Newest first; entry 0 is HEAD. Fails soft
 * to empty, like every other read here.
 */
export async function getVersionList(projectDir: string, limit = 50): Promise<VersionListResult> {
  try {
    const { stdout } = await runUserGit(projectDir, [
      'log',
      'HEAD',
      `--max-count=${limit + 1}`,
      '--pretty=format:%h%x1f%s%x1f%cr%x1f%an',
    ])
    const lines = stdout.split('\n').filter((l) => l.length > 0)
    const truncated = lines.length > limit
    const versions: CommitEntry[] = lines.slice(0, limit).map((line) => {
      const [sha, subject, relativeDate, authorName] = line.split('\x1f')
      return { sha, subject, relativeDate, authorName }
    })
    return { versions, truncated }
  } catch {
    return { versions: [], truncated: false } // no commits yet / not a repo
  }
}

export interface WorktreeInfo {
  path: string
  branch: string | null // null on a detached HEAD
  isCurrent: boolean // this window's own checkout
  dirtyCount: number
  lastActivity: string // relative date of the worktree's HEAD commit; '' if unreadable
  locked: boolean
  prunable: boolean // the folder is gone — git would prune it
}

/**
 * Dirty-file count + last-commit relative date for a worktree, run in ITS OWN dir (not projectDir).
 * Rename entries consume their trailing old-path token so the count matches getStatus. Fails soft — a
 * prunable/missing dir yields zeros.
 */
async function worktreeMeta(worktreePath: string): Promise<{ dirtyCount: number; lastActivity: string }> {
  const run = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileP('git', args, {
      cwd: worktreePath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    })
  const [dirtyCount, lastActivity] = await Promise.all([
    run(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
      .then(({ stdout }) => {
        const tokens = stdout.split('\0')
        let n = 0
        for (let i = 0; i < tokens.length; i++) {
          const e = tokens[i]
          if (e.length < 4) continue // trailing empty / stray short token
          if (e[0] === 'R' || e[1] === 'R') i++ // rename: skip the following old-path token
          n++
        }
        return n
      })
      .catch(() => 0),
    run(['log', '-1', '--format=%cr'])
      .then(({ stdout }) => stdout.trim())
      .catch(() => ''),
  ])
  return { dirtyCount, lastActivity }
}

/**
 * The worktrees on disk (`git worktree list --porcelain`) — the checkouts a past session left behind.
 * Their branches already show in the graph, but their UNCOMMITTED work has no other surface, so each
 * entry carries that stranded `dirtyCount` + when it was last touched. Bare worktrees are dropped (no
 * working tree to open); `isCurrent` flags this window's own checkout. Fails soft to []. Paths come
 * straight from git (not the renderer), so they're the repo's real worktrees — safe to hand to open.
 */
export async function getWorktrees(projectDir: string): Promise<WorktreeInfo[]> {
  let stdout: string
  try {
    ;({ stdout } = await runUserGit(projectDir, ['worktree', 'list', '--porcelain']))
  } catch {
    return [] // not a repo / old git without worktree support — fail soft
  }
  const realProject = await realpath(projectDir).catch(() => projectDir)

  // Porcelain: one block per worktree (attributes one-per-line), blank line between blocks.
  type Block = { path: string; branch: string | null; bare: boolean; locked: boolean; prunable: boolean }
  const blocks: Block[] = []
  let cur: Block | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, bare: false, locked: false, prunable: false }
      blocks.push(cur)
    } else if (!cur) {
      continue
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line.startsWith('locked')) {
      cur.locked = true
    } else if (line.startsWith('prunable')) {
      cur.prunable = true
    }
  }

  const usable = blocks.filter((b) => !b.bare)
  // A lone worktree needs no per-worktree dirty/activity: the Versions section won't render and the
  // badge only tracks OTHER worktrees. Skipping it keeps the after-every-turn poll to one git call.
  const needMeta = usable.length > 1
  return Promise.all(
    usable.map(async (b) => {
      const meta =
        needMeta && !b.prunable ? await worktreeMeta(b.path) : { dirtyCount: 0, lastActivity: '' }
      const real = await realpath(b.path).catch(() => b.path)
      return {
        path: b.path,
        branch: b.branch,
        isCurrent: real === realProject,
        dirtyCount: meta.dirtyCount,
        lastActivity: meta.lastActivity,
        locked: b.locked,
        prunable: b.prunable,
      }
    }),
  )
}

export interface MergedStray {
  branch: string
  /** The worktree checked out on this branch (removed together with it); null = a bare branch pointer. */
  worktreePath: string | null
}

/**
 * Leftovers from finished work: local branches whose every commit is already in the trunk, plus the
 * clean worktrees still checked out on them. These are safe to remove — nothing exists only there —
 * which is exactly why they're invisible mess: the graph shows their labels but nothing says "this is
 * done, tidy it". Excluded (NOT strays): the trunk itself, this window's own checkout, and any merged
 * branch whose worktree has unsaved changes or is locked — those keep their existing surfaces
 * (Changes / Other checkouts). Fails soft to [].
 */
export async function getMergedStrays(projectDir: string): Promise<MergedStray[]> {
  try {
    const info = await detectRepo(projectDir)
    if (!info.isRepo || !info.defaultBranch) return []
    const trunk = info.defaultBranch
    // `--format` before `--merged` for the same optional-commit-arg reason as getUnmergedBranches.
    const { stdout } = await runUserGit(projectDir, [
      'branch',
      '--format=%(refname:short)',
      '--merged',
      trunk,
    ])
    const merged = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((b) => b && b !== trunk && SAFE_BRANCH.test(b))
    if (merged.length === 0) return []

    const worktrees = await getWorktrees(projectDir)
    const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch as string, w]))
    const strays: MergedStray[] = []
    for (const branch of merged) {
      const wt = byBranch.get(branch)
      if (!wt) {
        strays.push({ branch, worktreePath: null })
      } else if (wt.isCurrent || wt.locked) {
        continue // this window's own checkout (side-branch banner territory) / deliberately pinned
      } else if (wt.prunable) {
        strays.push({ branch, worktreePath: wt.path }) // folder already gone — prune + delete
      } else if (wt.dirtyCount === 0) {
        strays.push({ branch, worktreePath: wt.path })
      }
      // dirty sibling checkout of a merged branch: not safe — stays in "Other checkouts"
    }
    return strays
  } catch {
    return []
  }
}

export interface TidyResult {
  /** Branches cleaned up (worktree removed too where one existed). */
  removed: string[]
  failed: { branch: string; message: string }[]
}

/**
 * Remove the merged strays — safe operations ONLY, recomputed here rather than trusting a renderer
 * list (the repo may have moved since it was shown). `worktree prune` first clears registrations whose
 * folders are already gone; `worktree remove` (never --force) refuses a dirty tree even if our check
 * raced; `branch -d` (never -D) refuses anything unmerged. Per-item failures are collected, not
 * thrown — one stubborn branch shouldn't stop the rest of the tidy.
 *
 * `only` (optional) limits the tidy to those branch names — the per-row "remove just this one". It's a
 * FILTER over the freshly-recomputed safe set, never a bypass: a name that isn't currently a safe stray
 * is simply skipped, so the renderer can't push an unsafe removal through by naming it.
 */
export async function tidyMergedStrays(projectDir: string, only?: string[]): Promise<TidyResult> {
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  await runUserGit(projectDir, ['worktree', 'prune']).catch(() => {})

  const wanted = only && only.length > 0 ? new Set(only) : null
  const removed: string[] = []
  const failed: { branch: string; message: string }[] = []
  for (const stray of await getMergedStrays(projectDir)) {
    if (wanted && !wanted.has(stray.branch)) continue
    try {
      if (stray.worktreePath) {
        await runUserGit(projectDir, ['worktree', 'remove', stray.worktreePath])
      }
      await runUserGit(projectDir, ['branch', '-d', stray.branch])
      removed.push(stray.branch)
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      failed.push({ branch: stray.branch, message: (e.stderr || e.message || 'git failed').trim() })
    }
  }
  return { removed, failed }
}

export interface BranchOverview {
  name: string
  /** Commits on this branch that aren't in the current branch (newest first). */
  commits: CommitEntry[]
  /** Files this branch changed vs the merge-base with the current branch. */
  files: StatusFile[]
  /** Number of commits ahead of the current branch. */
  ahead: number
  truncated: boolean
}

/** merge-base(HEAD, branch); '' if it can't be resolved (unrelated histories). */
async function mergeBase(projectDir: string, branch: string): Promise<string> {
  try {
    return (await runUserGit(projectDir, ['merge-base', 'HEAD', branch])).stdout.trim()
  } catch {
    return ''
  }
}

/**
 * "What's on this branch that isn't in your project yet" — the Review focus. Commits are `base..branch`;
 * files are the combined tree diff `base..branch`. Used to decide merge-in vs discard. Read-only.
 */
export async function getBranchOverview(projectDir: string, branch: string): Promise<BranchOverview> {
  if (!SAFE_BRANCH.test(branch)) throw new UserGitError('bad branch name', 'git_failed')
  const base = await mergeBase(projectDir, branch)
  const range = base ? `${base}..${branch}` : branch

  let commits: CommitEntry[] = []
  try {
    const { stdout } = await runUserGit(projectDir, [
      'log',
      `--max-count=${MAX_STATUS_FILES}`,
      '--pretty=format:%h%x1f%s%x1f%cr%x1f%an',
      range,
    ])
    commits = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\x1f'))
      .filter((f) => f.length >= 4)
      .map(([sha, subject, relativeDate, authorName]) => ({ sha, subject, relativeDate, authorName }))
  } catch {
    /* leave empty */
  }

  const files: StatusFile[] = []
  let truncated = false
  if (base) {
    try {
      const { stdout } = await runUserGit(projectDir, [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        base,
        branch,
      ])
      const tokens = stdout.split('\0')
      let total = 0
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const letter = tokens[i]?.[0]
        const path = tokens[i + 1]
        if (!letter || !path) continue
        total++
        if (files.length >= MAX_STATUS_FILES) continue
        files.push({
          path,
          status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
        })
      }
      truncated = total > files.length
    } catch {
      /* leave empty */
    }
  }

  return { name: branch, commits, files, ahead: commits.length, truncated }
}

/** One file's before/after for a branch Review: merge-base(HEAD,branch):file → branch:file. */
export async function branchFileDiff(
  projectDir: string,
  branch: string,
  requested: string,
): Promise<UserGitFileDiff> {
  if (!SAFE_BRANCH.test(branch)) throw new UserGitError('bad branch name', 'git_failed')
  // `requested` is project-root-relative (as getBranchOverview emits). `git show <rev>:<rel>` is
  // root-relative too, so before/after content is correct. Caveat (matches gitFileDiff): when the
  // project is a SUBDIR of a larger repo, the returned `path` display key is projectDir-joined.
  const abs = resolve(projectDir, requested)
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) {
    throw new Error('path escapes the project root')
  }
  const rel = relative(projectDir, abs).split(sep).join('/')
  const base = await mergeBase(projectDir, branch)

  let binary = false
  let truncated = false
  const cap = (s: string): string => {
    if (s.includes('\0')) binary = true
    if (s.length > MAX_FILE_BYTES) {
      truncated = true
      return s.slice(0, MAX_FILE_BYTES)
    }
    return s
  }
  const before = cap(base ? await showBlobOrEmpty(projectDir, base, rel) : '')
  const after = cap(await showBlobOrEmpty(projectDir, branch, rel))
  return { path: abs, before, after, binary, truncated }
}

/**
 * Delete a local branch (the manual "Discard this branch"). The ONE destructive op in this service —
 * gated three ways: a strict name regex (no flag injection), refusing the current branch (git would
 * anyway), and `-D` only after the renderer's explicit confirm. NOT covered by safety-git (it tracks
 * the working tree, not refs), so the renderer's confirm copy must be honest that this isn't a clean undo.
 */
export async function discardBranch(projectDir: string, branch: string): Promise<void> {
  if (!SAFE_BRANCH.test(branch)) throw new UserGitError('bad branch name', 'git_failed')
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  if (info.branch === branch) {
    throw new UserGitError("can't discard the branch you're on", 'git_failed')
  }
  try {
    await runUserGit(projectDir, ['branch', '-D', branch])
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new UserGitError(e.stderr || e.message || 'branch delete failed', 'git_failed')
  }
}

export interface UserGitFileDiff {
  /** Absolute path (the surface's stable key). */
  path: string
  before: string
  after: string
  binary: boolean
  truncated: boolean
}

/** Read a blob at a git ref (`ref:rel`); '' when it's absent there (added/deleted on that side). */
async function showBlobOrEmpty(projectDir: string, ref: string, rel: string): Promise<string> {
  try {
    return (await runUserGit(projectDir, ['show', `${ref}:${rel}`])).stdout
  } catch {
    return ''
  }
}

/**
 * One changed file's before/after for the artifact-zone diff. Two modes:
 *  - no `ref` (Source Control "Changes"): before = file at HEAD, after = current WORKING-TREE content.
 *  - with `ref` (a past version/commit): before = file at the commit's parent (`ref^`), after = the
 *    file AT that commit (`ref`) — "what this version changed".
 * Untracked/added → before ''; deleted → after ''. Contained to the project root, size-capped,
 * binary-guarded like the live-edits diff.
 */
export async function gitFileDiff(
  projectDir: string,
  requested: string,
  ref?: string,
): Promise<UserGitFileDiff> {
  const abs = resolve(projectDir, requested)
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) {
    throw new Error('path escapes the project root')
  }
  const rel = relative(projectDir, abs).split(sep).join('/')

  let before: string
  let after = ''
  let binary = false
  let truncated = false
  const cap = (s: string): string => {
    if (s.includes('\0')) binary = true
    if (s.length > MAX_FILE_BYTES) {
      truncated = true
      return s.slice(0, MAX_FILE_BYTES)
    }
    return s
  }

  if (ref) {
    before = cap(await showBlobOrEmpty(projectDir, `${ref}^`, rel)) // '' for a root commit (no parent)
    after = cap(await showBlobOrEmpty(projectDir, ref, rel))
  } else {
    before = cap(await showBlobOrEmpty(projectDir, 'HEAD', rel))
    try {
      const buf = await readFile(abs)
      const slice = buf.subarray(0, MAX_FILE_BYTES)
      if (slice.includes(0)) binary = true
      else after = slice.toString('utf8')
      if (buf.length > MAX_FILE_BYTES) truncated = true
    } catch {
      /* deleted on disk — after stays '' */
    }
  }

  return { path: abs, before, after, binary, truncated }
}

/** Cap for one unified-diff payload shipped to the phone — a pocket screen reads hunks, not megabytes. */
const MAX_DIFF_TEXT = 200_000

/**
 * Unified diff TEXT for one working-tree file vs HEAD — the remote (phone) diff surface. Ships git's
 * own hunks instead of before/after blobs, so the payload stays small enough for a relay frame and the
 * client just colors lines. Untracked files diff against /dev/null (all-adds); binary changes come out
 * as git's one-line "Binary files … differ" notice, which renders fine as-is.
 */
export async function diffTextOf(
  projectDir: string,
  requested: string,
): Promise<{ diff: string; truncated: boolean }> {
  const abs = resolve(projectDir, requested)
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) {
    throw new Error('path escapes the project root')
  }
  const rel = relative(projectDir, abs).split(sep).join('/')
  // `git diff` exits 1 when differences exist under --no-index — read stdout off the error too.
  const run = async (args: string[]): Promise<string> => {
    try {
      return (await runUserGit(projectDir, args)).stdout
    } catch (err) {
      const out = (err as { stdout?: string }).stdout
      if (typeof out === 'string' && out) return out
      return ''
    }
  }
  let diff = await run(['diff', 'HEAD', '--', rel])
  // Untracked file: HEAD has nothing to diff against — show it as all-adds. Gated on actually being
  // untracked: a file that went CLEAN between the status list and this call would otherwise fall
  // through and render its entire content as an added diff.
  if (!diff) {
    const tracked = await runUserGit(projectDir, ['ls-files', '--error-unmatch', '--', rel]).then(
      () => true,
      () => false,
    )
    if (!tracked) diff = await run(['diff', '--no-index', '--', '/dev/null', rel])
  }
  const truncated = diff.length > MAX_DIFF_TEXT
  return { diff: truncated ? diff.slice(0, MAX_DIFF_TEXT) + '\n… (truncated)' : diff, truncated }
}

/**
 * The files a commit changed (vs its first parent; a root commit shows as all-adds via `--root`).
 * `diff-tree` doesn't touch the working tree. Renames split into delete+add (`--no-renames`) — clearer
 * for a non-engineer. Capped like getStatus.
 */
export async function commitChanges(projectDir: string, sha: string): Promise<StatusResult> {
  const { stdout } = await runUserGit(projectDir, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '-r',
    '-z',
    '--no-renames',
    '--root',
    sha,
  ])
  const tokens = stdout.split('\0')
  const files: StatusFile[] = []
  let total = 0
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const letter = tokens[i]?.[0]
    const path = tokens[i + 1]
    if (!letter || !path) continue
    total++
    if (files.length >= MAX_STATUS_FILES) continue
    const status: StatusFile['status'] =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
    files.push({ path, status })
  }
  return { files, truncated: total > files.length }
}

/** `git init` at the project root. Idempotent; reports whether a repo already existed. */
export async function initRepo(projectDir: string): Promise<{ alreadyExisted: boolean }> {
  const before = await detectRepo(projectDir)
  if (before.isRepo && !before.isSubdir) return { alreadyExisted: true }
  await runUserGit(projectDir, ['init', '--quiet'])
  // Keep safety-git's store out of the user's history. ensureRepo also does this on session start,
  // but a user can init + commit from the panel before that runs — so a fresh user repo would
  // otherwise stage `.koda/safety.git/**`. Idempotent; safe to run here too.
  await excludeKodaFromUserGit(projectDir)
  return { alreadyExisted: false }
}

/** Are both user.name and user.email set? A commit without them fails cryptically for a non-engineer. */
async function hasIdentity(projectDir: string): Promise<boolean> {
  const read = async (key: string): Promise<string> => {
    try {
      return (await runUserGit(projectDir, ['config', key])).stdout.trim()
    } catch {
      return '' // unset → git config exits 1
    }
  }
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return !!name && !!email
}

/**
 * Stage everything and commit. Checks identity first (clear error beats a cryptic git one), and maps
 * "nothing to commit" to its own code. Never passes --no-verify/--no-gpg-sign: the user's hooks and
 * signing are theirs to keep. The new short SHA is read back via rev-parse (simpler than parsing the
 * commit line).
 */
export async function commitAll(projectDir: string, message: string): Promise<{ sha: string }> {
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  if (!(await hasIdentity(projectDir))) {
    throw new UserGitError('git has no user.name / user.email configured', 'no_identity')
  }

  await runUserGit(projectDir, ['add', '-A'])
  try {
    await runUserGit(projectDir, ['commit', '--message', message])
  } catch (err) {
    throwCommitError(err)
  }
  const { stdout } = await runUserGit(projectDir, ['rev-parse', '--short', 'HEAD'])
  return { sha: stdout.trim() }
}

/**
 * Commit ONLY the given paths — the per-session "Save this session's work". Stages exactly those paths
 * (covers new/untracked, modified, and deletions) and commits them via an explicit pathspec, so any
 * other dirty files (another session's in-flight work) stay uncommitted. Same identity check and error
 * mapping as commitAll. Paths are project-relative, straight from `getStatus`; `--` guards any that
 * look like flags.
 */
export async function commitPaths(
  projectDir: string,
  paths: string[],
  message: string,
): Promise<{ sha: string }> {
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  if (!(await hasIdentity(projectDir))) {
    throw new UserGitError('git has no user.name / user.email configured', 'no_identity')
  }
  if (paths.length === 0) throw new UserGitError('nothing to commit', 'nothing_to_commit')

  // Stage the requested paths (a deleted path stages its removal; an untracked one, its addition).
  await runUserGit(projectDir, ['add', '--', ...paths])
  // getStatus surfaces only a rename's NEW path; its old-path deletion is already staged (a staged
  // rename) — so the COMMIT pathspec must name the old path too, or the deletion would be left behind.
  // We don't `add` the old path (it has no working-tree file → `git add` would fatal); it's staged.
  const commitSpec = [...new Set([...paths, ...(await renameSources(projectDir, paths))])]
  try {
    // Pathspec-scoped commit: takes only these paths, ignoring whatever else is staged — the invariant
    // that keeps a sibling session's changes out of this version.
    await runUserGit(projectDir, ['commit', '--message', message, '--', ...commitSpec])
  } catch (err) {
    throwCommitError(err)
  }
  const { stdout } = await runUserGit(projectDir, ['rev-parse', '--short', 'HEAD'])
  return { sha: stdout.trim() }
}

/**
 * Reword the just-saved version — the "Rename" on a one-click save. Only proceeds if `sha` is still
 * HEAD, so it's a plain `git commit --amend` (message-only): never a rebase / history rewrite of an
 * older commit. `--amend` folds in the *staged* tree, but this flow leaves the index clean after a
 * save, so the amend touches only the message. A stale target (another version landed on top) fails
 * with `not_head` for the renderer to surface calmly.
 */
export async function renameHead(
  projectDir: string,
  sha: string,
  message: string,
): Promise<{ sha: string }> {
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  if (!(await hasIdentity(projectDir))) {
    throw new UserGitError('git has no user.name / user.email configured', 'no_identity')
  }
  const { stdout: head } = await runUserGit(projectDir, ['rev-parse', 'HEAD'])
  // Accept the short SHA the renderer holds by matching it as a prefix of the full HEAD.
  if (!head.trim().startsWith(sha)) {
    throw new UserGitError('version is no longer the latest', 'not_head')
  }
  try {
    await runUserGit(projectDir, ['commit', '--amend', '--message', message])
  } catch (err) {
    throwCommitError(err)
  }
  const { stdout } = await runUserGit(projectDir, ['rev-parse', '--short', 'HEAD'])
  return { sha: stdout.trim() }
}

/**
 * Restore the project's files to how they were at `sha`, saved as a NEW version on top — never a
 * history rewrite, so a restore is always undoable by another restore. `git restore --source --staged
 * --worktree :/` is the one primitive that both updates changed files AND deletes files added since
 * (verified: plain `checkout <sha> -- .` leaves later additions behind). Requires a clean tree —
 * proceeding with unsaved changes would silently eat them (`not_clean`); restoring to a state the
 * files already match surfaces as `nothing_to_commit` for the renderer's "already matches" copy.
 */
export async function restoreVersion(projectDir: string, sha: string): Promise<{ sha: string }> {
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  if (!(await hasIdentity(projectDir))) {
    throw new UserGitError('git has no user.name / user.email configured', 'no_identity')
  }
  const status = await getStatus(projectDir)
  if (status.files.length > 0) {
    throw new UserGitError('there are unsaved changes — save or discard them first', 'not_clean')
  }
  const subject = (await runUserGit(projectDir, ['log', '-1', '--format=%s', sha])).stdout.trim()
  await runUserGit(projectDir, ['restore', '--source', sha, '--staged', '--worktree', '--', ':/'])
  try {
    await runUserGit(projectDir, ['commit', '--message', `Restored “${subject}”`])
  } catch (err) {
    throwCommitError(err)
  }
  const { stdout } = await runUserGit(projectDir, ['rev-parse', '--short', 'HEAD'])
  return { sha: stdout.trim() }
}

/** Does HEAD have a blob at this (project-relative) path? Distinguishes a tracked file (revertable to
 *  its last-saved content) from a new one (nothing to revert to → removed). False on an unborn HEAD. */
async function pathInHead(projectDir: string, path: string): Promise<boolean> {
  try {
    await runUserGit(projectDir, ['cat-file', '-e', `HEAD:${path}`])
    return true
  } catch {
    return false
  }
}

/**
 * Discard ONE file's uncommitted change, back to the last saved version:
 *  - a file HEAD has (modified / deleted / staged) → restored to its HEAD content (index + worktree)
 *  - a file HEAD lacks (new, whether untracked or staged) → removed from the working tree
 * Whole-tree recoverability is the CALLER's job — a safety-git checkpoint BEFORE this — mirroring the
 * editor's delete/replace, so even removing an untracked file is undoable from the recovery timeline.
 * `--` guards paths that look like flags; the path is project-relative, straight from getStatus.
 */
export async function discardFile(projectDir: string, path: string): Promise<void> {
  const info = await detectRepo(projectDir)
  if (!info.isRepo) throw new UserGitError('not a git repo', 'not_a_repo')
  if (await pathInHead(projectDir, path)) {
    // Revert index + worktree to HEAD in one primitive — covers modified, staged, and deleted.
    await runUserGit(projectDir, ['restore', '--source', 'HEAD', '--staged', '--worktree', '--', path])
  } else {
    // Not in HEAD → a new file. Unstage first (no-op for a purely untracked path) so clean can see it,
    // then remove it from the working tree (-d to drop a newly-created directory too).
    try {
      await runUserGit(projectDir, ['reset', '--quiet', '--', path])
    } catch {
      /* nothing staged to unstage */
    }
    await runUserGit(projectDir, ['clean', '--force', '-d', '--', path])
  }
}

/** The old paths of any renames whose NEW path is in `paths` — so a path-scoped commit includes the
 *  rename's deletion side, not just its addition. Same porcelain parse as getStatus (renames emit
 *  new\0old). Fails soft to none. */
async function renameSources(projectDir: string, paths: string[]): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await runUserGit(projectDir, ['status', '--porcelain=v1', '-z']))
  } catch {
    return []
  }
  const want = new Set(paths)
  const tokens = stdout.split('\0')
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    if (entry[0] === 'R' || entry[1] === 'R') {
      const newPath = entry.slice(3)
      const oldPath = tokens[++i] // rename's old path is the next NUL field
      if (oldPath && want.has(newPath)) out.push(oldPath)
    }
  }
  return out
}

// ── Distribution (the remote) ─────────────────────────────────────────────────────────
// The one place user-git knows a remote exists. This models "is my work OUT of this machine, on
// GitHub?" — the answer that actually matters (off-machine safety, a live site, other devices), which
// is why the read side VERIFIES against the real remote instead of guessing from a stale local cache.
//   Read (getSyncState): `ls-remote` reads GitHub's real branch tip. If we already hold that commit
//   locally we count ahead/behind exactly with no fetch (the common "I'm ahead" case, fast). If we
//   don't (genuinely behind/diverged) we fetch just that branch to count. If the remote is unreachable
//   we return `verified:false` with best-effort local numbers — a false "you're safe" is the one
//   failure we refuse, so the UI shows "couldn't confirm", never a confident green.
//   Write (pushToRemote): plain fast-forward push; refusals come back tagged for the renderer.
// Remote SETUP (create a repo, auth) is deliberately not here — that's a conversation the agent owns.

export interface SyncState {
  /** Any remote configured at all? false ⇒ the project exists only on this machine. */
  hasRemote: boolean
  remoteName: string | null // 'origin' when present, else the first remote
  remoteUrl: string | null
  /** The current branch's upstream ref (e.g. "origin/main"); null when the branch was never pushed. */
  upstream: string | null
  /** Commits that exist only locally — versions not yet on the remote. */
  ahead: number
  /** Commits on the remote branch that aren't local. */
  behind: number
  /** Short SHA of the remote branch tip — the graph's "on GitHub up to here" marker. */
  upstreamTip: string | null
  /** True iff this read actually reached the remote. False ⇒ numbers are a best-effort local guess. */
  verified: boolean
}

const NO_SYNC: SyncState = {
  hasRemote: false,
  remoteName: null,
  remoteUrl: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamTip: null,
  verified: false,
}

/** merge-base --is-ancestor: does `sha` already exist in HEAD's history? Unknown object ⇒ false. */
async function containsCommit(projectDir: string, sha: string): Promise<boolean> {
  try {
    await runUserGit(projectDir, ['merge-base', '--is-ancestor', sha, 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Offline fallback: the old cache-based counts, used only when the remote can't be reached. */
async function localCachedCounts(
  projectDir: string,
  upstream: string | null,
): Promise<{ ahead: number; behind: number; upstreamTip: string | null }> {
  if (upstream) {
    try {
      const counts = (
        await runUserGit(projectDir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
      ).stdout.trim()
      const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10))
      const upstreamTip =
        (await runUserGit(projectDir, ['rev-parse', '--short', upstream])).stdout.trim() || null
      return { ahead: a || 0, behind: b || 0, upstreamTip }
    } catch {
      return { ahead: 0, behind: 0, upstreamTip: null }
    }
  }
  // Never-pushed branch: every commit that reached no remote-tracking ref at all is "not out".
  try {
    const ahead =
      parseInt(
        (await runUserGit(projectDir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).stdout.trim(),
        10,
      ) || 0
    return { ahead, behind: 0, upstreamTip: null }
  } catch {
    return { ahead: 0, behind: 0, upstreamTip: null }
  }
}

export async function getSyncState(projectDir: string): Promise<SyncState> {
  try {
    const remotes = (await runUserGit(projectDir, ['remote'])).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (remotes.length === 0) return NO_SYNC
    const remoteName = remotes.includes('origin') ? 'origin' : remotes[0]

    let remoteUrl: string | null = null
    try {
      remoteUrl = (await runUserGit(projectDir, ['remote', 'get-url', remoteName])).stdout.trim() || null
    } catch {
      /* leave null */
    }

    // Local upstream ref — kept only as the fallback source of numbers when the remote is unreachable.
    let upstream: string | null = null
    try {
      upstream =
        (
          await runUserGit(projectDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
        ).stdout.trim() || null
    } catch {
      /* leave null */
    }

    const branch = (await runUserGit(projectDir, ['branch', '--show-current'])).stdout.trim()
    const base = { hasRemote: true, remoteName, remoteUrl, upstream }

    // Detached HEAD (no branch to compare) — can't verify against a remote branch; best-effort local.
    if (!branch || !SAFE_BRANCH.test(branch)) {
      return { ...base, ...(await localCachedCounts(projectDir, upstream)), verified: false }
    }

    // The truth: ask the actual remote where its branch tip is.
    let remoteSha: string | null
    try {
      const ls = (
        await runUserGit(projectDir, ['ls-remote', remoteName, `refs/heads/${branch}`], {
          timeout: 15_000,
          noPrompt: true,
        })
      ).stdout.trim()
      remoteSha = ls ? ls.split(/\s+/)[0] : null
    } catch {
      // Offline / auth / timeout: fail conservative — best-effort numbers, flagged unverified.
      return { ...base, ...(await localCachedCounts(projectDir, upstream)), verified: false }
    }

    // Branch not on the remote yet → nothing is out. Every local commit is ahead.
    if (!remoteSha) {
      const ahead =
        parseInt((await runUserGit(projectDir, ['rev-list', '--count', 'HEAD'])).stdout.trim(), 10) || 0
      return { ...base, ahead, behind: 0, upstreamTip: null, verified: true }
    }

    const head = (await runUserGit(projectDir, ['rev-parse', 'HEAD'])).stdout.trim()
    if (remoteSha === head) {
      const tip = (await runUserGit(projectDir, ['rev-parse', '--short', 'HEAD'])).stdout.trim() || null
      return { ...base, ahead: 0, behind: 0, upstreamTip: tip, verified: true }
    }

    // Diverged from the remote tip. If we don't already hold that commit, fetch just this branch so we
    // can count exactly (the "behind"/diverged case; the common "ahead" case already contains it).
    if (!(await containsCommit(projectDir, remoteSha))) {
      try {
        await runUserGit(projectDir, ['fetch', remoteName, branch], { timeout: 30_000, noPrompt: true })
      } catch {
        // Reached ls-remote but can't fetch the objects → we know we're out of sync but can't count.
        return { ...base, ...(await localCachedCounts(projectDir, upstream)), verified: false }
      }
    }

    try {
      const counts = (
        await runUserGit(projectDir, ['rev-list', '--left-right', '--count', `${remoteSha}...HEAD`])
      ).stdout.trim()
      const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10))
      const tip = (await runUserGit(projectDir, ['rev-parse', '--short', remoteSha])).stdout.trim() || null
      return { ...base, ahead: a || 0, behind: b || 0, upstreamTip: tip, verified: true }
    } catch {
      return { ...base, ...(await localCachedCounts(projectDir, upstream)), verified: false }
    }
  } catch {
    return NO_SYNC // not a repo / git missing — fail soft like detect/status
  }
}

/**
 * Push the current branch. With an upstream: plain `git push` (respects the user's config). Without
 * one: `push -u <remote> <branch>` so the branch is connected for next time. Network op ⇒ longer
 * timeout + no terminal prompts (a credential ask would otherwise hang a GUI app). Failures map to
 * tagged codes the renderer can route: rejected (remote is ahead) / auth / everything else.
 */
export async function pushToRemote(projectDir: string): Promise<void> {
  const state = await getSyncState(projectDir)
  if (!state.hasRemote || !state.remoteName) throw new UserGitError('no remote configured', 'no_remote')

  let args: string[]
  if (state.upstream) {
    args = ['push']
  } else {
    const branch = (await runUserGit(projectDir, ['branch', '--show-current'])).stdout.trim()
    if (!branch || !SAFE_BRANCH.test(branch)) {
      throw new UserGitError('not on a branch — nothing to push', 'git_failed')
    }
    args = ['push', '--set-upstream', state.remoteName, branch]
  }

  try {
    await runUserGit(projectDir, args, { timeout: 120_000, noPrompt: true })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const out = `${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`
    const msg = (e.stderr || e.stdout || 'git push failed').trim()
    if (/non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]/i.test(out)) {
      throw new UserGitError(msg, 'push_rejected')
    }
    if (/authentication failed|could not read username|permission denied|publickey|403|terminal prompts disabled/i.test(out)) {
      throw new UserGitError(msg, 'push_auth')
    }
    throw new UserGitError(msg, 'git_failed')
  }
}

/** Map a failed `git commit` to a tagged UserGitError. "nothing to commit" lands on STDOUT (not
 *  stderr); GPG/hook failures on stderr. Always throws. */
function throwCommitError(err: unknown): never {
  const e = err as { stdout?: string; stderr?: string; message?: string }
  const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`
  if (/nothing to commit|no changes added/i.test(out)) {
    throw new UserGitError('nothing to commit', 'nothing_to_commit')
  }
  throw new UserGitError((e.stderr || e.stdout || 'git commit failed').trim(), 'git_failed')
}
