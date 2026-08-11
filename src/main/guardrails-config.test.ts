import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

import {
  readDisabledSet,
  readOverrides,
  setGuardrailsDisabled,
  setOverride,
  setPrincipleOverride,
} from './guardrails-config'
import { log } from './logger'

const roots: string[] = []

function project(): { root: string; file: string; backup: string } {
  const root = mkdtempSync(join(tmpdir(), 'koda-guardrails-'))
  roots.push(root)
  const dir = join(root, '.koda')
  mkdirSync(dir)
  const file = join(dir, 'guardrails.json')
  return { root, file, backup: `${file}.corrupt.bak` }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('guardrail settings integrity', () => {
  it('preserves malformed settings when either mutator tries to change them', () => {
    for (const original of [
      '{"disabled":["rule:keep"],"overrides":{"keep": broken',
      '{"disabled":"rule:keep","overrides":{"keep":"My rule"}}',
      '{"disabled":["rule:keep"],"overrides":{"keep":42}}',
    ]) {
      for (const mutate of [
        (root: string) => setGuardrailsDisabled(root, ['rule:new'], true),
        (root: string) => setOverride(root, 'new', 'replacement'),
      ]) {
        const { root, file, backup } = project()
        writeFileSync(file, original)
        vi.spyOn(log, 'warn').mockImplementation(() => {})

        expect(() => mutate(root)).toThrow('existing settings were left unchanged')
        expect(readFileSync(file, 'utf8')).toBe(original)
        expect(readFileSync(backup, 'utf8')).toBe(original)
      }
    }
  })

  it('creates first-use settings and preserves sibling fields on later edits', () => {
    const { root, file } = project()

    setGuardrailsDisabled(root, ['rule:keep'], true)
    setOverride(root, 'custom', 'My rule')

    expect(existsSync(file)).toBe(true)
    expect([...readDisabledSet(root)]).toEqual(['rule:keep'])
    expect(readOverrides(root)).toEqual({ custom: 'My rule' })
  })

  it('edits and restores a principle with its member switches as one config state', () => {
    const { root } = project()
    setGuardrailsDisabled(root, ['skill:keep'], true)

    setPrincipleOverride(root, 'safety', 'My safety rule', ['rule:a', 'rule:b'])
    expect([...readDisabledSet(root)].sort()).toEqual(['rule:a', 'rule:b', 'skill:keep'])
    expect(readOverrides(root)).toEqual({ safety: 'My safety rule' })

    setPrincipleOverride(root, 'safety', null, ['rule:a', 'rule:b'])
    expect([...readDisabledSet(root)]).toEqual(['skill:keep'])
    expect(readOverrides(root)).toEqual({})
  })

  it('keeps the new Codex delegation variant off for projects that disabled the older code principle', () => {
    const { root, file } = project()
    writeFileSync(
      file,
      JSON.stringify({ disabled: ['rule:delegate-independent-work', 'skill:keep'], overrides: {} }),
    )

    expect([...readDisabledSet(root)].sort()).toEqual([
      'rule:delegate-independent-work',
      'rule:delegate-independent-work-codex',
      'skill:keep',
    ])
    // Compatibility is derived on read; merely opening Settings does not rewrite the user's file.
    expect(JSON.parse(readFileSync(file, 'utf8')).disabled).toEqual([
      'rule:delegate-independent-work',
      'skill:keep',
    ])

    setGuardrailsDisabled(
      root,
      ['rule:delegate-independent-work', 'rule:delegate-independent-work-codex'],
      false,
    )
    expect([...readDisabledSet(root)]).toEqual(['skill:keep'])
  })
})
