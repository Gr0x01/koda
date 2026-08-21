/**
 * Retention — keep the safety store bounded so it reflects RECENT activity, not project age
 * (dual-git.md §6.1). Two lanes share this one repo:
 *
 *   refs/heads/master  → "moment" checkpoints (the browsable recovery timeline). Kept long.
 *   refs/koda/steps    → "step" checkpoints (the per-tool safety net). Disposable; kept 48h.
 *
 * The advertised policy:
 *   - steps: keep every one for 48h, then drop.
 *   - moments: keep every one for 90 days; one per day from 90d–1yr; one per week beyond;
 *     always keep the newest 50 regardless of age (a quiet old project never gets emptied).
 *
 * WHY a rewrite is safe here: nothing durable persists a checkpoint SHA across a process restart
 * except the humanized-label cache — and that cache is remapped old→new on every rewrite (see
 * reconcileLabels). Restore is always called with a SHA the renderer just fetched live from
 * listCheckpoints(). So dropping/re-SHA-ing old commits can't strand a handle. If you add a NEW
 * store that persists a checkpoint SHA past a restart, you MUST key it by label/timestamp/position
 * instead, or pruning will silently corrupt it. (Tripwire: checkpoint.ts `id`, dual-git.md §6.1.)
 *
 * Fail-safe by construction: every step is wrapped by the caller; a rewrite only flips a ref AFTER
 * its replacement is fully built and verified, git `update-ref` is atomic per-ref, and a crash
 * mid-gc just leaves unreachable objects (space not yet reclaimed) — never a corrupt timeline.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit, safetyGitDir } from './repo'
import { checkpointKind, headSha } from './checkpoint'
import { reconcileLabels } from '../assist/labels'
import { log } from '../logger'

const STEPS_REF = 'refs/koda/steps'

const DAY = 86_400
const STEP_WINDOW = 2 * DAY // keep every step for 48h
const NINETY_DAYS = 90 * DAY // keep every moment
const ONE_YEAR = 365 * DAY // then one/day, then one/week
const WEEK = 7 * DAY
const MOMENT_FLOOR = 50 // always keep the newest N moments, whatever their age
const PRUNE_INTERVAL = DAY // don't re-run a full prune more than once a day per store

/** Bump when the on-disk layout changes in a way that needs a one-time migration. */
const SCHEMA_VERSION = 1

interface CommitMeta {
  sha: string
  tree: string
  /** author date, unix seconds */
  at: number
  /** committer date, unix seconds — what the timeline sorts and ages by */
  ct: number
  subject: string
}

/** Commits of a ref, oldest→newest. Empty when the ref doesn't exist yet (e.g. no steps taken). */
async function listCommits(projectDir: string, ref: string): Promise<CommitMeta[]> {
  let stdout: string
  try {
    // Subjects are single-line by construction (checkpoint collapses whitespace), so a newline
    // record separator is safe; NUL field separator survives arbitrary subject text.
    ;({ stdout } = await runGit(projectDir, [
      'log',
      '--reverse',
      '--format=%H%x00%T%x00%at%x00%ct%x00%s',
      ref,
    ]))
  } catch {
    return [] // ref absent — nothing there yet
  }
  const out: CommitMeta[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [sha, tree, at, ct, subject = ''] = line.split('\0')
    out.push({ sha, tree, at: Number(at), ct: Number(ct), subject })
  }
  return out
}

/**
 * Rebuild a linear chain from an ordered (oldest→newest) subsequence of commits, re-parenting each
 * onto the previous kept one. Tree, subject and both dates are preserved verbatim — only the parent
 * link changes — so every replayed commit is byte-identical in content to its source (that's the
 * invariant migrate() verifies). Returns the new tip and the old→new SHA remap (for label cache).
 */
