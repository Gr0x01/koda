/**
 * Live engines: Koda downloads the newest upstream Claude and Codex builds itself and runs them in
 * place of the copy bundled in the app, so a new engine reaches the user without a Koda release.
 *
 * RB's decision, 2026-10-04: follow upstream `latest` with no Koda-side approval step. A bad upstream
 * release breaks sessions until upstream ships the next one; launching with KODA_LIVE_ENGINES=0 and
 * deleting the engine's `current` marker falls back to the bundled copy in the meantime.
 *
 * Why this is safe where engine self-update was not (engine-updates.md):
 *   - The binaries live under userData, never inside the signed app bundle, so the app's signature and
 *     notarization are untouched.
 *   - Each version gets its own directory and `current` is switched by rename. A running session keeps
 *     the file it spawned; only the next spawn sees the new version. Codex resolves its code-mode
 *     helper beside its own binary at run time, so superseded versions are never deleted while the
 *     app runs: they are pruned once at the next launch, before any session exists.
 *   - Nothing is selected until its SHA-256 matches the publisher's own checksum and it has answered
 *     `--version` with the expected number. Any failure leaves the previous engine in place.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readdirSync, rmSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { ENGINE_PLATFORM, liveEnginePath, liveEngineVersion, setLiveEngineRoot } from './binary'
import { buildEngineEnv } from './env'

const execFileP = promisify(execFile)

const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases'
const CODEX_LATEST = 'https://api.github.com/repos/openai/codex/releases/latest'
/** koda platform → codex release triple. A platform missing here keeps its bundled Codex. */
const CODEX_TRIPLE: Record<string, string> = { 'darwin-arm64': 'aarch64-apple-darwin' }
/** The CLI and the code-mode helper it spawns from its own directory; they ship as one release. */
const CODEX_ASSETS = ['codex', 'codex-code-mode-host'] as const

const VERSION_RE = /^\d+\.\d+\.\d+$/
const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export type LiveEngineName = 'claude' | 'codex'
type Fetch = typeof fetch
type Logger = (level: 'info' | 'warn', msg: string, data?: unknown) => void

interface EngineRelease {
  version: string
  /** Files to download; `extract` marks a tarball holding the single binary `name`. */
  files: { name: string; url: string; sha256: string; extract: boolean }[]
}

async function fetchOk(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<Response> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res
}

async function latestClaude(fetchImpl: Fetch, platform: string): Promise<EngineRelease> {
  const version = (await (await fetchOk(fetchImpl, `${CLAUDE_BASE}/latest`)).text()).trim()
  if (!VERSION_RE.test(version)) throw new Error(`unexpected claude version: ${JSON.stringify(version)}`)
  const manifest = (await (await fetchOk(fetchImpl, `${CLAUDE_BASE}/${version}/manifest.json`)).json()) as {
    platforms?: Record<string, { checksum?: string }>
  }
  const sha256 = manifest.platforms?.[platform]?.checksum
  if (!sha256) throw new Error(`no claude checksum for ${platform} in ${version}`)
  return {
    version,
    files: [{ name: 'claude', url: `${CLAUDE_BASE}/${version}/${platform}/claude`, sha256, extract: false }],
  }
}

async function latestCodex(fetchImpl: Fetch, platform: string): Promise<EngineRelease | null> {
  const triple = CODEX_TRIPLE[platform]
  if (!triple) return null
  const release = (await (
    await fetchOk(fetchImpl, CODEX_LATEST, { headers: { accept: 'application/vnd.github+json' } })
  ).json()) as {
    tag_name?: string
    assets?: { name: string; browser_download_url: string; digest?: string | null }[]
  }
  const version = release.tag_name?.replace(/^rust-v/, '') ?? ''
  if (!VERSION_RE.test(version)) throw new Error(`unexpected codex tag: ${JSON.stringify(release.tag_name)}`)
  const files = CODEX_ASSETS.map((name) => {
    const asset = release.assets?.find((a) => a.name === `${name}-${triple}.tar.gz`)
    // GitHub records each asset's digest at upload. Without one there is nothing to verify the
    // download against, so the bundled Codex stays rather than running an unchecked binary.
    const sha256 = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1]
    if (!asset || !sha256) throw new Error(`codex ${version} has no verifiable ${name} asset for ${triple}`)
    return { name, url: asset.browser_download_url, sha256, extract: true }
  })
  return { version, files }
}

/** Each engine's publisher has its own release index and checksum scheme; this is the one table of them. */
const UPSTREAM: Record<LiveEngineName, (fetchImpl: Fetch, platform: string) => Promise<EngineRelease | null>> = {
  claude: latestClaude,
  codex: latestCodex,
}

