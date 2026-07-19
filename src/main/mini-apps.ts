/**
 * Mini-app lifecycle supervisor (mini-apps-plan.md, lifecycle capability v0). A mini app is a project
 * folder that grew a face (`apps/<slug>/` + `koda-app.json`); the agent installs/starts/stops/inspects
 * apps ONLY through the broker's lifecycle verbs — it never hand-rolls background process management in
 * Bash. The supervisor owns the assigned port, the process group, bounded restart/backoff with
 * crash-loop detection, and restart-on-relaunch. Keyed by the app's absolute directory (NOT window or
 * session — an app outlives both; start/stop are idempotent per dir).
 *
 * The whole capability is gated at its activation seams (loadMiniAppsEnabled): the broker only
 * advertises the verbs when the flag is on, and boot-restart checks it first. This module is inert
 * until a seam calls it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import http from 'node:http'
import { app } from 'electron'
import { z } from 'zod'
import { BROKER_TOKEN_ENV } from './broker/server'
import { userPath } from './engine/user-path'
import { loadMiniAppsEnabled } from './settings'
import { log } from './logger'

// ── Manifest ──────────────────────────────────────────────────────────────────────────────────────

export const APP_MANIFEST = 'koda-app.json'

/** `koda-app.json` — OPTIONAL Koda lifecycle metadata. Deleting it loses Koda-managed install/run,
 *  never the ability to build or run the app normally (the anti-lock-in test). Unknown keys are
 *  stripped, not rejected, so an older Koda tolerates a newer manifest. */
const AppManifestSchema = z.object({
  name: z.string().min(1),
  /** Shell command that starts the app's server (e.g. "node server.js"). The host contract: it must
   *  read its port from the PORT env var and bind loopback only. */
  entry: z.string().min(1),
  /** App-relative path to the app's icon image (the launcher tile face, a later seam). */
  icon: z.string().optional(),
  /** App-relative mutable data paths (the SQLite file, uploads). Declared contract in raw-process v1 —
   *  recorded for sharing/backup boundaries, not OS-enforced. */
  data: z.array(z.string()).optional(),
  /** Project-relative paths OUTSIDE the app folder the app may touch, with access mode — the sanctioned
   *  exception to self-containment. */
  shared: z.array(z.object({ path: z.string().min(1), mode: z.enum(['read', 'readwrite']) })).optional(),
})
export type AppManifest = z.infer<typeof AppManifestSchema>

/** Parse + validate manifest JSON text (pure — the testable half of loadAppManifest). */
export function parseAppManifest(raw: string): AppManifest {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`${APP_MANIFEST} is not valid JSON`)
  }
  const parsed = AppManifestSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ')
    throw new Error(`${APP_MANIFEST} is invalid — ${issues}`)
  }
  return parsed.data
}

async function loadAppManifest(dir: string): Promise<AppManifest> {
  let raw: string
  try {
    raw = await readFile(join(dir, APP_MANIFEST), 'utf8')
  } catch {
    throw new Error(
      `no ${APP_MANIFEST} in "${basename(dir)}" — write the manifest first (name, entry, icon, data paths)`,
    )
  }
  return parseAppManifest(raw)
}

// ── Registry (which folders are apps; which should be running) ───────────────────────────────────

interface RegistryEntry {
  dir: string // absolute app folder — the app's identity
  projectPath: string // absolute root of the project that owns it (status filters by this)
  name: string
  /** Desired state, not observed state: true = the supervisor keeps it running, incl. across Koda
   *  relaunches. Set true only once a start actually served (a broken app never sticks as desired). */
  desiredRunning: boolean
}

/** In-memory registry, persisted to <userData>/mini-apps.json (app-lifetime state, same posture as
 *  runtime records — it must be readable at boot before any project window exists). */
const registry = new Map<string, RegistryEntry>()
let registryLoaded: Promise<void> | null = null

const registryFile = (): string => join(app.getPath('userData'), 'mini-apps.json')

