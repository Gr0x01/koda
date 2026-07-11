/**
 * On-demand runtime provisioning (Node, Python — see registry.ts).
 *
 * A fresh Mac has no Node and only a locked-down system Python, so a vibecoder can't run a backend
 * or script the agent writes. This downloads the official, relocatable tarball (pinned), SHA-256-
 * verifies it against the runtime's own SHASUMS, extracts it into a Koda-owned dir under userData,
 * and registers its bin with the spawn-PATH chokepoint (user-path.ts) — no brew, no Xcode CLT, no
 * admin, no touching the system.
 *
 * It's a true FALLBACK: getRuntimeStatus() reports `system` when the user already has the runtime, so
 * we never nag them or shadow their install. The downloaded binary is never executed during install
 * (only `/usr/bin/tar` runs); it becomes reachable only via PATH, on the next engine/dev-server spawn.
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannels } from '@shared/channels'
import type { RuntimeId, RuntimeProgress, RuntimeStatus } from '@shared/ipc'
import { loginPathHasBinary, setProvisionedBin } from '../engine/user-path'
import { log } from '../logger'
import { loadRuntimeRecord, saveRuntimeRecord } from '../settings'
import {
  RUNTIMES,
  RUNTIME_IDS,
  CLIS,
  CLI_IDS,
  cliArch,
  type RuntimeSpec,
  type CliId,
  type CliSpec,
} from './registry'

function installRoot(spec: RuntimeSpec, version = spec.pinnedVersion): string {
  return join(app.getPath('userData'), 'runtime', spec.id, version)
}
function binDirFor(spec: RuntimeSpec, version = spec.pinnedVersion): string {
  return join(installRoot(spec, version), 'bin')
}

const installing = new Set<RuntimeId>() // drives getRuntimeStatus's 'installing' state
/** In-flight runtime installs — so a second caller (agent ensure_tool while the Settings UI installs,
 *  or two sessions) JOINS the running install and gets its real result, rather than an error. */
const runtimeInstalls = new Map<RuntimeId, Promise<{ ok: boolean; message?: string }>>()

/** Re-activate runtimes installed in a previous session. Call early in whenReady, before any spawn. */
export function activateProvisionedRuntimes(): void {
  for (const id of RUNTIME_IDS) {
    const spec = RUNTIMES[id]
    const rec = loadRuntimeRecord(id)
    if (rec && rec.version === spec.pinnedVersion && existsSync(join(rec.binDir, spec.probeBinary))) {
      setProvisionedBin(id, rec.binDir)
      log.info('runtime', `${spec.label} ${rec.version} active at ${rec.binDir}`)
    }
  }
}

export function getRuntimeStatus(id: RuntimeId): RuntimeStatus {
  const spec = RUNTIMES[id]
  const base = { id, installedVersion: null as string | null, pinnedVersion: spec.pinnedVersion }
  if (installing.has(id)) return { ...base, state: 'installing' }
  // The user already has this runtime — never offer to install a second copy. (Per-runtime excludes
  // skip non-installs like macOS's /usr/bin/python3 stub, so a fresh Mac still gets the offer.)
  if (loginPathHasBinary(spec.probeBinary, spec.systemExcludeDirs)) return { ...base, state: 'system' }
  const rec = loadRuntimeRecord(id)
  if (rec && existsSync(join(rec.binDir, spec.probeBinary))) {
    return {
      ...base,
      state: rec.version === spec.pinnedVersion ? 'installed' : 'stale',
      installedVersion: rec.version,
    }
  }
  return { ...base, state: 'not_installed' }
}

export function isInstalling(id: RuntimeId): boolean {
  return installing.has(id)
}

function emit(event: RuntimeProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.runtimeProgress, event)
  }
}

/**
 * Install a runtime, de-duped: concurrent callers JOIN the same in-flight promise (so the agent's
 * ensure_tool doesn't error while the Settings UI is mid-install). The IPC handler doesn't await it
 * (fire-and-forget; outcomes also stream over `runtime:progress`), but `ensureRuntime` does.
 */
