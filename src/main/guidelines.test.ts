import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healGuidelinesPair } from './guidelines'

/**
 * One project guide, both engines: when a project carries only CLAUDE.md or only AGENTS.md, opening
 * it links the missing name to the existing file. The dangerous cases are the ones that must stay
 * no-ops — two real files (possibly deliberately distinct) and a dangling symlink (present-but-broken
 * must never be clobbered by a fresh link).
 */
describe('healGuidelinesPair', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'koda-guidelines-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('links AGENTS.md to an existing CLAUDE.md', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# guide')
    expect(healGuidelinesPair(dir)).toBe('linked')
    expect(readlinkSync(join(dir, 'AGENTS.md'))).toBe('CLAUDE.md')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# guide')
  })

  it('links CLAUDE.md to an existing AGENTS.md', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# guide')
    expect(healGuidelinesPair(dir)).toBe('linked')
    expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
  })

  it('is idempotent: a healed pair is a no-op on the next open', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# guide')
    expect(healGuidelinesPair(dir)).toBe('linked')
    expect(healGuidelinesPair(dir)).toBe('noop')
  })

  it('never touches a project with two real files', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude-specific')
    writeFileSync(join(dir, 'AGENTS.md'), 'codex-specific')
    expect(healGuidelinesPair(dir)).toBe('noop')
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('claude-specific')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('codex-specific')
  })

  it('does nothing in a project with neither file (intake owns authoring)', () => {
    expect(healGuidelinesPair(dir)).toBe('noop')
    expect(() => lstatSync(join(dir, 'CLAUDE.md'))).toThrow()
    expect(() => lstatSync(join(dir, 'AGENTS.md'))).toThrow()
  })

  it('treats a dangling symlink as present and leaves it alone', () => {
    symlinkSync('gone.md', join(dir, 'CLAUDE.md')) // broken on purpose
    writeFileSync(join(dir, 'AGENTS.md'), '# guide')
    expect(healGuidelinesPair(dir)).toBe('noop')
    expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('gone.md')
    unlinkSync(join(dir, 'CLAUDE.md'))
  })

  it('never links back to a lone dangling symlink (would make an ELOOP pair)', () => {
    // The healed pair minus its target: CLAUDE.md → AGENTS.md survives, AGENTS.md is gone. Creating
    // AGENTS.md → CLAUDE.md here would loop both names into ELOOP — must stay a no-op so intake can
    // re-offer and a fresh AGENTS.md write resolves the dangling link.
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'))
    expect(healGuidelinesPair(dir)).toBe('noop')
    expect(readlinkSync(join(dir, 'CLAUDE.md'))).toBe('AGENTS.md')
    expect(() => lstatSync(join(dir, 'AGENTS.md'))).toThrow()
    unlinkSync(join(dir, 'CLAUDE.md'))
  })

  it('never uses any lone symlink as a heal source', () => {
    writeFileSync(join(dir, 'real-guide.md'), '# elsewhere')
    symlinkSync('real-guide.md', join(dir, 'AGENTS.md'))
    expect(healGuidelinesPair(dir)).toBe('noop')
    expect(() => lstatSync(join(dir, 'CLAUDE.md'))).toThrow()
  })
})
