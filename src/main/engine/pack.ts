import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineId } from '@shared/ipc'
import { principleKey, readDisabledSet, readOverrides, ruleKey } from '../guardrails-config'

/**
 * Rewrite Claude-style MCP tool names (`mcp__<server>__<tool>`) to the Codex convention
 * (`<server>__<tool>` — verified against a real Codex session: an MCP server `posthog` surfaces
 * `posthog__query`, no `mcp__` prefix). The rules and skills author tool names the Claude way (Koda's
 * primary engine); this makes those same references correct when they're handed to Codex, so a rule
 * that says "call `mcp__koda_broker__preview`" points Codex at the tool it actually sees (`koda_broker__preview`).
 * Scoped to the MCP servers Koda ships (broker + Playwright) so it can't touch unrelated prose.
 */
const KODA_MCP_SERVERS = ['koda_broker', 'playwright'] as const
export function toCodexToolNames(text: string): string {
  let out = text
  for (const server of KODA_MCP_SERVERS) out = out.replaceAll(`mcp__${server}__`, `${server}__`)
  return out
}

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

export interface PackRule {
  id: string
  kind: 'preference' | 'safety'
  text: string
  /**
   * Gate: the rule only assembles into the prompt when that capability is wired. `'broker'` = the
   * in-process MCP broker is present, so the tools the rule names (`mcp__koda_broker__*`) actually
   * exist. Omitted ⇒ always applies. Keeps broker-only tool-steering out of standalone/dev sessions
   * (no broker = no preview/ensure-tool tools to point at). Author tool names the Claude way
   * (`mcp__<server>__<tool>`); assembleGuardrailText rewrites them per-engine (toCodexToolNames).
   */
  requires?: 'broker'
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
 */
export function assemblePackRules(
  rules: PackRules,
  disabled: Set<string>,
  opts: { brokerWired?: boolean } = {},
): string {
  const parts: string[] = [`# ${rules.title}`, '', rules.preamble]
  for (const group of rules.groups) {
    const live = group.rules.filter(
      (r) => !disabled.has(ruleKey(r.id)) && (r.requires !== 'broker' || opts.brokerWired),
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
 * makes memory-loading model-independent (and engine-independent: Codex has no hooks). We inject only
 * the small, always-relevant pair — the one-line-per-note index and active-context — not every note;
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
 * any edited-principle overrides, and the project's memory index + live context folded in (so the agent
 * always sees it rather than relying on a "read memory on start" instruction it might skip). The ONE
 * assembly both engine drivers share — Claude appends it via `--append-system-prompt`, Codex passes it
 * as additive `developerInstructions`. Returns '' when no pack resolves and there's no memory to inject.
 */
export function assembleGuardrailText(opts: {
  cwd: string
  resourcesPath?: string
  brokerWired: boolean
  /** The engine this text is for. `'codex'` rewrites MCP tool names to the Codex convention
   *  (see toCodexToolNames); Claude (default) is byte-identical to before. */
  engine?: EngineId
}): string {
  const pack = resolvePack({ resourcesPath: opts.resourcesPath })
  const disabled = readDisabledSet(opts.cwd)
  const packRules = pack ? loadPackRules(pack.dir) : null
  const rulesText = packRules
    ? assemblePackRules(packRules, disabled, { brokerWired: opts.brokerWired })
    : ''
  // An edited principle's replacement text, except any whose principle is toggled off.
  const overrideText = Object.entries(readOverrides(opts.cwd))
    .filter(([id]) => !disabled.has(principleKey(id)))
    .map(([, text]) => text)
    .join('\n\n')
  const memoryText = readProjectMemory(opts.cwd)
  const text = [rulesText, overrideText, memoryText].filter(Boolean).join('\n\n')
  return opts.engine === 'codex' ? toCodexToolNames(text) : text
}
