import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { EngineId } from '@shared/ipc'
import { principleKey, readDisabledSet, readOverrides, ruleKey, skillKey } from '../guardrails-config'
import { projectSkillCollisionNames } from '../project-skills'
import { engineCapabilities } from '@shared/engine-capabilities'

/**
 * The Koda behavior-layer pack — a Claude Code plugin (skills + specialist subagents) plus a
 * structured `rules/rules.json` of always-on judgment. Loaded into every engine session: the plugin
 * via `--plugin-dir`, the rules via the system-prompt channel (spike/plugin-load: plugin CLAUDE.md
 * is NOT auto-injected, but `--plugin-dir` delivers agents/skills and `--append-system-prompt`
 * delivers always-on rules). Shipped, versioned with the app — NOT written into the user's project
 * or `~/.claude` (architecture/guardrails.md §4.1).
 *
 * Rules are discrete + addressable (each has a stable id + a preference/safety kind) so a project can
 * switch individual defaults off (guardrails-config.ts); assembly drops the disabled ones from the
 * prompt. A `safety` rule guards an irreversible/destructive action — disabling it is a deliberate act.
 */
export interface PackLocation {
  /** The plugin root passed to `--plugin-dir`. */
  dir: string
}

/** Skills from the shared Claude pack that Koda also installs into its isolated Codex plugin. Keep
 * this list explicit: browser-verify remains capability-gated and Codex-only supplements live apart.
 * Every skill shipped to Codex also carries `agents/openai.yaml` interface metadata (display name,
 * short description, default prompt) — OpenAI's own curated skills do 20/20; match that convention
 * when adding a skill here. Claude ignores the `agents/` folder. */
export const CODEX_PACK_SKILLS = [
  'goal',
  'memory',
  'documents',
  'shape-new-work',
  'code-work',
  'git-work',
  'finish-work',
  'review-work',
  'research',
  'fan-out-work',
  'verify',
  'frontend-design',
  'review-architecture',
] as const

/**
 * Built-but-not-shipped skills — they live in the separate `pack-staging` plugin (resolveStagingPack),
 * NOT the main pack, and reach an engine only when the mini-apps dogfood flag is on (loadMiniAppsEnabled):
 * Claude via a second `--plugin-dir` at the staging pack; Codex keeps an immutable private catalog and
 * disables these paths natively for every flag-off app-server spawn. Keeping them physically out of the
 * main pack keeps Claude's normal release path clean, while per-process Codex enablement avoids rewriting
 * one shared plugin cache under concurrent sessions. When mini-apps ships, graduate the skill back into
 * the main pack + CODEX_PACK_SKILLS and drop it here. See mini-apps-plan.md.
 */
export const GATED_PACK_SKILLS = ['create-mini-app', 'app-data'] as const

/** The shared playbook that is usable only when Koda wires Playwright for the session. */
export const BROWSER_VERIFY_SKILL = 'browser-verify'

/** Whether this project's guardrail switches leave at least one Koda playbook intentionally enabled.
 * Runtime attestation answers whether it loaded; this answers only expected vs deliberately disabled. */
export function kodaPlaybooksExpected(
  cwd: string,
  opts: { includeBrowser?: boolean; includeGated?: boolean } = {},
): boolean {
  const disabled = readDisabledSet(cwd)
  const names: readonly string[] = [
    ...CODEX_PACK_SKILLS,
    ...(opts.includeBrowser ? [BROWSER_VERIFY_SKILL] : []),
    ...(opts.includeGated ? GATED_PACK_SKILLS : []),
  ]
  return names.some((name) => !disabled.has(skillKey(name)))
}

/** Standalone first-party plugin loaded beside the behavior pack on both engines. Keeping its own
 * namespace proves the plugin seam without folding an expensive, explicit workflow into Koda's core
 * review route. */
export const DEEP_REVIEW_PLUGIN_NAME = 'deep-review'

/** Bump when same-app-version dogfood must rematerialize the Codex plugin after pack wiring changes. */
export const CODEX_PACK_REVISION = 38

export function codexPackMarker(appVersion: string, deepReviewVersion: string | null): string {
  const deepReviewRevision = deepReviewVersion ? encodeURIComponent(deepReviewVersion) : 'none'
  return `${appVersion}:pack${CODEX_PACK_REVISION}:dr${deepReviewRevision}`
}

