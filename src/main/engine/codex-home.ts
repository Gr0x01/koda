/**
 * Koda gives Codex its OWN isolated home (`<userData>/codex/`) instead of sharing the user's
 * `~/.codex`. Why: Codex only surfaces skills from an INSTALLED plugin (spike-proven —
 * pure `-c` config injection and workspace `.agents/` files both fail; `codex plugin add` cache-copies
 * the plugin into `$CODEX_HOME/plugins/cache/`). Installing Koda's bundled plugin into the user's real
 * `~/.codex` would pollute their standalone Codex; an isolated home keeps it untouched. `CODEX_HOME` is
 * set for EVERY Codex spawn at the `buildEngineEnv` chokepoint (env.ts) — login + auth probe + driver —
 * so they all agree on the home. `codexHome()` is the pure path; `ensureCodexHome()` does the one-time
 * setup (seed login, install the plugin) and is fail-soft: skills are additive, a setup failure must
 * never block a session from starting.
 */
import { execFile, spawn } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { resolveEnginePath } from './binary'
import { buildEngineEnv } from './env'
import {
  CODEX_PACK_SKILLS,
  GATED_PACK_SKILLS,
  codexPackMarker,
  resolvePack,
  resolveStagingPack,
  toCodexToolNames,
} from './pack'
import { loadMiniAppsEnabled } from '../settings'
import { log } from '../logger'

const execFileP = promisify(execFile)

/** The Koda-managed Codex home. Memoized pure path (no side effects) — safe to call from the
 *  buildEngineEnv chokepoint on every Codex spawn. Directory creation happens in ensureCodexAuthSeed. */
let cachedHome: string | null = null
export function codexHome(): string {
  if (!cachedHome) cachedHome = join(app.getPath('userData'), 'codex')
  return cachedHome
}

/**
 * The lightweight prerequisite EVERY Codex spawn needs: the isolated home exists and carries the login.
 * Since buildEngineEnv points all Codex spawns (auth probe, model list, login, driver) at the isolated
 * home, this must run before ANY of them — otherwise the pre-session probes read an empty home and Codex
 * reads as signed-out. Cheap + idempotent + fail-soft (mkdir + a one-time auth copy); call it freely.
 * The heavier plugin install lives in ensureCodexHome (session-start only).
 */
export function ensureCodexAuthSeed(): void {
  try {
    const home = codexHome()
    mkdirSync(home, { recursive: true })
    // Copy the user's existing ChatGPT login once (only if the isolated home has none — don't clobber a
    // refreshed token). Absent source is fine: Koda's own login flow writes here instead.
    const dest = join(home, 'auth.json')
    const src = join(homedir(), '.codex', 'auth.json')
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest)
  } catch (err) {
    log.warn('codex-home', 'auth seed failed', (err as Error)?.message)
  }
}

/** Codex's auth.json holds ONE credential at a time: `{auth_mode:'apikey', OPENAI_API_KEY}` or
 *  `{auth_mode:'chatgpt', tokens, …}`. */
interface CodexAuth {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
}
function readCodexAuth(home: string): CodexAuth | null {
  try {
    const p = join(home, 'auth.json')
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CodexAuth) : null
  } catch {
    return null
  }
}

/** `codex login --with-api-key` reads the key from stdin and writes an apikey auth.json into CODEX_HOME.
 *  Spawn (not execFileSync) so the main process isn't blocked; resolves on a clean exit. */
function codexApiKeyLogin(bin: string, env: NodeJS.ProcessEnv, apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['login', '--with-api-key'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('codex login timed out'))
    }, 30_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`codex login exited ${code}`))
    })
    child.stdin.write(apiKey)
    child.stdin.end()
  })
}

/**
 * Reconcile the isolated home's auth.json to the desired billing credential BEFORE a Codex spawn. Codex's
 * app-server IGNORES OPENAI_API_KEY in the environment for auth, so API-key billing must be WRITTEN into
 * the home via `codex login --with-api-key`. Switching preserves the ChatGPT login: it's backed up before
 * an api-key login overwrites it, and restored on the way back. Idempotent (skips when auth already matches)
 * and fail-soft — a failure logs and leaves auth as-is, so the session still starts on whatever's present.
 *
 * Returns whether the desired credential is now in place. The session-start path ignores it (fail-soft: a
 * transient login failure shouldn't block the session — it runs on the plan, the money-SAFE direction). The
 * Settings save path checks it so a key that can't be written surfaces as an error instead of silently
 * leaving the user on their plan while they think they're on the API key.
 *
 * @param apiKey  the OpenAI key to bill against, or null/undefined to use the ChatGPT subscription login.
 */
