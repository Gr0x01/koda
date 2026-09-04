#!/usr/bin/env node
/**
 * Apply the only repository edits an automated engine bump may make.
 *
 * Keeping this as one small, tested writer lets the scheduled workflow auto-merge a compatible
 * upstream engine without giving a shell script license to edit arbitrary files. The workflow still
 * verifies the resulting Git diff before it creates and merges the bot PR.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
const SHA256_RE = /^[a-f0-9]{64}$/

export function compareStableVersions(left, right) {
  if (!VERSION_RE.test(left) || !VERSION_RE.test(right)) throw new Error('engine versions must be stable semver')
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

function validateInputs(engine, version, darwinSha, darwinHostSha) {
  if (engine !== 'claude' && engine !== 'codex') throw new Error('engine must be claude or codex')
  if (!VERSION_RE.test(version)) throw new Error(`invalid stable engine version: ${version}`)
  if (engine === 'claude' && (darwinSha !== undefined || darwinHostSha !== undefined)) {
    throw new Error('Claude bumps do not accept a tarball SHA')
  }
  // The CLI and its code-mode helper ship as two assets of one release; a bump that pins only one
  // would fetch a helper from a different version than the CLI that spawns it.
  if (engine === 'codex' && !(SHA256_RE.test(darwinSha ?? '') && SHA256_RE.test(darwinHostSha ?? ''))) {
    throw new Error('Codex bumps require a 64-character lowercase SHA-256 for both the CLI and the code-mode host')
  }
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
  if (matches?.length !== 1) throw new Error(`expected exactly one ${label}; found ${matches?.length ?? 0}`)
  return source.replace(pattern, replacement)
}

export function updateUnreleasedEngineLine(changelog, engine, version) {
  const unreleased = changelog.indexOf('## [Unreleased]')
  if (unreleased === -1) throw new Error('CHANGELOG.md has no [Unreleased] section')
  const nextVersion = changelog.indexOf('\n## [', unreleased + 1)
  const end = nextVersion === -1 ? changelog.length : nextVersion
  const before = changelog.slice(0, end)
  const after = changelog.slice(end)
  const name = engine === 'claude' ? 'Claude' : 'Codex'
  const line = `- Updated the bundled ${name} engine to ${version}.`
  const existing = new RegExp(`^- Updated the bundled ${name} engine to [^\\n]+\\.$`, 'm')
  const existingLines = before.match(new RegExp(existing.source, 'gm')) ?? []

  if (existingLines.length > 1) throw new Error(`Unreleased has more than one ${name} engine line`)
  if (existingLines.length === 1) return before.replace(existing, line) + after

  const changed = before.indexOf('### Changed', unreleased)
  if (changed !== -1) {
    const insertAt = before.indexOf('\n', changed) + 1
    return `${before.slice(0, insertAt)}\n${line}\n${before.slice(insertAt)}${after}`
  }

  const separator = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  return `${before}${separator}### Changed\n\n${line}\n${after}`
}

function updatedEngineSource(source, engine, version, darwinSha, darwinHostSha) {
  const currentPattern = engine === 'claude'
    ? /const PINNED_VERSION = '([^']+)'/
    : /const PINNED_CODEX_VERSION = '([^']+)'/
  const current = source.match(currentPattern)?.[1]
  if (!current) throw new Error(`could not read the current ${engine} pin`)
  if (compareStableVersions(version, current) <= 0) {
    throw new Error(`refusing a non-upgrade ${engine} bump: ${current} -> ${version}`)
  }

  if (engine === 'claude') {
    source = replaceExactlyOnce(
      source,
      /const PINNED_VERSION = '[^']+'/,
      `const PINNED_VERSION = '${version}'`,
      'Claude pin',
    )
  } else {
    source = replaceExactlyOnce(
      source,
      /const PINNED_CODEX_VERSION = '[^']+'/,
      `const PINNED_CODEX_VERSION = '${version}'`,
      'Codex pin',
    )
    // Two sibling assets, two checksum maps; each pattern is anchored to its own map so neither
    // replacement can land in the other.
    source = replaceExactlyOnce(
      source,
      /(const CODEX_TARBALL_SHA256 = \{\n\s*'darwin-arm64': ')[a-f0-9]+(')/,
      `$1${darwinSha}$2`,
      'Codex darwin-arm64 checksum',
    )
    source = replaceExactlyOnce(
      source,
      /(const CODEX_HOST_TARBALL_SHA256 = \{\n\s*'darwin-arm64': ')[a-f0-9]+(')/,
      `$1${darwinHostSha}$2`,
      'Codex code-mode host darwin-arm64 checksum',
    )
  }

  return source
}

export function applyEngineBump({ root = SCRIPT_ROOT, engine, version, darwinSha, darwinHostSha }) {
  validateInputs(engine, version, darwinSha, darwinHostSha)

  const enginePath = join(root, 'scripts', 'fetch-engine.mjs')
  const changelogPath = join(root, 'CHANGELOG.md')
  const source = updatedEngineSource(
    readFileSync(enginePath, 'utf8'),
    engine,
    version,
    darwinSha,
    darwinHostSha,
  )

  const changelog = updateUnreleasedEngineLine(readFileSync(changelogPath, 'utf8'), engine, version)
  writeFileSync(enginePath, source)
  writeFileSync(changelogPath, changelog)
}

export function verifyEngineBumpWorktree({ root = SCRIPT_ROOT, engine, version, darwinSha, darwinHostSha }) {
  validateInputs(engine, version, darwinSha, darwinHostSha)
  const gitOutput = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
    return result.stdout
  }
  const gitNames = (args) => gitOutput(args).trim().split('\n').filter(Boolean)
  const changed = [...new Set([
    ...gitNames(['diff', '--name-only', '--diff-filter=ACMRTUXB']),
    ...gitNames(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB']),
    ...gitNames(['ls-files', '--others', '--exclude-standard']),
  ])].sort()
  const allowed = new Set(['CHANGELOG.md', 'scripts/fetch-engine.mjs'])
  if (changed.length !== allowed.size || changed.some((path) => !allowed.has(path))) {
    throw new Error(`engine bump changed an unexpected file set: ${changed.join(', ') || '(none)'}`)
  }

  // Recreate the complete expected files from HEAD and compare bytes. Restricting file names alone is
  // insufficient because the candidate engine is untrusted code and executes before this verification.
  const enginePath = join(root, 'scripts', 'fetch-engine.mjs')
  const changelogPath = join(root, 'CHANGELOG.md')
  const expectedEngine = updatedEngineSource(
    gitOutput(['show', 'HEAD:scripts/fetch-engine.mjs']),
    engine,
    version,
    darwinSha,
    darwinHostSha,
  )
  if (readFileSync(enginePath, 'utf8') !== expectedEngine) {
    throw new Error('engine file differs from the exact guarded pin update')
  }

  const expectedChangelog = updateUnreleasedEngineLine(
    gitOutput(['show', 'HEAD:CHANGELOG.md']),
    engine,
    version,
  )
  if (readFileSync(changelogPath, 'utf8') !== expectedChangelog) {
    throw new Error('changelog differs from the exact guarded engine entry')
  }

  for (const args of [['diff', '--check'], ['diff', '--cached', '--check']]) {
    const check = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (check.status !== 0) throw new Error(check.stdout.trim() || check.stderr.trim() || 'git diff --check failed')
  }
  return changed
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const verb = process.argv[2]
  const engine = arg('engine')
  const version = arg('version')
  const darwinSha = arg('darwin-sha')
  const darwinHostSha = arg('darwin-host-sha')
  if ((verb !== 'apply' && verb !== 'verify') || !engine || !version) {
    throw new Error('usage: apply-engine-bump.mjs <apply|verify> --engine <claude|codex> --version <version> [--darwin-sha <sha256> --darwin-host-sha <sha256>]')
  }
  const options = { engine, version, darwinSha, darwinHostSha }
  if (verb === 'apply') applyEngineBump(options)
  else verifyEngineBumpWorktree(options)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`apply-engine-bump: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
