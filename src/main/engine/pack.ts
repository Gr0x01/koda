import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import type { EngineId } from '@shared/ipc'
import { principleKey, readDisabledSet, readOverrides, ruleKey } from '../guardrails-config'

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
export const CODEX_PACK_SKILLS = ['memory', 'documents', 'verify', 'frontend-design', 'review-architecture'] as const

/**
 * Built-but-not-shipped skills — they live in the separate `pack-staging` plugin (resolveStagingPack),
 * NOT the main pack, and reach an engine only when the mini-apps dogfood flag is on (loadMiniAppsEnabled):
 * Claude via a second `--plugin-dir` at the staging pack, Codex by copying these from staging into its
 * plugin. Keeping them physically out of the main pack is what makes normal releases ship clean without
 * per-file flag checks. When the mini-apps project ships, graduate the skill back into the main pack +
 * CODEX_PACK_SKILLS and drop it here. See mini-apps-plan.md.
 */
export const GATED_PACK_SKILLS = ['create-mini-app', 'app-data'] as const

/** Bump when same-app-version dogfood must rematerialize the Codex plugin after pack wiring changes. */
export const CODEX_PACK_REVISION = 28

export function codexPackMarker(appVersion: string, playwrightWired: boolean, miniAppsWired: boolean): string {
  return `${appVersion}:pack${CODEX_PACK_REVISION}:pw${playwrightWired ? 1 : 0}:ma${miniAppsWired ? 1 : 0}`
}

export interface PackRule {
  id: string
  kind: 'preference' | 'safety'
  text: string
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
   * `'critique-off'` = the user turned the critique pass off (Settings → General → Finishing work),
   * so the rule standing it down assembles. The always-on `critique-before-done` rule carries the
   * behavior itself, which is why default-ON assembles NO rule here — silence is the on state.
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
    | 'critique-off'
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
        if (!r || typeof r.id !== 'string' || typeof r.text !== 'string') return null
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
 * `disabled` or whose `requires` capability isn't wired (e.g. `requires:'broker'` drops when
 * `opts.brokerWired` is false). A group left with no surviving rules drops its heading too. The
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
    critiqueOff?: boolean
    engine?: EngineId
  } = {},
): string {
  const wired: Record<string, boolean> = {
    broker: !!opts.brokerWired,
    'mini-app': !!opts.miniAppProject,
    'mini-apps-wired': !!opts.miniAppsWired,
    'critique-off': !!opts.critiqueOff,
    'claude-delegation': opts.engine === 'claude',
    'codex-delegation': opts.engine === 'codex',
  }
  const parts: string[] = [`# ${rules.title}`, '', rules.preamble]
  for (const group of rules.groups) {
    const live = group.rules.filter(
      (r) => !disabled.has(ruleKey(r.id)) && (r.requires === undefined || wired[r.requires] === true),
    )
    if (live.length === 0) continue
    parts.push('', `## ${group.heading}`, '', ...live.map((r) => `- ${r.text}`))
  }
  return parts.join('\n').trim()
}

/**
 * Fold the project's memory index + live context straight into the system prompt so the agent SEES
 * them on turn one instead of having to choose to read them. The "read memory on start" rule was pure
 * prompt guidance — a looser instruction-follower skipped it until nudged. Injecting the files here
 * makes memory-loading model- and engine-independent; it does not rely on an engine choosing to read.
 * We inject only the small, always-relevant pair — the one-line-per-note index and active-context —
 * not every note;
 * the agent still opens individual notes on demand, preserving the "read only what you need" design.
 * Missing dir/files ⇒ '' (fails soft; a project without `.koda/memory/` just gets no block).
 */
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

/**
 * Heaviness threshold for the always-injected pair (index + active-context), in characters —
 * ~7.5k tokens at ~4 chars/token, under 4% of the context window. Past it the injected memory starts
 * weighing down every turn of every session, which is the documented failure mode for always-loaded
 * context (bloat degrades compliance). Sized so a freshly-tidied heavy project (~13k measured on the
 * Koda repo) has weeks of normal growth before the pill fires — at 20k it re-fired within a day, a
 * nag instead of a signal. The status bar warns at this line and offers a tidy; it does NOT stop
 * injection — memory still loads in full, heavy or not.
 */
export const MEMORY_HEAVY_CHARS = 30_000

/** How much always-injected memory this project carries, for the status-bar pill + Settings → Memory. */
export function projectMemoryWeight(cwd: string): { present: boolean; chars: number; heavy: boolean } {
  const { index, active } = readMemoryPair(cwd)
  const present = index.length > 0
  const chars = index.length + active.length
  return { present, chars, heavy: present && chars >= MEMORY_HEAVY_CHARS }
}

const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.org'])

/** How much of the user's `Documents/` shape we describe. Depth 3 reaches a topic folder's own
 *  sub-grouping without turning the map into a file listing. Two budgets, not one: `maxNested` stops a
 *  deep subtree from eating the room the TOP-LEVEL folders need (they're the actual filing choice — a
 *  cap that hides them under a header claiming to be the shape is worse than no map at all), and
 *  `maxLines` is the overall ceiling so this can't crowd out the rules above it. */
const DOC_MAP = { maxDepth: 3, maxNested: 60, maxLines: 120 }

/**
 * A compact map of the user's `Documents/` folders (names + how many documents each holds) for the
 * system prompt.
 *
 * The placement rule ("file each new document in the folder it belongs to") was guidance with nothing
 * behind it: an agent about to write a doc had never seen the folders that already exist, so obeying
 * it meant choosing to go list them first — and skipping that step looks exactly like following the
 * rule, right up until you have three sibling folders holding one topic. Showing the shape makes the
 * right placement the cheap one. Counts, never filenames: this is for choosing a folder, and the doc
 * list itself would grow without bound.
 *
 * Missing/empty `Documents/` ⇒ '' (a new project has no shape to honor yet).
 */