export async function reconcileCodexAuth(opts: { resourcesPath?: string; apiKey?: string | null }): Promise<boolean> {
  try {
    ensureCodexAuthSeed() // home dir + (a ChatGPT login copied from ~/.codex if present)
    const home = codexHome()
    const authPath = join(home, 'auth.json')
    const backupPath = join(home, 'auth.chatgpt.json')
    const current = readCodexAuth(home)

    if (opts.apiKey) {
      // Desired: api-key billing with this exact key.
      if (current?.auth_mode === 'apikey' && current.OPENAI_API_KEY === opts.apiKey) return true
      // Preserve a ChatGPT login before the api-key login overwrites auth.json, so a switch back can restore it.
      if (current?.auth_mode === 'chatgpt' && existsSync(authPath)) copyFileSync(authPath, backupPath)
      const bin = resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' }).path
      const env = buildEngineEnv(process.env, { engineId: 'codex' }) // sets CODEX_HOME; strips the ambient key
      await codexApiKeyLogin(bin, env, opts.apiKey)
    } else {
      // Desired: subscription (ChatGPT) billing. NEVER leave apikey auth in place here — that would bill the
      // key the user is switching AWAY from. Restore the backed-up ChatGPT login, else clear to signed-out
      // (the honest state when there's no plan login to fall back to; the UI shows "Not signed in").
      if (current?.auth_mode !== 'apikey') return true // already on ChatGPT (or no login yet — seed handled it)
      if (existsSync(backupPath)) {
        copyFileSync(backupPath, authPath) // restore the ChatGPT login we saved before switching to api
      } else {
        rmSync(authPath, { force: true })
        ensureCodexAuthSeed() // re-copy a standalone ChatGPT login from ~/.codex if one exists; else signed-out
      }
    }
    return true
  } catch (err) {
    log.warn('codex-home', 'auth reconcile failed (session continues on current credential)', (err as Error)?.message ?? err)
    return false
  }
}

/** The pack skill that teaches browser verification — materialized for Codex only when Playwright is wired. */
const BROWSER_VERIFY_SKILL = 'browser-verify'

/** Codex-only skills (resources/codex-skills) that supplement the pack — e.g. code-review, which on
 *  Claude is a subagent (agents/code-reviewer.md), a mechanism Codex plugins can't carry, so Codex gets
 *  the same criteria as a self-invoked skill instead. Resolved like the pack: packaged Resources → repo. */
function codexOnlySkillsDir(resourcesPath?: string): string | null {
  const candidates: string[] = []
  if (resourcesPath) candidates.push(join(resourcesPath, 'codex-skills'))
  candidates.push(join(process.cwd(), 'resources', 'codex-skills'))
  return candidates.find((d) => existsSync(d)) ?? null
}

// Plugin name == the skill namespace Codex shows the model (`koda:memory`, matching Claude's pack).
const MARKETPLACE_NAME = 'koda-market'
const PLUGIN_NAME = 'koda'
const MARKER = 'koda-plugin-version'

const marketplaceJson = () =>
  JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      interface: { displayName: 'Koda' },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
          policy: { installation: 'AVAILABLE' },
          category: 'Productivity',
        },
      ],
    },
    null,
    2,
  )

const pluginJson = (version: string) =>
  JSON.stringify(
    {
      name: PLUGIN_NAME,
      version,
      description: "Koda's bundled skills and specialist reviewers.",
      author: { name: 'Koda' },
      license: 'MIT',
      skills: './skills/',
      // No `agents` — Codex plugins don't load named subagents (verified: it reports "no installed
      // code-reviewer agent"). Its subagents are generic spawn_agent workers, not Claude-style personas.
      interface: {
        displayName: 'Koda',
        shortDescription: "Koda's bundled skills",
        category: 'Productivity',
        capabilities: ['Interactive'],
      },
    },
    null,
    2,
  )

let ready: Promise<void> | null = null

/**
 * Ensure the isolated Codex home exists, carries a login, and has Koda's skills plugin
 * installed. Single-flight (concurrent first sessions share one run); version-keyed (re-installs only
 * when the app version changes); NEVER rejects (a failure logs + resets so a later session retries,
 * and the session starts regardless — skills are additive).
 */
export function ensureCodexHome(opts: {
  appVersion: string
  resourcesPath?: string
  /** Whether the browser capability is wired — decides if browser-verify is materialized. Folded into
   *  the version marker so toggling it re-installs the plugin on the next app run (within a run the
   *  install is single-flighted; the MCP tools still attach live per-session via the driver). */
  playwrightWired?: boolean
}): Promise<void> {
  if (!ready) {
    ready = setup(opts).catch((err) => {
      log.warn('codex-home', 'setup failed (Codex still usable, without Koda skills)', err?.message ?? err)
      ready = null // let a later session retry
    })
  }
  return ready
}

