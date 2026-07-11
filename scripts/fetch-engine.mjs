#!/usr/bin/env node
/**
 * Fetch + verify the pinned engine binaries into resources/engine/<platform>/{claude,codex}.
 *
 * The binaries are NOT committed (gitignored, ~200 MB claude + ~95 MB codex). This runs before packaging
 * (`npm run dist`) and on demand for dev. Idempotent: an already-present binary whose SHA-256 matches the
 * pin is left alone. Both engines ship bundled + pinned so a Koda release carries known-good versions of
 * each (see architecture/engine-updates.md); the weekly engine-contract workflow proposes bumps.
 *
 * Claude — the scheme the official install.sh uses (Anthropic publishes a per-platform checksum manifest):
 *   <CLAUDE_BASE>/<version>/manifest.json      → { platforms: { "<platform>": { checksum, size } } }
 *   <CLAUDE_BASE>/<version>/<platform>/claude   → the executable
 *
 * Codex — GitHub releases (openai/codex, tag `rust-v<version>`). OpenAI publishes checksums only for the
 * `-package-` tarballs, NOT the plain self-contained CLI binary Koda bundles, so we pin the tarball's
 * SHA-256 ourselves (captured when the version is chosen — a lockfile, verified on every fetch):
 *   <CODEX_BASE>/rust-v<version>/codex-<triple>.tar.gz  → tar of a single self-contained `codex` binary
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod, readFile, rename, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ── Claude ─────────────────────────────────────────────────────────────────────────────────────────
// Pinned to the npm `stable` dist-tag (not `latest`) — our posture favors stable over bleeding-edge.
// 2.1.197 brings Sonnet 5 + native 1M context while staying BEFORE background-subagents-by-default
// (2.1.198) and the permission-default→Manual flip (2.1.200), both of which touch seams Koda renders.
// Bump deliberately (the engine-contract workflow opens the PR). NOTE: check-engine-floor.mjs + the
// workflow read `PINNED_VERSION` by regex — keep the name.
const PINNED_VERSION = '2.1.197'
const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases'

// ── Codex ──────────────────────────────────────────────────────────────────────────────────────────
// Latest GitHub-releases `stable` (non-prerelease) at pin time. Bump deliberately (the codex-contract
// workflow opens the PR, updating BOTH the version and the per-platform tarball SHA below).
const PINNED_CODEX_VERSION = '0.144.1'
const CODEX_BASE = 'https://github.com/openai/codex/releases/download'
// koda platform → codex release triple.
const CODEX_TRIPLE = { 'darwin-arm64': 'aarch64-apple-darwin' }
// SHA-256 of the plain `codex-<triple>.tar.gz` asset, per koda platform. Self-pinned (OpenAI publishes no
// checksum for the plain binary). Recompute when bumping PINNED_CODEX_VERSION.
const CODEX_TARBALL_SHA256 = {
  'darwin-arm64': '88e72ac8bd30815f7d18e62dac333dc20ce3ad1cba94be1649a1977dd9bfdbb8',
}

const PLATFORMS = ['darwin-arm64']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(root, 'resources', 'engine')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchClaude(platform) {
  const dest = join(outRoot, platform, 'claude')

  const manifestRes = await fetch(`${CLAUDE_BASE}/${PINNED_VERSION}/manifest.json`)
  if (!manifestRes.ok) throw new Error(`claude manifest fetch failed: HTTP ${manifestRes.status}`)
  const manifest = await manifestRes.json()
  const entry = manifest.platforms?.[platform]
  if (!entry?.checksum) throw new Error(`no checksum for ${platform} in ${PINNED_VERSION} manifest`)

  if (existsSync(dest) && (await sha256(await readFile(dest))) === entry.checksum) {
    console.log(`✓ ${platform} claude already present + verified (${PINNED_VERSION})`)
    return
  }

  console.log(`↓ ${platform} claude ${PINNED_VERSION} (${(entry.size / 1e6).toFixed(0)} MB)…`)
  const res = await fetch(`${CLAUDE_BASE}/${PINNED_VERSION}/${platform}/claude`)
  if (!res.ok) throw new Error(`claude download failed for ${platform}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

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
}

async function fetchCodex(platform) {
  const triple = CODEX_TRIPLE[platform]
  const expected = CODEX_TARBALL_SHA256[platform]
  if (!triple || !expected) throw new Error(`no codex triple/checksum configured for ${platform}`)
  const dest = join(outRoot, platform, 'codex')

  // The extracted binary can't be re-verified against the tarball SHA, so a version marker records what's
  // on disk; matching marker + present binary ⇒ skip the ~95 MB download.
  const marker = join(outRoot, platform, '.codex-version')
  if (existsSync(dest) && existsSync(marker) && (await readFile(marker, 'utf8')).trim() === PINNED_CODEX_VERSION) {
    console.log(`✓ ${platform} codex already present (${PINNED_CODEX_VERSION})`)
    return
  }

  console.log(`↓ ${platform} codex ${PINNED_CODEX_VERSION}…`)
  const res = await fetch(`${CODEX_BASE}/rust-v${PINNED_CODEX_VERSION}/codex-${triple}.tar.gz`)
  if (!res.ok) throw new Error(`codex download failed for ${platform}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const actual = sha256(buf)
  if (actual !== expected) {
    throw new Error(`codex checksum mismatch for ${platform}: expected ${expected}, got ${actual}`)
  }

  // Extract the single self-contained binary (`codex-<triple>`) from the tarball → dest.
  await mkdir(dirname(dest), { recursive: true })
  const tarPath = `${dest}.tar.gz`
  const stage = join(outRoot, platform, '.codex-stage')
  await writeFile(tarPath, buf)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  await execFileP('tar', ['-xzf', tarPath, '-C', stage])
  const entries = await readdir(stage)
  if (entries.length !== 1) throw new Error(`unexpected codex tarball layout for ${platform}: ${entries.join(', ')}`)
  const tmp = `${dest}.tmp`
  await rename(join(stage, entries[0]), tmp)
  await chmod(tmp, 0o755)
  await rename(tmp, dest)
  await writeFile(marker, `${PINNED_CODEX_VERSION}\n`)
  await rm(tarPath, { force: true })
  await rm(stage, { recursive: true, force: true })
  console.log(`✓ ${platform} codex verified + written → ${dest}`)
}

for (const platform of PLATFORMS) {
  await fetchClaude(platform)
  await fetchCodex(platform)
}

// Loud failure before packaging: every target platform must have both engines on disk.
const missing = []
for (const p of PLATFORMS) {
  for (const name of ['claude', 'codex']) {
    if (!existsSync(join(outRoot, p, name))) missing.push(`${p}/${name}`)
  }
}
if (missing.length) throw new Error(`engine missing after fetch: ${missing.join(', ')}`)
console.log(`engine fetch complete (claude ${PINNED_VERSION}, codex ${PINNED_CODEX_VERSION}).`)
