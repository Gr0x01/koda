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
  BROWSER_VERIFY_SKILL,
  CODEX_PACK_SKILLS,
  DEEP_REVIEW_PLUGIN_NAME,
  GATED_PACK_SKILLS,
  codexPackMarker,
  deepReviewPluginVersion,
  resolveDeepReviewPlugin,
  resolvePack,
  resolveStagingPack,
} from './pack'
import { readDisabledSet, skillKey } from '../guardrails-config'
import { canonicalSkillName, projectSkillCollisionNames, projectSkillDescriptors } from '../project-skills'
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

/** Codex-only skills that supplement the shared pack — currently code-review, which is a named
 *  specialist on Claude but a route-invoked skill on Codex. Resolved like the pack. */
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

export interface CodexSkillConfigEntry {
  path: string
  enabled: boolean
}

export interface CodexSkillConfigOptions {
  home?: string
  playwrightWired?: boolean
  miniAppsWired?: boolean
}

/**
 * Codex's native per-skill config is the parity seam for Settings → Guardrails. The installed plugin
 * remains one shared immutable catalog; each app-server spawn receives path-keyed enablement for THIS
 * project. Codex selectors use the exact canonical `SKILL.md` file (a parent directory is not a valid
 * identity). A project `.claude/skills/<name>` fork disables the same-named bundled skill and is exposed
 * directly as the replacement, so editing or toggling a playbook has the same visible effect on both
 * engines without rewriting the shared plugin between concurrent sessions.
 */
export function codexSkillConfig(
  projectRoot: string,
  appVersion: string,
  opts: CodexSkillConfigOptions = {},
): CodexSkillConfigEntry[] {
  const home = opts.home ?? codexHome()
  const disabled = readDisabledSet(projectRoot)
  const installedSkills = join(home, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, appVersion, 'skills')
  const projectSkills = join(projectRoot, '.claude', 'skills')
  const entries = new Map<string, CodexSkillConfigEntry>()
  const capabilityDisabled = new Set<string>([
    ...(opts.playwrightWired ? [] : [BROWSER_VERIFY_SKILL]),
    ...(opts.miniAppsWired ? [] : GATED_PACK_SKILLS),
  ])

  // The private plugin is an immutable superset. Optional playbooks are switched off per app-server
  // process, at the same native config seam as project guardrail toggles, so concurrent sessions with
  // different feature snapshots cannot rewrite each other's shared cache.
  for (const name of capabilityDisabled) {
    const bundled = join(installedSkills, name, 'SKILL.md')
    if (existsSync(bundled)) entries.set(bundled, { path: bundled, enabled: false })
  }

  const projectDescriptors = projectSkillDescriptors(projectRoot)
  const projectNames = new Set(projectDescriptors.map((descriptor) => descriptor.name))

  // Two project folders claiming one identity are unsafe to select. Codex does not discover the
  // `.claude/skills` copies directly, but the same name may exist in Koda's bundled plugin; disable
  // that too so both engines fail closed on the collision instead of silently choosing different work.
  for (const name of projectSkillCollisionNames(projectRoot)) {
    const bundled = join(installedSkills, name, 'SKILL.md')
    if (existsSync(bundled)) entries.set(bundled, { path: bundled, enabled: false })
  }

  for (const descriptor of projectDescriptors) {
    const name = descriptor.name
    const bundled = join(installedSkills, name, 'SKILL.md')
    if (existsSync(bundled)) entries.set(bundled, { path: bundled, enabled: false })
    const local = join(projectSkills, descriptor.directoryName, 'SKILL.md')
    entries.set(local, {
      path: local,
      enabled: !disabled.has(skillKey(name)) && !capabilityDisabled.has(name),
    })
  }

  for (const key of disabled) {
    if (!key.startsWith('skill:')) continue
    const name = canonicalSkillName(key.slice('skill:'.length))
    if (!name) continue
    if (projectNames.has(name)) continue
    const bundled = join(installedSkills, name, 'SKILL.md')
    if (existsSync(bundled)) entries.set(bundled, { path: bundled, enabled: false })
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export const codexMarketplaceJson = (includeDeepReview: boolean) =>
  JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      interface: { displayName: 'Koda' },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
        ...(includeDeepReview
          ? [
              {
                name: DEEP_REVIEW_PLUGIN_NAME,
                source: { source: 'local', path: `./plugins/${DEEP_REVIEW_PLUGIN_NAME}` },
                policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
                category: 'Developer Tools',
              },
            ]
          : []),
      ],
    },
    null,
    2,
  )

export const codexPluginJson = (version: string) =>
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

/** Read the native CLI's installed-plugin inventory without treating malformed output as an empty
 * inventory. Callers must fail closed on null so they never write a marker while stale Koda-owned
 * plugins may still be active. */
export function codexInstalledPluginIds(raw: string): Set<string> | null {
  try {
    const parsed = JSON.parse(raw) as { installed?: unknown }
    if (!Array.isArray(parsed.installed)) return null
    const ids = new Set<string>()
    for (const entry of parsed.installed) {
      if (!entry || typeof entry !== 'object') return null
      const pluginId = (entry as { pluginId?: unknown }).pluginId
      if (typeof pluginId !== 'string') return null
      ids.add(pluginId)
    }
    return ids
  } catch {
    return null
  }
}

interface CodexHomeSetupRequest {
  appVersion: string
  resourcesPath?: string
}

interface CodexHomeSetupFlight {
  key: string
  promise: Promise<void>
  owner: object
}

