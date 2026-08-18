import { describe, expect, it } from 'vitest'
import type { GitCommitGraphResult, GitGraphRow, GitSyncState, GitWorktree } from '@shared/ipc'
import {
  INFLOW_PREVIEW,
  LANE_CAP,
  buildTimeline,
  bundleSummary,
  collectLooseEnds,
  dayLabel,
  isTrunkMerge,
  relativeAgeMs,
  shortAge,
} from './timeline'

function mkRow(
  sha: string,
  subject: string,
  relativeDate: string,
  o: {
    lane?: number
    color?: number
    merge?: boolean
    converge?: number[]
    opens?: number[]
    branchLabel?: string
    /** Epoch ms. Left at 0 by default so these rows carry NO day, and the timelines under test stay
     *  pure runs of commits — the day-heading tests below opt in with real timestamps. */
    committedAt?: number
  } = {},
): GitGraphRow {
  const lane = o.lane ?? 0
  return {
    sha,
    subject,
    relativeDate,
    committedAt: o.committedAt ?? 0,
    authorName: 'RB',
    parents: [],
    lane,
    color: o.color ?? 0,
    isMerge: !!o.merge,
    segments: [
      ...(o.converge ?? []).map((color, i) => ({ x1: i + 1, y1: 0, x2: lane, y2: 1, color })),
      ...(o.opens ?? []).map((color, i) => ({ x1: lane, y1: 1, x2: i + 1, y2: 2, color })),
    ],
    branchLabel: o.branchLabel ?? null,
    branchKind: o.branchLabel ? 'unmerged' : null,
  }
}

function mkGraph(
  rows: GitGraphRow[],
  unmerged: Array<{ name: string; ahead: number }> = [],
  inflows: GitCommitGraphResult['mergeInflows'] = {},
): GitCommitGraphResult {
  return {
    layout: { rows, laneCount: 3, laneKinds: { '0': 'main' } },
    unmergedBranches: unmerged,
    mergeInflows: inflows,
    headBranch: 'main',
    truncated: false,
  }
}

function mkWorktree(name: string, o: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: `/tmp/wt/${name}`,
    branch: name,
    isCurrent: false,
    dirtyCount: 3,
    statusKnown: true,
    lastActivity: '2 days ago',
    locked: false,
    prunable: false,
    ...o,
  }
}

const SYNC: GitSyncState = {
  hasRemote: true,
  remoteName: 'origin',
  remoteUrl: 'git@github.com:rb/x.git',
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  upstreamTip: 'c3',
  verified: true,
}

// A spine with one merged branch (opened at the merge, closing at c3) and one open side line
// (tip `feat/open`, forking at c4).
const ROWS = [
  mkRow('tip', 'wip on the open line', '10 minutes ago', { lane: 2, color: 2, branchLabel: 'feat/open' }),
  mkRow('c1', 'newest', '1 hour ago'),
  mkRow('c2', 'a merge', '2 hours ago', { merge: true, opens: [1] }),
  mkRow('c3', 'before the merge', '3 hours ago', { converge: [1] }),
  mkRow('c4', 'the fork point', '4 hours ago', { converge: [2] }),
  mkRow('c5', 'oldest', '5 hours ago'),
]

// The same spine, plus the two commits the `c2` merge actually brought in. They sit off the spine
// (lane 1) — which is exactly why nothing ever rendered them until merges drew their own work.
const MERGE_ROWS = [
  mkRow('c1', 'newest', '1 hour ago'),
  mkRow('c2', 'a merge', '2 hours ago', { merge: true, opens: [1] }),
  mkRow('b1', 'branch work, newer', '2 hours ago', { lane: 1, color: 1 }),
  mkRow('b2', 'branch work, older', '3 hours ago', { lane: 1, color: 1 }),
  mkRow('c3', 'before the merge', '3 hours ago', { converge: [1] }),
  mkRow('c4', 'the fork point', '4 hours ago'),
  mkRow('c5', 'oldest', '5 hours ago'),
]

