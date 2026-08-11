import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GuardrailItemRef, GuardrailSaveRequest, GuardrailsLayer } from '@shared/ipc'
import { loadPackRules, loadPresentation, type PackRule, resolvePack } from './engine/pack'
import { catalogSkillIds } from './engine/skills-catalog'
import {
  principleKey,
  readDisabledSet,
  readOverrides,
  ruleKey,
  setGuardrailsDisabled,
  setPrincipleOverride,
  skillKey,
  subagentKey,
} from './guardrails-config'

/**
 * Enumerate the behavior layer that's shaping the agent, for the Settings → Guardrails surface
 * (architecture/guardrails.md). Two scopes: `koda` = the bundled, curated pack (shared across every
 * project); `project` = this project's own rules/skills/subagents (editable). The user's own
 * `~/.claude` config is deliberately NOT surfaced here — it's their CLI setup, not Koda's layer.
 *
 * Koda rules are presented as a few human-scale **principles** (rules/presentation.json), not the ~20
 * underlying lines — the prompt is untouched, this only changes how the surface groups + toggles them.
 * One principle toggle fans out to its member rule ids (`enabled` is on unless every member is disabled).
 */
type Rule = GuardrailsLayer['rules'][number]
type Item = GuardrailsLayer['skills'][number]

interface ResolvedPrinciple {
  id: string
  title: string
  section: 'core' | 'capability'
  summary: string
  members: PackRule[]
}

export function listGuardrails(projectRoot: string, resourcesPath?: string): GuardrailsLayer {
  const rules: Rule[] = []
  let packSkills: Item[] = []
  let packAgents: Item[] = []
  let projSkills: Item[] = []
  let projAgents: Item[] = []
  const disabled = readDisabledSet(projectRoot)
  const overrides = readOverrides(projectRoot)

  // Koda pack — the curated defaults, grouped into principles. Each principle toggles as a unit. An
  // EDITED principle (`overrides[id]`) shows the user's text + Restore instead of a toggle; skills +
  // subagents load via the plugin dir and switch off via --disallowedTools.
  const pack = resolvePack({ resourcesPath })
  if (pack) {
    for (const p of buildPrinciples(pack.dir)) {
      if (p.members.length === 0) continue
      const customized = p.id in overrides
      rules.push({
        scope: 'koda',
        title: p.title,
        summary: p.summary,
        body: customized ? overrides[p.id] : p.members.map(memberLine).join('\n\n'),
        kind: p.members.some((m) => m.kind === 'safety') ? 'safety' : 'preference',
        section: p.section,
        // Customized ⇒ active unless its override is suppressed (principle key); otherwise on unless
        // every member rule is disabled. Either way the toggle key is the principle id (the handler
        // routes a customized principle's toggle to suppress the override; a pristine one fans out).
        enabled: customized
          ? !disabled.has(principleKey(p.id))
          : !p.members.every((m) => disabled.has(ruleKey(m.id))),
        toggleKey: principleKey(p.id),
        principleId: p.id,
        customized,
      })
    }
    packSkills = readSkills(join(pack.dir, 'skills'), 'koda', disabled)
    packAgents = readAgents(join(pack.dir, 'agents'), 'koda', disabled)
  }

  // This project — its own behavior layer (CLAUDE.md + .claude/skills + .claude/agents).
  if (projectRoot) {
    const claudeMd = join(projectRoot, 'CLAUDE.md')
    if (existsSync(claudeMd)) {
      const body = safeRead(claudeMd).trim()
      // `path` makes this row editable in place; the project's own rules aren't toggled (delete to remove).
      if (body) rules.push({ scope: 'project', title: 'This project (CLAUDE.md)', body, enabled: true, path: claudeMd })
    }
    // Skip catalog skills the user activated for this project — they live in `.claude/skills/<id>`
    // like a hand-made one, but the Skills gallery owns them (turning them on/off). Surfacing them
    // here too would let a Guardrails disable/remove silently contradict the gallery.
    const ownedByGallery = catalogSkillIds(resourcesPath)
    projSkills = readSkills(join(projectRoot, '.claude', 'skills'), 'project', disabled).filter(
      (s) => !ownedByGallery.has(s.name),
    )
    projAgents = readAgents(join(projectRoot, '.claude', 'agents'), 'project', disabled)
  }

  return {
    rules,
    skills: mergeItems(packSkills, projSkills),
    subagents: mergeItems(packAgents, projAgents),
  }
}

/**
 * Fold the pack defaults and the project's own items into one list per kind. A project item that
 * shares a Koda default's name is a *fork* of it: it's marked `isOverride` and supersedes the default
 * (which is dropped, so the surface shows one row per name). Defaults first, then project items.
 */
function mergeItems(packItems: Item[], projItems: Item[]): Item[] {
  const projNames = new Set(projItems.map((i) => i.name))
  const packNames = new Set(packItems.map((i) => i.name))
  const overridden = projItems.map((i) => (packNames.has(i.name) ? { ...i, isOverride: true } : i))
  const remaining = packItems.filter((i) => !projNames.has(i.name))
  return [...remaining, ...overridden]
}

