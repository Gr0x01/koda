/**
 * The Versions timeline model — one pure function turning what the panel already fetched (the commit
 * graph, the sync state, the sibling checkouts) into the rows and lanes the rail draws.
 *
 * Why a model instead of ad-hoc JSX: the surface has to say three things at once — what happened, what
 * is still open, and what is only on this Mac — and they share one vertical line. Row order, lane
 * ownership, and the GitHub seam are decided here so the renderer stays layout-only and this part can
 * be tested in plain node.
 *
 * The rules it encodes:
 *  - The spine is HEAD's first-parent chain (lane 0 in git-graph.ts). Every commit shown is on it.
 *  - A merge shows the commits it BROUGHT IN on their own lane, then reconnects that lane to the real
 *    fork point. Only unfinished work gets an open end; a fork outside the window runs off the edge.
 *  - Open side lines are lanes that never rejoin. They terminate at their own card, placed in the
 *    timeline where the work actually happened.
 *  - At most LANE_CAP OPEN side lines get a lane (live sessions first, then the freshest). The rest
 *    collapse into one bundle row. Completed merge loops may use more columns when topology demands
 *    it: dropping a finished rail would leave its commits branching out of nothing.
 */
import type { GitCommitGraphResult, GitGraphRow, GitSyncState, GitWorktree } from '@shared/ipc'

/** How many open side lines are allowed a real lane before the rest become one bundle row. */
export const LANE_CAP = 3

/**
 * How many of a merge's own commits the rail shows before it offers the rest behind one more row.
 *
 * A merged branch used to be drawn as an arc around commits the rail did not render. The commits are
 * the branch, so they now sit on the lane itself. The lane still reconnects to its real fork: stopping
 * it under the preview makes completed work look like an open branch that started from nowhere.
 */
export const INFLOW_PREVIEW = 5

/** An open side line: agent work that never came back to the main line. */
export interface LooseEnd {
  /** Stable key — the branch name, else the checkout path. */
  id: string
  /** Branch it lives on; null for a detached checkout. */
  branch: string | null
  /** The sibling checkout holding it, when there is one (drives Open vs Review). */
  path: string | null
  /** What to call it on screen (branch name, else the folder). */
  label: string
  /** One plain line: "needs cleanup · 17 loose files · 21m". */
  status: string
  /** Committed and clean, so reviewing it is the next step. */
  ready: boolean
  /** The checkout folder is gone. */
  missing: boolean
  /** A session is working here right now. */
  live: boolean
  /** Rough age from git's relative date; null when we have no date at all. */
  ageMs: number | null
  /** Index in the spine where this line forked off; null when the fork is outside the loaded window. */
  forkSpine: number | null
}

export type TimelineRow =
  | {
      t: 'commit'
      key: string
      sha: string
      subject: string
      /** Compact age ("9h"); falls back to git's own relative date when it can't be parsed. */
      when: string
      /** git's full relative date, for the row title. */
      whenLong: string
      /** Confirmed present/absent on GitHub; null when the seam cannot prove either per commit. */
      onGitHub: boolean | null
      merge: boolean
      /** How many commits this merge brought in; 0 when it is not a merge or brought nothing shown. */
      inflowCount: number
      /** More exist than the fetch window held, so the count is a floor rather than the whole story. */
      inflowPartial: boolean
      /** Merging the trunk back down is catching up, not work arriving — collapsed until asked for. */
      fromTrunk: boolean
      /** This merge's own commits are showing below it. */
      inflowOpen: boolean
      /** The count can reveal/hide rows rather than merely report what the graph knows. */
      inflowToggleable: boolean
      /** Ordinary merge is showing every fetched commit rather than its preview. */
      inflowExpanded: boolean
    }
  /** One commit a merge brought in, drawn on the merge's lane rather than on the spine. */
  | {
      t: 'inflow'
      key: string
      /** Merge whose lane this commit belongs to; spans can overlap, so row position is not identity. */
      mergeSha: string
      sha: string
      subject: string
      when: string
      whenLong: string
    }
  /** The tail of a merge's commits, behind one row rather than shown in full. */
  | {
      t: 'inflowMore'
      key: string
      mergeSha: string
      remaining: number
      partial: boolean
      /** More fetched rows exist to reveal; otherwise this is honest, static clipped-history copy. */
      expandable: boolean
    }
  | { t: 'side'; key: string; end: LooseEnd }
  | { t: 'bundle'; key: 'timeline:bundle'; ends: LooseEnd[] }
  | { t: 'seam'; key: 'timeline:seam'; kind: SeamKind }
  /** Heads the run of versions saved on one calendar day ("Today", "Yesterday", "Tue, Aug 12"). */
  | { t: 'day'; key: string; label: string }