describe('relativeAgeMs', () => {
  it('reads git relative dates', () => {
    expect(relativeAgeMs('3 minutes ago')).toBe(3 * 60_000)
    expect(relativeAgeMs('2 hours ago')).toBe(2 * 3_600_000)
    expect(relativeAgeMs('5 days ago')).toBe(5 * 86_400_000)
    expect(relativeAgeMs('an hour ago')).toBe(3_600_000)
    expect(relativeAgeMs('yesterday')).toBe(86_400_000)
  })

  it('returns null rather than guessing when there is no date', () => {
    expect(relativeAgeMs('')).toBeNull()
    expect(relativeAgeMs(undefined)).toBeNull()
    expect(relativeAgeMs('some time back')).toBeNull()
  })

  it('prints the compact age the rail shows', () => {
    expect(shortAge(21 * 60_000)).toBe('21m')
    expect(shortAge(9 * 3_600_000)).toBe('9h')
    expect(shortAge(3 * 86_400_000)).toBe('3d')
    expect(shortAge(null)).toBeNull()
  })
})

describe('collectLooseEnds', () => {
  it('drops a side line whose checkout is dirty, so the work is stated once', () => {
    const ends = collectLooseEnds({
      graph: mkGraph(ROWS, [{ name: 'feat/open', ahead: 2 }]),
      worktrees: [mkWorktree('feat/open')],
    })
    expect(ends).toHaveLength(1)
    expect(ends[0].path).toBe('/tmp/wt/feat/open')
    expect(ends[0].ready).toBe(false)
    expect(ends[0].status).toContain('needs cleanup')
  })

  it('sorts live lines first, then freshest, with undated ones last', () => {
    const ends = collectLooseEnds({
      graph: mkGraph(ROWS, []),
      worktrees: [
        mkWorktree('old', { lastActivity: '3 days ago' }),
        mkWorktree('undated', { lastActivity: '' }),
        mkWorktree('fresh', { lastActivity: '5 minutes ago' }),
        mkWorktree('live-one', { lastActivity: '2 days ago' }),
      ],
      liveBranches: ['live-one'],
    })
    expect(ends.map((e) => e.label)).toEqual(['live-one', 'fresh', 'old', 'undated'])
  })

  it('says a missing folder plainly', () => {
    const [end] = collectLooseEnds({
      graph: null,
      worktrees: [mkWorktree('gone', { prunable: true, dirtyCount: 0 })],
    })
    expect(end.missing).toBe(true)
    expect(end.status).toContain('folder missing')
  })
})

