/**
 * Subscription sign-in — the onboarding "Sign in to Claude" step, promoted from spike/auth/.
 *
 * Two jobs:
 *  1. detectAuthNow() — read login/billing mode programmatically (adaptive ✓ when already signed in).
 *  2. The login state machine — drive `claude auth login --claudeai` over piped stdio and stream
 *     progress to the wizard. Mirrors playwright/index.ts: a module singleton + broadcast() to all
 *     windows, every entry point fail-soft (a miss surfaces as a 'failed' progress event, never a throw).
 *
 * R1 probe (resolved 2026-06-27): `claude auth login --claudeai` DOES run over `stdio:'pipe'` (no TTY).
 * The flow is manual code-paste: it opens the browser, prints the OAuth URL, then blocks on stdin with
 * "Paste code here if prompted >". The redirect_uri is Anthropic's HOSTED callback (not a localhost
 * loopback), so the user copies a code from the browser and we write it back to the child's stdin
 * (submitAuthCode). No `--no-browser`/`--print-url` flag exists; surfacing the URL ourselves is the
 * manual fallback if the auto-opened browser misses.
 *
 * Detection runs under buildEngineEnv(process.env) — the SAME env the engine spawns with — so the
 * verdict reflects what the engine will actually experience (a stray ANTHROPIC_API_KEY is stripped, so
 * it can't silently shadow the subscription). Always uses the resolved engine binary, never a bare
 * `claude` off PATH, so onboarding and the engine agree on one CLI.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/channels'
import type { AuthProgress, AuthVerdict } from '@shared/ipc'
import { resolveEnginePath } from './engine/binary'
import { buildEngineEnv } from './engine/env'
import { log } from './logger'

const execFileP = promisify(execFile)

/** Raw `claude auth status --json` shape (observed 2.1.x). apiKeySource appears ONLY when an API key is
 *  the active credential — the precise billing-trap detector. */
interface AuthStatusRaw {
  loggedIn: boolean
  authMethod: string | null
  subscriptionType: string | null
  email: string | null
  apiKeySource?: string | null
}

function engineBin(): string {
  return resolveEnginePath({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined }).path
}

function broadcast(p: AuthProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.authProgress, p)
  }
}

/** Reduce raw status → the verdict the wizard renders + whether the API-key billing trap is active.
 *  `deliberate` = the caller injected an API key ON PURPOSE (the user chose API billing), so an active
 *  apiKeySource is the intended state, not a trap. Under the default subscription detection it's false,
 *  and an apiKeySource then means a STRAY key is shadowing the subscription — the real trap. */
function classify(s: AuthStatusRaw, deliberate = false): AuthVerdict {
  if (!s.loggedIn && !s.apiKeySource) {
    return { mode: 'logged-out', apiKeyTrap: false, email: null, plan: null, detail: 'Not signed in.' }
  }
  if (s.apiKeySource) {
    // Deliberate API mode → the user's chosen billing, not a trap.
    if (deliberate) {
      return { mode: 'api-key', apiKeyTrap: false, email: null, plan: null, detail: 'Billing to your API key.' }
    }
    // Otherwise a stray env key is shadowing the subscription → billing at API rates. Koda's env
    // chokepoint strips it, so this should never appear under the clean env; surfaced for honesty.
    return {
      mode: 'api-key',
      apiKeyTrap: true,
      email: null,
      plan: null,
      detail: `An API key (${s.apiKeySource}) is shadowing your subscription.`,
    }
  }
  if (s.subscriptionType) {
    return {
      mode: 'subscription',
      apiKeyTrap: false,
      email: s.email,
      plan: s.subscriptionType,
      detail: `Signed in on your ${s.subscriptionType} subscription.`,
    }
  }
  // Logged in, no subscriptionType, no apiKeySource → a console/API login the user chose.
  return { mode: 'api-key', apiKeyTrap: false, email: s.email, plan: null, detail: 'Signed in with an API key.' }
}

/** Read the current login/billing mode. Throws only if the binary is missing or status is unparseable
 *  (the caller wraps it into a {ok:false} result).
 *
 *  Pass `{ apiKey }` to read status under API-billing mode: the key is injected the SAME way the engine
 *  spawns with it, so `auth status` reports the API identity instead of the subscription that the clean
 *  env would otherwise surface. The default (no opts) is the subscription path — unchanged. */