async function setup(opts: {
  appVersion: string
  resourcesPath?: string
  playwrightWired?: boolean
}): Promise<void> {
  const home = codexHome()
  ensureCodexAuthSeed() // home dir + login (shared with the pre-session probes)

  // Version-keyed install, plus the wired-state of optional skills, so a capability toggle re-installs.
  const miniApps = loadMiniAppsEnabled()
  const markerValue = codexPackMarker(opts.appVersion, opts.playwrightWired === true, miniApps)
  const markerPath = join(home, MARKER)
  if (existsSync(markerPath) && readFileSync(markerPath, 'utf8').trim() === markerValue) return

  const pack = resolvePack({ resourcesPath: opts.resourcesPath })
  if (!pack) return // no pack bundled (stripped build) — nothing to install

  // Materialize the Codex plugin from the SAME resources/pack skills (one source of truth) rather than
  // shipping a duplicate skill tree that could drift from the Claude pack.
  const srcRoot = join(home, 'koda-plugin-src')
  rmSync(srcRoot, { recursive: true, force: true })
  const pluginDir = join(srcRoot, 'plugins', PLUGIN_NAME)
  mkdirSync(join(srcRoot, '.agents', 'plugins'), { recursive: true })
  mkdirSync(join(pluginDir, '.codex-plugin'), { recursive: true })
  mkdirSync(join(pluginDir, 'skills'), { recursive: true })
  writeFileSync(join(srcRoot, '.agents', 'plugins', 'marketplace.json'), marketplaceJson())
  writeFileSync(join(pluginDir, '.codex-plugin', 'plugin.json'), pluginJson(opts.appVersion))
  const packSkills = opts.playwrightWired ? [...CODEX_PACK_SKILLS, BROWSER_VERIFY_SKILL] : [...CODEX_PACK_SKILLS]
  for (const name of packSkills) {
    const from = join(pack.dir, 'skills', name)
    if (existsSync(from)) cpSync(from, join(pluginDir, 'skills', name), { recursive: true })
  }
  // Built-but-unshipped skills live in the staging pack, not the main one — copy them only when the
  // mini-apps dogfood flag is on (mirrors the Claude side's staging --plugin-dir; folded into the marker
  // above so toggling re-installs). Absent staging (graduated/stripped build) ⇒ nothing to copy.
  const staging = miniApps ? resolveStagingPack({ resourcesPath: opts.resourcesPath }) : null
  if (staging) {
    for (const name of GATED_PACK_SKILLS) {
      const from = join(staging.dir, 'skills', name)
      if (existsSync(from)) cpSync(from, join(pluginDir, 'skills', name), { recursive: true })
    }
  }
  // Codex-only supplements (each a dir with a SKILL.md).
  const codexOnly = codexOnlySkillsDir(opts.resourcesPath)
  if (codexOnly) {
    for (const name of readdirSync(codexOnly)) {
      const from = join(codexOnly, name)
      if (existsSync(join(from, 'SKILL.md'))) cpSync(from, join(pluginDir, 'skills', name), { recursive: true })
    }
  }
  // Skills author tool names the Claude way (`mcp__<server>__<tool>`, e.g. browser-verify's
  // `mcp__playwright__browser_navigate`); rewrite them to the Codex convention (`<server>__<tool>`) so the
  // guidance names the tools Codex actually surfaces. No-op for skills that reference no tools.
  const skillsRoot = join(pluginDir, 'skills')
  for (const name of readdirSync(skillsRoot)) {
    const md = join(skillsRoot, name, 'SKILL.md')
    if (existsSync(md)) writeFileSync(md, toCodexToolNames(readFileSync(md, 'utf8')))
  }

  // Install via the codex binary. CODEX_HOME rides buildEngineEnv (engineId:'codex') → these spawns
  // target the isolated home, same as every session spawn. marketplace-add is idempotent.
  const bin = resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' }).path
  const env = buildEngineEnv(process.env, { engineId: 'codex' })
  const run = (args: string[]) => execFileP(bin, args, { env, timeout: 30_000 })
  await run(['plugin', 'marketplace', 'add', srcRoot])
  await run(['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`])
  writeFileSync(markerPath, markerValue)
  log.info('codex-home', `installed Koda plugin (${packSkills.join(', ')} + code-review) into ${home}`)
}