export function installRuntime(id: RuntimeId): Promise<{ ok: boolean; message?: string }> {
  const inflight = runtimeInstalls.get(id)
  if (inflight) return inflight
  const p = runInstall(id).finally(() => runtimeInstalls.delete(id))
  runtimeInstalls.set(id, p)
  return p
}

/**
 * The actual download → verify → extract → activate. Nothing lands on disk until the checksum passes.
 * Runtimes install independently (own root + flag). Wrapped by installRuntime's in-flight de-dup.
 */
async function runInstall(id: RuntimeId): Promise<{ ok: boolean; message?: string }> {
  const spec = RUNTIMES[id]
  installing.add(id)
  const version = spec.pinnedVersion
  const root = installRoot(spec, version)
  const extractTmp = `${root}.extract.tmp`
  try {
    // 1. Official checksums (same TLS origin as the tarball — not a separate trust root).
    emit({ runtime: id, phase: 'download', message: 'Starting…', progress: 0 })
    const shasums = await fetch(spec.shasumsUrl(), { signal: AbortSignal.timeout(15_000) }).then((r) => {
      if (!r.ok) throw new Error(`couldn't fetch checksums (${r.status})`)
      return r.text()
    })
    const name = spec.tarballName()
    const expected = shasums
      .split('\n')
      .find((line) => line.trimEnd().endsWith(`  ${name}`))
      ?.split(/\s+/)[0]
    if (!expected) throw new Error(`no checksum listed for ${name}`)

    // 2. Download, streaming byte progress. An overall deadline so a stalled connection can't hang
    //    the install forever (it'd otherwise leave the `installing` flag stuck) — it throws into catch.
    const res = await fetch(spec.tarballUrl(), { signal: AbortSignal.timeout(180_000) })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      emit({ runtime: id, phase: 'download', message: spec.downloadMessage, progress: total ? received / total : undefined })
    }
    const buf = Buffer.concat(chunks)

    // 3. Verify BEFORE anything touches disk. A mismatch aborts with nothing written.
    emit({ runtime: id, phase: 'verify', message: 'Verifying…' })
    if (createHash('sha256').update(buf).digest('hex') !== expected) {
      throw new Error('checksum mismatch — download may be corrupt. Try again.')
    }

    // 4. Extract straight from memory into a temp dir, then atomically move into place. tar is the
    //    only thing spawned here — never the downloaded binary.
    emit({ runtime: id, phase: 'extract', message: 'Installing…' })
    await rm(extractTmp, { recursive: true, force: true })
    await mkdir(extractTmp, { recursive: true })
    await extractTarball(buf, extractTmp)
    if (!existsSync(join(extractTmp, spec.verifyRelPath))) {
      throw new Error(`${spec.label} binary missing after extract`)
    }
    await rm(root, { recursive: true, force: true })
    await rename(extractTmp, root)

    // 5. Record + activate — effective on the next spawn, no restart.
    saveRuntimeRecord(id, { version, binDir: binDirFor(spec, version) })
    setProvisionedBin(id, binDirFor(spec, version))
    emit({ runtime: id, phase: 'done', message: `${spec.label} is ready.` })
    log.info('runtime', `installed ${spec.label} ${version}`)
    return { ok: true }
  } catch (err) {
    await rm(extractTmp, { recursive: true, force: true }).catch(() => {})
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    const message = timedOut
      ? 'Download timed out — check your connection and try again.'
      : err instanceof Error
        ? err.message
        : String(err)
    log.error('runtime', `install failed (${id})`, message)
    emit({ runtime: id, phase: 'error', message })
    return { ok: false, message }
  } finally {
    installing.delete(id)
  }
}

/** Pipe the verified tarball into the system `tar` via stdin (no temp file). bsdtar rejects absolute
 *  and `..` paths; `--strip-components=1` drops the tarball's top-level dir (`node-vX-…/` / `python/`). */
function extractTarball(buf: Buffer, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('/usr/bin/tar', ['-xz', '--strip-components=1', '-C', dest, '-f', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    tar.stderr?.on('data', (d) => (stderr += d.toString()))
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)),
    )
    tar.stdin?.on('error', () => {}) // EPIPE if tar dies early — the close handler reports the real cause
    tar.stdin?.end(buf)
  })
}