describe('buildTimeline', () => {
  it('shows only the current line, and marks what GitHub already has', () => {
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: SYNC, worktrees: [] })
    const commits = t.rows.filter((r) => r.t === 'commit')
    expect(commits.map((r) => r.key)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect(commits.filter((r) => r.t === 'commit' && r.onGitHub).map((r) => r.key)).toEqual(['c3', 'c4', 'c5'])
    expect(commits.find((r) => r.key === 'c1')).toMatchObject({ when: '1h' })
  })

  it('puts the seam at the version GitHub actually has', () => {
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: SYNC, worktrees: [] })
    expect(t.seamRow).not.toBeNull()
    expect(t.rows[t.seamRow as number]).toMatchObject({ t: 'seam', kind: 'boundary' })
    // upstreamTip is c3, so the two versions above it are the local-only ones.
    expect(t.rows.slice(0, t.seamRow as number).filter((r) => r.t === 'commit')).toHaveLength(2)
    expect(t.ahead).toBe(2)
  })

  it('locates the seam by SHA, not by counting versions ahead', () => {
    // `ahead` counts commits that arrived inside a merge and never appear on the spine, so counting
    // rows with it puts the seam too deep and marks versions GitHub has as local-only.
    const t = buildTimeline({
      graph: mkGraph(ROWS),
      sync: { ...SYNC, ahead: 5, upstreamTip: 'c5' },
      worktrees: [],
    })
    expect(t.rows[t.seamRow as number]).toMatchObject({ kind: 'boundary' })
    expect(t.rows.filter((r) => r.t === 'commit' && r.onGitHub).map((r) => r.key)).toEqual(['c5'])
  })

  it('describes the branch, not individual commits, when it was never pushed', () => {
    // A repo WITH a remote that holds no copy of this branch. Commits from the shared base may still
    // exist there through another branch, so their individual presence remains unknown.
    const t = buildTimeline({
      graph: mkGraph(ROWS),
      sync: { ...SYNC, ahead: 5, upstream: null, upstreamTip: null },
      worktrees: [],
    })
    expect(t.seamKind).toBe('neverPushed')
    expect(t.boundaryRow).toBeNull()
    expect(t.rows.every((r) => r.t !== 'commit' || r.onGitHub === null)).toBe(true)
    expect(t.rows[0].t).toBe('seam')
    expect(t.ahead).toBe(5)
  })

  it('marks every local version on GitHub when the verified branch is only behind', () => {
    // The newer remote tip cannot appear in the local spine, but ahead=0 proves HEAD's whole history
    // is reachable from it. This is an all-pushed line plus a separate behind notice.
    const t = buildTimeline({
      graph: mkGraph(ROWS),
      sync: { ...SYNC, ahead: 0, behind: 2, upstreamTip: 'remote-newer' },
      worktrees: [],
    })
    expect(t.seamKind).toBe('boundary')
    expect(t.rows.every((r) => r.t !== 'commit' || r.onGitHub === true)).toBe(true)
  })

  it('draws no boundary when GitHub’s tip is outside the loaded window', () => {
    const t = buildTimeline({
      graph: mkGraph(ROWS),
      sync: { ...SYNC, ahead: 40, upstreamTip: 'deadbee' },
      worktrees: [],
    })
    expect(t.seamKind).toBe('unlocated')
    expect(t.boundaryRow).toBeNull()
    expect(t.rows.every((r) => r.t !== 'commit' || r.onGitHub === null)).toBe(true)
  })

  it('matches the remote tip across short and long SHAs', () => {
    const t = buildTimeline({
      graph: mkGraph([
        mkRow('c1abcdef1234', 'newest', '1 hour ago'),
        mkRow('c2abcdef1234', 'older', '2 hours ago'),
      ]),
      sync: { ...SYNC, ahead: 1, upstreamTip: 'c2abcde' },
      worktrees: [],
    })
    expect(t.seamKind).toBe('boundary')
    expect(t.rows.filter((r) => r.t === 'commit' && r.onGitHub).map((r) => r.key)).toEqual([
      'c2abcdef1234',
    ])
  })

  it('refuses to split the line on an unverified guess', () => {
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: { ...SYNC, verified: false }, worktrees: [] })
    expect(t.boundaryRow).toBeNull()
    expect(t.seamKind).toBe('unverified')
    expect(t.rows.every((r) => r.t !== 'commit' || r.onGitHub === null)).toBe(true)
    expect(t.rows[0].t).toBe('seam') // an advisory at the top, not a claim about history
  })

  it('has no seam when there are no versions to have a boundary in', () => {
    const t = buildTimeline({ graph: mkGraph([]), sync: SYNC, worktrees: [] })
    expect(t.seamRow).toBeNull()
    expect(t.rows).toHaveLength(0)
  })

  it('has no seam at all without a remote', () => {
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: { ...SYNC, hasRemote: false }, worktrees: [] })
    expect(t.seamRow).toBeNull()
    expect(t.rows.some((r) => r.t === 'seam')).toBe(false)
    expect(t.rows.every((r) => r.t !== 'commit' || r.onGitHub === false)).toBe(true)
  })

  it('namespaces side and synthetic rows so legal branch names cannot collide', () => {
    const graph = mkGraph(
      [
        mkRow('seam-tip', 'seam work', '5 minutes ago', {
          lane: 3,
          color: 3,
          branchLabel: 'seam',
        }),
        mkRow('bundle-tip', 'bundle work', '10 minutes ago', {
          lane: 4,
          color: 4,
          branchLabel: 'bundle',
        }),
        ...ROWS,
      ],
      [
        { name: 'seam', ahead: 1 },
        { name: 'bundle', ahead: 1 },
      ],
    )
    const t = buildTimeline({
      graph,
      sync: SYNC,
      worktrees: ['a', 'b', 'c', 'd'].map((name) => mkWorktree(name)),
    })
    const keys = t.rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(t.rows[t.seamRow as number]).toMatchObject({ t: 'seam' })
    expect(t.rows.some((row) => row.t === 'bundle')).toBe(true)
    for (const lane of t.lanes.filter((candidate) => candidate.kind === 'open')) {
      expect(t.rows[lane.toRow].t).toBe('side')
    }
  })

  it('shows what a merge brought in, on its own lane under it', () => {
    // The whole point: those commits live off the first-parent chain, so before this the merge could
    // only be drawn as an arc curving around versions that were never rendered.
    const t = buildTimeline({
      graph: mkGraph(MERGE_ROWS, [], { c2: { shas: ['b1', 'b2'], partial: false } }),
      sync: null,
      worktrees: [],
    })
    const keys = t.rows.map((r) => r.key)
    expect(keys).toEqual(['c1', 'c2', 'inflow:c2:b1', 'inflow:c2:b2', 'c3', 'c4', 'c5'])
    expect(t.rows.find((r) => r.key === 'c2')).toMatchObject({ inflowCount: 2, inflowOpen: true })

    expect(t.rows.filter((r) => r.t === 'inflow').map((r) => r.mergeSha)).toEqual(['c2', 'c2'])
    const lane = t.lanes.find((l) => l.kind === 'inflow') as Extract<
      (typeof t.lanes)[number],
      { kind: 'inflow' }
    >
    expect(t.rows[lane.fromRow].key).toBe('c2')
    expect(t.rows[lane.toRow].key).toBe('c3')
    expect(lane.beyondWindow).toBe(false)
  })

  it('keeps a merge FROM the trunk shut, because that is catching up rather than work arriving', () => {
    const rows = [
      mkRow('c1', 'newest', '1 hour ago'),
      mkRow('m', "Merge branch 'main' into feat/x", '2 hours ago', { merge: true, opens: [1] }),
      mkRow('b1', 'something from main', '3 hours ago', { lane: 1, color: 1 }),
      mkRow('base', 'where the lines parted', '4 hours ago', { converge: [1] }),
    ]
    const inflows = { m: { shas: ['b1'], partial: false } }
    const shut = buildTimeline({ graph: mkGraph(rows, [], inflows), sync: null, worktrees: [], trunk: 'main' })
    expect(shut.rows.some((r) => r.t === 'inflow')).toBe(false)
    // The count still shows, so the work is never silently hidden — only folded.
    expect(shut.rows.find((r) => r.key === 'm')).toMatchObject({ inflowCount: 1, fromTrunk: true })

    const opened = buildTimeline({
      graph: mkGraph(rows, [], inflows),
      sync: null,
      worktrees: [],
      trunk: 'main',
      openMerges: new Set(['m']),
    })
    expect(opened.rows.filter((r) => r.t === 'inflow')).toHaveLength(1)
    const lane = opened.lanes.find((l) => l.kind === 'inflow')
    expect(lane && opened.rows[lane.toRow].key).toBe('base')
  })

  it('reads the merged branch off git\'s own subject, and shrugs at a custom message', () => {
    expect(isTrunkMerge("Merge branch 'main' into feat/x", 'main')).toBe(true)
    expect(isTrunkMerge("Merge remote-tracking branch 'origin/main'", 'main')).toBe(true)
    expect(isTrunkMerge("Merge branch 'design/doc-workspace' into feat/x", 'main')).toBe(false)
    // Treating an unreadable message as ordinary work is the safe way to be wrong: it shows more,
    // never less.
    expect(isTrunkMerge('bring main in', 'main')).toBe(false)
    expect(isTrunkMerge("Merge branch 'main'", null)).toBe(false)
  })

  it('holds the tail behind one row instead of pouring a long branch onto the line', () => {
    const carried = Array.from({ length: INFLOW_PREVIEW + 4 }, (_, i) =>
      mkRow(`b${i}`, `branch work ${i}`, '3 hours ago', { lane: 1, color: 1 }),
    )
    const rows = [
      mkRow('m', 'a big merge', '1 hour ago', { merge: true, opens: [1] }),
      ...carried,
      mkRow('base', 'where the branch began', '4 hours ago', { converge: [1] }),
    ]
    const inflows = { m: { shas: carried.map((c) => c.sha), partial: false } }

    const preview = buildTimeline({ graph: mkGraph(rows, [], inflows), sync: null, worktrees: [] })
    expect(preview.rows.filter((r) => r.t === 'inflow')).toHaveLength(INFLOW_PREVIEW)
    expect(preview.rows.find((r) => r.t === 'inflowMore')).toMatchObject({ remaining: 4 })
    const previewLane = preview.lanes.find((l) => l.kind === 'inflow')
    expect(previewLane && preview.rows[previewLane.toRow].key).toBe('base')

    const all = buildTimeline({
      graph: mkGraph(rows, [], inflows),
      sync: null,
      worktrees: [],
      openMerges: new Set(['m']),
    })
    expect(all.rows.filter((r) => r.t === 'inflow')).toHaveLength(INFLOW_PREVIEW + 4)
    expect(all.rows.some((r) => r.t === 'inflowMore')).toBe(false)
  })

  it('counts what it was told about even when the commit itself was never fetched', () => {
    // The fetch window is finite. Reporting only the rows we hold would under-count the merge.
    const rows = [
      mkRow('m', 'a merge', '1 hour ago', { merge: true, opens: [1] }),
      mkRow('b1', 'the one we fetched', '2 hours ago', { lane: 1, color: 1 }),
    ]
    const t = buildTimeline({
      graph: mkGraph(rows, [], { m: { shas: ['b1', 'gone-1', 'gone-2'], partial: true } }),
      sync: null,
      worktrees: [],
    })
    expect(t.rows.find((r) => r.key === 'm')).toMatchObject({ inflowCount: 3, inflowPartial: true })
    expect(t.rows.filter((r) => r.t === 'inflow')).toHaveLength(1)
    expect(t.rows.find((r) => r.t === 'inflowMore')).toMatchObject({ partial: true })
    const lane = t.lanes.find((l) => l.kind === 'inflow')
    expect(lane).toMatchObject({ beyondWindow: true, toRow: t.rows.length })
  })

  it('draws an off-window rail when none of a partial merge\'s commits were fetched', () => {
    const rows = [mkRow('m', 'a merge beyond the window', '1 hour ago', { merge: true, opens: [1] })]
    const t = buildTimeline({
      graph: mkGraph(rows, [], { m: { shas: [], partial: true } }),
      sync: null,
      worktrees: [],
    })

    expect(t.rows.find((r) => r.key === 'm')).toMatchObject({
      inflowOpen: true,
      inflowPartial: true,
      inflowToggleable: false,
    })
    expect(t.rows.find((r) => r.t === 'inflowMore')).toMatchObject({
      remaining: 0,
      partial: true,
      expandable: false,
    })
    expect(t.lanes.find((l) => l.kind === 'inflow')).toMatchObject({
      mergeSha: 'm',
      beyondWindow: true,
      toRow: t.rows.length,
    })
  })

  it('lets a zero-fetched trunk inflow be opened from its folded state', () => {
    const rows = [
      mkRow('m', "Merge branch 'main' into feat/x", '1 hour ago', { merge: true, opens: [1] }),
    ]
    const graph = mkGraph(rows, [], { m: { shas: [], partial: true } })

    const folded = buildTimeline({ graph, sync: null, worktrees: [], trunk: 'main' })
    expect(folded.rows.find((r) => r.key === 'm')).toMatchObject({
      fromTrunk: true,
      inflowOpen: false,
      inflowPartial: true,
      inflowToggleable: true,
    })
    expect(folded.lanes.some((l) => l.kind === 'inflow')).toBe(false)

    const opened = buildTimeline({
      graph,
      sync: null,
      worktrees: [],
      trunk: 'main',
      openMerges: new Set(['m']),
    })
    expect(opened.rows.find((r) => r.t === 'inflowMore')).toMatchObject({ remaining: 0, partial: true })
    expect(opened.lanes.find((l) => l.kind === 'inflow')).toMatchObject({
      mergeSha: 'm',
      beyondWindow: true,
      toRow: opened.rows.length,
    })
  })

  it('keeps four overlapping merge loops and puts each commit on its own loop', () => {
    const rows = [
      mkRow('m1', 'newer merge', '1 hour ago', { merge: true, opens: [1] }),
      mkRow('b1', 'newer branch work', '2 hours ago', { lane: 1, color: 1 }),
      mkRow('m2', 'second merge', '3 hours ago', { merge: true, opens: [2] }),
      mkRow('b2', 'second branch work', '4 hours ago', { lane: 2, color: 2 }),
      mkRow('m3', 'third merge', '5 hours ago', { merge: true, opens: [3] }),
      mkRow('b3', 'third branch work', '6 hours ago', { lane: 3, color: 3 }),
      mkRow('m4', 'fourth merge', '7 hours ago', { merge: true, opens: [4] }),
      mkRow('b4', 'fourth branch work', '8 hours ago', { lane: 4, color: 4 }),
      mkRow('base1', 'first branch fork', '9 hours ago', { converge: [1] }),
      mkRow('base2', 'second branch fork', '10 hours ago', { converge: [2] }),
      mkRow('base3', 'third branch fork', '11 hours ago', { converge: [3] }),
      mkRow('base4', 'fourth branch fork', '12 hours ago', { converge: [4] }),
    ]
    const t = buildTimeline({
      graph: mkGraph(rows, [], {
        m1: { shas: ['b1'], partial: false },
        m2: { shas: ['b2'], partial: false },
        m3: { shas: ['b3'], partial: false },
        m4: { shas: ['b4'], partial: false },
      }),
      sync: null,
      worktrees: [],
    })

    expect(t.rows.filter((r) => r.t === 'inflow').map((r) => [r.sha, r.mergeSha])).toEqual([
      ['b1', 'm1'],
      ['b2', 'm2'],
      ['b3', 'm3'],
      ['b4', 'm4'],
    ])
    const loops = t.lanes.filter((l) => l.kind === 'inflow')
    expect(loops).toHaveLength(4)
    expect(new Set(loops.map((l) => l.column)).size).toBe(4)
    expect(Math.max(...loops.map((l) => l.column))).toBe(3)
    expect(t.rows[loops.find((l) => l.mergeSha === 'm1')!.toRow].key).toBe('base1')
    expect(t.rows[loops.find((l) => l.mergeSha === 'm2')!.toRow].key).toBe('base2')
    expect(t.rows[loops.find((l) => l.mergeSha === 'm3')!.toRow].key).toBe('base3')
    expect(t.rows[loops.find((l) => l.mergeSha === 'm4')!.toRow].key).toBe('base4')
  })

  it('gives an open side line a lane from its fork up to its own card', () => {
    const t = buildTimeline({
      graph: mkGraph(ROWS, [{ name: 'feat/open', ahead: 2 }]),
      sync: null,
      worktrees: [],
    })
    const card = t.rows.findIndex((r) => r.t === 'side')
    const lane = t.lanes.find((l) => l.kind === 'open')
    expect(lane).toBeDefined()
    expect(lane).toMatchObject({ toRow: card, tone: 'loose' })
    // It forks at c4 and its card sits above that row, where 10-minute-old work belongs.
    expect((lane as { fromRow: number }).fromRow).toBe(t.rows.findIndex((r) => r.key === 'c4'))
    expect(card).toBeLessThan(t.rows.findIndex((r) => r.key === 'c4'))
  })

  it('runs a lane off the bottom edge when the fork is older than the loaded window', () => {
    const t = buildTimeline({
      graph: mkGraph([mkRow('c1', 'only', '1 hour ago')]),
      sync: null,
      worktrees: [mkWorktree('stray', { lastActivity: '2 hours ago' })],
    })
    const lane = t.lanes.find((l) => l.kind === 'open') as { fromRow: number }
    expect(lane.fromRow).toBe(t.rows.length)
  })

  it('caps lanes and collapses the rest into one bundle', () => {
    const worktrees = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n, i) =>
      mkWorktree(n, { lastActivity: `${i + 1} hours ago` }),
    )
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: null, worktrees })
    expect(t.rows.filter((r) => r.t === 'side')).toHaveLength(LANE_CAP)
    const bundle = t.rows.find((r) => r.t === 'bundle')
    expect(bundle && bundle.t === 'bundle' && bundle.ends).toHaveLength(8 - LANE_CAP)
    expect(t.lanes.filter((l) => l.kind === 'open')).toHaveLength(LANE_CAP)
    expect(t.lanes.filter((l) => l.kind === 'bundle')).toHaveLength(1)
  })

  it('keeps all three columns for open work when they span the whole timeline', () => {
    // Three open lines with no fork in view span the whole timeline, so all three columns are busy
    // across the merge. Open side lines claim columns first, so they are the three that get lanes.
    const worktrees = ['a', 'b', 'c'].map((n, i) =>
      mkWorktree(n, { lastActivity: `${i + 1} minutes ago`, branch: null }),
    )
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: null, worktrees })
    expect(t.lanes.filter((l) => l.kind === 'open')).toHaveLength(3)
  })

  it('never puts two lanes in the same column at the same height', () => {
    const worktrees = ['a', 'b', 'c'].map((n, i) => mkWorktree(n, { lastActivity: `${i + 1} hours ago` }))
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: null, worktrees })
    const spans = t.lanes
      .filter((l): l is Extract<typeof l, { column: number }> => 'column' in l)
      .map((l) => ({ column: l.column, lo: Math.min(l.fromRow, l.toRow), hi: Math.max(l.fromRow, l.toRow) }))
    for (const a of spans) {
      for (const b of spans) {
        if (a === b || a.column !== b.column) continue
        expect(a.hi < b.lo || a.lo > b.hi).toBe(true)
      }
    }
  })

  it('still shows open work when there are no versions at all', () => {
    const t = buildTimeline({ graph: null, sync: null, worktrees: [mkWorktree('a')] })
    expect(t.rows.map((r) => r.t)).toEqual(['side'])
  })
})