export interface PackRule {
  id: string
  kind: 'preference' | 'safety'
  text: string
  /** Runtime-only dogfood rule. It still participates in prompt assembly and capability gates, but
   * does not appear as an orphaned toggle in the public Settings → Guardrails presentation. */
  internal?: boolean
  /** Native playbook this compact route names. Disabling that playbook removes the route too, so the
   * prompt never asks an engine to load guidance the user deliberately switched off. */
  targetSkill?: string
  /**
   * Gate: the rule only assembles into the prompt when that capability is wired. `'broker'` = the
   * in-process MCP broker is present, so the tools the rule names (`mcp__koda_broker__*`) actually
   * exist. Omitted ⇒ always applies. Keeps broker-only tool-steering out of standalone/dev sessions
   * (no broker = no preview/ensure-tool tools to point at). Author tool names the Claude way
   * (`mcp__<server>__<tool>`); both engines expose Koda's MCP tools under that name.
   * `'mini-app'` = this project has a registered mini app (and the faces feature is on), so the
   * summon-pill rule applies — without it the rule would describe chrome that doesn't exist.
   * `'mini-apps-wired'` = the mini-apps dogfood flag is on, so the staging create-mini-app skill is
   * loaded — gates the routing rule that hands app-shaped asks to that skill (naming an absent skill
   * would dangle). Distinct from `'mini-app'`: wired = the feature exists, mini-app = THIS project has one.
   * `'critique-on'` = the review preference is enabled (Settings → General → Finishing work), so the
   * compact route to `review-work` assembles. Turning the preference off removes the instruction;
   * there is no contradictory stand-down prose.
   * `'orchestrator-session'` = this install's session role is orchestrator, so the compact route to
   * `fan-out-work` assembles. The playbook owns engine-specific mechanics and keeps atomic work local.
   *
   * Gates FAIL CLOSED: a `requires` value this code doesn't know drops the rule (see assemblePackRules).
   * `'claude-delegation'` = Claude's named, capability-bounded leaf profiles are loaded.
   * `'codex-delegation'` = Codex's generic collaboration agents are available; the paired rule avoids
   * pretending those agents have Claude's named profiles or isolated worktree guarantee.
   */
  requires?:
    | 'broker'
    | 'mini-app'
    | 'mini-apps-wired'
    | 'critique-on'
    | 'orchestrator-session'
    | 'claude-delegation'
    | 'codex-delegation'
}
export interface PackRuleGroup {
  id: string
  heading: string
  rules: PackRule[]
}
export interface PackRules {
  title: string
  preamble: string
  groups: PackRuleGroup[]
}

/**
 * A presentation-only grouping of the pack rules into human-scale principles, for the
 * Settings → Guardrails surface (rules/presentation.json). NOT part of the prompt — the engine
 * assembles its system prompt from `rules.json` alone (assemblePackRules). A principle bundles a set
 * of member rule ids under one title + plain-language summary; its on/off toggle fans out to those
 * member ids through the existing per-id disable mechanism (guardrails.ts). `section` separates the
 * always-applies core from a capability module (code) that only matters when the work calls for it.
 */
export interface PackPrinciple {
  id: string
  title: string
  section: 'core' | 'capability'
  summary: string
  members: string[]
}

/**
 * Resolve the bundled pack, mirroring resolveEnginePath(): packaged Resources first, then the
 * in-repo copy for dev. Returns null when no pack is present (dev before it's authored / a
 * stripped build) so sessions still start — the pack is additive, never required to run.
 *
 * @param opts.resourcesPath  process.resourcesPath in the packaged app (omit in tests/dev).
 */
export function resolvePack(opts: { resourcesPath?: string } = {}): PackLocation | null {
  const candidates: string[] = []
  // 1. Packaged: <Resources>/pack (electron-builder extraResources).
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, 'pack'))
  // 2. Dev: the in-repo source (committed, unlike the fetched engine binary).
  candidates.push(join(process.cwd(), 'resources', 'pack'))

  for (const dir of candidates) {
    // A valid plugin has the manifest; without it `--plugin-dir` would error.
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      return { dir }
    }
  }
  return null
}

/**
 * Resolve the staging pack (GATED_PACK_SKILLS) the same way as resolvePack — packaged Resources first,
 * then the in-repo copy. Its skills only reach an engine when the caller has decided the mini-apps flag
 * is on (loadMiniAppsEnabled); this just locates the dir. Returns null when absent (stripped build /
 * once the pieces have graduated into the main pack and staging is empty).
 */
