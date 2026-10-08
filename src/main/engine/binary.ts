import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { userPath } from './user-path'

/** Platform folder name — matches the releases bucket naming (e.g. "darwin-arm64"). */
export const ENGINE_PLATFORM = `${process.platform}-${process.arch}`

export interface EngineLocation {
  path: string
  /**
   * "live" = the newest upstream build Koda downloaded itself (live-engines.ts); "bundled" = the copy
   * shipped inside the app; "dev-fallback" = the user's installed CLI.
   */
  source: 'live' | 'bundled' | 'dev-fallback'
}

let liveEngineRoot: string | null = null

/**
 * Where downloaded engines live (`<root>/<name>/<version>/<name>`, selected by `<root>/<name>/current`).
 * Module state rather than a resolveEnginePath option because every engine spawn in main resolves
 * through this file: one setter at boot reaches all of them, where an option would have to be threaded
 * through each caller and the one that forgot it would silently keep running the bundled copy.
 */
export function setLiveEngineRoot(root: string | null): void {
  liveEngineRoot = root
}

export function liveEngineVersion(root: string, name: string): string | null {
  try {
    const version = readFileSync(join(root, name, 'current'), 'utf8').trim()
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null
  } catch {
    return null
  }
}

export function liveEnginePath(root: string, name: string, version: string): string {
  return join(root, name, version, name)
}

/**
 * Resolve an engine binary: the downloaded live copy first, then the bundled copy, then the user's
 * installed CLI in dev (so HMR doesn't require the ~206 MB fetch).
 *
 * @param opts.resourcesPath  process.resourcesPath in the packaged app (omit in tests/dev).
 * @param opts.binaryName     which engine to resolve ('claude' | 'codex'); defaults to 'claude'.
 */
export function resolveEnginePath(
  opts: { resourcesPath?: string; binaryName?: string } = {},
): EngineLocation {
  const name = opts.binaryName ?? 'claude'

  // 0. Live: the newest upstream build, downloaded outside the app bundle. A `current` marker that
  //    names a missing version falls through to the bundled copy instead of failing the spawn.
  if (liveEngineRoot) {
    const version = liveEngineVersion(liveEngineRoot, name)
    if (version) {
      const path = liveEnginePath(liveEngineRoot, name, version)
      if (existsSync(path)) return { path, source: 'live' }
    }
  }

  const candidates: string[] = []

  // 1. Packaged: <Resources>/engine/<platform>/<name> (electron-builder extraResources).
  if (opts.resourcesPath) {
    candidates.push(join(opts.resourcesPath, 'engine', ENGINE_PLATFORM, name))
  }
  // 2. Dev: the fetched copy in the repo (npm run fetch-engine).
  candidates.push(join(process.cwd(), 'resources', 'engine', ENGINE_PLATFORM, name))

  for (const path of candidates) {
    if (existsSync(path)) return { path, source: 'bundled' }
  }

  // 3. Dev fallback: the user's installed CLI. Claude's installer drops it in ~/.local/bin; for
  //    other engines (Homebrew `codex` in /opt/homebrew/bin) scan the login-shell PATH so a dev
  //    machine resolves whichever copy is installed without a hardcoded location per engine.
  const userBin = join(homedir(), '.local', 'bin', name)
  if (existsSync(userBin)) return { path: userBin, source: 'dev-fallback' }
  for (const dir of userPath().split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    if (existsSync(p)) return { path: p, source: 'dev-fallback' }
  }

  throw new Error(
    `No ${name} engine found for ${ENGINE_PLATFORM}. Run \`npm run fetch-engine\`, or install the CLI for dev.`,
  )
}