async function replayChain(
  projectDir: string,
  commits: CommitMeta[],
): Promise<{ tip: string | null; remap: Map<string, string> }> {
  const remap = new Map<string, string>()
  let parent: string | null = null
  for (const c of commits) {
    const args = ['commit-tree', c.tree]
    if (parent) args.push('-p', parent)
    args.push('-m', c.subject)
    const { stdout } = await runGit(projectDir, args, {
      // git unix-timestamp date format: "@<unix> <tz>". Preserves committer time exactly (%ct), which
      // is what the timeline orders by; tz is normalized (cosmetic — %ct is tz-independent).
      extraEnv: { GIT_AUTHOR_DATE: `@${c.at} +0000`, GIT_COMMITTER_DATE: `@${c.ct} +0000` },
    })
    const next = stdout.trim()
    remap.set(c.sha, next)
    parent = next
  }
  return { tip: parent, remap }
}

async function schemaPath(projectDir: string): Promise<string> {
  return join(safetyGitDir(projectDir), 'koda-schema')
}
async function readSchema(projectDir: string): Promise<number> {
  try {
    return Number((await readFile(await schemaPath(projectDir), 'utf8')).trim()) || 0
  } catch {
    return 0
  }
}

async function prunedAtPath(projectDir: string): Promise<string> {
  return join(safetyGitDir(projectDir), 'koda-pruned-at')
}
async function prunedRecently(projectDir: string, now: number): Promise<boolean> {
  try {
    const at = Number((await readFile(await prunedAtPath(projectDir), 'utf8')).trim()) || 0
    return now - at < PRUNE_INTERVAL
  } catch {
    return false
  }
}

/** Reflog holds old ref tips reachable, so it must be expired before gc can reclaim anything. */
async function reclaim(projectDir: string): Promise<void> {
  await runGit(projectDir, ['reflog', 'expire', '--expire=now', '--all'])
  await runGit(projectDir, ['gc', '--prune=now', '--quiet'])
}

/**
 * One-time: split an existing single-chain store (moments and steps interleaved on master) into the
 * two-lane layout. Idempotent via the schema marker. Verifies the split preserved content (each
 * lane's newest tree matches its source) before flipping any ref; on mismatch it aborts untouched.
 */
export async function migrate(projectDir: string): Promise<Map<string, string>> {
  const none = new Map<string, string>()
  if ((await readSchema(projectDir)) >= SCHEMA_VERSION) return none
  if (!(await headSha(projectDir))) {
    // Empty store — nothing to split; mark done so we don't re-scan every launch.
    await writeFile(await schemaPath(projectDir), String(SCHEMA_VERSION), 'utf8')
    return none
  }

  const all = await listCommits(projectDir, 'refs/heads/master')
  const moments = all.filter((c) => checkpointKind(c.subject) === 'moment')
  const steps = all.filter((c) => checkpointKind(c.subject) === 'step')

  // A store with no moments is degenerate (the first checkpoint is always a turn-boundary moment);
  // leave it untouched rather than build an empty master. New steps already route off-master, so it
  // won't grow. Retry next launch once a moment exists.
  if (moments.length === 0) return none

  const newMaster = await replayChain(projectDir, moments)
  const newSteps = await replayChain(projectDir, steps)

  // Parity: a faithful replay carries each source tree verbatim, so the newest kept commit of each
  // lane must have the exact tree of its source newest. If not, the split is wrong — abort.
  const okMaster = newMaster.tip
    ? (await treeOf(projectDir, newMaster.tip)) === moments[moments.length - 1].tree
    : false
  const okSteps =
    steps.length === 0 ||
    (newSteps.tip ? (await treeOf(projectDir, newSteps.tip)) === steps[steps.length - 1].tree : false)
  if (!okMaster || !okSteps) {
    log.error('safety-git', 'migration parity check failed — leaving store untouched')
    return none
  }

  if (newMaster.tip) await runGit(projectDir, ['update-ref', 'refs/heads/master', newMaster.tip])
  if (newSteps.tip) await runGit(projectDir, ['update-ref', STEPS_REF, newSteps.tip])
  reconcileLabels(newMaster.remap, new Set(newMaster.remap.values()))
  await reclaim(projectDir)
  await writeFile(await schemaPath(projectDir), String(SCHEMA_VERSION), 'utf8')
  // Master was re-SHA'd; caller re-pins any live diff baseline through this map.
  return newMaster.remap
}