describe('day headings', () => {
  const NOON = (day: number, hour = 12): number => new Date(2026, 7, day, hour).getTime()
  const TODAY = NOON(14)

  it('names the two days the user is working in, and dates the rest', () => {
    expect(dayLabel(NOON(14), TODAY)).toBe('Today')
    expect(dayLabel(NOON(13), TODAY)).toBe('Yesterday')
    expect(dayLabel(NOON(12), TODAY)).toMatch(/Aug/)
  })

  it('calls it yesterday across a midnight, not "20 hours ago"', () => {
    // 11pm yesterday to 7am today is eight hours, and still two different days on the rail.
    expect(dayLabel(NOON(13, 23), NOON(14, 7))).toBe('Yesterday')
  })

  it('opens one heading per day, above everything else placed at that version', () => {
    const t = buildTimeline({
      graph: mkGraph([
        mkRow('a', 'newest', '2 hours ago', { committedAt: NOON(14, 10) }),
        mkRow('b', 'also today', '5 hours ago', { committedAt: NOON(14, 7) }),
        mkRow('c', 'the day before', '1 day ago', { committedAt: NOON(13) }),
      ]),
      sync: null,
      worktrees: [],
      now: TODAY,
    })
    expect(t.rows.filter((r) => r.t === 'day').map((r) => (r as { label: string }).label)).toEqual([
      'Today',
      'Yesterday',
    ])
    expect(t.rows[0]).toMatchObject({ t: 'day', label: 'Today' })
    expect(t.rows[1].key).toBe('a')
  })

  it('writes no heading for a version whose commit time never arrived', () => {
    // A renderer hot-reloaded ahead of main sees rows with no commit time. No heading beats a wrong one.
    const t = buildTimeline({ graph: mkGraph(ROWS), sync: null, worktrees: [], now: TODAY })
    expect(t.rows.some((r) => r.t === 'day')).toBe(false)
  })
})

describe('bundleSummary', () => {
  const end = (over: Partial<ReturnType<typeof collectLooseEnds>[number]>) =>
    ({
      id: 'x',
      branch: 'x',
      path: null,
      label: 'x',
      status: '',
      ready: false,
      missing: false,
      live: false,
      ageMs: null,
      forkSpine: null,
      ...over,
    }) as ReturnType<typeof collectLooseEnds>[number]

  it('counts what needs cleanup and how old the worst one is', () => {
    expect(bundleSummary([end({ ageMs: 86_400_000 * 3 }), end({ ready: true, ageMs: 1000 })])).toBe(
      '1 needs cleanup · oldest is 3 days old',
    )
  })

  it('says so when the whole pile is clean', () => {
    expect(bundleSummary([end({ ready: true }), end({ ready: true })])).toBe('all clean and ready to review')
  })
})
