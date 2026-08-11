import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({ log: { info: () => {}, warn, error: () => {}, debug: () => {} } }))

const { getCommitGraph, getMergedStrays, getWorktrees } = await import('./user-git')

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