function readDocumentsMap(cwd: string): string {
  const lines: string[] = []
  let looseDocs = 0
  let truncated = false
  const walk = (dir: string, name: string, depth: number): void => {
    if (depth > 1 && lines.length >= DOC_MAP.maxNested) return void (truncated = true)
    if (lines.length >= DOC_MAP.maxLines) return void (truncated = true)
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir (missing, EACCES) — fail soft, same as the memory pair
    }
    const docs = entries.filter((e) => e.isFile() && DOC_EXTS.has(extname(e.name).toLowerCase()))
    const count = `${docs.length} doc${docs.length === 1 ? '' : 's'}`
    if (depth > 0) lines.push(`${'  '.repeat(depth - 1)}- ${label(name)}/ — ${count}`)
    else looseDocs = docs.length
    if (depth >= DOC_MAP.maxDepth) return
    // Sorted so the block is stable and scannable rather than in filesystem order — once a cap bites,
    // readdir order would also change WHICH folders survive. `isDirectory()` is false for a symlinked
    // dir, which is what keeps this walk from following a link back to an ancestor: don't swap in
    // statSync to "fix" symlinked folders showing up without adding a visited-set first.
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const e of dirs) walk(join(dir, e.name), e.name, depth + 1)
  }
  walk(join(cwd, 'Documents'), '', 0)
  if (!lines.length && !looseDocs) return ''
  return [
    '# The shape of this project’s `Documents/` (already listed — no need to go look)',
    '',
    'These folders already exist. Put a new document in the one it belongs to; only make a new folder when a genuinely new topic has nothing here that fits, and prefer extending an existing document over adding a parallel one.',
    '',
    ...(looseDocs ? [`- (loose at the \`Documents/\` root) — ${looseDocs} doc${looseDocs === 1 ? '' : 's'}`] : []),
    ...lines,
    // Never let a cut list read as the whole shape — that's what makes an agent confidently duplicate
    // a folder it simply wasn't shown.
    ...(truncated ? ['- …more folders exist below this — list `Documents/` yourself before filing.'] : []),
  ].join('\n')
}

/** A folder name safe to drop into a markdown list line: a newline in a name would otherwise forge a
 *  second list entry (a folder literally named "x\n- invented" reads as two folders). */
function label(name: string): string {
  // Control characters (a newline is the dangerous one) collapse to spaces; hyphens survive.
  return name.replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, 80)
}

function readProjectMemory(cwd: string): string {
  const { index, active } = readMemoryPair(cwd)
  if (!index) return '' // no index ⇒ no memory system to inject
  const parts = [
    '# Project memory (already loaded — do not re-read these files)',
    '',
    'You have been shown this project’s memory index and current context below. Open the individual notes named in the index only as the task needs them; do NOT spend a turn re-reading MEMORY.md or active-context.md — their content is here.',
    '',
    'This pair is also the ONLY memory the next session is guaranteed to see. So when you record something the next session must act on — a handoff, an open problem, a just-reverted approach — put it in active-context.md, or make its MEMORY.md index line point straight at it. A fact left only in a topic note, with no index line leading to it, will not be seen next session.',
    '',
    '## .koda/memory/MEMORY.md',
    '',
    index,
  ]
  if (active) parts.push('', '## .koda/memory/active-context.md', '', active)
  return parts.join('\n')
}

/**
 * The full guardrail system-prompt text for a session: the assembled always-on pack rules (this
 * project's disabled defaults dropped, plus the broker-gated rules dropped when `brokerWired` is false),
 * any edited-principle overrides, the project's memory index + live context folded in (so the agent
 * always sees it rather than relying on a "read memory on start" instruction it might skip), and the
 * shape of the user's `Documents/` so a new doc gets filed instead of dropped anywhere. The ONE
 * assembly both engine drivers share — Claude appends it via `--append-system-prompt`, Codex passes it
 * as additive `developerInstructions`. Returns '' only when every part is empty — no pack, no memory,
 * and no `Documents/` shape to describe.
 */
export function assembleGuardrailText(opts: {
  cwd: string
  resourcesPath?: string
  brokerWired: boolean
  /** This project owns a registered mini app (faces on) — assembles the summon-pill rule. */
  miniAppProject?: boolean
  /** The mini-apps dogfood flag is on (staging create-mini-app skill loaded) — assembles the app-ask routing rule. */
  miniAppsWired?: boolean
  /** The user turned the critique pass off — assembles the stand-down rule (on assembles nothing). */
  critiqueOff?: boolean
  /** The engine this text is for. Reserved for engine-specific assembly differences. */
  engine?: EngineId
}): string {
  const pack = resolvePack({ resourcesPath: opts.resourcesPath })
  const disabled = readDisabledSet(opts.cwd)
  const packRules = pack ? loadPackRules(pack.dir) : null
  const rulesText = packRules
    ? assemblePackRules(packRules, disabled, {
        brokerWired: opts.brokerWired,
        miniAppProject: opts.miniAppProject,
        miniAppsWired: opts.miniAppsWired,
        critiqueOff: opts.critiqueOff,
        engine: opts.engine,
      })
    : ''
  // An edited principle's replacement text, except any whose principle is toggled off.
  const overrideText = Object.entries(readOverrides(opts.cwd))
    .filter(([id]) => !disabled.has(principleKey(id)))
    .map(([, text]) => text)
    .join('\n\n')
  const memoryText = readProjectMemory(opts.cwd)
  const docsMapText = readDocumentsMap(opts.cwd)
  const text = [rulesText, overrideText, memoryText, docsMapText].filter(Boolean).join('\n\n')
  return text
}
