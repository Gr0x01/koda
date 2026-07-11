import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRepo, runGit } from './repo'
import { checkpoint, headSha, listCheckpoints } from './checkpoint'
import { restore } from './restore'
import { migrate, pruneStore, selectRetainedMoments, maintainStore } from './prune'

const DAY = 86_400

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'koda-prune-'))
  await ensureRepo(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A dated commit straight onto a ref (bypasses checkpoint() so tests can control history + time). */
async function commitOn(
  ref: string,
  files: Record<string, string>,
  subject: string,
  unix: number,
): Promise<string> {
  for (const [p, content] of Object.entries(files)) await writeFile(join(dir, p), content)
  await runGit(dir, ['add', '-A'])
  const tree = (await runGit(dir, ['write-tree'])).stdout.trim()
  let parent: string | null = null
  try {
    parent = (await runGit(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim()
  } catch {
    /* unborn ref */
  }
  const id = (
    await runGit(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', subject], {
      extraEnv: { GIT_AUTHOR_DATE: `@${unix} +0000`, GIT_COMMITTER_DATE: `@${unix} +0000` },
    })
  ).stdout.trim()
  await runGit(dir, ['update-ref', ref, id])
  return id
}

async function logShas(ref: string): Promise<string[]> {
  try {
    return (await runGit(dir, ['log', '--format=%H', ref])).stdout.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
async function exists(sha: string): Promise<boolean> {
  try {
    await runGit(dir, ['cat-file', '-e', sha])
    return true
  } catch {
    return false
  }
}
const meta = (sha: string, ct: number) => ({ sha, tree: sha, at: ct, ct, subject: 'x' })

describe('selectRetainedMoments (GFS policy)', () => {
  const now = 1_000 * DAY // arbitrary fixed "now"

  it('keeps every moment inside 90 days', () => {
    const moments = [80, 45, 10, 1].map((d, i) => meta(`s${i}`, now - d * DAY))
    expect(selectRetainedMoments(moments, now)).toHaveLength(4)
  })

  it('thins 90d–1yr to one per day and >1yr to one per week (once past the floor)', () => {
    // Old groups must sit OUTSIDE the newest-50 floor to be eligible, so pad with 50 recent fillers.
    const day180 = now - 180 * DAY
    const week500 = now - 500 * DAY
    const old = [
      meta('w0', week500),
      meta('w1', week500 + 3600), // same week as w0
      meta('w2', week500 + 7200),
      meta('d0', day180),
      meta('d1', day180 + 3600), // same day as d0
      meta('d2', day180 + 7200),
    ]
    const fillers = Array.from({ length: 50 }, (_, i) => meta(`r${i}`, now - (50 - i) * DAY))
    const kept = selectRetainedMoments([...old, ...fillers], now).map((c) => c.sha)
    expect(kept).toContain('w0') // first of the week kept
    expect(kept).toContain('d0') // first of the day kept
    expect(kept).not.toContain('w1')
    expect(kept).not.toContain('w2')
    expect(kept).not.toContain('d1')
    expect(kept).not.toContain('d2')
    expect(kept).toHaveLength(52) // w0 + d0 + 50 fillers
  })

  it('floor: always keeps the newest 50 however old they are', () => {
    // 60 moments, all ~2 years old (would otherwise collapse to a couple of weekly buckets).
    const moments = Array.from({ length: 60 }, (_, i) => meta(`m${i}`, now - 800 * DAY + i * 60))
    const kept = selectRetainedMoments(moments, now)
    expect(kept.length).toBeGreaterThanOrEqual(50)
    // the newest 50 are all present
    for (let i = 10; i < 60; i++) expect(kept.some((c) => c.sha === `m${i}`)).toBe(true)
  })

  it('returns an ordered subsequence (safe to replay)', () => {
    const moments = [400, 300, 200, 100, 5].map((d, i) => meta(`s${i}`, now - d * DAY))
    const kept = selectRetainedMoments(moments, now)
    const cts = kept.map((c) => c.ct)
    expect(cts).toEqual([...cts].sort((a, b) => a - b)) // oldest→newest preserved
  })
})

describe('checkpoint routing (two lanes)', () => {
  it('sends moments to master and steps to refs/koda/steps, leaving HEAD on master', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1')
    await checkpoint(dir, 'add feature') // moment
    await writeFile(join(dir, 'a.txt'), 'v2')
    await checkpoint(dir, 'before Edit: a.txt') // step

    expect(await logShas('refs/heads/master')).toHaveLength(1)
    expect(await logShas('refs/koda/steps')).toHaveLength(1)
    // the browsable timeline shows only the moment
    const timeline = await listCheckpoints(dir)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].label).toBe('add feature')
    // HEAD still points at the moment, not the step
    expect(await headSha(dir)).toBe((await logShas('refs/heads/master'))[0])
  })

  it('skips a step when nothing changed since the lane tip', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1')
    await checkpoint(dir, 'add feature')
    const first = await checkpoint(dir, 'before Bash: ls') // no file change since moment
    expect(first.skipped).toBe(true)
    expect(await logShas('refs/koda/steps')).toHaveLength(0)
  })
})