function ensureRegistry(): Promise<void> {
  registryLoaded ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(registryFile(), 'utf8')) as { apps?: RegistryEntry[] }
      for (const e of raw.apps ?? []) {
        if (e && typeof e.dir === 'string' && typeof e.projectPath === 'string') registry.set(e.dir, e)
      }
    } catch {
      // first run / unreadable — start empty (fail-soft, same as settings.ts)
    }
  })()
  return registryLoaded
}

async function saveRegistry(): Promise<void> {
  try {
    await writeFile(registryFile(), JSON.stringify({ apps: [...registry.values()] }, null, 2))
  } catch (err) {
    log.warn('mini-apps', 'failed to persist app registry', err instanceof Error ? err.message : err)
  }
}

/** ipc.ts hooks this to push list changes to open windows. A callback (not a BrowserWindow import)
 *  keeps the supervisor window-free and the tests electron-light. */
let onAppsChanged: (() => void) | null = null
export function setMiniAppsChangedListener(fn: (() => void) | null): void {
  onAppsChanged = fn
}
function notifyChanged(): void {
  try {
    onAppsChanged?.()
  } catch {
    // a broken push must never fail the verb that triggered it
  }
}

// ── Process table ─────────────────────────────────────────────────────────────────────────────────

export type MiniAppState = 'starting' | 'running' | 'stopped' | 'crashed'

interface AppProc {
  child?: ChildProcess
  port?: number
  url?: string
  state: MiniAppState
  /** Unexpected-exit timestamps inside the sliding crash window (pruned on each exit). */
  exits: number[]
  /** Pending auto-restart timer (crash backoff). */
  backoff?: NodeJS.Timeout
  /** Auto-restarts this Koda run — status visibility for the agent. */
  restarts: number
  /** In-flight start, so a concurrent app_start joins it instead of double-spawning. */
  ready?: Promise<{ url: string; port: number }>
}

const procs = new Map<string, AppProc>()

/** How long a starting app gets to serve on its assigned port before we give up and kill it. */
const START_TIMEOUT_MS = 30_000
const PROBE_INTERVAL_MS = 250
const PROBE_TIMEOUT_MS = 2_000
/** Crash-loop policy: this many unexpected exits inside the window → 'crashed', stop restarting. */
const CRASH_MAX = 3
const CRASH_WINDOW_MS = 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000
/** On quit: grace between SIGTERM and SIGKILL escalation (index.ts's app.exit backstop bounds us). */
const QUIT_KILL_GRACE_MS = 2_000

/** Restart delay after the nth recent crash (1-based). Exported for the unit test. */
export function crashBackoffMs(recentExits: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, recentExits - 1), BACKOFF_CAP_MS)
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A free loopback port for the child's PORT env. TOCTOU window between close and the child's bind is
 *  real but tiny on a single-user machine; a lost race surfaces as a start failure the caller retries. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** Probe once: anything listening + speaking HTTP counts as serving (same posture as preview.ts —
 *  a 500 still means the server is up; connected-but-slow means it's busy, which also proves it's up). */