let ready: CodexHomeSetupFlight | null = null

/** Identity of the plugin materialization a session needs. Exported as a tripwire: adding another
 * runtime-gated skill without folding its state into this key would resurrect a stale in-process
 * cache even though the on-disk marker is correct. */
export function codexHomeSetupKey(opts: CodexHomeSetupRequest): string {
  const deepReviewVersion = deepReviewPluginVersion(resolveDeepReviewPlugin({ resourcesPath: opts.resourcesPath }))
  return `${opts.resourcesPath ?? '<dev>'}:${codexPackMarker(opts.appVersion, deepReviewVersion)}`
}

/**
 * Ensure the isolated Codex home exists, carries a login, and has Koda's skills plugin
 * installed. Single-flight per immutable catalog key (concurrent matching sessions share one run);
 * re-installs when a content version or source changes; NEVER rejects (a failure logs + resets so a
 * later session retries, and the session starts regardless — skills are additive).
 */
export function ensureCodexHome(opts: CodexHomeSetupRequest): Promise<void> {
  const key = codexHomeSetupKey(opts)
  if (ready?.key === key) return ready.promise

  // Different catalog sources serialize through the prior flight because they rewrite one isolated
  // plugin cache. Runtime feature toggles deliberately do NOT enter this key: the installed catalog is
  // a superset and each app-server receives its own native enablement in codexSkillConfig.
  const prior = ready?.promise ?? Promise.resolve()
  const owner = {}
  const flight = prior
    .then(() => setup(opts))
    .catch((err) => {
      log.warn('codex-home', 'setup failed (Codex still usable, without Koda skills)', err?.message ?? err)
      if (ready?.owner === owner) ready = null // let a later session retry this exact state
    })
  ready = { key, promise: flight, owner }
  return flight
}

async function setup(opts: CodexHomeSetupRequest): Promise<void> {
  const home = codexHome()
  ensureCodexAuthSeed() // home dir + login (shared with the pre-session probes)

  // Version/source-keyed immutable catalog. Runtime optional-skill state belongs to each app-server.
  const deepReviewSource = resolveDeepReviewPlugin({ resourcesPath: opts.resourcesPath })
  const deepReviewVersion = deepReviewPluginVersion(deepReviewSource)
  const deepReview = deepReviewVersion && deepReviewSource ? deepReviewSource : null
  // Persist the SAME identity used by the in-process flight. If two same-version app/resource bundles
  // share one user-data home, accepting a path-blind disk marker would silently keep the first bundle's
  // cached plugin bodies even though the second flight correctly noticed a different source.
  const markerValue = codexHomeSetupKey(opts)
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
  writeFileSync(join(srcRoot, '.agents', 'plugins', 'marketplace.json'), codexMarketplaceJson(deepReview !== null))
  writeFileSync(join(pluginDir, '.codex-plugin', 'plugin.json'), codexPluginJson(opts.appVersion))
  const packSkills = [...CODEX_PACK_SKILLS, BROWSER_VERIFY_SKILL]
  for (const name of packSkills) {
    const from = join(pack.dir, 'skills', name)
    if (existsSync(from)) cpSync(from, join(pluginDir, 'skills', name), { recursive: true })
  }
  // Codex gets one immutable private catalog. Staged skills remain unreachable when the feature is off
  // because codexSkillConfig disables their exact paths for that app-server process. This differs from
  // Claude's second --plugin-dir but prevents concurrent Codex starts from racing over one shared cache.
  // Absent staging (graduated/stripped build) ⇒ nothing to copy.
  const staging = resolveStagingPack({ resourcesPath: opts.resourcesPath })
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
  // Deep Review stays a real second plugin (and therefore a distinct namespace) instead of being
  // flattened into Koda's behavior pack. Copy the same source Claude loads; its Codex manifest and
  // shared skill already live beside the Claude manifest and named reviewers.
  if (deepReview) {
    cpSync(deepReview.dir, join(srcRoot, 'plugins', DEEP_REVIEW_PLUGIN_NAME), { recursive: true })
  }
  // Install via the codex binary. CODEX_HOME rides buildEngineEnv (engineId:'codex') → these spawns
  // target the isolated home, same as every session spawn. marketplace-add is idempotent.
  const bin = resolveEnginePath({ resourcesPath: opts.resourcesPath, binaryName: 'codex' }).path
  const env = buildEngineEnv(process.env, { engineId: 'codex' })
  const run = (args: string[]) => execFileP(bin, args, { env, timeout: 30_000 })
  await run(['plugin', 'marketplace', 'add', srcRoot])
  await run(['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`])
  const deepReviewId = `${DEEP_REVIEW_PLUGIN_NAME}@${MARKETPLACE_NAME}`
  if (deepReview) {
    await run(['plugin', 'add', deepReviewId])
  } else {
    // Unlike Claude's per-session source list, Codex installations persist in its isolated home.
    // Reconcile absence explicitly so a stripped/older build cannot leave a stale first-party plugin.
    const listed = await run(['plugin', 'list', '--json'])
    const installed = codexInstalledPluginIds(listed.stdout.toString())
    if (!installed) throw new Error('Codex returned an unreadable installed-plugin inventory')
    if (installed.has(deepReviewId)) await run(['plugin', 'remove', deepReviewId])
  }
  writeFileSync(markerPath, markerValue)
  log.info(
    'codex-home',
    `installed Koda plugin (${packSkills.join(', ')} + code-review)${deepReview ? ' + deep-review' : ''} into ${home}`,
  )
}