async function treeOf(projectDir: string, sha: string): Promise<string> {
  const { stdout } = await runGit(projectDir, ['rev-parse', `${sha}^{tree}`])
  return stdout.trim()
}

/**
 * Which moments survive, given the GFS policy. `moments` is oldest→newest; the return is the same
 * order, a subsequence (safe to replay). Newest-50 floor wins over any age rule.
 */
export function selectRetainedMoments(moments: CommitMeta[], now: number): CommitMeta[] {
  const floor = new Set(moments.slice(-MOMENT_FLOOR).map((c) => c.sha))
  const retained: CommitMeta[] = []
  let lastDay: number | null = null
  let lastWeek: number | null = null
  for (const c of moments) {
    const age = now - c.ct
    let keep: boolean
    if (floor.has(c.sha) || age <= NINETY_DAYS) {
      keep = true
    } else if (age <= ONE_YEAR) {
      const bucket = Math.floor(c.ct / DAY) // keep the first moment of each day
      keep = bucket !== lastDay
      if (keep) lastDay = bucket
    } else {
      const bucket = Math.floor(c.ct / WEEK) // keep the first moment of each week
      keep = bucket !== lastWeek
      if (keep) lastWeek = bucket
    }
    if (keep) retained.push(c)
  }
  return retained
}

/**
 * Trim aged-out steps (>48h) and thin aged moments per the GFS policy, then reclaim disk. Rewrites a
 * lane only when it actually drops something. `now` is injectable for tests. Assumes it's called
 * under the per-project safety-git mutex (sessions.ts runExclusive) so it can't race a checkpoint.
 */
export async function pruneStore(projectDir: string, now: number): Promise<Map<string, string>> {
  let changed = false
  let masterRemap = new Map<string, string>()

  // Steps: keep the last 48h. Re-SHAs only steps (never a moment, so never an active diff baseline).
  const steps = await listCommits(projectDir, STEPS_REF)
  const keptSteps = steps.filter((c) => now - c.ct <= STEP_WINDOW)
  if (keptSteps.length < steps.length) {
    const { tip } = await replayChain(projectDir, keptSteps)
    if (tip) await runGit(projectDir, ['update-ref', STEPS_REF, tip])
    else await runGit(projectDir, ['update-ref', '-d', STEPS_REF]) // all steps aged out
    changed = true
  }

  // Moments: GFS thinning. Re-SHAs kept moments too (linear-chain cascade), so labels are remapped
  // and the caller re-pins every live safety handle through the returned map.
  const moments = await listCommits(projectDir, 'refs/heads/master')
  const retained = selectRetainedMoments(moments, now)
  if (retained.length < moments.length) {
    const { tip, remap } = await replayChain(projectDir, retained)
    if (tip) {
      await runGit(projectDir, ['update-ref', 'refs/heads/master', tip])
      reconcileLabels(remap, new Set(remap.values()))
      masterRemap = remap
    }
    changed = true
  }

  if (changed) await reclaim(projectDir)
  await writeFile(await prunedAtPath(projectDir), String(now), 'utf8')
  return masterRemap
}

/** Compose two master remaps (migrate → prune) into one original-SHA → final-SHA map. */
function composeRemap(first: Map<string, string>, second: Map<string, string>): Map<string, string> {
  if (first.size === 0) return second
  if (second.size === 0) return first
  const out = new Map<string, string>()
  for (const [orig, mid] of first) out.set(orig, second.get(mid) ?? mid)
  return out
}

/**
 * Migrate-if-needed then prune-if-due. The single entry point for the background maintenance pass.
 * Fully fail-safe: any error is logged and swallowed — a recovery net that stays a bit large is far
 * better than one that throws mid-maintenance.
 */
export async function maintainStore(
  projectDir: string,
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, string>> {
  try {
    const migrated = await migrate(projectDir)
    if (await prunedRecently(projectDir, now)) return migrated
    const pruned = await pruneStore(projectDir, now)
    return composeRemap(migrated, pruned)
  } catch (err) {
    log.warn('safety-git', 'store maintenance skipped', err instanceof Error ? err.message : err)
    return new Map()
  }
}