export async function detectAuthNow(opts: { apiKey?: string } = {}): Promise<AuthVerdict> {
  const env = opts.apiKey
    ? buildEngineEnv(process.env, { apiMode: true, apiKey: opts.apiKey })
    : buildEngineEnv(process.env)
  const { stdout } = await execFileP(engineBin(), ['auth', 'status', '--json'], {
    env,
    timeout: 10_000, // a hung binary surfaces as {ok:false}, not a forever "Checking…" spinner
  })
  return classify(JSON.parse(stdout) as AuthStatusRaw, opts.apiKey != null)
}

// ── Login state machine (one at a time) ──────────────────────────────────────────────────────────

let login: ChildProcess | null = null
let loginTimer: NodeJS.Timeout | null = null
/** Set when WE end the child (cancel/timeout) so its `close` doesn't also broadcast 'failed'. */
let aborting = false
let lastErr = ''

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function cleanup(): void {
  if (loginTimer) clearTimeout(loginTimer)
  loginTimer = null
  login = null
  lastErr = ''
}

/** Spawn `claude auth login --claudeai` and stream progress. Returns immediately; the wizard subscribes
 *  to auth:progress. Single-flighted — a second start while one is live is a no-op ack. */
export function startSubscriptionLogin(): { ok: boolean; reason?: string } {
  if (login) return { ok: false, reason: 'already in progress' }
  aborting = false
  lastErr = ''

  let child: ChildProcess
  try {
    child = spawn(engineBin(), ['auth', 'login', '--claudeai'], {
      env: buildEngineEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    log.error('auth', 'login spawn failed', err instanceof Error ? err.message : err)
    broadcast({ state: 'failed', message: 'Could not start sign-in.' })
    return { ok: false, reason: 'spawn failed' }
  }
  login = child
  loginTimer = setTimeout(() => cancelSubscriptionLogin('timeout'), LOGIN_TIMEOUT_MS)

  let out = ''
  let urlSent = false
  child.stdout?.on('data', (d: Buffer) => {
    if (urlSent) return // URL captured; the rest (the "Paste code" prompt) we don't parse
    out += d.toString()
    const m = /(https?:\/\/[^\s"']+)/.exec(out)
    if (m) {
      urlSent = true
      out = '' // release the buffer
      broadcast({ state: 'awaiting-code', url: m[1] })
    }
  })
  child.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line) lastErr = line
  })
  child.on('error', (err) => {
    if (login !== child) return // a newer login owns the state now — don't touch it
    cleanup()
    if (!aborting) broadcast({ state: 'failed', message: err.message || 'Sign-in failed.' })
  })
  child.on('close', async (code, signal) => {
    if (login !== child) return // superseded by a newer login (cancel → re-enter → start)
    const wasAborting = aborting
    cleanup()
    if (wasAborting || signal) return // cancel/timeout already broadcast their own state
    if (code === 0) {
      broadcast({ state: 'verifying' })
      try {
        broadcast({ state: 'completed', verdict: await detectAuthNow() })
      } catch {
        broadcast({ state: 'completed' })
      }
    } else {
      broadcast({ state: 'failed', message: lastErr || 'Sign-in did not complete.' })
    }
  })

  return { ok: true }
}

/** Write the code the user pasted from the browser to the waiting child's stdin. */
export function submitAuthCode(code: string): void {
  const c = login
  if (!c?.stdin?.writable) {
    // No live child waiting on stdin — tell the UI rather than leave it stuck on "verifying".
    broadcast({ state: 'failed', message: 'Sign-in isn’t waiting for a code. Try again.' })
    return
  }
  try {
    c.stdin.write(code.trim() + '\n')
    broadcast({ state: 'verifying' })
  } catch (err) {
    log.warn('auth', 'could not submit code', err instanceof Error ? err.message : err)
    broadcast({ state: 'failed', message: 'Could not submit the code. Try again.' })
  }
}

/** End an in-flight login (user backed out, or the 5-min timeout). Aborting before the OAuth callback
 *  writes no credential, so the existing login is untouched. */
export function cancelSubscriptionLogin(reason: 'cancelled' | 'timeout' = 'cancelled'): void {
  const child = login
  if (!child) return
  aborting = true
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
  cleanup()
  broadcast({ state: reason })
}
