#!/usr/bin/env node
/**
 * Download + SHA-256-verify a SPECIFIC `claude` engine version/platform into an output dir, for the
 * engine-contract CI job (which then drives it through the smoke test before we re-bundle). Mirrors
 * fetch-engine.mjs's URL scheme + verify, but takes version/platform/out as args instead of the pinned
 * mac defaults — CI runs on linux-x64.
 *
 *   node scripts/fetch-candidate-engine.mjs --version 2.1.202 --platform linux-x64 --out /tmp/candidate
 *
 * Prints the absolute binary path to stdout on success; exits non-zero on any fetch/verify failure.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod, readFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const BASE = 'https://downloads.claude.ai/claude-code-releases'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const version = arg('version')
const platform = arg('platform', 'linux-x64')
const out = resolve(arg('out', '/tmp/candidate'))
if (!version) {
  console.error('usage: fetch-candidate-engine.mjs --version <X> [--platform linux-x64] [--out <dir>]')
  process.exit(2)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const dest = join(out, 'claude')

const manifestRes = await fetch(`${BASE}/${version}/manifest.json`)
if (!manifestRes.ok) throw new Error(`manifest fetch failed for ${version}: HTTP ${manifestRes.status}`)
const manifest = await manifestRes.json()
const entry = manifest.platforms?.[platform]
if (!entry?.checksum) throw new Error(`no checksum for ${platform} in ${version} manifest`)

if (existsSync(dest) && (await sha256(await readFile(dest))) === entry.checksum) {
  console.log(dest)
  process.exit(0)
}

const res = await fetch(`${BASE}/${version}/${platform}/claude`)
if (!res.ok) throw new Error(`download failed for ${platform} ${version}: HTTP ${res.status}`)
const buf = Buffer.from(await res.arrayBuffer())
const actual = sha256(buf)
if (actual !== entry.checksum) throw new Error(`checksum mismatch: expected ${entry.checksum}, got ${actual}`)

await mkdir(dirname(dest), { recursive: true })
const tmp = `${dest}.tmp`
await writeFile(tmp, buf)
await chmod(tmp, 0o755)
await rename(tmp, dest)
console.log(dest)
