/**
 * Codex auth + model probes — the `claude auth status` / model-list analogs for the second engine
 * (architecture/multi-engine-codex.md, Piece 4). Each is a ONE-SHOT spawn of `codex app-server
 * --stdio`: initialize → call → kill. Not a long-lived session (that's codex-driver.ts) — these answer
 * "is the user signed in, and with what?" and "which models can this account use?" for onboarding +
 * the Settings engine picker.
 *
 * Every spawn goes through the same chokepoints as a real session — `resolveEnginePath` (bundled →
 * dev-fallback) and `buildEngineEnv({ engineId: 'codex' })` (strips OPENAI_API_KEY so we read the true
 * subscription state, never a stray ambient key). Short, bounded, fail-soft: a probe that can't reach a
 * signed-in answer resolves to a "not signed in" shape rather than throwing into the caller.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { app, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/channels'
import type { CodexAuthStatus, CodexLoginProgress, CodexModel } from '@shared/ipc'
import { resolveEnginePath } from './binary'
import { buildEngineEnv } from './env'
import { ensureCodexAuthSeed } from './codex-home'
import { log } from '../logger'

/** An OpenAI auth mode (codex `AuthMode`). 'chatgpt' = an active ChatGPT subscription. */
type CodexAuthMethod = 'apikey' | 'chatgpt' | 'chatgptAuthTokens' | 'agentIdentity' | 'personalAccessToken' | 'bedrockApiKey'

const PROBE_TIMEOUT_MS = 20_000

/**
 * Spawn `codex app-server --stdio`, run `initialize` then one method, return its result, kill.
 * Resolves null on any failure (spawn error, JSON-RPC error, timeout) — callers degrade gracefully.
 * Ignores notifications and best-effort-acks any server-initiated request (none expected pre-turn).
 */
async function probe<T>(
  opts: { resourcesPath?: string },
  method: string,
  params: unknown = null,
): Promise<T | null> {
  let loc
  try {
    loc = resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' })
  } catch (err) {
    log.warn('codex', 'no codex binary for probe', err instanceof Error ? err.message : err)
    return null
  }

  // The probe reads Codex's isolated home (buildEngineEnv sets CODEX_HOME); seed it first so a
  // signed-in user isn't reported signed-out before their first session installs the plugin.
  ensureCodexAuthSeed()

  return new Promise<T | null>((resolve) => {
    const child = spawn(
      loc.path,
      ['app-server', '--stdio', '-c', 'check_for_update_on_startup=false'],
      { stdio: ['pipe', 'pipe', 'ignore'], env: buildEngineEnv(process.env, { engineId: 'codex' }) },
    )

    let nextId = 1
    let settled = false
    const pending = new Map<number, { method: string }>()

    const done = (value: T | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(value)
    }
    const timer = setTimeout(() => {
      log.warn('codex', `probe timed out: ${method}`)
      done(null)
    }, PROBE_TIMEOUT_MS)

    const send = (m: string, p: unknown) => {
      const id = nextId++
      pending.set(id, { method: m })
      child.stdin.write(JSON.stringify({ id, method: m, params: p }) + '\n')
      return id
    }

    const initId = send('initialize', {
      clientInfo: { name: 'koda', title: 'Koda', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    let callId = -1

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      // Response to one of our requests.
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const id = msg.id as number
        pending.delete(id)
        if (msg.error) {
          log.warn('codex', `probe error on ${method}`, JSON.stringify(msg.error))
          return done(null)
        }
        if (id === initId) {
          callId = send(method, params) // initialize OK → run the real call
        } else if (id === callId) {
          done(msg.result as T)
        }
        return
      }
      // Server-initiated request before any turn (rare) — best-effort ack so we never wedge it.
      if (msg.id !== undefined && typeof msg.method === 'string') {
        child.stdin.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
      }
      // Notifications: ignored.
    })

    child.on('error', (err) => {
      log.warn('codex', 'probe spawn failed', err.message)
      done(null)
    })
    child.on('close', () => done(null)) // closed before answering → null (no-op if already settled)
  })
}

/**
 * Is the user signed in to Codex, and how? The `claude auth status` analog. 'chatgpt' = subscription.
 * Never throws — a signed-out / unreachable state returns `{ signedIn: false, authMethod: null }`.
 */
export async function getCodexAuthStatus(opts: { resourcesPath?: string } = {}): Promise<CodexAuthStatus> {
  const res = await probe<{ authMethod: CodexAuthMethod | null; requiresOpenaiAuth: boolean | null }>(
    opts,
    'getAuthStatus',
    {},
  )
  if (!res) return { signedIn: false, authMethod: null, requiresOpenaiAuth: null }
  return {
    signedIn: res.authMethod != null,
    authMethod: res.authMethod,
    requiresOpenaiAuth: res.requiresOpenaiAuth,
  }
}

/**
 * Models this account can use, for the Settings picker. The engine owns model selection (no hardcoded
 * list); hidden models are dropped. Empty array on failure. NOTE: a ChatGPT subscription rejects the
 * `-codex` default at `thread/start` (FINDINGS nuance #1) — the driver, not this list, handles picking a
 * supported model, so the picker can show whatever the account legitimately lists.
 */