/**
 * What the seam is allowed to say, which is only ever what we actually know:
 *  - `boundary`   — we found GitHub's tip in view, so the line can be split at it.
 *  - `neverPushed`— GitHub has no copy of this branch at all. Nothing here is backed up.
 *  - `unlocated`  — GitHub has a copy, but its tip isn't on the loaded part of this line (older than
 *                   the window, or the two lines diverged), so there's no honest place to split.
 *  - `unverified` — we couldn't reach GitHub; the numbers are the last thing it told us.
 */
export type SeamKind = 'boundary' | 'neverPushed' | 'unlocated' | 'unverified'

/** A drawn line on the rail. Row numbers are indices into `rows`; geometry is LaneGraph's job. */
export type Lane =
  | {
      kind: 'open'
      key: string
      tone: 'live' | 'loose'
      /** Row the lane forks off the spine (lower on screen); `rows.length` ⇒ off the bottom edge. */
      fromRow: number
      /** Row holding the card the lane terminates at (higher on screen). */
      toRow: number
      column: number
    }
  /** A merge's own commits, running from the merge dot back to the branch's real fork. */
  | {
      kind: 'inflow'
      key: string
      mergeSha: string
      fromRow: number
      /** The fork row, or `rows.length` when the fork is older than the loaded window. */
      toRow: number
      column: number
      beyondWindow: boolean
    }
  | { kind: 'bundle'; key: 'lane:bundle'; atRow: number }

const BUNDLE_ROW_KEY = 'timeline:bundle' as const
const SEAM_ROW_KEY = 'timeline:seam' as const
const sideRowKey = (id: string): string => `side:${id}`

export interface Timeline {
  rows: TimelineRow[]
  lanes: Lane[]
  /** Row index where local-only versions end and GitHub's copy begins; null unless we located it. */
  boundaryRow: number | null
  /** Row index of the seam row, or null when there is no remote to have a seam with. */
  seamRow: number | null
  /** What the seam is entitled to claim. null when there's no seam. */
  seamKind: SeamKind | null
  /** Versions on the current line that GitHub does not have yet (drives the push button's count). */
  ahead: number
  /** The graph window clipped older versions. */
  truncated: boolean
}

// ── Ages ────────────────────────────────────────────────────────────────────────────
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

const UNITS: Array<[RegExp, number]> = [
  [/^sec/, 1000],
  [/^min/, MIN],
  [/^hour/, HOUR],
  [/^day/, DAY],
  [/^week/, WEEK],
  [/^month/, MONTH],
  [/^year/, YEAR],
]

/**
 * git's `--date=relative` string → rough milliseconds ("3 days ago" → 259200000). Rough is enough:
 * this only orders side lines and prints "oldest is 3 days old". Returns null when there's no date to
 * read, so callers can fall back to position rather than invent an age.
 */
export function relativeAgeMs(text: string | null | undefined): number | null {
  if (!text) return null
  const s = text.trim().toLowerCase()
  if (s === 'now' || s === 'just now') return 0
  if (s === 'yesterday') return DAY
  const m = /^(\d+|an?)\s+([a-z]+)/.exec(s)
  if (!m) return null
  const n = m[1] === 'a' || m[1] === 'an' ? 1 : Number(m[1])
  const unit = UNITS.find(([re]) => re.test(m[2]))
  return unit ? n * unit[1] : null
}