// ── Portable CLI tools (agent-requested via the broker `ensure_tool` capability) ────────────────────
//
// Distinct from runtimes: a single binary installed into ONE shared `tools/bin` dir, which we
// pre-register on the spawn PATH at startup. Because that dir is already in every session's frozen
// PATH, a binary dropped into it mid-session is immediately found by the agent's next Bash call — no
// session restart, no PATH push (the OS resolves PATH at exec time). See registry.ts CliSpec.

/** The shared bin dir for every provisioned CLI tool. */
function toolsBinDir(): string {
  return join(app.getPath('userData'), 'runtime', 'tools', 'bin')
}

/**
 * Pre-register the tools bin dir on the spawn PATH at startup, BEFORE any session spawns — even while
 * empty. This is what makes mid-session installs immediately usable (the dir is already in the frozen
 * PATH). Call alongside activateProvisionedRuntimes(). Fail-soft.
 */
export function activateToolsBinDir(): void {
  try {
    mkdirSync(toolsBinDir(), { recursive: true })
    setProvisionedBin('_cli_tools', toolsBinDir())
  } catch (err) {
    log.warn('runtime', 'could not prepare tools bin dir', err instanceof Error ? err.message : err)
  }
}

export type EnsureToolResult =
  | { status: 'already-present'; source: 'system' | 'koda'; binPath: string }
  | { status: 'installed'; binPath: string }
  | { status: 'unknown'; available: string[] }
  | { status: 'error'; message: string }

/** Every id the agent's ensure_tool capability can install — runtimes + CLIs (the curated set). */
export const ALL_TOOL_IDS: string[] = [...RUNTIME_IDS, ...CLI_IDS]

/**
 * The broker's `ensure_tool` entry point — make a curated tool available (a runtime like Node/Python,
 * or a CLI like ripgrep/fd/jq), awaited so the agent can use it the moment this returns. Routes by id;
 * an unknown id is REFUSED (the curated registry is the only thing installable — never an agent URL).
 */
export async function ensureTool(id: string): Promise<EnsureToolResult> {
  // hasOwn, not `in` — `in` walks the prototype chain ('__proto__'/'constructor'/…). The two curated
  // registries are the ONLY installable sets.
  if (Object.hasOwn(RUNTIMES, id)) return ensureRuntime(id as RuntimeId)
  if (Object.hasOwn(CLIS, id)) return ensureCli(CLIS[id as CliId])
  return { status: 'unknown', available: ALL_TOOL_IDS }
}

/** Ensure a runtime (Node/Python). Short-circuits on a system/Koda install; else installs + awaits. */
async function ensureRuntime(id: RuntimeId): Promise<EnsureToolResult> {
  const spec = RUNTIMES[id]
  const status = getRuntimeStatus(id)
  if (status.state === 'system') return { status: 'already-present', source: 'system', binPath: spec.probeBinary }
  const rec = loadRuntimeRecord(id)
  if (status.state === 'installed' && rec) {
    return { status: 'already-present', source: 'koda', binPath: join(rec.binDir, spec.probeBinary) }
  }
  const res = await installRuntime(id)
  if (!res.ok) return { status: 'error', message: res.message ?? `couldn't set up ${spec.label}` }
  const after = loadRuntimeRecord(id)
  return { status: 'installed', binPath: after ? join(after.binDir, spec.probeBinary) : spec.probeBinary }
}

/** In-flight CLI installs keyed by id — concurrent callers share the SAME promise (await-able, unlike
 *  the runtimes' fire-and-forget Set), so a second request mid-download joins rather than double-installs. */
const cliInstalls = new Map<CliId, Promise<EnsureToolResult>>()

function cliBinPath(spec: CliSpec): string {
  return join(toolsBinDir(), spec.probeBinary)
}

/** Ensure a single-binary CLI is in tools/bin. Short-circuits when present; else installs once.
 *  NB: this short-circuit is version-blind (unlike runtimes, which expose a `stale` state) — bumping a
 *  CLI's pinned version in registry.ts will NOT reinstall for users who already have the old binary.
 *  Acceptable for these stable tools (rg/fd/jq); if a bump ever ships a security fix, delete the binary
 *  or add a version sentinel here. */
