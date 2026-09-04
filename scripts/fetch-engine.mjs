#!/usr/bin/env node
/**
 * Fetch + verify the pinned engine binaries into resources/engine/<platform>/{claude,codex}.
 *
 * The binaries are NOT committed (gitignored, ~200 MB claude + ~95 MB codex). This runs before packaging
 * (`npm run dist`) and on demand for dev. Idempotent: an already-present binary whose SHA-256 matches the
 * pin is left alone. Both engines ship bundled + pinned so a Koda release carries known-good versions of
 * each (see architecture/engine-updates.md); the daily engine-contract workflow gates stable bumps.
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
// Normally pinned to the npm `stable` dist-tag (not `latest`) — our posture favors stable over
// bleeding-edge. 2.1.258 is a deliberate exception: it's `latest` (stable was 2.1.236 at pin time)
// because day-one support for Fable 5.1, the new default Fable model, lands only in 2.1.257+, and
// 2.1.258 also carries the fix for 2.1.255's macOS launch regression. Verified through the full
// engine-contract gate before pinning (2026-09-02). Re-converge on `stable` at the next bump. The
// engine-contract workflow verifies, writes, and merges only a strictly newer compatible stable pin.
// NOTE: check-engine-floor.mjs + the workflow read `PINNED_VERSION` by regex — keep the name.
const PINNED_VERSION = '2.1.258'
const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases'

// ── Codex ──────────────────────────────────────────────────────────────────────────────────────────
// Latest GitHub-releases `stable` (non-prerelease) at pin time. The codex-contract job updates BOTH the
// version and the per-platform tarball SHA only after its real app-server contract and repository gate.
const PINNED_CODEX_VERSION = '0.153.1'
const CODEX_BASE = 'https://github.com/openai/codex/releases/download'
// koda platform → codex release triple.
const CODEX_TRIPLE = { 'darwin-arm64': 'aarch64-apple-darwin' }
// SHA-256 of the plain `codex-<triple>.tar.gz` asset, per koda platform. Self-pinned (OpenAI publishes no
// checksum for the plain binary). Recompute when bumping PINNED_CODEX_VERSION.
const CODEX_TARBALL_SHA256 = {
  'darwin-arm64': '818f3c65c6973ae54586ba52f8e37c7673f3f5b8e09c74858c19e25c74479226',
}
// SHA-256 of the sibling `codex-code-mode-host-<triple>.tar.gz` asset from the SAME release. Every
// GPT-5.6 model and GPT-6 Astra run `tool_mode: code_mode_only`, and the CLI spawns this helper from
// the directory the `codex` binary lives in; without it Code Mode "fails closed" and those models
// have no working shell or file tools (Koda's own dev logs showed the spawn failure from 2026-08-26).
// Homebrew and npm install both binaries side by side; this reproduces that layout.
const CODEX_HOST_TARBALL_SHA256 = {
  'darwin-arm64': '4a87aa89a198976ebc68a85017b36234edd1b126dfb63d94c10a20fcfab81479',
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

/** The two Codex release assets that make one working install: the CLI and the code-mode helper it
 *  spawns beside itself. Both come from the same `rust-v<version>` release and land as siblings. */
const CODEX_ASSETS = [
  { name: 'codex', checksums: CODEX_TARBALL_SHA256 },
  { name: 'codex-code-mode-host', checksums: CODEX_HOST_TARBALL_SHA256 },
]

async function fetchCodex(platform) {
  const triple = CODEX_TRIPLE[platform]
  if (!triple) throw new Error(`no codex triple configured for ${platform}`)
  const dests = CODEX_ASSETS.map((asset) => join(outRoot, platform, asset.name))

  // The extracted binaries can't be re-verified against the tarball SHAs, so a version marker records
  // what's on disk; matching marker + both binaries present ⇒ skip the ~115 MB download.
  const marker = join(outRoot, platform, '.codex-version')
  if (
    dests.every((dest) => existsSync(dest)) &&
    existsSync(marker) &&
    (await readFile(marker, 'utf8')).trim() === PINNED_CODEX_VERSION
  ) {
    console.log(`✓ ${platform} codex already present (${PINNED_CODEX_VERSION})`)
    return
  }

  for (const asset of CODEX_ASSETS) await fetchCodexAsset(platform, triple, asset)
  await writeFile(marker, `${PINNED_CODEX_VERSION}\n`)
}

async function fetchCodexAsset(platform, triple, { name, checksums }) {
  const expected = checksums[platform]
  if (!expected) throw new Error(`no ${name} checksum configured for ${platform}`)
  const dest = join(outRoot, platform, name)

  console.log(`↓ ${platform} ${name} ${PINNED_CODEX_VERSION}…`)
  const res = await fetch(`${CODEX_BASE}/rust-v${PINNED_CODEX_VERSION}/${name}-${triple}.tar.gz`)
  if (!res.ok) throw new Error(`${name} download failed for ${platform}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

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

for (const platform of PLATFORMS) {
  await fetchClaude(platform)
  await fetchCodex(platform)
}

// Loud failure before packaging: every target platform must have both engines, and Codex's helper, on disk.
const missing = []
for (const p of PLATFORMS) {
  for (const name of ['claude', ...CODEX_ASSETS.map((asset) => asset.name)]) {
    if (!existsSync(join(outRoot, p, name))) missing.push(`${p}/${name}`)
  }
}
if (missing.length) throw new Error(`engine missing after fetch: ${missing.join(', ')}`)
console.log(`engine fetch complete (claude ${PINNED_VERSION}, codex ${PINNED_CODEX_VERSION}).`)