/** Milliseconds → the compact age the rail prints: "40s", "21m", "9h", "3d", "2w", "5mo", "2y". */
export function shortAge(ms: number | null): string | null {
  if (ms === null) return null
  if (ms < MIN) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`
  if (ms < WEEK) return `${Math.round(ms / DAY)}d`
  if (ms < MONTH) return `${Math.round(ms / WEEK)}w`
  if (ms < YEAR) return `${Math.round(ms / MONTH)}mo`
  return `${Math.round(ms / YEAR)}y`
}

// ── Days ────────────────────────────────────────────────────────────────────────────
/** Local calendar day as `YYYY-MM-DD` — the grouping key, and stable across a render. */
function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * What to call a day on the rail. "Today" and "Yesterday" carry the two the user is actually working
 * in; everything older gets a real date, because "3 days ago" is a duration and this is a heading.
 */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const then = new Date(ts)
  const today = new Date(now)
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const daysBack = Math.round((midnight(today) - midnight(then)) / DAY)
  if (daysBack <= 0) return 'Today'
  if (daysBack === 1) return 'Yesterday'
  return then.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** Milliseconds → a spoken age for a sentence ("3 days old"). */
export function spokenAge(ms: number | null): string | null {
  if (ms === null) return null
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (ms < HOUR) return plural(Math.max(1, Math.round(ms / MIN)), 'minute')
  if (ms < DAY) return plural(Math.round(ms / HOUR), 'hour')
  if (ms < MONTH) return plural(Math.max(1, Math.round(ms / DAY)), 'day')
  if (ms < YEAR) return plural(Math.round(ms / MONTH), 'month')
  return plural(Math.round(ms / YEAR), 'year')
}

// ── Loose ends ──────────────────────────────────────────────────────────────────────
function worktreeStatus(w: GitWorktree, age: string | null): string {
  const parts: string[] = []
  if (w.prunable) parts.push('folder missing')
  else if (!w.statusKnown) parts.push('needs a check · status unavailable')
  else parts.push(`needs cleanup · ${w.dirtyCount} loose ${w.dirtyCount === 1 ? 'file' : 'files'}`)
  if (age) parts.push(age)
  return parts.join(' · ')
}

/**
 * The open side lines worth a human decision, exactly as the old Loose Ends section chose them: a
 * side line the agent never brought in, and a sibling checkout still holding loose or unreadable work.
 * A dirty checkout speaks for its own branch, so the branch doesn't also appear as "ready".
 */
export function collectLooseEnds({
  graph,
  worktrees,
  liveBranches = [],
}: {
  graph: GitCommitGraphResult | null
  worktrees: GitWorktree[]
  liveBranches?: string[]
}): LooseEnd[] {
  const rows = graph?.layout.rows ?? []
  const spineIndex = spineIndexBySha(rows)
  const live = new Set(liveBranches)

  const siblings = worktrees.filter((w) => !w.isCurrent)
  const loose = siblings.filter((w) => !w.statusKnown || w.dirtyCount > 0 || w.prunable)
  const notReady = new Set(
    loose.filter((w) => (!w.statusKnown || w.dirtyCount > 0) && w.branch).map((w) => w.branch as string),
  )

  const ends: LooseEnd[] = []

  for (const b of graph?.unmergedBranches ?? []) {
    if (notReady.has(b.name)) continue
    const tip = rows.find((r) => r.branchLabel === b.name)
    const ageMs = relativeAgeMs(tip?.relativeDate)
    const age = shortAge(ageMs)
    ends.push({
      id: b.name,
      branch: b.name,
      path: null,
      label: b.name,
      status: ['clean · ready to review', `${b.ahead} ${b.ahead === 1 ? 'version' : 'versions'}`, age]
        .filter(Boolean)
        .join(' · '),
      ready: true,
      missing: false,
      live: live.has(b.name),
      ageMs,
      forkSpine: tip ? forkSpineIndex(rows, spineIndex, tip.lane, tip.color) : null,
    })
  }

  for (const w of loose) {
    const tip = w.branch ? rows.find((r) => r.branchLabel === w.branch) : undefined
    const ageMs = relativeAgeMs(w.lastActivity) ?? relativeAgeMs(tip?.relativeDate)
    ends.push({
      id: w.path,
      branch: w.branch,
      path: w.path,
      label: w.branch ?? basename(w.path),
      status: worktreeStatus(w, shortAge(ageMs)),
      ready: false,
      missing: w.prunable,
      live: !!w.branch && live.has(w.branch),
      ageMs,
      forkSpine: tip ? forkSpineIndex(rows, spineIndex, tip.lane, tip.color) : null,
    })
  }

  // Live sessions first (they're the only lane that's still moving), then freshest. An end with no
  // readable date sorts last rather than pretending to be new.
  return ends.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    if (a.ageMs === null || b.ageMs === null) return (a.ageMs === null ? 1 : 0) - (b.ageMs === null ? 1 : 0)
    return a.ageMs - b.ageMs
  })
}

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

// ── Graph reading ───────────────────────────────────────────────────────────────────
function spineIndexBySha(rows: GitGraphRow[]): Map<string, number> {
  const map = new Map<string, number>()
  let i = 0
  for (const r of rows) if (r.lane === 0) map.set(r.sha, i++)
  return map
}

/**
 * Where a side lane rejoins the spine — its merge base. git-graph.ts folds a finished lane into the
 * commit both lines share, emitting a top→node segment carrying that lane's color, so the first spine
 * row that swallows this color IS the fork. null ⇒ the fork is older than the loaded window.
 */
function forkSpineIndex(
  rows: GitGraphRow[],
  spineIndex: Map<string, number>,
  lane: number,
  color: number,
): number | null {
  // A line already ON the spine has no lane to fold back in; scanning for its color would match the
  // spine's own segments and invent a fork.
  if (lane === 0) return null
  for (const r of rows) {
    if (r.lane !== 0) continue
    if (r.segments.some((s) => s.y1 === 0 && s.y2 === 1 && s.x1 !== 0 && s.color === color)) {
      return spineIndex.get(r.sha) ?? null
    }
  }
  return null
}

/**
 * Where a merge's second-parent lane originally left the spine.
 *
 * The merge row opens that lane below itself. `git-graph.ts` later folds the same lane color into the
 * shared spine commit, so the existing fork reader can resolve the other end. Octopus merges are
 * folded onto one calm inflow lane; use the oldest resolved fork so the line never closes before one
 * of the branches it represents did.
 */
function mergeForkSpineIndex(
  rows: GitGraphRow[],
  spineIndex: Map<string, number>,
  merge: GitGraphRow,
): number | null {
  if (merge.lane !== 0 || !merge.isMerge) return null
  const forks = merge.segments
    .filter((s) => s.y1 === 1 && s.y2 === 2 && s.x1 === 0 && s.x2 !== 0)
    .map((s) => forkSpineIndex(rows, spineIndex, s.x2, s.color))
    .filter((fork): fork is number => fork !== null)
  return forks.length > 0 ? Math.max(...forks) : null
}

/**
 * Was this merge bringing the trunk back down onto a side branch?
 *
 * That direction is the user catching their branch up, not work arriving, so its commits stay
 * collapsed behind their count. Read from git's own default merge subject rather than from topology:
 * the second parent's branch ref is long gone by the time we see it. A custom merge message simply
 * misses this test and is treated as ordinary work, which is the safe way to be wrong.
 */
export function isTrunkMerge(subject: string, trunk: string | null): boolean {
  if (!trunk) return false
  const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject)
  if (!m) return false
  return m[1] === trunk || m[1].replace(/^[^/]+\//, '') === trunk
}

// ── Column packing ──────────────────────────────────────────────────────────────────
/**
 * Lowest column whose taken spans don't overlap this one. With a cap, returns -1 when every allowed
 * column is busy; without one, adds the next column. Open work is capped and bundled, while completed
 * merge loops grow the gutter rather than disappearing or overprinting a relationship that does not
 * exist.
 */
function packColumn(
  taken: Array<Array<[number, number]>>,
  from: number,
  to: number,
  max: number = taken.length + 1,
): number {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  for (let c = 0; c < max; c++) {
    const spans = taken[c] ?? (taken[c] = [])
    if (spans.every(([a, b]) => hi < a || lo > b)) {
      spans.push([lo, hi])
      return c
    }
  }
  return -1
}

/** git's short SHAs vary in length between calls, so compare by prefix in whichever direction fits. */
function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * Where GitHub's copy of this line begins — located by SHA, never by counting. `sync.ahead` counts
 * every commit the remote lacks, including ones that arrived inside a merge and never appear on the
 * first-parent spine, so using it as a row offset puts the seam too deep and marks pushed versions as
 * local. The remote tip is a real commit: find it, or say we couldn't.
 */
function locateSeam(
  spine: GitGraphRow[],
  sync: GitSyncState | null,
): { kind: SeamKind; spine: number } | null {
  // Nothing saved yet: there is no line to mark a boundary on, and the empty state says it better.
  if (!sync?.hasRemote || spine.length === 0) return null
  if (!sync.verified) return { kind: 'unverified', spine: 0 }
  // Verified, and the remote has no tip for this branch: the branch itself has never been pushed.
  // Individual commits may still exist there through another branch, so the renderer treats them as
  // unknown rather than claiming every shared-base commit lives only on this Mac.
  if (!sync.upstreamTip) return { kind: 'neverPushed', spine: 0 }
  const at = spine.findIndex((r) => sameCommit(r.sha, sync.upstreamTip))
  if (at >= 0) return { kind: 'boundary', spine: at }
  // A remote tip that is newer than local HEAD cannot appear in the local first-parent spine, but a
  // verified zero-ahead count still proves every local commit is already reachable from that tip.
  if (sync.ahead === 0) return { kind: 'boundary', spine: 0 }
  // The remote's tip isn't on the loaded part of this line (older than the window, or the lines
  // diverged). We know how far ahead we are, but not where to draw the split.
  return { kind: 'unlocated', spine: 0 }
}

// ── The model ───────────────────────────────────────────────────────────────────────
export function buildTimeline({
  graph,
  sync,
  worktrees,
  liveBranches,
  trunk = null,
  openMerges,
  now = Date.now(),
}: {
  graph: GitCommitGraphResult | null
  sync: GitSyncState | null
  worktrees: GitWorktree[]
  /** Branches a session is driving right now. See the live-lane seam in SourceControl. */
  liveBranches?: string[]
  /** The project's main line, so a merge FROM it can be told apart from work arriving. */
  trunk?: string | null
  /** Merges the user opened (or, for a trunk merge, opened at all). */
  openMerges?: ReadonlySet<string>
  /** Injectable clock, so day headings can be tested against a fixed today. */
  now?: number
}): Timeline {
  const all = graph?.layout.rows ?? []
  const spine = all.filter((r) => r.lane === 0)
  const spineIndex = spineIndexBySha(all)
  // Off-spine rows were always fetched and laid out; until merges drew their own commits, nothing
  // ever looked them up.
  const byShaRow = new Map(all.map((r) => [r.sha, r]))

  // One decision drives BOTH the split and the words: a hollow dot and the sentence beside it are the
  // same promise, and they must never come from different tests of the same data.
  const seam = locateSeam(spine, sync)
  const ahead = sync?.hasRemote ? sync.ahead : 0
  const boundarySpine = seam?.kind === 'boundary' ? seam.spine : null

  const ends = collectLooseEnds({ graph, worktrees, liveBranches })
  const laned = ends.slice(0, LANE_CAP)
  const bundled = ends.slice(LANE_CAP)

  // Every insertion is expressed as "before this spine row", then merged in one pass so positions
  // never shift under each other.
  const spineAges = spine.map((r) => relativeAgeMs(r.relativeDate))
  const before = new Map<number, TimelineRow[]>()
  const addBefore = (at: number, row: TimelineRow): void => {
    const list = before.get(at)
    if (list) list.push(row)
    else before.set(at, [row])
  }

  /** Where a side line's card belongs: with work of its age, but never below its own fork. */
  const placementFor = (end: LooseEnd): number => {
    const fork = end.forkSpine ?? spine.length
    if (end.ageMs === null) return fork
    const chrono = spineAges.findIndex((age) => age !== null && age > (end.ageMs as number))
    return Math.min(chrono === -1 ? spine.length : chrono, fork)
  }

  for (const end of laned) addBefore(placementFor(end), { t: 'side', key: sideRowKey(end.id), end })
  if (bundled.length > 0) {
    addBefore(Math.min(...bundled.map(placementFor)), {
      t: 'bundle',
      key: BUNDLE_ROW_KEY,
      ends: bundled,
    })
  }

  // A located seam splits the line at the exact version GitHub has. Every other kind can't claim a
  // position in history, so it rides the top as a plain statement instead of splitting on a guess —
  // and stays where the push button is reachable without scrolling a long history.
  if (seam) addBefore(seam.spine, { t: 'seam', key: SEAM_ROW_KEY, kind: seam.kind })

  const rows: TimelineRow[] = []
  const rowOfSpine: number[] = []
  const flush = (at: number): void => {
    for (const row of before.get(at) ?? []) rows.push(row)
  }
  // A day heading opens the run of versions saved that day, and opens it ABOVE anything inserted at
  // the same spine position — a side card or the seam belongs inside the day it sits in.
  let openDay: string | null = null
  for (let i = 0; i < spine.length; i++) {
    const at = spine[i].committedAt
    // Guarded rather than assumed: a renderer hot-reloaded ahead of a still-old main process sees
    // rows without a commit time, and no heading is the honest answer to not knowing the day.
    if (at) {
      const key = dayKey(at)
      if (key !== openDay) {
        rows.push({ t: 'day', key: `timeline:day:${key}`, label: dayLabel(at, now) })
        openDay = key
      }
    }
    flush(i)
    rowOfSpine[i] = rows.length
    const r = spine[i]
    const ageMs = spineAges[i]

    // What this merge brought in. `shas` may name commits outside the fetch window, so the rows we
    // can actually draw are the ones we hold — the count still reports everything git told us about.
    const inflow = r.isMerge ? graph?.mergeInflows?.[r.sha] : undefined
    const carried = (inflow?.shas ?? []).map((sha) => byShaRow.get(sha)).filter(Boolean) as GitGraphRow[]
    const fromTrunk = r.isMerge && isTrunkMerge(r.subject, trunk)
    // A trunk merge stays shut until asked for; ordinary work opens to a preview and can go further.
    // `partial` alone still proves that a branch arrived, even when none of its commits fit in the
    // fetch window. Give that evidence a row so its rail can honestly continue offscreen.
    const opened = openMerges?.has(r.sha) ?? false
    const showing = fromTrunk && !opened ? 0 : opened ? carried.length : Math.min(INFLOW_PREVIEW, carried.length)
    const inflowVisible = (!fromTrunk || opened) && (showing > 0 || (inflow?.partial ?? false))
    const hasInflowEvidence = (inflow?.shas.length ?? 0) > 0 || (inflow?.partial ?? false)

    rows.push({
      t: 'commit',
      key: r.sha,
      sha: r.sha,
      subject: r.subject,
      when: shortAge(ageMs) ?? r.relativeDate,
      whenLong: r.relativeDate,
      onGitHub:
        boundarySpine !== null
          ? i >= boundarySpine
          : sync?.hasRemote === false
            ? false
            : null,
      merge: r.isMerge,
      inflowCount: inflow?.shas.length ?? 0,
      inflowPartial: inflow?.partial ?? false,
      fromTrunk,
      inflowOpen: inflowVisible,
      // A trunk merge's control opens/closes the whole folded branch. An ordinary merge already
      // shows its preview, so its count is actionable only when more fetched rows can be revealed.
      inflowToggleable: fromTrunk ? hasInflowEvidence : carried.length > INFLOW_PREVIEW,
      inflowExpanded: opened,
    })

    for (let k = 0; k < showing; k++) {
      const c = carried[k]
      const carriedAge = relativeAgeMs(c.relativeDate)
      rows.push({
        t: 'inflow',
        key: `inflow:${r.sha}:${c.sha}`,
        mergeSha: r.sha,
        sha: c.sha,
        subject: c.subject,
        when: shortAge(carriedAge) ?? c.relativeDate,
        whenLong: c.relativeDate,
      })
    }
    const remaining = (inflow?.shas.length ?? 0) - showing
    if (inflowVisible && (remaining > 0 || inflow?.partial))
      rows.push({
        t: 'inflowMore',
        key: `inflowMore:${r.sha}`,
        mergeSha: r.sha,
        remaining,
        partial: inflow?.partial ?? false,
        expandable: showing < carried.length,
      })
  }
  flush(spine.length)

  const rowIndexOf = (key: string): number => rows.findIndex((r) => r.key === key)
  /** A fork below the loaded window has no row to hang from; the lane runs off the bottom edge. */
  const forkRow = (forkSpine: number | null): number =>
    forkSpine === null || forkSpine >= rowOfSpine.length ? rows.length : rowOfSpine[forkSpine]

  const taken: Array<Array<[number, number]>> = []
  const lanes: Lane[] = []
  // Open lines claim the three calm, fixed columns first — they're the work still waiting on someone.
  for (const end of laned) {
    const toRow = rowIndexOf(sideRowKey(end.id))
    if (toRow === -1) continue
    const fromRow = forkRow(end.forkSpine)
    const column = packColumn(taken, fromRow, toRow, LANE_CAP)
    if (column === -1) continue
    lanes.push({
      kind: 'open',
      key: `lane:open:${end.id}`,
      tone: end.live ? 'live' : 'loose',
      fromRow,
      toRow,
      column,
    })
  }
  // A merge's own commits leave its dot and reconnect at the real fork. The rows stay grouped under
  // the merge so they read as what arrived, while the continuation down to the shared spine commit
  // keeps the topology honest. If the fork is outside the fetch window, run off the bottom instead of
  // drawing the hollow end cap reserved for unfinished work.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.t !== 'commit' || !row.inflowOpen) continue
    let end = i
    while (end + 1 < rows.length && (rows[end + 1].t === 'inflow' || rows[end + 1].t === 'inflowMore'))
      end++
    if (end === i) continue
    const merge = byShaRow.get(row.sha)
    const forkSpine = merge ? mergeForkSpineIndex(all, spineIndex, merge) : null
    const resolvedForkRow = forkRow(forkSpine)
    // A malformed or clipped layout can name no usable fork. Continuing offscreen is the honest
    // fallback: closing on a preview row would claim completed topology the graph did not prove.
    const beyondWindow = forkSpine === null || resolvedForkRow <= end
    const toRow = beyondWindow ? rows.length : resolvedForkRow
    // Completed topology does not disappear when the three open-work columns are occupied. These
    // loops are finite, so the renderer may widen its gutter for the rare overlap instead of leaving
    // their commits with no line or pretending two separate branches were one.
    const column = packColumn(taken, i, toRow)
    lanes.push({
      kind: 'inflow',
      key: `lane:inflow:${row.sha}`,
      mergeSha: row.sha,
      fromRow: i,
      toRow,
      column,
      beyondWindow,
    })
  }
  const bundleRow = rows.findIndex((r) => r.t === 'bundle')
  if (bundleRow !== -1) lanes.push({ kind: 'bundle', key: 'lane:bundle', atRow: bundleRow })

  const seamRow = seam ? rowIndexOf(SEAM_ROW_KEY) : -1
  return {
    rows,
    lanes,
    boundaryRow: boundarySpine === null ? null : (rowOfSpine[boundarySpine] ?? rows.length),
    seamRow: seamRow === -1 ? null : seamRow,
    seamKind: seam?.kind ?? null,
    ahead,
    truncated: !!graph?.truncated,
  }
}

/** The bundle's one-line summary: how many still need cleanup, and how old the worst one is. */
export function bundleSummary(ends: LooseEnd[]): string {
  const dirty = ends.filter((e) => !e.ready).length
  const oldest = ends.reduce<number | null>(
    (max, e) => (e.ageMs === null ? max : max === null ? e.ageMs : Math.max(max, e.ageMs)),
    null,
  )
  const head =
    dirty === 0 ? 'all clean and ready to review' : `${dirty} need${dirty === 1 ? 's' : ''} cleanup`
  const age = spokenAge(oldest)
  return age ? `${head} · oldest is ${age} old` : head
}