async function ensureCli(spec: CliSpec): Promise<EnsureToolResult> {
  if (loginPathHasBinary(spec.probeBinary, spec.systemExcludeDirs)) {
    return { status: 'already-present', source: 'system', binPath: spec.probeBinary }
  }
  if (existsSync(cliBinPath(spec))) {
    return { status: 'already-present', source: 'koda', binPath: cliBinPath(spec) }
  }
  const inflight = cliInstalls.get(spec.id)
  if (inflight) return inflight
  const p = runCliInstall(spec).finally(() => cliInstalls.delete(spec.id))
  cliInstalls.set(spec.id, p)
  return p
}

/** Download → SHA-256-verify-before-disk → place the single binary in tools/bin. Returns a result
 *  (never throws) so the capability can report it to the agent. */
async function runCliInstall(spec: CliSpec): Promise<EnsureToolResult> {
  const dest = cliBinPath(spec)
  const tmp = `${dest}.download.tmp`
  const extractTmp = `${dest}.extract.tmp`
  try {
    log.info('runtime', `installing ${spec.label} ${spec.pinnedVersion}`)
    const expected = await expectedSha(spec)
    const res = await fetch(spec.assetUrl(), { signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (createHash('sha256').update(buf).digest('hex') !== expected) {
      throw new Error('checksum mismatch — download may be corrupt. Try again.')
    }
    await mkdir(toolsBinDir(), { recursive: true })

    if (spec.format === 'raw') {
      // The download IS the binary — write to a temp file, mark executable, then atomically swap in
      // (rename replaces an existing dest atomically, so there's never an absent-file window).
      await writeFile(tmp, buf, { mode: 0o755 })
      await rename(tmp, dest)
    } else {
      // tar.gz — extract, lift the one binary out, atomically swap it in.
      await rm(extractTmp, { recursive: true, force: true })
      await mkdir(extractTmp, { recursive: true })
      await extractTarball(buf, extractTmp)
      const binary = join(extractTmp, spec.binaryRelPath ?? spec.probeBinary)
      if (!existsSync(binary)) throw new Error(`${spec.label} binary missing after extract`)
      await chmod(binary, 0o755)
      await rename(binary, dest)
      await rm(extractTmp, { recursive: true, force: true })
    }
    log.info('runtime', `installed ${spec.label} ${spec.pinnedVersion}`)
    return { status: 'installed', binPath: dest }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    await rm(extractTmp, { recursive: true, force: true }).catch(() => {})
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    const message = timedOut
      ? 'Download timed out — check your connection and try again.'
      : err instanceof Error
        ? err.message
        : String(err)
    log.error('runtime', `install failed (${spec.id})`, message)
    return { status: 'error', message }
  }
}

/** The expected SHA-256: an in-repo pinned hex (per arch) or fetched from the source's checksum file.
 *  The file match is lenient — find the line whose last token ends with the asset name (handles both a
 *  per-asset `.sha256` with a path-prefixed name and a combined `<hash>␠␠<file>` list). */
async function expectedSha(spec: CliSpec): Promise<string> {
  let hex: string | undefined
  if (spec.checksum.kind === 'pinned') {
    hex = spec.checksum.hex[cliArch()]
  } else {
    const text = await fetch(spec.checksum.url(), { signal: AbortSignal.timeout(15_000) }).then((r) => {
      if (!r.ok) throw new Error(`couldn't fetch checksums (${r.status})`)
      return r.text()
    })
    const asset = spec.assetName()
    hex = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && l.split(/\s+/).pop()?.endsWith(asset))
      ?.split(/\s+/)[0]
  }
  // Normalize + shape-validate (digest('hex') is lowercase): a wrong-token match from the lenient
  // parser then fails HERE with a clear error, not later as a confusing "checksum mismatch".
  const normalized = hex?.toLowerCase()
  if (!normalized || !/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`no valid checksum found for ${spec.assetName()}`)
  }
  return normalized
}
