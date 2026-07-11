#!/usr/bin/env node
/**
 * Download + extract a SPECIFIC `codex` engine version into an output dir, for the codex-contract CI job
 * (which then drives it through the codex smoke test before we re-bundle). Mirrors fetch-engine.mjs's
 * codex path, but takes version/triple/out as args — CI runs on linux-x64 (musl static build).
 *
 * OpenAI publishes no checksum for the plain CLI tarball, so `--sha` is optional: when given it's verified,
 * otherwise the tarball's computed SHA-256 is printed (the bump workflow records it into fetch-engine.mjs).
 *
 *   node scripts/fetch-candidate-codex.mjs --version 0.144.1 [--triple x86_64-unknown-linux-musl] [--out /tmp/candidate-codex] [--sha <hex>]
 *
 * Prints the absolute binary path to stdout on success (last line); exits non-zero on any failure.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, chmod, rename, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const BASE = 'https://github.com/openai/codex/releases/download'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const version = arg('version')
const triple = arg('triple', 'x86_64-unknown-linux-musl')
const out = resolve(arg('out', '/tmp/candidate-codex'))
const expectedSha = arg('sha')
if (!version) {
  console.error('usage: fetch-candidate-codex.mjs --version <X> [--triple <t>] [--out <dir>] [--sha <hex>]')
  process.exit(2)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const dest = join(out, 'codex')

const res = await fetch(`${BASE}/rust-v${version}/codex-${triple}.tar.gz`)
if (!res.ok) throw new Error(`codex download failed for ${triple} ${version}: HTTP ${res.status}`)
const buf = Buffer.from(await res.arrayBuffer())
const actual = sha256(buf)
if (expectedSha && actual !== expectedSha) {
  throw new Error(`codex checksum mismatch: expected ${expectedSha}, got ${actual}`)
}

await mkdir(out, { recursive: true })
const tarPath = `${dest}.tar.gz`
const stage = join(out, '.stage')
await writeFile(tarPath, buf)
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await execFileP('tar', ['-xzf', tarPath, '-C', stage])
const entries = await readdir(stage)
if (entries.length !== 1) throw new Error(`unexpected codex tarball layout: ${entries.join(', ')}`)
await rename(join(stage, entries[0]), dest)
await chmod(dest, 0o755)
await rm(tarPath, { force: true })
await rm(stage, { recursive: true, force: true })

console.error(`codex ${version} (${triple}) sha256=${actual}`)
console.log(dest)