/** Split a rule's bold lead off as the row title; the rest is the revealed "why". */
function splitRule(text: string): { title: string; body: string } {
  const m = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(text.trim())
  return m ? { title: m[1].trim(), body: m[2].trim() } : { title: text.trim(), body: '' }
}

/** A member rule, rendered for the principle's read-only "Show" view (de-asterisked, one per line). */
function memberLine(r: PackRule): string {
  const { title, body } = splitRule(r.text)
  return body ? `${title} — ${body}` : title
}

/**
 * Resolve the pack rules + presentation grouping into the principles the surface shows. Falls back to
 * one principle per rule group when presentation.json is missing, and sweeps any rule the presentation
 * forgot into a trailing "More" principle so nothing live in the prompt goes invisible (or un-toggleable).
 */
function buildPrinciples(packDir: string): ResolvedPrinciple[] {
  const packRules = loadPackRules(packDir)
  if (!packRules) return []
  const byId = new Map<string, PackRule>()
  for (const g of packRules.groups) for (const r of g.rules) byId.set(r.id, r)

  const presentation = loadPresentation(packDir)
  if (!presentation) {
    return packRules.groups.map((g) => ({
      id: g.id,
      title: g.heading,
      section: 'core' as const,
      summary: '',
      members: g.rules,
    }))
  }

  const used = new Set<string>()
  const principles = presentation.map((p) => {
    const members = p.members.map((id) => byId.get(id)).filter((r): r is PackRule => !!r)
    members.forEach((m) => used.add(m.id))
    return { id: p.id, title: p.title, section: p.section, summary: p.summary, members }
  })
  const orphans = [...byId.values()].filter((r) => !used.has(r.id))
  if (orphans.length) {
    principles.push({ id: 'more', title: 'More', section: 'core', summary: '', members: orphans })
  }
  return principles
}

/**
 * Expand a guardrails:setEnabled key into the keys actually written to the disabled set. A principle
 * key fans out to its member `rule:` ids (so toggling the principle toggles all its rules); any other
 * key (a skill/subagent) passes through unchanged.
 */
export function principleMemberKeys(key: string, resourcesPath?: string): string[] {
  if (!key.startsWith('principle:')) return [key]
  const id = key.slice('principle:'.length)
  const pack = resolvePack({ resourcesPath })
  if (!pack) return []
  const p = buildPrinciples(pack.dir).find((x) => x.id === id)
  return p ? p.members.map((m) => ruleKey(m.id)) : []
}

/**
 * Edit a Koda rule principle's wording for this project, or restore the default. Editing forks: the
 * user's `text` is stored as the principle's override AND its member rules are disabled (so the bundled
 * wording drops from the pack prompt and the override is injected in its place — adapter.ts). Passing
 * `null` restores: clear the override and re-enable the members. The prompt for untouched principles is
 * unaffected. Caller checkpoints before this (recoverable).
 */
export function setRuleOverride(
  projectRoot: string,
  resourcesPath: string | undefined,
  principleId: string,
  text: string | null,
): void {
  if (!projectRoot) throw new Error('Open a project first.')
  const memberKeys = principleMemberKeys(principleKey(principleId), resourcesPath)
  if (text === null) {
    setPrincipleOverride(projectRoot, principleId, null, memberKeys)
  } else {
    if (!text.trim()) throw new Error('A rule can’t be empty — restore the default instead.')
    setPrincipleOverride(projectRoot, principleId, text.trim(), memberKeys)
  }
}

/**
 * Write a typed/pasted rule/skill/subagent straight into this project — the "Save" authoring path
 * (no agent round-trip). A rule appends to the project CLAUDE.md (the project's editable rules blob);
 * a skill/subagent is written verbatim to its standard `.claude/` location, named from the pasted
 * frontmatter. The caller (ipc.ts) takes a safety-git checkpoint BEFORE this write, so it's recoverable.
 * Returns the absolute path written. Throws a user-legible Error on bad input (surfaced in the composer).
 */
export async function saveGuardrail(
  projectRoot: string,
  req: GuardrailSaveRequest,
  // Awaited immediately before the actual write — the caller's safety-git checkpoint. Validation
  // (missing name, name clash) throws BEFORE this runs, so a rejected paste never checkpoints.
  beforeWrite: () => Promise<unknown>,
): Promise<{ path: string }> {
  if (!projectRoot) throw new Error('Open a project first.')
  const text = req.text.trim()
  if (!text) throw new Error('Nothing to save.')

  if (req.kind === 'rule') {
    const file = join(projectRoot, 'CLAUDE.md')
    const existing = existsSync(file) ? readFileSync(file, 'utf8').trimEnd() : ''
    await beforeWrite()
    writeFileSync(file, existing ? `${existing}\n\n${text}\n` : `${text}\n`, 'utf8')
    return { path: file }
  }

  // skills/subagents: the name drives the file path, so it must come from the pasted file's frontmatter.
  const name = parseFrontmatter(text).name
  const slug = slugify(name || '')
  if (!slug) {
    throw new Error(
      'This needs a `name:` line at the top (paste the whole file), or use Create with agent to scaffold it.',
    )
  }

  const file =
    req.kind === 'skill'
      ? join(projectRoot, '.claude', 'skills', slug, 'SKILL.md')
      : join(projectRoot, '.claude', 'agents', `${slug}.md`)
  if (existsSync(file)) {
    throw new Error(`A ${req.kind} named “${slug}” already exists — rename it or edit the existing one.`)
  }
  await beforeWrite()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
  return { path: file }
}

