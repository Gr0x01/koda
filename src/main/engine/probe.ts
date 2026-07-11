import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveEnginePath, type EngineLocation } from './binary'
import { buildEngineEnv } from './env'

const execFileP = promisify(execFile)

export interface EngineProbe {
  version: string
  path: string
  source: EngineLocation['source']
}

/**
 * Prove the engine binary executes from inside our clean env. Spawns `claude --version`
 * (over plain pipes, via the buildEngineEnv chokepoint) — the minimal end-to-end check
 * that bundling + env wiring work before the adapter drives a real stream-json session.
 */
export async function probeEngine(resourcesPath?: string): Promise<EngineProbe> {
  const loc = resolveEnginePath({ resourcesPath })
  const env = buildEngineEnv(process.env)
  const { stdout } = await execFileP(loc.path, ['--version'], { env, timeout: 15_000 })
  // "2.1.185 (Claude Code)" → "2.1.185"; a broken binary must read as failure, not blank.
  const match = stdout.trim().match(/^\d+\.\d+\.\d+\S*/)
  if (!match) throw new Error(`unexpected engine --version output: ${JSON.stringify(stdout.trim())}`)
  return { version: match[0], path: loc.path, source: loc.source }
}
