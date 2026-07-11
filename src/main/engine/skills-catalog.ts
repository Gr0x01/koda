import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The Koda skills gallery — a curated, bundled subset of Anthropic's open-source (Apache-2.0) Agent
 * Skills (resources/skills-catalog/, vendored from github.com/anthropics/skills; the source-available
 * office-document skills are deliberately NOT bundled — see NOTICE). Two surfaces:
 *
 * - A few defaults ship ACTIVE out of the box (seeded once into the global plugin dir below).
 * - The rest are discoverable in Settings → Skills and activated with one click.
 *
 * Activation copies a skill folder to one of two places, each a real engine skill-discovery location:
 * - GLOBAL: a Koda-managed plugin dir under userData, loaded for every session via a 2nd `--plugin-dir`
 *   (claude-code-guide 2026-06-28 — `--plugin-dir` is repeatable). Available in every project WITHOUT
 *   touching the user's `~/.claude` (we never pollute their vanilla CLI setup).
 * - PROJECT: `<project>/.claude/skills/<id>` — scoped to this project and, since a project skill
 *   overrides a plugin skill of the same name, also the seam the user forks an edited copy through.
 */
export interface CatalogSkill {
  id: string
  title: string
  category: string
  blurb: string
  /** Human-readable dependency note for the gallery badge ('none' | 'Uses Python' | 'Uses Node'). */
  deps: string
  defaultActive: boolean
}
export interface Catalog {
  version: number
  source: string
  license: string
  skills: CatalogSkill[]
}

/** Where a skill is currently active, layered onto its catalog entry (for the gallery). */
export interface SkillState extends CatalogSkill {
  global: boolean
  project: boolean
}

export type SkillScope = 'global' | 'project'

const PLUGIN_NAME = 'koda-skills'

/**
 * Resolve the bundled catalog dir, mirroring resolvePack(): packaged Resources first, then the in-repo
 * copy for dev. Null when absent (a stripped build / dev before vendoring) — the gallery just shows
 * nothing and sessions still start (additive, never required).
 */
export function resolveCatalogDir(opts: { resourcesPath?: string } = {}): string | null {
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, 'skills-catalog'))
  candidates.push(join(process.cwd(), 'resources', 'skills-catalog'))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'catalog.json'))) return dir
  }
  return null
}

/** Parse catalog.json; missing/malformed ⇒ null (fails soft — read on startup and for the surface). */
export function loadCatalog(dir: string): Catalog | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'))
    if (!raw || !Array.isArray(raw.skills)) return null
    const skills: CatalogSkill[] = []
    for (const s of raw.skills) {
      if (!s || typeof s.id !== 'string' || !s.id) return null
      skills.push({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : s.id,
        category: typeof s.category === 'string' ? s.category : 'Other',
        blurb: typeof s.blurb === 'string' ? s.blurb : '',
        deps: typeof s.deps === 'string' ? s.deps : 'none',
        defaultActive: s.defaultActive === true,
      })
    }
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      source: typeof raw.source === 'string' ? raw.source : '',
      license: typeof raw.license === 'string' ? raw.license : '',
      skills,
    }
  } catch {
    return null
  }
}

/**
 * The set of catalog skill ids — so the Guardrails surface can hide a project-activated catalog skill
 * (it lives in `.claude/skills/<id>` like a hand-made one). Without this the gallery and Guardrails
 * both manage the same folder, and a Guardrails disable/remove silently contradicts the gallery.
 */
export function catalogSkillIds(resourcesPath?: string): Set<string> {
  const dir = resolveCatalogDir({ resourcesPath })
  if (!dir) return new Set()
  const catalog = loadCatalog(dir)
  return new Set(catalog ? catalog.skills.map((s) => s.id) : [])
}

/** The Koda-managed global skills plugin dir (userData/skills/global). */
export function globalSkillsDir(userData: string): string {
  return join(userData, 'skills', 'global')
}

