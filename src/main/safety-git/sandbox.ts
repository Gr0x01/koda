/** Materialize one safety checkpoint as a disposable working copy for read-only offline inference. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gitEnv } from '../engine/user-path'
import { safetyGitDir } from './repo'

const execFileP = promisify(execFile)

export async function createCheckpointSandbox(projectDir: string, checkpointId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-rem-'))
  const options = {
    env: gitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  }
  try {
    // Shared object storage keeps this cheap; the checkout has its own index/work-tree and cannot
    // alter the live project or move the safety store's refs.
    await execFileP('git', ['clone', '--quiet', '--shared', '--no-checkout', safetyGitDir(projectDir), dir], options)
    await execFileP('git', ['-C', dir, 'checkout', '--quiet', '--detach', checkpointId], options)
    return dir
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function removeCheckpointSandbox(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
