/**
 * Safety-git ↔ git-bundle round trip — the backup's payload format.
 *
 * A full bundle every time, no incrementals: pruning REWRITES the store's history (prune.ts
 * replayChain re-SHAs master), so any delta scheme keyed on commit SHAs breaks every prune cycle
 * and converges on "re-baseline anyway." Safety stores are source trees without node_modules /
 * build output / databases (repo.ts EXCLUDE) — small enough that whole-bundle is the KISS answer
 * until dogfood proves otherwise.
 *
 * Both refs lanes ride along: master (moments — the visible timeline) AND refs/koda/steps (the
 * fine-grained per-tool lane, already capped at 48h) — a restored project keeps its full undo net
 * right when it's needed most.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runGit, safetyGitDir, ensureRepo } from '../safety-git/repo'
import { listCheckpoints } from '../safety-git/checkpoint'
import { restore } from '../safety-git/restore'

const execFileP = promisify(execFile)

/** Same config isolation as runGit, for git commands that don't target an existing store. */
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

async function refExists(projectDir: string, ref: string): Promise<boolean> {
  try {
    await runGit(projectDir, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

/** What the bundle would contain, as a cheap identity: the two lanes' tips. Unchanged tips ⇒ an
 *  identical bundle ⇒ skip the re-seal + re-upload (a chat-only session arms the debounce on no-op
 *  checkpoints for the replica's sake — the bundle must not ride along for free gigabytes). */
export async function bundleFingerprint(projectDir: string): Promise<string | null> {
  if (!(await refExists(projectDir, 'refs/heads/master'))) return null
  const shas: string[] = []
  for (const ref of ['refs/heads/master', 'refs/koda/steps']) {
    try {
      shas.push((await runGit(projectDir, ['rev-parse', '--verify', '--quiet', ref])).stdout.trim())
    } catch {
      /* lane absent — part of the identity too */
    }
  }
  return shas.join(':')
}

/**
 * Bundle the safety store. Null = nothing to back up yet (no master → the project has never been
 * checkpointed). The bundle is verified against the store before we hand it back — the cloud copy
 * is a single overwritten object, so a corrupt upload must never replace a good one.
 */
export async function createBundle(projectDir: string): Promise<Buffer | null> {
  if (!(await refExists(projectDir, 'refs/heads/master'))) return null
  const refs = ['refs/heads/master']
  if (await refExists(projectDir, 'refs/koda/steps')) refs.push('refs/koda/steps')

  const dir = await mkdtemp(join(tmpdir(), 'koda-backup-'))
  const bundlePath = join(dir, 'safety.bundle')
  try {
    // Refs only, no HEAD: a store whose init-default branch never got a commit has an unborn HEAD
    // (checkpoints land on `master` explicitly), and `bundle create HEAD` errors on it. Restore
    // re-points HEAD at master itself.
    await runGit(projectDir, ['bundle', 'create', bundlePath, ...refs])
    await runGit(projectDir, ['bundle', 'verify', bundlePath])
    return await readFile(bundlePath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Rebuild a project from a bundle: mirror-clone it back into `.koda/safety.git`, re-apply the
 * store's local config/excludes (a mirror clone carries neither), then materialize the working
 * tree through the EXISTING restore() machinery — no new tree code.
 *
 * Refuses a project that already has a safety store: restore-over-live could stomp real work.
 * Phase 1 restore targets a fresh/empty directory (the disaster-recovery case); a same-project
 * "roll back from cloud" is deliberately not a thing — the local timeline already does that.
 */
export async function restoreFromBundle(projectDir: string, bundle: Buffer): Promise<void> {
  const storeDir = safetyGitDir(projectDir)
  if (existsSync(storeDir)) {
    throw new Error('project already has a local safety store — cloud restore targets a fresh folder')
  }

  const dir = await mkdtemp(join(tmpdir(), 'koda-restore-'))
  const bundlePath = join(dir, 'safety.bundle')
  try {
    await writeFile(bundlePath, bundle)
    await execFileP('git', ['clone', '--mirror', '--quiet', bundlePath, storeDir], {
      env: GIT_ENV,
      timeout: 60_000,
    })
    // A mirror clone marks itself bare=true and carries no local config — ensureRepo re-inits
    // in place (no-op on the objects), re-applies identity/hooks/excludes, and un-bares it so
    // runGit's --work-tree pairing behaves like every other store.
    await runGit(projectDir, ['config', 'core.bare', 'false'])
    await runGit(projectDir, ['symbolic-ref', 'HEAD', 'refs/heads/master'])
    await ensureRepo(projectDir)
    const checkpoints = await listCheckpoints(projectDir)
    if (checkpoints.length === 0) throw new Error('restored store has no checkpoints')
    await restore(projectDir, checkpoints[0].id)
  } catch (err) {
    // Don't leave a half-restored store behind: it would turn a retry into a confusing
    // "already has a safety store" / "pick an empty folder" refusal mid-disaster-recovery.
    // We created storeDir in this call (guarded absent at entry), so removing it is safe.
    await rm(storeDir, { recursive: true, force: true }).catch(() => {})
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