export function resolveStagingPack(opts: { resourcesPath?: string } = {}): PackLocation | null {
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, 'pack-staging'))
  candidates.push(join(process.cwd(), 'resources', 'pack-staging'))
  for (const dir of candidates) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return { dir }
  }
  return null
}

/** Resolve the standalone Deep Review plugin. It stays outside `pack`: Claude therefore exposes its
 * own `deep-review:*` namespace, while Codex installs the same source as a second native plugin. */
export function resolveDeepReviewPlugin(opts: { resourcesPath?: string } = {}): PackLocation | null {
  const candidates: string[] = []
  if (opts.resourcesPath) candidates.push(join(opts.resourcesPath, 'plugins', DEEP_REVIEW_PLUGIN_NAME))
  candidates.push(join(process.cwd(), 'resources', 'plugins', DEEP_REVIEW_PLUGIN_NAME))
  for (const dir of candidates) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return { dir }
  }
  return null
}

/** The standalone plugin owns its Codex cache revision in its native manifest. Returning null for a
 * missing or malformed manifest keeps Claude's independently valid half loadable while Codex fails
 * closed instead of installing content it cannot version. Bump this version when the plugin changes. */
export function deepReviewPluginVersion(plugin: PackLocation | null): string | null {
  if (!plugin) return null
  try {
    const raw = JSON.parse(readFileSync(join(plugin.dir, '.codex-plugin', 'plugin.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null
  } catch {
    return null
  }
}

/**
 * Parse the structured rules source; missing/unreadable/malformed ⇒ null (the plugin half still
 * loads). Validated through to the rule level so a bad hand-edit of rules.json fails SOFT (no rules)
 * rather than throwing in assemblePackRules at session spawn — this file is loaded for every session.
 */
export function loadPackRules(dir: string): PackRules | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'rules', 'rules.json'), 'utf8'))
    if (!raw || typeof raw.title !== 'string' || typeof raw.preamble !== 'string' || !Array.isArray(raw.groups)) {
      return null
    }
    for (const g of raw.groups) {
      if (!g || typeof g.heading !== 'string' || !Array.isArray(g.rules)) return null
      for (const r of g.rules) {
        if (
          !r ||
          typeof r.id !== 'string' ||
          typeof r.text !== 'string' ||
          (r.targetSkill !== undefined && typeof r.targetSkill !== 'string')
        ) return null
      }
    }
    return raw as PackRules
  } catch {
    return null
  }
}

/**
 * Parse the presentation grouping; missing/unreadable/malformed ⇒ null (the surface falls back to
 * one principle per rule group, so it never breaks). Like loadPackRules this fails SOFT — it's read
 * for the Settings surface, never for the prompt.
 */
export function loadPresentation(dir: string): PackPrinciple[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'rules', 'presentation.json'), 'utf8'))
    if (!raw || !Array.isArray(raw.principles)) return null
    const out: PackPrinciple[] = []
    for (const p of raw.principles) {
      if (!p || typeof p.id !== 'string' || typeof p.title !== 'string' || !Array.isArray(p.members)) return null
      out.push({
        id: p.id,
        title: p.title,
        section: p.section === 'capability' ? 'capability' : 'core',
        summary: typeof p.summary === 'string' ? p.summary : '',
        members: p.members.filter((m: unknown): m is string => typeof m === 'string'),
      })
    }
    return out
  } catch {
    return null
  }
}

/**
 * Assemble the always-on rules text for `--append-system-prompt`, omitting any rule whose key is in
 * `disabled`, whose target playbook is disabled, or whose `requires` capability isn't wired (e.g.
 * `requires:'broker'` drops when `opts.brokerWired` is false). A group left with no surviving rules drops its heading too. The
 * framing preamble always rides along (it's the agent's footing, not a toggleable rule). Returns ''
 * only if there's no source.
 *
 * Gates are a lookup keyed by `requires`, and an UNKNOWN key drops the rule — fail CLOSED. rules.json
 * is read from disk at spawn, so it can be newer than this code (a dev app left running across a pack
 * change, a hand-edited pack). The old chain of `!==` clauses let a requires value it didn't recognise
 * sail through: that's how `critique-stood-down` assembled into every session — telling the agent the
 * critique pass was off — while the setting was on. A gate that fails open isn't a gate.
 */