/** Stream to disk while hashing: the Claude binary is ~200 MB, too large to hold in main's heap. */
async function downloadVerified(fetchImpl: Fetch, url: string, dest: string, sha256: string): Promise<void> {
  const res = await fetchOk(fetchImpl, url)
  if (!res.body) throw new Error(`empty body for ${url}`)
  const hash = createHash('sha256')
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(body, createWriteStream(dest))
  const actual = hash.digest('hex')
  if (actual !== sha256) throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${actual}`)
}

async function installRelease(
  fetchImpl: Fetch,
  root: string,
  name: LiveEngineName,
  release: EngineRelease,
): Promise<void> {
  const engineDir = join(root, name)
  const finalDir = join(engineDir, release.version)
  const stage = join(engineDir, `.partial-${release.version}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  try {
    for (const file of release.files) {
      const dest = join(stage, file.name)
      if (file.extract) {
        const tarPath = `${dest}.tar.gz`
        const unpacked = join(stage, `.unpack-${file.name}`)
        await downloadVerified(fetchImpl, file.url, tarPath, file.sha256)
        await mkdir(unpacked)
        await execFileP('tar', ['-xzf', tarPath, '-C', unpacked])
        const entries = await readdir(unpacked)
        if (entries.length !== 1) throw new Error(`unexpected ${file.name} tarball layout: ${entries.join(', ')}`)
        await rename(join(unpacked, entries[0]!), dest)
        await rm(tarPath)
        await rm(unpacked, { recursive: true })
      } else {
        await downloadVerified(fetchImpl, file.url, dest, file.sha256)
      }
      await chmod(dest, 0o755)
    }

    // A verified download can still be unrunnable here (wrong arch, a signature macOS refuses). Prove
    // it executes before any session is pointed at it.
    const { stdout } = await execFileP(join(stage, name), ['--version'], {
      env: buildEngineEnv(process.env, { engineId: name }),
      timeout: 30_000,
    })
    if (!stdout.includes(release.version)) {
      throw new Error(`${name} ${release.version} reported ${JSON.stringify(stdout.trim())}`)
    }

    await rm(finalDir, { recursive: true, force: true })
    await rename(stage, finalDir)
  } catch (err) {
    await rm(stage, { recursive: true, force: true })
    throw err
  }

  const marker = join(engineDir, 'current')
  await writeFile(`${marker}.tmp`, `${release.version}\n`)
  await rename(`${marker}.tmp`, marker)
}

/**
 * Delete every downloaded version except the selected one. Only safe before the first session spawns:
 * the single-instance lock means no other process can be running out of these directories then.
 */
export function pruneLiveEngines(root: string): void {
  for (const name of Object.keys(UPSTREAM)) {
    const engineDir = join(root, name)
    const keep = liveEngineVersion(root, name)
    let entries: string[]
    try {
      entries = readdirSync(engineDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry === 'current' || entry === keep) continue
      rmSync(join(engineDir, entry), { recursive: true, force: true })
    }
  }
}

/**
 * Bring one engine to upstream `latest`. Returns the version installed, or null when already current
 * (or the platform has no live build). Throws on any fetch, checksum, or run failure, having changed
 * nothing a session can see.
 */
export async function updateLiveEngine(
  root: string,
  name: LiveEngineName,
  opts: { fetchImpl?: Fetch; platform?: string } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const platform = opts.platform ?? ENGINE_PLATFORM
  const release = await UPSTREAM[name](fetchImpl, platform)
  if (!release) return null
  const current = liveEngineVersion(root, name)
  if (current === release.version && existsSync(liveEnginePath(root, name, current))) return null
  await installRelease(fetchImpl, root, name, release)
  return release.version
}

/**
 * Point engine resolution at `root`, then check upstream shortly after launch and every few hours.
 * `enabled: false` (tests, hermetic E2E) still registers the root so an already-downloaded engine
 * resolves, but never touches the network. The timers are unref'd, so they never hold the app open.
 */
export function startLiveEngineUpdates(opts: { root: string; enabled: boolean; log: Logger }): void {
  setLiveEngineRoot(opts.root)
  if (!opts.enabled) return
  pruneLiveEngines(opts.root)

  let running = false
  const check = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (const name of ['claude', 'codex'] as const) {
        try {
          const installed = await updateLiveEngine(opts.root, name)
          if (installed) opts.log('info', `${name} ${installed} downloaded; new sessions use it`)
        } catch (err) {
          opts.log('warn', `${name} update failed; keeping the current engine`, err instanceof Error ? err.message : err)
        }
      }
    } finally {
      running = false
    }
  }

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS).unref()
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref()
}