function probeServing(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const settle = (v: boolean): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.destroy()
      settle(true)
    })
    req.on('timeout', () => {
      req.destroy()
      settle(true)
    })
    req.on('error', () => settle(false))
  })
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    // Negative pid = the whole process group (detached: true made the child a group leader) — killing
    // just the shell wrapper would leave a grandchild server alive holding the port.
    if (child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

// ── Verbs ─────────────────────────────────────────────────────────────────────────────────────────

export interface InstallResult {
  installed: true
  name: string
  entry: string
  note: string
}

/** Validate the app's manifest and register it with the supervisor. Does NOT install npm deps —
 *  that's the agent's own (gated, user-visible) Bash step. Idempotent. */
export async function installApp(dir: string, projectPath: string): Promise<InstallResult> {
  await ensureRegistry()
  const manifest = await loadAppManifest(dir)
  const existing = registry.get(dir)
  registry.set(dir, { dir, projectPath, name: manifest.name, desiredRunning: existing?.desiredRunning ?? false })
  await saveRegistry()
  notifyChanged()
  return {
    installed: true,
    name: manifest.name,
    entry: manifest.entry,
    note: 'registered with the lifecycle supervisor — install its dependencies yourself (npm install in the app folder) before starting it',
  }
}

/**
 * Start the app under supervision: assign a free port, spawn its entry command (PORT in env), and
 * resolve only once it's actually serving. Idempotent per dir — already running returns the live URL;
 * a concurrent start joins the in-flight one. Auto-installs (validate + register) so a fresh
 * `app_start` works without a prior `app_install`. Marks the app desired-running (restarted on
 * relaunch) only after it has served once.
 */
export async function startApp(dir: string, projectPath: string): Promise<{ url: string; port: number }> {
  await ensureRegistry()
  const existing = procs.get(dir)
  if (existing?.ready) return existing.ready
  if (existing?.state === 'running' && existing.url && existing.port != null) {
    return { url: existing.url, port: existing.port }
  }
  if (existing?.backoff) clearTimeout(existing.backoff) // an explicit start supersedes a pending auto-restart

  const manifest = await loadAppManifest(dir) // re-read every start, so build turns' manifest edits apply
  const prior = registry.get(dir)
  registry.set(dir, { dir, projectPath, name: manifest.name, desiredRunning: prior?.desiredRunning ?? false })

  // Carry crash history across restarts (that's what catches a loop); a NEW proc object per attempt so
  // a stale child's exit handler can't touch the current one.
  const proc: AppProc = { state: 'starting', exits: existing?.exits ?? [], restarts: existing?.restarts ?? 0 }
  procs.set(dir, proc)
  proc.ready = launch(dir, manifest, proc, projectPath)
  try {
    return await proc.ready
  } finally {
    proc.ready = undefined
  }
}

async function launch(
  dir: string,
  manifest: AppManifest,
  proc: AppProc,
  projectPath: string,
): Promise<{ url: string; port: number }> {
  const port = await freePort()
  // A stop that landed during the manifest/port awaits must win — spawning now would un-stop the app.
  if (procs.get(dir) !== proc || proc.state === 'stopped') {
    throw new Error(`"${manifest.name}" was stopped while starting`)
  }
  // Same env posture as preview.ts dev servers: no broker token (the app has no business with it),
  // login-shell PATH (a Finder-launched .app can't find the user's node otherwise), assigned PORT.
  const env = { ...process.env }
  delete env[BROKER_TOKEN_ENV]
  env.PATH = userPath()
  env.PORT = String(port)
  const child = spawn(manifest.entry, {
    cwd: dir,
    shell: true,
    env,
    detached: true, // own process group → killGroup can signal the whole tree
  })
  proc.child = child
  proc.port = port
  const url = `http://localhost:${port}`

  let spawnError: Error | undefined
  child.on('error', (err) => {
    spawnError = err
  })
  child.on('exit', (code) => onExit(dir, proc, child, code))

  // `state !== 'stopped'` is what lets a mid-start stopApp win (it sets that synchronously).
  const isCurrent = (): boolean => procs.get(dir) === proc && proc.child === child && proc.state !== 'stopped'
  // Every failure path funnels here: the dead/doomed child must leave the table (a phantom pid in
  // status, and quit would wait its full SIGKILL grace on a child whose exit already fired).
  const bail = (err: Error): never => {
    if (proc.child === child) proc.child = undefined
    if (procs.get(dir) === proc && proc.state === 'starting') proc.state = 'stopped'
    killGroup(child) // harmless if already dead or already killed by stopApp
    throw err
  }
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isCurrent()) bail(new Error(`"${manifest.name}" was stopped while starting`))
    if (spawnError) bail(spawnError)
    if (child.exitCode !== null) {
      bail(new Error(`"${manifest.name}" exited (code ${child.exitCode}) before serving on its assigned port`))
    }
    if (await probeServing(port)) {
      if (!isCurrent()) bail(new Error(`"${manifest.name}" was stopped while starting`))
      proc.state = 'running'
      proc.url = url
      // NOW it's proven to run — keep it running, including across Koda relaunches.
      const entry = registry.get(dir)
      registry.set(dir, entry ? { ...entry, desiredRunning: true } : { dir, projectPath, name: manifest.name, desiredRunning: true })
      await saveRegistry()
      notifyChanged()
      log.info('mini-apps', 'app serving', { dir, url })
      return { url, port }
    }
    await delay(PROBE_INTERVAL_MS)
  }
  return bail(
    new Error(
      `"${manifest.name}" didn't serve on its assigned port within ${START_TIMEOUT_MS / 1000}s — it must read the port from the PORT env var and bind 127.0.0.1`,
    ),
  )
}

