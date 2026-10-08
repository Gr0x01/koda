#!/usr/bin/env node
/**
 * Fetch + verify the newest upstream engine binaries into resources/engine/<platform>/{claude,codex}.
 *
 * The binaries are NOT committed (gitignored, ~200 MB claude + ~95 MB codex). This runs before packaging
 * (`npm run dist`) and on demand for dev. There is no pinned version (RB, 2026-10-07): the app follows
 * upstream `latest` at runtime (src/main/engine/live-engines.ts), so the bundled copy is only what a
 * fresh install runs until its first download, and it is whatever is newest when the build is made.
 * Both engines resolve and verify the same way the runtime does.
 *
 * Claude — the scheme the official install.sh uses (Anthropic publishes a per-platform checksum manifest):
 *   <CLAUDE_BASE>/latest                        → the version string
 *   <CLAUDE_BASE>/<version>/manifest.json      → { platforms: { "<platform>": { checksum, size } } }
 *   <CLAUDE_BASE>/<version>/<platform>/claude   → the executable
 *
 * Codex — the GitHub `releases/latest` of openai/codex (newest non-prerelease `rust-v<version>`). Each
 * asset carries the SHA-256 digest GitHub recorded at upload, which is what the tarball is checked against:
 *   codex-<triple>.tar.gz, codex-code-mode-host-<triple>.tar.gz → tar of one self-contained binary each
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod, readFile, rename, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases'
const CODEX_LATEST = 'https://api.github.com/repos/openai/codex/releases/latest'
// koda platform → codex release triple.
const CODEX_TRIPLE = { 'darwin-arm64': 'aarch64-apple-darwin' }
// The CLI and the code-mode helper it spawns from its own directory. Every GPT-5.6 model and GPT-6
// Astra run `tool_mode: code_mode_only`; without the helper beside the binary Code Mode fails closed
// and those models have no working shell or file tools.
const CODEX_ASSETS = ['codex', 'codex-code-mode-host']

const PLATFORMS = ['darwin-arm64']
const VERSION_RE = /^\d+\.\d+\.\d+$/

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(root, 'resources', 'engine')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchOk(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res
}

async function fetchClaude(platform) {
  const dest = join(outRoot, platform, 'claude')

  const version = (await (await fetchOk(`${CLAUDE_BASE}/latest`)).text()).trim()
  if (!VERSION_RE.test(version)) throw new Error(`unexpected claude version: ${JSON.stringify(version)}`)
  const manifest = await (await fetchOk(`${CLAUDE_BASE}/${version}/manifest.json`)).json()
  const entry = manifest.platforms?.[platform]
  if (!entry?.checksum) throw new Error(`no checksum for ${platform} in ${version} manifest`)

  if (existsSync(dest) && sha256(await readFile(dest)) === entry.checksum) {
    console.log(`✓ ${platform} claude already present + verified (${version})`)
    return version
  }

  console.log(`↓ ${platform} claude ${version} (${(entry.size / 1e6).toFixed(0)} MB)…`)
  const buf = Buffer.from(await (await fetchOk(`${CLAUDE_BASE}/${version}/${platform}/claude`)).arrayBuffer())

  const actual = sha256(buf)
  if (actual !== entry.checksum) {
    throw new Error(`claude checksum mismatch for ${platform}: expected ${entry.checksum}, got ${actual}`)
  }

  // Write to a temp path then rename, so the final path never appears truncated.
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  await writeFile(tmp, buf)
  await chmod(tmp, 0o755)
  await rename(tmp, dest)
  console.log(`✓ ${platform} claude verified + written → ${dest}`)
  return version
}

async function fetchCodex(platform) {
  const triple = CODEX_TRIPLE[platform]
  if (!triple) throw new Error(`no codex triple configured for ${platform}`)

  // GITHUB_TOKEN only lifts the anonymous API rate limit on shared CI addresses; it is never required.
  const headers = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const release = await (await fetchOk(CODEX_LATEST, { headers })).json()
  const version = release.tag_name?.replace(/^rust-v/, '') ?? ''
  if (!VERSION_RE.test(version)) throw new Error(`unexpected codex tag: ${JSON.stringify(release.tag_name)}`)

  // The extracted binaries can't be re-verified against the tarball digests, so a version marker records
  // what's on disk; matching marker + both binaries present ⇒ skip the ~115 MB download.
  const marker = join(outRoot, platform, '.codex-version')
  if (
    CODEX_ASSETS.every((name) => existsSync(join(outRoot, platform, name))) &&
    existsSync(marker) &&
    (await readFile(marker, 'utf8')).trim() === version
  ) {
    console.log(`✓ ${platform} codex already present (${version})`)
    return version
  }

  for (const name of CODEX_ASSETS) {
    const asset = release.assets?.find((a) => a.name === `${name}-${triple}.tar.gz`)
    // Without a recorded digest there is nothing to verify the download against, so the build stops
    // rather than bundling an unchecked binary.
    const expected = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1]
    if (!asset || !expected) throw new Error(`codex ${version} has no verifiable ${name} asset for ${triple}`)
    await fetchCodexAsset(platform, version, name, asset.browser_download_url, expected)
  }
  await writeFile(marker, `${version}\n`)
  return version
}

async function fetchCodexAsset(platform, version, name, url, expected) {
  const dest = join(outRoot, platform, name)

  console.log(`↓ ${platform} ${name} ${version}…`)
  const buf = Buffer.from(await (await fetchOk(url)).arrayBuffer())

  const actual = sha256(buf)
  if (actual !== expected) {
    throw new Error(`${name} checksum mismatch for ${platform}: expected ${expected}, got ${actual}`)
  }

  // Extract the single self-contained binary (`<name>-<triple>`) from the tarball → dest.
  await mkdir(dirname(dest), { recursive: true })
  const tarPath = `${dest}.tar.gz`
  const stage = join(outRoot, platform, `.${name}-stage`)
  await writeFile(tarPath, buf)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  await execFileP('tar', ['-xzf', tarPath, '-C', stage])
  const entries = await readdir(stage)
  if (entries.length !== 1) throw new Error(`unexpected ${name} tarball layout for ${platform}: ${entries.join(', ')}`)
  const tmp = `${dest}.tmp`
  await rename(join(stage, entries[0]), tmp)
  await chmod(tmp, 0o755)
  await rename(tmp, dest)
  await rm(tarPath, { force: true })
  await rm(stage, { recursive: true, force: true })
  console.log(`✓ ${platform} ${name} verified + written → ${dest}`)
}

const fetched = []
for (const platform of PLATFORMS) {
  fetched.push(`claude ${await fetchClaude(platform)}`, `codex ${await fetchCodex(platform)}`)
}

// Loud failure before packaging: every target platform must have both engines, and Codex's helper, on disk.
const missing = []
for (const p of PLATFORMS) {
  for (const name of ['claude', ...CODEX_ASSETS]) {
    if (!existsSync(join(outRoot, p, name))) missing.push(`${p}/${name}`)
  }
}
if (missing.length) throw new Error(`engine missing after fetch: ${missing.join(', ')}`)
console.log(`engine fetch complete (${[...new Set(fetched)].join(', ')}).`)