/** A safe file/dir slug from a frontmatter name — strips separators/traversal entirely. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Where a skill (a <name>/SKILL.md directory) or subagent (a flat <name>.md) lives in this project
// (.claude/skills//.claude/agents/). NB: save/remove resolve the path from slugify(frontmatter name) —
// assumes a pack item's `name:` equals its on-disk name (true for every current pack item; keep in sync).
const projectItemPath = (root: string, kind: GuardrailItemRef['kind'], slug: string): string =>
  kind === 'skill'
    ? join(root, '.claude', 'skills', slug, 'SKILL.md')
    : join(root, '.claude', 'agents', `${slug}.md`)
const itemKey = (kind: GuardrailItemRef['kind'], slug: string): string =>
  kind === 'skill' ? skillKey(slug) : subagentKey(slug)

/**
 * Save an edited skill/subagent body to this project. For a project item this overwrites its file; for
 * a Koda default it forks — writes the (possibly edited) content into `.claude/`, which then supersedes
 * the bundled one (a project subagent shadows the plugin by precedence; plugin skills are namespaced —
 * claude-code-guide, 2026-06-27). We never `--disallowedTools` the original (that denies by name
 * globally, killing the fork too); instead we ENSURE the name is enabled so the saved copy is invocable.
 * Checkpointed by the caller. Returns the path written.
 */
export async function saveItemBody(
  projectRoot: string,
  ref: GuardrailItemRef,
  content: string,
  beforeWrite: () => Promise<unknown>,
): Promise<{ path: string }> {
  if (!projectRoot) throw new Error('Open a project first.')
  const slug = slugify(ref.name)
  if (!slug) throw new Error('Invalid name.')
  if (!content.trim()) throw new Error('This can’t be empty.')
  const dest = projectItemPath(projectRoot, ref.kind, slug)
  await beforeWrite()
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
  setGuardrailsDisabled(projectRoot, [itemKey(ref.kind, slug)], false)
  return { path: dest }
}

/**
 * Remove a project skill/subagent (delete its file/dir). If it was a fork of a Koda default, the
 * default simply reappears once the project copy is gone (it was never disabled — see forkGuardrailItem).
 * Checkpointed by the caller before the delete (recoverable).
 */
export async function removeGuardrailItem(
  projectRoot: string,
  ref: GuardrailItemRef,
  beforeWrite: () => Promise<unknown>,
): Promise<void> {
  if (!projectRoot) throw new Error('Open a project first.')
  const slug = slugify(ref.name)
  if (!slug) throw new Error('Invalid name.')
  const file = projectItemPath(projectRoot, ref.kind, slug)
  if (!existsSync(file)) throw new Error('That item no longer exists.')
  await beforeWrite()
  // A skill is a directory (<name>/SKILL.md); a subagent is a single file.
  rmSync(ref.kind === 'skill' ? dirname(file) : file, { recursive: true, force: true })
}

/** Skills live at <dir>/<name>/SKILL.md. */
function readSkills(dir: string, scope: Item['scope'], disabled: Set<string>): Item[] {
  return listDir(dir)
    .map((entry) => {
      const file = join(dir, entry, 'SKILL.md')
      return existsSync(file) ? itemFrom(file, entry, scope, disabled, skillKey) : null
    })
    .filter((x): x is Item => x !== null)
}

/** Subagents are flat <dir>/<name>.md files. */
function readAgents(dir: string, scope: Item['scope'], disabled: Set<string>): Item[] {
  return listDir(dir)
    .filter((e) => e.endsWith('.md'))
    .map((entry) => itemFrom(join(dir, entry), entry.replace(/\.md$/, ''), scope, disabled, subagentKey))
}

function itemFrom(
  file: string,
  fallbackName: string,
  scope: Item['scope'],
  disabled: Set<string>,
  keyFor: (name: string) => string,
): Item {
  const content = safeRead(file)
  const fm = parseFrontmatter(content)
  const name = fm.name || fallbackName
  // Uniform: every item — Koda default or the project's own — has an on/off toggle (by name, via
  // --disallowedTools) and is editable in place (the panel edits `body`; saving a Koda default forks
  // it into the project). `openPath` marks a project file (inside the per-window root).
  return {
    scope,
    name,
    description: fm.description || '',
    body: content,
    enabled: !disabled.has(keyFor(name)),
    toggleKey: keyFor(name),
    openPath: scope === 'project' ? file : undefined,
  }
}

/** Pull `name:` / `description:` from a leading YAML frontmatter block (no YAML dep needed). */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const grab = (key: string): string | undefined => {
    const r = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1])
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : undefined
  }
  return { name: grab('name'), description: grab('description') }
}

function listDir(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : []
  } catch {
    return []
  }
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