/** Unexpected-exit handler: sliding-window crash counting → bounded-backoff restart, or 'crashed'. */
function onExit(dir: string, proc: AppProc, child: ChildProcess, code: number | null): void {
  if (procs.get(dir) !== proc || proc.child !== child) return // superseded by a newer start/stop
  if (proc.state === 'starting') return // the launch loop reports start failures itself
  if (proc.state !== 'running') return // manual stop / quit teardown — expected
  const now = Date.now()
  proc.exits = [...proc.exits.filter((t) => now - t < CRASH_WINDOW_MS), now]
  proc.child = undefined
  proc.url = undefined
  if (proc.exits.length >= CRASH_MAX) {
    proc.state = 'crashed'
    log.warn('mini-apps', 'app crash-looped — giving up until the next explicit start', { dir, code })
    notifyChanged()
    return
  }
  const wait = crashBackoffMs(proc.exits.length)
  proc.state = 'starting'
  proc.restarts += 1
  log.info('mini-apps', `app exited unexpectedly (code ${code}) — restarting in ${wait}ms`, { dir })
  proc.backoff = setTimeout(() => {
    proc.backoff = undefined
    const entry = registry.get(dir)
    if (!entry?.desiredRunning || procs.get(dir) !== proc) return
    startApp(dir, entry.projectPath).catch((err) => {
      log.warn('mini-apps', 'auto-restart failed', { dir, message: err instanceof Error ? err.message : err })
      // Served once, crashed, and can't come back up = a crash-loop outcome the agent must see —
      // NOT a quiet 'stopped' (which reads as deliberate). Unless the user stopped it meanwhile.
      const cur = procs.get(dir)
      if (cur && registry.get(dir)?.desiredRunning) cur.state = 'crashed'
      notifyChanged()
    })
  }, wait)
}

/** Stop the app (and stop restarting it, incl. at boot). A deliberate stop clears crash history so a
 *  later start begins fresh. Idempotent — stopping a non-running app just records the desired state. */
export async function stopApp(dir: string): Promise<void> {
  await ensureRegistry()
  const entry = registry.get(dir)
  if (entry?.desiredRunning) {
    registry.set(dir, { ...entry, desiredRunning: false })
    await saveRegistry()
  }
  const proc = procs.get(dir)
  if (!proc) return
  if (proc.backoff) {
    clearTimeout(proc.backoff)
    proc.backoff = undefined
  }
  proc.exits = []
  proc.state = 'stopped'
  const child = proc.child
  proc.child = undefined
  proc.url = undefined
  if (child) killGroup(child)
  notifyChanged()
}

export interface AppStatus {
  name: string
  path: string // project-relative app folder — the id the agent passes to the other verbs
  state: MiniAppState
  url?: string
  pid?: number
  restartsThisRun: number
  startsOnLaunch: boolean
}

/** This project's registered apps + live state, for the agent's app_status. */
export async function appStatus(projectPath: string): Promise<AppStatus[]> {
  await ensureRegistry()
  return [...registry.values()]
    .filter((e) => e.projectPath === projectPath)
    .map((e) => {
      const p = procs.get(e.dir)
      return {
        name: e.name,
        path: relative(e.projectPath, e.dir),
        state: p?.state ?? 'stopped',
        url: p?.state === 'running' ? p.url : undefined,
        pid: p?.child?.pid,
        restartsThisRun: p?.restarts ?? 0,
        startsOnLaunch: e.desiredRunning,
      }
    })
}

// ── Renderer-facing (the face — seam ③) ───────────────────────────────────────────────────────────

export interface MiniAppListing {
  dir: string
  projectPath: string
  name: string
  state: MiniAppState
  url?: string
}

/** Every registered app + live state, across all projects — the launcher rail's data (the rail lives
 *  on ProjectHome, which has no project context yet). */
