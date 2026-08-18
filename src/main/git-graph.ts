/**
 * Pure git-graph lane layout — the calm "Versions" rail (Source Control redo).
 *
 * Turns a flat, newest-first commit list (with parent SHAs + ref decorations) into per-row draw
 * instructions: which lane the node sits on, and the line segments crossing that row's cell. No git,
 * no I/O, no Electron here — it's a deterministic function so it can be tested in plain `node`.
 *
 * Design choices that keep it CALM rather than GitLens-busy:
 *  - **Lane 0 is reserved for the current branch (HEAD).** Its first-parent chain runs lane 0 from top
 *    to root, so the trunk reads as one unbroken vertical (RB: "don't break the main line"). Side
 *    branches only ever curve OFF it.
 *  - **Stable lanes (no compaction):** a freed lane is reused by the next new branch instead of sliding
 *    every lane left, so pass-through lines stay vertical and the rail doesn't wiggle.
 *  - **Topology tells the story:** a merged branch's tip is referenced by its merge commit (a line comes
 *    IN from above), so its lane closes into the trunk. An abandoned branch's tip is referenced by
 *    nobody — its lane has an OPEN TOP — which is exactly the "stranded work" signal.
 *
 * Segment coordinates are lane indices on the x axis and {0:top, 1:node-mid, 2:bottom} on the y axis;
 * the renderer maps those to pixels and draws straight lines (x1===x2) or soft curves (merge/branch).
 */

export interface RawCommit {
  /** Short SHA. */
  sha: string
  /** Short SHAs of parents (first parent = the line that continues straight). */
  parents: string[]
  subject: string
  relativeDate: string
  /** Commit time in epoch ms — what the rail groups days by; `relativeDate` can't name a day. */
  committedAt: number
  authorName: string
  /** Branch/tag ref names decorating this commit (HEAD already stripped into `isHead`). */
  refs: string[]
  /** This commit is the current HEAD (its lane must be 0). */
  isHead: boolean
}

export type LaneKind = 'main' | 'branch' | 'unmerged'
export type BranchKind = 'head' | 'merged' | 'unmerged'

export interface GraphSegment {
  x1: number
  y1: 0 | 1 | 2
  x2: number
  y2: 0 | 1 | 2
  /** Color key — index into the renderer palette via `laneKinds`. */
  color: number
}

export interface GraphRow {
  sha: string
  subject: string
  relativeDate: string
  /** Commit time in epoch ms — see RawCommit. */
  committedAt: number
  authorName: string
  parents: string[]
  /** Lane the node sits on. */
  lane: number
  /** Color key of the node's lane. */
  color: number
  isMerge: boolean
  segments: GraphSegment[]
  /** Friendly branch name to show as a chip on this row (only where a branch ref decorates it). */
  branchLabel: string | null
  branchKind: BranchKind | null
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Widest lane index used + 1 — drives the rail width. */
  laneCount: number
  /** color key → palette family, so the renderer colors a whole branch lane consistently. */
  laneKinds: Record<number, LaneKind>
}

/**
 * What each merge on the current line actually brought in, newest-first.
 *
 * The rail draws HEAD's first-parent chain, so the commits a merge carried in through its SECOND
 * parent are fetched, laid out, and then never rendered — which is why a merge used to be an arc
 * curving around nothing. This attributes them: walk back from the second parent and stop at the
 * trunk (any commit already on the first-parent chain), because the merge base is on that chain and
 * the walk terminates there naturally.
 *
 * Merges are processed newest-first and commits are claimed once, so a branch that was merged in
 * stages belongs to the merge that actually landed it rather than to every later merge above it.
 *
 * `partial` is the honest edge: the fetch window is finite, so a walk can run out of commits before
 * it reaches the trunk. Then the list is what we hold, not what exists.
 */
export interface MergeInflow {
  /** Short SHAs this merge brought in, newest-first. */
  shas: string[]
  /** The walk hit the end of the fetched window instead of the trunk. */
  partial: boolean
}

export function computeMergeInflows(commits: RawCommit[]): Record<string, MergeInflow> {
  const bySha = new Map(commits.map((c) => [c.sha, c]))

  // HEAD's first-parent chain — the line the rail draws, and the wall every walk stops at.
  const trunk = new Set<string>()
  let cursor = commits.find((c) => c.isHead)?.sha
  while (cursor) {
    trunk.add(cursor)
    cursor = bySha.get(cursor)?.parents[0]
  }

  const claimed = new Set<string>()
  const inflows: Record<string, MergeInflow> = {}

  for (const merge of commits) {
    if (!trunk.has(merge.sha) || merge.parents.length < 2) continue
    let partial = false
    const queue = merge.parents.slice(1)
    const found = new Set<string>()
    while (queue.length > 0) {
      const sha = queue.shift() as string
      if (trunk.has(sha) || claimed.has(sha) || found.has(sha)) continue
      const commit = bySha.get(sha)
      if (!commit) {
        // Outside the fetched window: we know something is there, not what.
        partial = true
        continue
      }
      found.add(sha)
      queue.push(...commit.parents)
    }
    for (const sha of found) claimed.add(sha)
    // Ordered by the fetch's own date order, so the list reads newest-first like the rail does.
    const shas = commits.filter((c) => found.has(c.sha)).map((c) => c.sha)
    if (shas.length > 0 || partial) inflows[merge.sha] = { shas, partial }
  }
  return inflows
}

export interface BuildGraphOptions {
  /** Local branch names not merged into the current branch (powers unmerged coloring + the chip). */
  unmergedBranchNames: Set<string>
  /** The current branch name, for the HEAD chip label. */
  headBranch: string | null
}

interface Slot {
  sha: string
  color: number
}

