import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({ log: { info: () => {}, warn, error: () => {}, debug: () => {} } }))

const {
  commitPaths,
  completionGitSnapshot,
  completionStatusForPaths,
  detectRepo,
  getCommitGraph,
  getMergedStrays,
  getWorktrees,
} = await import('./user-git')

const execFileP = promisify(execFile)
const git = (cwd: string, args: string[]): Promise<unknown> => execFileP('git', args, { cwd })

/** Did the probe log the "silent zero" warning for this leg (`status` / `log`)? */
const warnedAbout = (what: string): boolean =>
  warn.mock.calls.some(
    ([scope, msg, data]) =>
      scope === 'user-git' &&
      msg === 'worktree probe failed' &&
      (data as { what?: string })?.what === what,
  )

let dir: string
let repo: string
beforeEach(async () => {
  warn.mockClear()
  dir = await mkdtemp(join(tmpdir(), 'koda-user-git-'))
  repo = join(dir, 'repo')
  await git(dir, ['init', '-q', '-b', 'main', 'repo'])
  await git(repo, ['config', 'user.email', 'test@koda.local'])
  await git(repo, ['config', 'user.name', 'Koda Test'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repo, 'a.txt'), 'hello\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-qm', 'init'])
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * The bug this pins: worktreeMeta's probes used to swallow every failure and return 0/'' — so a
 * worktree whose git spawn genuinely failed was indistinguishable from a clean one, which is how a
 * packaged .app read every row as "0 changed files". A failed probe must leave a trail; the one
 * exempted failure (a branch with no commits yet, hit on an after-every-turn poll) must not.
 * Meta is only probed when there's more than one worktree, so every case adds a second checkout.
 */
describe('getWorktrees — worktree probe failures are not silent zeros', () => {
  it('warns when a probe fails instead of reporting a clean worktree', async () => {
    const wt = join(dir, 'broken')
    await git(repo, ['worktree', 'add', '-q', '-b', 'broken', wt])
    // The dir still exists (so git does NOT mark it prunable and the listing still probes it), but
    // its gitfile is garbage — every git command run inside it fails.
    await writeFile(join(wt, '.git'), 'not a gitfile\n')

    const entry = (await getWorktrees(repo)).find((w) => basename(w.path) === 'broken')
    expect(entry).toBeDefined()
    expect(entry!.prunable).toBe(false) // otherwise the listing skipped the code under test
    expect(entry!.dirtyCount).toBe(0)
    expect(entry!.statusKnown).toBe(false)
    expect(entry!.lastActivity).toBe('')
    expect(warnedAbout('status')).toBe(true)
    expect(warnedAbout('log')).toBe(true)
  })

  it('stays silent for a branch with no commits yet', async () => {
    await git(repo, ['worktree', 'add', '-q', '--orphan', join(dir, 'empty')])

    const entry = (await getWorktrees(repo)).find((w) => basename(w.path) === 'empty')
    expect(entry).toBeDefined()
    // `git log -1` DID fail here (nothing to report yet) — the empty value proves the path ran.
    expect(entry!.lastActivity).toBe('')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports the real dirty count for a healthy worktree', async () => {
    const wt = join(dir, 'feature')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature', wt])
    await writeFile(join(wt, 'a.txt'), 'changed\n') // tracked, modified
    await writeFile(join(wt, 'new.txt'), 'new\n') // untracked

    const entry = (await getWorktrees(repo)).find((w) => basename(w.path) === 'feature')
    expect(entry).toBeDefined()
    expect(entry!.dirtyCount).toBe(2)
    expect(entry!.statusKnown).toBe(true)
    expect(entry!.lastActivity).not.toBe('')
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not auto-tidy a merged worktree whose status could not be checked', async () => {
    const wt = join(dir, 'merged-but-unreadable')
    await git(repo, ['worktree', 'add', '-q', '-b', 'merged-but-unreadable', wt])
    // This branch points at main and is therefore merged, but the checkout is not provably clean.
    await writeFile(join(wt, '.git'), 'not a gitfile\n')

    expect(await getMergedStrays(repo)).not.toContainEqual({
      branch: 'merged-but-unreadable',
      worktreePath: wt,
    })
  })
})

/**
 * A linked worktree is its own `--show-toplevel` root and reports a perfectly ordinary branch, so
 * only git-dir vs git-common-dir separates it from the canonical checkout — and that separation is
 * what keeps an unattended commit off a checkout the user is reviewing in. The subdir case is the
 * trap: git prints `--git-common-dir` relative to the process cwd, so resolving it anywhere but the
 * project dir reads a plain nested project as a worktree.
 */
describe('detectRepo — canonical checkout vs linked worktree', () => {
  it('flags a linked worktree and leaves the canonical checkout unflagged', async () => {
    const wt = join(dir, 'feature')
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature', wt])

    expect(await detectRepo(repo)).toMatchObject({
      isRepo: true,
      isSubdir: false,
      branch: 'main',
      isLinkedWorktree: false,
    })
    expect(await detectRepo(wt)).toMatchObject({
      isRepo: true,
      isSubdir: false,
      branch: 'feature',
      isLinkedWorktree: true,
    })
  })

  it('does not read a nested project inside the canonical checkout as a worktree', async () => {
    const nested = join(repo, 'apps', 'demo')
    await mkdir(nested, { recursive: true })

    expect(await detectRepo(nested)).toMatchObject({ isSubdir: true, isLinkedWorktree: false })
  })
})

describe('commitPaths — unattended author', () => {
  it('records the unattended writer as author while the user stays the committer', async () => {
    await writeFile(join(repo, 'b.txt'), 'dream\n')

    await commitPaths(repo, ['b.txt'], 'Dream: tidy project memory', {
      author: 'Koda Dream <dream@koda.local>',
    })

    const { stdout } = await execFileP('git', ['log', '-1', '--format=%an <%ae>%n%cn'], { cwd: repo })
    expect(stdout.trim().split('\n')).toEqual(['Koda Dream <dream@koda.local>', 'Koda Test'])
  })
})

describe('getCommitGraph — ready side lines', () => {
  it('reports how many committed versions each unmerged branch is ready to review', async () => {
    await git(repo, ['switch', '-q', '-c', 'agent/ready-topic'])
    await writeFile(join(repo, 'a.txt'), 'first\n')
    await git(repo, ['commit', '-qam', 'first topic commit'])
    await writeFile(join(repo, 'a.txt'), 'second\n')
    await git(repo, ['commit', '-qam', 'second topic commit'])
    await git(repo, ['switch', '-q', 'main'])

    const graph = await getCommitGraph(repo)
    expect(graph.unmergedBranches).toContainEqual({ name: 'agent/ready-topic', ahead: 2 })
  })
})

describe('turn-scoped completion evidence', () => {
  it('keeps pre-turn dirt explicit and uncapped by the Changes surface limit', async () => {
    expect(await completionGitSnapshot(repo)).toEqual({ kind: 'repo', dirty: [] })
    await writeFile(join(repo, 'a.txt'), 'changed before the turn\n')
    await mkdir(join(repo, 'notes'))
    await writeFile(join(repo, 'notes', 'draft.md'), 'untracked\n')

    expect(await completionGitSnapshot(repo)).toEqual({
      kind: 'repo',
      dirty: ['a.txt', 'notes/'],
    })
  })

  it('rechecks only task-owned paths and expands owned untracked files', async () => {
    await writeFile(join(repo, 'a.txt'), 'unrelated\n')
    await mkdir(join(repo, 'generated'))
    await writeFile(join(repo, 'generated', 'one.txt'), 'one\n')
    await writeFile(join(repo, 'generated', 'two.txt'), 'two\n')
    await writeFile(join(repo, 'literal[1].txt'), 'literal\n')

    expect(await completionStatusForPaths(repo, ['generated/one.txt'])).toEqual({
      kind: 'repo',
      dirty: ['generated/one.txt'],
    })
    expect(await completionStatusForPaths(repo, ['literal[1].txt'])).toEqual({
      kind: 'repo',
      dirty: ['literal[1].txt'],
    })
    expect(await completionStatusForPaths(repo, ['missing.txt'])).toEqual({ kind: 'repo', dirty: [] })
  })

  it('retains both sides of a rename for safe reconciliation', async () => {
    await rename(join(repo, 'a.txt'), join(repo, 'renamed.txt'))
    await git(repo, ['add', '-A'])
    expect(await completionGitSnapshot(repo)).toEqual({
      kind: 'repo',
      dirty: expect.arrayContaining(['a.txt', 'renamed.txt']),
    })
  })

  it('scopes a nested project snapshot and reports project-relative paths', async () => {
    const project = join(repo, 'apps', 'demo')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'inside.txt'), 'inside\n')
    await writeFile(join(repo, 'outside.txt'), 'outside\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-qm', 'add nested project'])

    await writeFile(join(project, 'inside.txt'), 'changed inside\n')
    await writeFile(join(repo, 'outside.txt'), 'changed outside\n')
    await mkdir(join(project, 'drafts'))
    await writeFile(join(project, 'drafts', 'note.md'), 'draft\n')
    await writeFile(join(repo, 'outside-untracked.txt'), 'outside\n')

    expect(await completionGitSnapshot(project)).toEqual({
      kind: 'repo',
      dirty: ['inside.txt', 'drafts/'],
    })
  })

  it('keeps a wholly untracked nested project visible', async () => {
    const project = join(repo, 'new', 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'draft.txt'), 'draft\n')

    expect(await completionGitSnapshot(project)).toEqual({
      kind: 'repo',
      dirty: ['draft.txt'],
    })
  })

  it('rechecks task-owned paths from a nested project without leaking enclosing-repo dirt', async () => {
    const project = join(repo, 'apps', 'demo')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'inside.txt'), 'inside\n')
    await writeFile(join(repo, 'outside.txt'), 'outside\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-qm', 'add nested project'])

    await writeFile(join(project, 'inside.txt'), 'changed inside\n')
    await writeFile(join(repo, 'outside.txt'), 'changed outside\n')

    expect(await completionStatusForPaths(project, ['inside.txt', 'missing.txt'])).toEqual({
      kind: 'repo',
      dirty: ['inside.txt'],
    })
  })

  it('retains project-relative rename sides inside a nested project', async () => {
    const project = join(repo, 'apps', 'demo')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'before.txt'), 'inside\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-qm', 'add nested project'])

    await rename(join(project, 'before.txt'), join(project, 'after.txt'))
    await git(repo, ['add', '-A'])

    expect(await completionGitSnapshot(project)).toEqual({
      kind: 'repo',
      dirty: expect.arrayContaining(['before.txt', 'after.txt']),
    })
    expect(await completionStatusForPaths(project, ['before.txt', 'after.txt'])).toEqual({
      kind: 'repo',
      dirty: ['before.txt', 'after.txt'],
    })
  })

  it('distinguishes a project with no user Git from a failed clean probe', async () => {
    const plain = await mkdtemp(join(dir, 'plain-'))
    expect(await completionGitSnapshot(plain)).toEqual({ kind: 'not-repo' })
    expect(await completionStatusForPaths(plain, ['new.txt'])).toEqual({ kind: 'not-repo' })
  })
})
