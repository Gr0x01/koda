import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleGuardrailText, MEMORY_HEAVY_CHARS, projectMemoryWeight, toCodexToolNames } from './pack'

// A project dir with no `.koda/guardrails.json` ⇒ nothing disabled, so we read the shipped pack as-is.
// assembleGuardrailText resolves the in-repo resources/pack via process.cwd() (dev path).
const cwd = tmpdir()

describe('assembleGuardrailText (shared by both engine drivers)', () => {
  it('carries the project-memory rule to any engine (Codex parity — the rule, not the skill)', () => {
    const text = assembleGuardrailText({ cwd, brokerWired: true })
    expect(text).toContain('.koda/memory/')
    expect(text).toContain('MEMORY.md')
  })

  it('includes broker-gated rules only when the broker is wired', () => {
    const wired = assembleGuardrailText({ cwd, brokerWired: true })
    const bare = assembleGuardrailText({ cwd, brokerWired: false })
    // The preview rule names the broker tool — present with the broker, dropped without it.
    expect(wired).toContain('mcp__koda_broker__preview')
    expect(bare).not.toContain('mcp__koda_broker__preview')
    // Engine-neutral rules (the memory discipline) survive either way.
    expect(bare).toContain('.koda/memory/')
  })

  it('rewrites broker tool names to the Codex convention for Codex (no mcp__ prefix)', () => {
    const claude = assembleGuardrailText({ cwd, brokerWired: true, engine: 'claude' })
    const codex = assembleGuardrailText({ cwd, brokerWired: true, engine: 'codex' })
    // Claude keeps the fully-qualified name; Codex sees the same tool as `koda_broker__preview`.
    expect(claude).toContain('mcp__koda_broker__preview')
    expect(codex).toContain('koda_broker__preview')
    expect(codex).not.toContain('mcp__koda_broker__')
    expect(codex).toContain('A declined call does not remove the Preview tools')
  })

  it('folds the project memory index + active-context into the prompt (no "read on start" dependency)', () => {
    const proj = mkdtempSync(join(tmpdir(), 'koda-mem-'))
    mkdirSync(join(proj, '.koda', 'memory'), { recursive: true })
    writeFileSync(join(proj, '.koda', 'memory', 'MEMORY.md'), '# Index\n- [Orientation](orientation.md) — the map')
    writeFileSync(join(proj, '.koda', 'memory', 'active-context.md'), 'Currently: wiring memory injection.')
    const text = assembleGuardrailText({ cwd: proj, brokerWired: true })
    expect(text).toContain('Project memory (already loaded')
    expect(text).toContain('- [Orientation](orientation.md) — the map')
    expect(text).toContain('Currently: wiring memory injection.')
  })

  it('injects nothing when the project has no memory index (fails soft)', () => {
    // tmpdir() has no `.koda/memory/MEMORY.md`, so the memory block is absent.
    const text = assembleGuardrailText({ cwd: tmpdir(), brokerWired: true })
    expect(text).not.toContain('Project memory (already loaded')
  })

  it('weighs the injected memory pair: absent ⇒ not present, small ⇒ healthy, big ⇒ heavy', () => {
    // No `.koda/memory/` at all — nothing injected, nothing to warn about.
    expect(projectMemoryWeight(mkdtempSync(join(tmpdir(), 'koda-mem-')))).toEqual({
      present: false,
      chars: 0,
      heavy: false,
    })

    const proj = mkdtempSync(join(tmpdir(), 'koda-mem-'))
    mkdirSync(join(proj, '.koda', 'memory'), { recursive: true })
    writeFileSync(join(proj, '.koda', 'memory', 'MEMORY.md'), '- [A note](a.md) — small index')
    writeFileSync(join(proj, '.koda', 'memory', 'active-context.md'), 'Currently: fine.')
    expect(projectMemoryWeight(proj)).toMatchObject({ present: true, heavy: false })

    // Grow active-context past the line — the same threshold the status-bar pill warns at.
    writeFileSync(join(proj, '.koda', 'memory', 'active-context.md'), 'x'.repeat(MEMORY_HEAVY_CHARS))
    expect(projectMemoryWeight(proj)).toMatchObject({ present: true, heavy: true })
  })

  it('toCodexToolNames rewrites only Koda MCP servers, leaving other prose untouched', () => {
    expect(toCodexToolNames('call mcp__koda_broker__preview and mcp__playwright__browser_navigate')).toBe(
      'call koda_broker__preview and playwright__browser_navigate',
    )
    // A non-Koda mcp__ reference (hypothetical) is left alone — scoped, not a blanket strip.
    expect(toCodexToolNames('mcp__other__thing')).toBe('mcp__other__thing')
  })
})