describe('migrate (one-time split of a legacy single chain)', () => {
  it('splits interleaved moments/steps into the two lanes, preserving latest content', async () => {
    const t = 500 * DAY
    await commitOn('refs/heads/master', { 'a.txt': 'm0' }, 'first moment', t)
    await commitOn('refs/heads/master', { 'a.txt': 's1' }, 'before Edit: a.txt', t + 1)
    await commitOn('refs/heads/master', { 'a.txt': 'm2' }, 'second moment', t + 2)
    await commitOn('refs/heads/master', { 'a.txt': 's3' }, 'before Bash: x', t + 3)

    await migrate(dir)

    expect(await logShas('refs/heads/master')).toHaveLength(2) // moments only
    expect(await logShas('refs/koda/steps')).toHaveLength(2) // steps only
    // master tip = the latest MOMENT's content (not the trailing step)
    const tipFile = (await runGit(dir, ['show', 'refs/heads/master:a.txt'])).stdout
    expect(tipFile).toBe('m2')
    // idempotent: a second run is a no-op (schema marker set)
    const before = await logShas('refs/heads/master')
    await migrate(dir)
    expect(await logShas('refs/heads/master')).toEqual(before)
  })
})

describe('pruneStore', () => {
  it('drops steps older than 48h, keeps recent, and reclaims the dropped objects', async () => {
    const now = 600 * DAY
    await commitOn('refs/heads/master', { 'a.txt': 'm' }, 'a moment', now)
    const old100d = await commitOn('refs/koda/steps', { 'a.txt': 's-old' }, 'before Edit: a', now - 100 * DAY)
    const old3d = await commitOn('refs/koda/steps', { 'a.txt': 's-3d' }, 'before Edit: b', now - 3 * DAY)
    await commitOn('refs/koda/steps', { 'a.txt': 's-1h' }, 'before Edit: c', now - 3600)

    await pruneStore(dir, now)

    // Step-trim re-roots the surviving chain, so the recent step is re-SHA'd; assert by content.
    const steps = await logShas('refs/koda/steps')
    expect(steps).toHaveLength(1) // only the <48h step survives
    expect((await runGit(dir, ['show', 'refs/koda/steps:a.txt'])).stdout).toBe('s-1h')
    expect(await exists(old3d)).toBe(false) // >48h → dropped + gc'd
    expect(await exists(old100d)).toBe(false)
    // the moment lane is untouched
    expect(await logShas('refs/heads/master')).toHaveLength(1)
  })

  it('thins old moments past the newest-50 floor per GFS, keeping the timeline restorable', async () => {
    const now = 800 * DAY
    // Two moments on one old day (~200d, in the daily-thin band) — but they must sit OUTSIDE the
    // newest-50 floor to be eligible, so add 50 recent moments after them.
    const d200 = now - 200 * DAY
    await commitOn('refs/heads/master', { 'a.txt': 'old-a' }, 'old a', d200)
    await commitOn('refs/heads/master', { 'a.txt': 'old-b' }, 'old b', d200 + 3600) // same day
    for (let i = 0; i < 50; i++) {
      await commitOn('refs/heads/master', { 'a.txt': `r${i}` }, `recent ${i}`, now - (50 - i) * DAY)
    }
    expect(await logShas('refs/heads/master')).toHaveLength(52)

    await pruneStore(dir, now)

    // old-a and old-b are the same day, both past the floor → collapse to one. 52 → 51.
    expect(await logShas('refs/heads/master')).toHaveLength(51)
    // tip content preserved → restore target still valid
    expect((await runGit(dir, ['show', 'refs/heads/master:a.txt'])).stdout).toBe('r49')
  })
})

describe('maintainStore returns an original→final remap (so live diff baselines can be re-pinned)', () => {
  it('maps re-SHA’d moments from their pre-rewrite SHA to the current one', async () => {
    const t = 500 * DAY
    const m0 = await commitOn('refs/heads/master', { 'a.txt': 'm0' }, 'first moment', t)
    await commitOn('refs/heads/master', { 'a.txt': 's1' }, 'before Edit: a', t + 1)
    const m2 = await commitOn('refs/heads/master', { 'a.txt': 'm2' }, 'second moment', t + 2)

    const remap = await maintainStore(dir, t + 10)

    // The migrate rewrite re-SHA'd both moments; their old SHAs map to live, existing commits.
    expect(remap.get(m0)).toBeTruthy()
    expect(remap.get(m2)).toBeTruthy()
    expect(await exists(remap.get(m0)!)).toBe(true)
    // The mapped newest moment is the current master tip content — a valid diff baseline.
    expect((await runGit(dir, ['show', `${remap.get(m2)}:a.txt`])).stdout).toBe('m2')
  })
})

describe('restore still works across the lane split', () => {
  it('recovers an earlier moment byte-for-byte', async () => {
    await writeFile(join(dir, 'a.txt'), 'version-one')
    const first = await checkpoint(dir, 'write version one')
    await writeFile(join(dir, 'a.txt'), 'version-two')
    await checkpoint(dir, 'write version two')

    await restore(dir, first.id)

    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('version-one')
  })
})