export async function listMiniApps(): Promise<MiniAppListing[]> {
  await ensureRegistry()
  // Prune entries whose folder vanished (project deleted in Finder or by the agent) — a dead tile on
  // the launcher rail would otherwise outlive its app until the registry file is edited by hand.
  const gone = [...registry.values()].filter((e) => !existsSync(e.dir))
  if (gone.length) {
    for (const e of gone) registry.delete(e.dir)
    await saveRegistry()
  }
  return [...registry.values()].map((e) => {
    const p = procs.get(e.dir)
    return {
      dir: e.dir,
      projectPath: e.projectPath,
      name: e.name,
      state: p?.state ?? 'stopped',
      url: p?.state === 'running' ? p.url : undefined,
    }
  })
}

/** Project deletion: stop every app under the project and drop it from the registry entirely —
 *  unlike stopApp (which records desiredRunning=false for the next launch), deletion leaves nothing
 *  to restart, list, or resurrect from the in-memory map. */
export async function deleteProjectApps(projectPath: string): Promise<void> {
  await ensureRegistry()
  const entries = [...registry.values()].filter((e) => e.projectPath === projectPath)
  for (const e of entries) {
    await stopApp(e.dir)
    registry.delete(e.dir)
  }
  if (entries.length) {
    await saveRegistry()
    notifyChanged()
  }
}

/** Start an app the renderer names by dir — but only one the agent actually registered. The renderer
 *  only learns dirs from listMiniApps, and this check keeps a compromised renderer from turning
 *  app_start into "run any folder's entry command". */
export async function startRegisteredMiniApp(dir: string): Promise<{ url: string; port: number }> {
  await ensureRegistry()
  const entry = registry.get(dir)
  if (!entry) throw new Error('that app is not registered with Koda')
  return startApp(entry.dir, entry.projectPath)
}

// ── App lifetime (boot restart / quit teardown) ───────────────────────────────────────────────────

/** Restart desired-running apps when Koda launches ("restart when Koda relaunches — not a daemon").
 *  Fire-and-forget per app: a failed boot start just leaves that app stopped/crashed, discoverable via
 *  app_status — no boot-progress orchestration (v0 has no UI). Reads the flag itself (a seam). */
export function bootStartMiniApps(): void {
  if (!loadMiniAppsEnabled()) return
  void ensureRegistry().then(() => {
    for (const e of registry.values()) {
      if (!e.desiredRunning) continue
      startApp(e.dir, e.projectPath).then(
        ({ url }) => log.info('mini-apps', 'restarted app on launch', { dir: e.dir, url }),
        (err) =>
          log.warn('mini-apps', 'boot start failed', { dir: e.dir, message: err instanceof Error ? err.message : err }),
      )
    }
  })
}

/** Quit teardown: SIGTERM every app's process group, escalate to SIGKILL after a short grace — a child
 *  that ignores SIGTERM would otherwise hold its port and break the next launch's boot-restart.
 *  desiredRunning is untouched (they come back next launch). Bounded; index.ts's app.exit backstop
 *  covers the pathological case. */
export function disposeMiniApps(): Promise<void> {
  // exitCode === null = actually alive; a defunct child would never fire 'exit' again, and waiting on
  // it would cost every quit the full SIGKILL grace.
  const running = [...procs.values()].filter(
    (p): p is AppProc & { child: ChildProcess } => !!p.child && p.child.exitCode === null,
  )
  for (const p of procs.values()) {
    if (p.backoff) {
      clearTimeout(p.backoff)
      p.backoff = undefined
    }
    p.state = 'stopped' // suppress crash-restart on the way down
  }
  if (running.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let remaining = running.length
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(escalate)
      resolve()
    }
    const onOneExit = (): void => {
      remaining -= 1
      if (remaining <= 0) finish()
    }
    const escalate = setTimeout(() => {
      for (const p of running) if (p.child.exitCode === null) killGroup(p.child, 'SIGKILL')
      finish() // don't wait on SIGKILL delivery; the quit backstop bounds everything anyway
    }, QUIT_KILL_GRACE_MS)
    for (const p of running) {
      p.child.once('exit', onOneExit)
      killGroup(p.child, 'SIGTERM')
    }
  })
}