/** Strip a remote prefix and `tag: ` so the chip reads like a plain branch name. */
function cleanRefName(ref: string): string {
  return ref
    .replace(/^tag:\s*/, '')
    .replace(/^refs\/(heads|remotes|tags)\//, '')
    .replace(/^origin\//, '')
}

/**
 * Pick the branch chip for a commit: prefer the current branch, then any unmerged local branch, then
 * the first remaining ref. Returns null when only HEAD/remote-dupes remain (nothing worth a chip).
 */
function chipFor(
  refs: string[],
  isHead: boolean,
  opts: BuildGraphOptions,
): { label: string; kind: BranchKind } | null {
  const names = refs.map(cleanRefName).filter((n) => n && n !== 'HEAD')
  if (isHead) {
    const label = opts.headBranch ?? names[0] ?? 'current'
    return { label, kind: 'head' }
  }
  if (names.length === 0) return null
  const unmerged = names.find((n) => opts.unmergedBranchNames.has(n))
  if (unmerged) return { label: unmerged, kind: 'unmerged' }
  return { label: names[0], kind: 'merged' }
}

export function buildGraph(commits: RawCommit[], opts: BuildGraphOptions): GraphLayout {
  const frontier: (Slot | null)[] = []
  const rows: GraphRow[] = []
  const laneKinds: Record<number, LaneKind> = {}
  let laneCount = 0
  let nextColor = 1 // 0 is reserved for the main/HEAD lane

  const claimFreeLane = (): number => {
    // Never hand out lane 0 to a side branch — it belongs to the trunk. Reserve it up front so the
    // very first commit (newest across ALL branches, often a side-branch tip) can't grab it.
    if (frontier.length === 0) frontier.push(null)
    for (let i = 1; i < frontier.length; i++) if (frontier[i] === null) return i
    frontier.push(null)
    return frontier.length - 1
  }

  for (const c of commits) {
    // Lanes from already-drawn children that were waiting for this commit (they come in from the top).
    const converging: number[] = []
    for (let i = 0; i < frontier.length; i++) if (frontier[i]?.sha === c.sha) converging.push(i)

    let lane: number
    let color: number
    if (c.isHead) {
      // The trunk: HEAD always anchors lane 0 + the main color, even when a side branch is "ahead" of
      // it (has newer commits) and a lane is already waiting for HEAD — those converging lanes fold
      // into the node below. Lane 0 is reserved (claimFreeLane never hands it out), so it's free here.
      lane = 0
      color = 0
      if (frontier.length === 0) frontier.push(null)
    } else if (converging.length > 0) {
      lane = converging[0]
      color = frontier[lane]!.color
    } else {
      lane = claimFreeLane()
      color = nextColor++
    }
    laneKinds[color] ??= color === 0 ? 'main' : 'branch'

    const chip = chipFor(c.refs, c.isHead, opts)
    // A real tip (no child references it) that names an unmerged branch ⇒ paint its whole lane as
    // stranded. Merged-branch tips are referenced by their merge (converging > 0), so they stay 'branch'.
    if (converging.length === 0 && chip?.kind === 'unmerged') laneKinds[color] = 'unmerged'

    const segments: GraphSegment[] = []

    // Top → node: every converging lane folds into this commit's node (the lane==self one is vertical).
    for (const j of converging) {
      segments.push({ x1: j, y1: 0, x2: lane, y2: 1, color: frontier[j]!.color })
    }

    // Build the bottom edge: this commit's lane becomes its first parent; extra parents open new lanes.
    // Free every converging lane first (their child has now landed), then re-seat the first parent here.
    for (const j of converging) frontier[j] = null
    const parents = c.parents
    const openedLanes = new Set<number>() // lanes started at THIS node (drawn node→bottom, not top→bottom)
    if (parents.length > 0) {
      frontier[lane] = { sha: parents[0], color } // first parent keeps the lane + color (same line)
      segments.push({ x1: lane, y1: 1, x2: lane, y2: 2, color }) // node → bottom, straight
      for (let p = 1; p < parents.length; p++) {
        const pSha = parents[p]
        const existing = frontier.findIndex((s) => s?.sha === pSha)
        let pLane: number
        let pColor: number
        if (existing >= 0) {
          // Merging into an already-active lane (criss-cross) — keep its line, just add the diagonal.
          pLane = existing
          pColor = frontier[existing]!.color
        } else {
          pLane = claimFreeLane()
          pColor = nextColor++
          frontier[pLane] = { sha: pSha, color: pColor }
          laneKinds[pColor] ??= 'branch'
          openedLanes.add(pLane)
        }
        segments.push({ x1: lane, y1: 1, x2: pLane, y2: 2, color: pColor }) // merge diagonal down
      }
    }

    // Pass-through: any other still-active lane crosses this cell vertically (stable index ⇒ x1===x2).
    // Lanes opened at this node already have their node→bottom segment, so skip them here.
    for (let i = 0; i < frontier.length; i++) {
      if (i === lane || openedLanes.has(i)) continue
      const slot = frontier[i]
      if (!slot) continue
      segments.push({ x1: i, y1: 0, x2: i, y2: 2, color: slot.color })
    }

    laneCount = Math.max(laneCount, frontier.length, lane + 1)

    rows.push({
      sha: c.sha,
      subject: c.subject,
      relativeDate: c.relativeDate,
      committedAt: c.committedAt,
      authorName: c.authorName,
      parents: c.parents,
      lane,
      color,
      isMerge: parents.length > 1,
      segments,
      branchLabel: chip?.label ?? null,
      branchKind: chip?.kind ?? null,
    })
  }

  return { rows, laneCount, laneKinds }
}