export function assemblePackRules(
  rules: PackRules,
  disabled: Set<string>,
  opts: {
    brokerWired?: boolean
    miniAppProject?: boolean
    miniAppsWired?: boolean
    critiqueOn?: boolean
    orchestratorSession?: boolean
    engine?: EngineId
  } = {},
): string {
  const wired: Record<string, boolean> = {
    broker: !!opts.brokerWired,
    'mini-app': !!opts.miniAppProject,
    'mini-apps-wired': !!opts.miniAppsWired,
    'critique-on': opts.critiqueOn === true,
    'orchestrator-session': !!opts.orchestratorSession,
    // Delegation guidance follows how this engine actually launches children, not its name: Claude's
    // Agent tool vs Codex's spawned collaboration threads.
    'claude-delegation': engineCapabilities(opts.engine).delegation === 'subagents',
    'codex-delegation': engineCapabilities(opts.engine).delegation === 'collab',
  }
  const parts: string[] = [`# ${rules.title}`, '', rules.preamble]
  for (const group of rules.groups) {
    const live = group.rules.filter(
      (r) =>
        !disabled.has(ruleKey(r.id)) &&
        (!r.targetSkill || !disabled.has(skillKey(r.targetSkill))) &&
        (r.requires === undefined || wired[r.requires] === true),
    )
    if (live.length === 0) continue
    parts.push('', `## ${group.heading}`, '', ...live.map((r) => `- ${r.text}`))
  }
  return parts.join('\n').trim()
}

/** Read the memory navigation pair for library-health measurement only. Neither file is assembled into
 * the session prompt; the project card points at them and the memory playbook retrieves them on demand. */
function readMemoryPair(cwd: string): { index: string; active: string } {
  const dir = join(cwd, '.koda', 'memory')
  const read = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8').trim()
    } catch {
      return ''
    }
  }
  return { index: read('MEMORY.md'), active: read('active-context.md') }
}

/** Heaviness threshold for the navigation pair (index + active-context), in characters. Above this,
 * finding the right topic becomes unreliable even though the files are retrieved only when relevant.
 * The existing threshold keeps the tidy signal occasional rather than turning normal growth into a nag. */
export const MEMORY_HEAVY_CHARS = 30_000

/** How large the project's memory navigation pair has grown, for the status-bar pill + Settings. */
export function projectMemoryWeight(cwd: string): { present: boolean; chars: number; heavy: boolean } {
  const { index, active } = readMemoryPair(cwd)
  const present = index.length > 0
  const chars = index.length + active.length
  return { present, chars, heavy: present && chars >= MEMORY_HEAVY_CHARS }
}

/** The source card is intentionally tiny and parseable. The fixed cap prevents a hand-edited card
 *  from turning back into the project narrative this layer replaces. Detailed context stays behind
 *  the fixed memory pointers and is retrieved through the memory playbook. */
export const PROJECT_CARD_MAX_CHARS = 700
const PROJECT_CARD_POINTER =
  'Before changing files, read an existing `CLAUDE.md` or `AGENTS.md`. Deeper context: `.koda/memory/MEMORY.md`; current state: `.koda/memory/active-context.md`; open only relevant notes.'

function cardField(source: string, label: 'What' | 'Now' | 'Critical'): string {
  const line = source.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(`${label}:`))
  if (!line) return ''
  return line
    .slice(line.indexOf(':') + 1)
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
}

/** Keep bounded fields readable. Prefer the last complete word that uses most of the available room;
 * a single very long token still gets a hard cut rather than breaking the card's total budget. */
function truncateCardField(value: string, max: number): string {
  if (value.length <= max) return value
  if (max <= 1) return ''
  const prefix = value.slice(0, max - 1).trimEnd()
  const wordBreak = prefix.lastIndexOf(' ')
  const cut = wordBreak >= Math.floor(max * 0.6) ? prefix.slice(0, wordBreak) : prefix
  return cut ? `${cut}…` : ''
}

/** A bounded always-loaded identity + routing card. Missing or malformed files fail soft to the
 *  sanitized project folder name; read-only conversation never creates the card as a side effect. */
