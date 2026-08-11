import { constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './logger'
import { writeFileAtomic } from './atomic-write'

/**
 * Per-project behavior-layer config at `<project>/.koda/guardrails.json`. Two parts, both reversible:
 * - `disabled`: typed keys of bundled defaults switched OFF (`rule:<id>` / `skill:<name>` /
 *   `subagent:<name>`). The default stays in the immutable pack, so "restore" = remove the key.
 * - `overrides`: per-principle edited rule text (`{ <principleId>: text }`). When a principle is
 *   edited, its member rules are added to `disabled` (so the pack copy drops) and the user's text is
 *   stored here + injected at the prompt seam; "restore default" deletes the entry and re-enables them.
 *
 * Covered by safety-git (not in the scratch/safety EXCLUDE), so changes are themselves recoverable; kept
 * out of the user's git by the broader `.koda/` exclude (project-local config, doesn't travel in commits).
 */
export interface GuardrailsConfig {
  disabled: string[]
  overrides: Record<string, string>
}

function configPath(projectRoot: string): string {
  return join(projectRoot, '.koda', 'guardrails.json')
}

type ReadResult = { config: GuardrailsConfig; writable: boolean }

/**
 * Reads fail open for prompt assembly, but a failed read must never authorize a later read-modify-write
 * from empty defaults. A missing file is first use and remains writable.
 */
function readConfig(projectRoot: string): ReadResult {
  const empty = { disabled: [], overrides: {} }
  if (!projectRoot) return { config: empty, writable: true }
  const file = configPath(projectRoot)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid guardrail settings shape')
    if (raw.disabled !== undefined && (!Array.isArray(raw.disabled) || raw.disabled.some((x: unknown) => typeof x !== 'string'))) {
      throw new Error('invalid guardrail disabled settings')
    }
    if (raw.overrides !== undefined && (!raw.overrides || typeof raw.overrides !== 'object' || Array.isArray(raw.overrides))) {
      throw new Error('invalid guardrail override settings')
    }
    const disabled = (raw.disabled ?? []) as string[]
    const overrides: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.overrides ?? {})) {
      if (typeof v !== 'string') throw new Error('invalid guardrail override text')
      overrides[k] = v
    }
    return { config: { disabled, overrides }, writable: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: empty, writable: true }
    log.warn(
      'guardrails',
      'guardrail settings are present but unreadable; preserving them',
      err instanceof Error ? err.message : err,
    )
    try {
      copyFileSync(file, `${file}.corrupt.bak`, constants.COPYFILE_EXCL)
    } catch {
      // The original stays in place; most importantly, this read cannot authorize a write.
    }
    return { config: empty, writable: false }
  }
}

function configForWrite(projectRoot: string): GuardrailsConfig {
  const result = readConfig(projectRoot)
  if (!result.writable) {
    throw new Error('Guardrail settings could not be read. Your existing settings were left unchanged.')
  }
  return result.config
}

function writeConfig(projectRoot: string, cfg: GuardrailsConfig): void {
  const file = configPath(projectRoot)
  mkdirSync(dirname(file), { recursive: true })
  const sorted = { disabled: [...cfg.disabled].sort(), overrides: cfg.overrides }
  writeFileAtomic(file, `${JSON.stringify(sorted, null, 2)}\n`)
}

export function readDisabledSet(projectRoot: string): Set<string> {
  const disabled = new Set(readConfig(projectRoot).config.disabled)
  // The Codex-specific delegation rule was added after projects could already switch the owning code
  // principle off. Mirror that established key in memory so the new engine variant cannot silently
  // re-enable itself; the next explicit principle toggle writes/removes both current member keys.
  if (disabled.has('rule:delegate-independent-work')) {
    disabled.add('rule:delegate-independent-work-codex')
  }
  return disabled
}

/** The per-principle edited rule text overriding the bundled default ({ principleId: text }). */
export function readOverrides(projectRoot: string): Record<string, string> {
  return readConfig(projectRoot).config.overrides
}

/**
 * Switch keys off (`disabled: true`) or back on in one write. A principle toggle (Settings →
 * Guardrails) fans out to all its member rule keys through this, so flipping one switch — or one
 * skill/subagent — is a single file write. Preserves `overrides`. Idempotent.
 */
export function setGuardrailsDisabled(projectRoot: string, keys: string[], disabled: boolean): void {
  if (!projectRoot) throw new Error('Open a project first.')
  if (keys.length === 0) return
  const cfg = configForWrite(projectRoot)
  const set = new Set(cfg.disabled)
  for (const key of keys) {
    if (disabled) set.add(key)
    else set.delete(key)
  }
  writeConfig(projectRoot, { ...cfg, disabled: [...set] })
}

/** Set (or clear, with `null`) a principle's edited text. Preserves `disabled`. */
export function setOverride(projectRoot: string, principleId: string, text: string | null): void {
  if (!projectRoot) throw new Error('Open a project first.')
  const cfg = configForWrite(projectRoot)
  const overrides = { ...cfg.overrides }
  if (text === null) delete overrides[principleId]
  else overrides[principleId] = text
  writeConfig(projectRoot, { ...cfg, overrides })
}

/** Edit/restore a principle and its bundled member switches in one atomic config write. */
export function setPrincipleOverride(
  projectRoot: string,
  principleId: string,
  text: string | null,
  memberKeys: string[],
): void {
  if (!projectRoot) throw new Error('Open a project first.')
  const cfg = configForWrite(projectRoot)
  const overrides = { ...cfg.overrides }
  const disabled = new Set(cfg.disabled)
  if (text === null) {
    delete overrides[principleId]
    for (const key of memberKeys) disabled.delete(key)
  } else {
    overrides[principleId] = text
    for (const key of memberKeys) disabled.add(key)
  }
  writeConfig(projectRoot, { disabled: [...disabled], overrides })
}

// Typed-key constructors — the one place the key format lives.
export const ruleKey = (id: string): string => `rule:${id}`
export const skillKey = (name: string): string => `skill:${name}`
export const subagentKey = (name: string): string => `subagent:${name}`
// A principle is a presentation-level grouping; its toggle key is never stored — main expands it to
// its member `rule:` keys before writing (guardrails.ts principleMemberKeys), so storage + the prompt
// assembler keep dealing only in individual rule ids.
export const principleKey = (id: string): string => `principle:${id}`

/**
 * The `--disallowedTools` tokens implied by disabled skills/subagents (rules are dropped from the
 * system prompt instead, not denied as tools). A disabled skill → `Skill(name)`, a disabled subagent
 * → `Agent(name)` — the engine's permission deny syntax (claude-code-guide, 2026-06-26), which already
 * works under our `-p` transport (the deep-research `Skill(deep-research)` denial proves it).
 */
export function disabledToolTokens(disabled: Set<string>): string[] {
  const tokens: string[] = []
  for (const key of disabled) {
    if (key.startsWith('skill:')) tokens.push(`Skill(${key.slice('skill:'.length)})`)
    else if (key.startsWith('subagent:')) tokens.push(`Agent(${key.slice('subagent:'.length)})`)
  }
  return tokens
}
