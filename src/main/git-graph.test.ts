import { describe, expect, it } from 'vitest'
import { computeMergeInflows, type RawCommit } from './git-graph'

/**
 * Attribution is the part that has to be right: the rail now DRAWS these commits under their merge,
 * so a wrong walk shows a user work that arrived somewhere else.
 */
function mk(sha: string, parents: string[], o: { head?: boolean } = {}): RawCommit {
  return {
    sha,
    parents,
    subject: `subject ${sha}`,
    relativeDate: '1 hour ago',
    committedAt: 0,
    authorName: 'RB',
    refs: [],
    isHead: !!o.head,
  }
}

describe('computeMergeInflows', () => {
  it('claims the commits a merge brought in, and stops at the trunk', () => {
    // m ── merge of the trunk (t1…) with a branch (b1 → b2), forking at t2.
    const commits = [
      mk('m', ['t1', 'b1'], { head: true }),
      mk('t1', ['t2']),
      mk('b1', ['b2']),
      mk('b2', ['t2']),
      mk('t2', ['t3']),
      mk('t3', []),
    ]
    expect(computeMergeInflows(commits)).toEqual({ m: { shas: ['b1', 'b2'], partial: false } })
  })

  it('never claims a commit that is on the line itself', () => {
    const commits = [mk('m', ['t1', 't1'], { head: true }), mk('t1', [])]
    expect(computeMergeInflows(commits)).toEqual({})
  })

  it('gives a commit to the merge that landed it, not to every merge above it', () => {
    // `outer` sits above `inner`, and both can reach b1 — but b1 arrived through `inner`.
    const commits = [
      mk('outer', ['inner', 'x1'], { head: true }),
      mk('inner', ['t1', 'b1']),
      mk('x1', ['inner']),
      mk('t1', []),
      mk('b1', ['t1']),
    ]
    const inflows = computeMergeInflows(commits)
    expect(inflows.inner).toEqual({ shas: ['b1'], partial: false })
    expect(inflows.outer.shas).toEqual(['x1'])
  })

  it('orders a branch newest-first, the way the rail reads', () => {
    const commits = [
      mk('m', ['t1', 'b1'], { head: true }),
      mk('t1', []),
      mk('b1', ['b2']),
      mk('b2', ['b3']),
      mk('b3', ['t1']),
    ]
    expect(computeMergeInflows(commits).m.shas).toEqual(['b1', 'b2', 'b3'])
  })

  it('says so when the fetch window ended before the walk reached the trunk', () => {
    // b2 is referenced but was never fetched: we know work is there, not what it is.
    const commits = [mk('m', ['t1', 'b1'], { head: true }), mk('t1', []), mk('b1', ['b2'])]
    expect(computeMergeInflows(commits).m).toEqual({ shas: ['b1'], partial: true })
  })

  it('has nothing to say about a repo with no merges', () => {
    expect(computeMergeInflows([mk('c1', ['c2'], { head: true }), mk('c2', [])])).toEqual({})
  })

  it('walks an octopus merge past its first parent', () => {
    const commits = [
      mk('m', ['t1', 'a1', 'b1'], { head: true }),
      mk('t1', []),
      mk('a1', ['t1']),
      mk('b1', ['t1']),
    ]
    expect(computeMergeInflows(commits).m.shas.sort()).toEqual(['a1', 'b1'])
  })
})