/** Lazily create the plugin manifest + skills/ dir so `--plugin-dir` accepts it. */
function ensureGlobalPlugin(dir: string): void {
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) {
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: PLUGIN_NAME, description: 'Skills you turned on in Koda.', version: '1.0.0' }, null, 2)}\n`,
      'utf8',
    )
  }
  mkdirSync(join(dir, 'skills'), { recursive: true })
}

/**
 * The global plugin dir to add as a `--plugin-dir`, IFF it's a valid plugin holding ≥1 active skill —
 * else null so the adapter omits the flag (an empty plugin dir would otherwise error / load nothing).
 */
export function resolveGlobalSkillsPlugin(userData: string): string | null {
  const dir = globalSkillsDir(userData)
  if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return null
  const skillsDir = join(dir, 'skills')
  try {
    if (readdirSync(skillsDir).length === 0) return null
  } catch {
    return null
  }
  return dir
}

// Seed bookkeeping: which defaults have EVER been seeded. Lets a default seed exactly once, so a user
// who later removes it isn't re-nagged, while an app update that adds a new default still seeds it.
interface SeedState {
  everSeeded: string[]
}
function seedStatePath(userData: string): string {
  return join(userData, 'skills', 'seed-state.json')
}
function readSeedState(userData: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(seedStatePath(userData), 'utf8'))
    return new Set(Array.isArray(raw?.everSeeded) ? raw.everSeeded.filter((x: unknown) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
function writeSeedState(userData: string, seeded: Set<string>): void {
  const file = seedStatePath(userData)
  mkdirSync(dirname(file), { recursive: true })
  const state: SeedState = { everSeeded: [...seeded].sort() }
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Seed the default-active skills into the global plugin dir, once each. Idempotent and removal-safe:
 * a default is copied only if it's never been seeded before, then recorded — so the user's later
 * removal sticks and an app update only adds genuinely-new defaults. Called once at startup; fails
 * soft (the gallery still works, defaults just won't be present).
 */
export function ensureGlobalSkillsSeeded(userData: string, resourcesPath?: string): void {
  const catalogDir = resolveCatalogDir({ resourcesPath })
  if (!catalogDir) return
  const catalog = loadCatalog(catalogDir)
  if (!catalog) return
  const dir = globalSkillsDir(userData)
  ensureGlobalPlugin(dir)
  const seeded = readSeedState(userData)
  let changed = false
  for (const s of catalog.skills) {
    if (!s.defaultActive || seeded.has(s.id)) continue
    const src = join(catalogDir, 'skills', s.id)
    const dest = join(dir, 'skills', s.id)
    if (!existsSync(src)) continue // a broken/missing default — don't mark seeded, retry on a later build
    if (!existsSync(dest)) {
      try {
        cpSync(src, dest, { recursive: true })
      } catch {
        rmSync(dest, { recursive: true, force: true }) // drop a partial copy; retry next run, unmarked
        continue
      }
    }
    seeded.add(s.id) // only after the skill is actually present
    changed = true
  }
  if (changed) writeSeedState(userData, seeded)
}

// A skill id is also a single directory segment we copy/remove (under userData or .claude/skills) —
// constrain it to a safe slug so a crafted id can never traverse out and rmSync/cp an arbitrary path.
// The IPC schema enforces the same shape; this is the module's own guard (it's exported + reusable).
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/
function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error('Invalid skill id.')
}

/** Destination dir for a skill at a given scope. */
function destFor(scope: SkillScope, id: string, userData: string, projectRoot?: string): string {
  assertSafeId(id)
  if (scope === 'global') return join(globalSkillsDir(userData), 'skills', id)
  if (!projectRoot) throw new Error('Open a project first.')
  return join(projectRoot, '.claude', 'skills', id)
}

interface MutateOpts {
  id: string
  scope: SkillScope
  userData: string
  projectRoot?: string
  resourcesPath?: string
  /** The caller's safety-git checkpoint, awaited immediately before a PROJECT-scope fs write (so it's
   *  recoverable). Global-scope writes land in userData, outside any project — no checkpoint needed. */
  beforeWrite?: () => Promise<unknown>
}

/** Turn a catalog skill on at the given scope (copy its folder in). No-op if already active. */
export async function activateSkill(opts: MutateOpts): Promise<void> {
  const catalogDir = resolveCatalogDir({ resourcesPath: opts.resourcesPath })
  if (!catalogDir) throw new Error('The skills catalog is unavailable.')
  const catalog = loadCatalog(catalogDir)
  if (!catalog || !catalog.skills.some((s) => s.id === opts.id)) throw new Error('Unknown skill.')
  const src = join(catalogDir, 'skills', opts.id)
  if (!existsSync(src)) throw new Error('That skill is no longer available.')
  if (opts.scope === 'global') ensureGlobalPlugin(globalSkillsDir(opts.userData))
  const dest = destFor(opts.scope, opts.id, opts.userData, opts.projectRoot)
  if (existsSync(dest)) return
  if (opts.scope === 'project') await opts.beforeWrite?.()
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
}

/** Turn a skill off at the given scope (delete its folder). No-op if not active. */
export async function deactivateSkill(opts: MutateOpts): Promise<void> {
  const dest = destFor(opts.scope, opts.id, opts.userData, opts.projectRoot)
  if (!existsSync(dest)) return
  if (opts.scope === 'project') await opts.beforeWrite?.()
  rmSync(dest, { recursive: true, force: true })
}

/** The catalog with each skill's current active-scopes layered on, for the gallery. */
export function listSkillState(opts: {
  userData: string
  projectRoot?: string
  resourcesPath?: string
}): SkillState[] {
  const catalogDir = resolveCatalogDir({ resourcesPath: opts.resourcesPath })
  if (!catalogDir) return []
  const catalog = loadCatalog(catalogDir)
  if (!catalog) return []
  const gSkills = join(globalSkillsDir(opts.userData), 'skills')
  const pSkills = opts.projectRoot ? join(opts.projectRoot, '.claude', 'skills') : null
  return catalog.skills.map((s) => ({
    ...s,
    global: existsSync(join(gSkills, s.id)),
    project: !!pSkills && existsSync(join(pSkills, s.id)),
  }))
}