export async function listCodexModels(opts: { resourcesPath?: string } = {}): Promise<CodexModel[]> {
  const res = await probe<{ data: Array<{ id: string; displayName?: string; isDefault?: boolean; hidden?: boolean }> }>(
    opts,
    'model/list',
    {},
  )
  if (!res?.data) return []
  return res.data
    .filter((m) => !m.hidden && m.id)
    .map((m) => ({ id: m.id, label: m.displayName || m.id, isDefault: !!m.isDefault }))
}

// ── Codex login state machine (ChatGPT OAuth, one at a time) ───────────────────────────────────────
//
// The `claude auth login` analog for the second engine. `codex login` prints a local-server line + the
// OpenAI OAuth URL, then BLOCKS on a loopback callback (localhost:1455) until the browser redirect
// lands — so unlike Claude's hosted-callback paste-code flow, there's nothing to write back: we surface
// the URL, the user approves in the browser, and the child exits 0 on its own. Mirrors auth.ts: a module
// singleton + broadcast() to all windows, every entry point fail-soft.
//
// Spawns through the same chokepoints as a real session — resolveEnginePath (bundled → dev-fallback) and
// buildEngineEnv({ engineId: 'codex' }) (strips a stray OPENAI_API_KEY so we never log in over an
// ambient key). The login child auto-opens the browser itself; the surfaced URL is the manual fallback.

function codexBin(): string {
  return resolveEnginePath({
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    binaryName: 'codex',
  }).path
}

function broadcastLogin(p: CodexLoginProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.codexLoginProgress, p)
  }
}

let codexLogin: ChildProcess | null = null
let codexLoginTimer: NodeJS.Timeout | null = null
/** Set when WE end the child (cancel/timeout) so its `close` doesn't also broadcast 'failed'. */
let codexAborting = false
let codexLastErr = ''

const CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function cleanupCodexLogin(): void {
  if (codexLoginTimer) clearTimeout(codexLoginTimer)
  codexLoginTimer = null
  codexLogin = null
  codexLastErr = ''
}

/** Spawn `codex login` and stream progress. Returns immediately; the renderer watches
 *  codexLoginProgress. Single-flighted — a second start while one is live is a no-op ack. */
export function startCodexLogin(): { ok: boolean; reason?: string } {
  if (codexLogin) return { ok: false, reason: 'already in progress' }
  codexAborting = false
  codexLastErr = ''

  // `codex login` writes into the isolated home (buildEngineEnv sets CODEX_HOME); ensure it exists.
  ensureCodexAuthSeed()

  let child: ChildProcess
  try {
    child = spawn(codexBin(), ['login'], {
      env: buildEngineEnv(process.env, { engineId: 'codex' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    log.error('codex', 'login spawn failed', err instanceof Error ? err.message : err)
    broadcastLogin({ state: 'failed', message: 'Could not start sign-in.' })
    return { ok: false, reason: 'spawn failed' }
  }
  codexLogin = child
  codexLoginTimer = setTimeout(() => cancelCodexLogin('timeout'), CODEX_LOGIN_TIMEOUT_MS)

  let out = ''
  let urlSent = false
  child.stdout?.on('data', (d: Buffer) => {
    if (urlSent) return // URL captured; the rest is the "waiting for callback" chatter
    out += d.toString()
    // First `https://` URL = the OAuth authorize URL. `codex login` prints its loopback line as
    // `http://localhost:1455` (plain http), so anchoring on https skips it AND survives an authorize-host
    // change (today auth.openai.com) without hard-coding the host.
    const m = /(https:\/\/[^\s"']+)/.exec(out)
    if (m) {
      urlSent = true
      out = '' // release the buffer
      broadcastLogin({ state: 'awaiting-browser', url: m[1] })
    }
  })
  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line) codexLastErr = line
  })
  child.on('error', (err) => {
    if (codexLogin !== child) return // a newer login owns the state now
    cleanupCodexLogin()
    if (!codexAborting) broadcastLogin({ state: 'failed', message: err.message || 'Sign-in failed.' })
  })
  child.on('close', async (code, signal) => {
    if (codexLogin !== child) return // superseded by a newer login
    const wasAborting = codexAborting
    cleanupCodexLogin()
    if (wasAborting || signal) return // cancel/timeout already broadcast their own state
    if (code === 0) {
      broadcastLogin({ state: 'verifying' })
      try {
        broadcastLogin({ state: 'completed', status: await getCodexAuthStatus() })
      } catch {
        broadcastLogin({ state: 'completed' })
      }
    } else {
      broadcastLogin({ state: 'failed', message: codexLastErr || 'Sign-in did not complete.' })
    }
  })

  return { ok: true }
}

/** End an in-flight Codex login (user backed out, or the 5-min timeout). Aborting before the OAuth
 *  callback writes no credential, so the existing login is untouched. */
export function cancelCodexLogin(reason: 'cancelled' | 'timeout' = 'cancelled'): void {
  const child = codexLogin
  if (!child) return
  codexAborting = true
  try {
    child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }, 500)
  cleanupCodexLogin()
  broadcastLogin({ state: reason })
}