export function readProjectCard(cwd: string): string {
  let source = ''
  try {
    // The card's source contract is itself 700 characters. Bound parsing too, so one malformed file
    // cannot turn this tiny ambient route into arbitrary startup work.
    source = readFileSync(join(cwd, '.koda', 'memory', 'project-card.md'), 'utf8').slice(0, PROJECT_CARD_MAX_CHARS)
  } catch {
    // A project does not need a memory system to get a truthful, bounded identity card.
  }
  const projectName = basename(cwd).replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, 80) || 'this project'
  let what = cardField(source, 'What') || `Project folder \`${projectName}\`.`
  let now = cardField(source, 'Now')
  let critical = cardField(source, 'Critical')
  const render = (): string =>
    [
      '# Project card',
      '',
      `What: ${what}`,
      ...(now ? [`Now: ${now}`] : []),
      ...(critical ? [`Critical: ${critical}`] : []),
      '',
      PROJECT_CARD_POINTER,
    ].join('\n')

  // The public contract is one assembled budget, not three arbitrary field caps. Preserve Critical
  // intact whenever possible because it carries the high-consequence route; reclaim space from Now,
  // then What, before shortening it. All shortening happens at a word boundary.
  let overflow = render().length - PROJECT_CARD_MAX_CHARS
  if (overflow > 0 && now) {
    const target = now.length - overflow
    now = target >= 16 ? truncateCardField(now, target) : ''
  }
  overflow = render().length - PROJECT_CARD_MAX_CHARS
  if (overflow > 0) what = truncateCardField(what, Math.max(16, what.length - overflow))
  overflow = render().length - PROJECT_CARD_MAX_CHARS
  if (overflow > 0 && critical) critical = truncateCardField(critical, Math.max(0, critical.length - overflow))
  overflow = render().length - PROJECT_CARD_MAX_CHARS
  if (overflow > 0) what = truncateCardField(what, Math.max(1, what.length - overflow))
  return render()
}

/**
 * The full guardrail system-prompt text for a session: the assembled always-on pack rules (this
 * project's disabled defaults dropped, plus the broker-gated rules dropped when `brokerWired` is false),
 * any edited-principle overrides, and the project's bounded identity/routing card. Detailed memory
 * and the live `Documents/` shape are retrieved by their native playbooks only when work calls for
 * them. The ONE
 * assembly both engine drivers share — Claude appends it via `--append-system-prompt`, Codex passes it
 * as additive `developerInstructions`. A bounded fallback card means a valid cwd always has something
 * truthful to describe even when the optional pack is absent.
 */
export function assembleGuardrailText(opts: {
  cwd: string
  resourcesPath?: string
  brokerWired: boolean
  /** This project owns a registered mini app (faces on) — assembles the summon-pill rule. */
  miniAppProject?: boolean
  /** The mini-apps dogfood flag is on (staging create-mini-app skill loaded) — assembles the app-ask routing rule. */
  miniAppsWired?: boolean
  /** The user explicitly enabled the optional fresh-review route. */
  critiqueOn?: boolean
  /** This install starts sessions as parent orchestrators — adds the compact fan-out route. */
  orchestratorSession?: boolean
  /** The engine this text is for. Reserved for engine-specific assembly differences. */
  engine?: EngineId
}): string {
  const pack = resolvePack({ resourcesPath: opts.resourcesPath })
  const disabled = new Set(readDisabledSet(opts.cwd))
  // One ambiguous project identity disables every consumer, including compact routes that name a
  // bundled skill of the same name. The engines and Settings read this same collision source.
  for (const name of projectSkillCollisionNames(opts.cwd)) disabled.add(skillKey(name))
  const packRules = pack ? loadPackRules(pack.dir) : null
  const rulesText = packRules
    ? assemblePackRules(packRules, disabled, {
        brokerWired: opts.brokerWired,
        miniAppProject: opts.miniAppProject,
        miniAppsWired: opts.miniAppsWired,
        critiqueOn: opts.critiqueOn,
        orchestratorSession: opts.orchestratorSession,
        engine: opts.engine,
      })
    : ''
  // An edited principle's replacement text, except any whose principle is toggled off.
  const overrideText = Object.entries(readOverrides(opts.cwd))
    .filter(([id]) => !disabled.has(principleKey(id)))
    .map(([, text]) => text)
    .join('\n\n')
  const projectCardText = readProjectCard(opts.cwd)
  const text = [rulesText, overrideText, projectCardText].filter(Boolean).join('\n\n')
  return text
}
