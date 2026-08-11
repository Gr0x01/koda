import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureGlobalSkillsSeeded, globalSkillsDir } from './skills-catalog'

const roots: string[] = []

function fixture(): { resourcesPath: string; userData: string; seededSkill: string } {
  const root = mkdtempSync(join(tmpdir(), 'koda-skills-seed-'))
  roots.push(root)
  const resourcesPath = join(root, 'resources')
  const catalogDir = join(resourcesPath, 'skills-catalog')
  const seededSkill = join(root, 'user-data', 'skills', 'global', 'skills', 'starter')
  mkdirSync(join(catalogDir, 'skills', 'starter'), { recursive: true })
  writeFileSync(
    join(catalogDir, 'catalog.json'),
    JSON.stringify({ version: 1, source: '', license: '', skills: [{ id: 'starter', defaultActive: true }] }),
  )
  writeFileSync(join(catalogDir, 'skills', 'starter', 'SKILL.md'), '# Starter\n')
  return { resourcesPath, userData: join(root, 'user-data'), seededSkill }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ensureGlobalSkillsSeeded', () => {
  it('seeds a default skill on first use', () => {
    const { resourcesPath, userData, seededSkill } = fixture()

    ensureGlobalSkillsSeeded(userData, resourcesPath)

    expect(existsSync(seededSkill)).toBe(true)
  })

  it('does not reinstall a removed skill when seed state is unreadable', () => {
    const { resourcesPath, userData, seededSkill } = fixture()
    const stateFile = join(userData, 'skills', 'seed-state.json')
    mkdirSync(join(globalSkillsDir(userData), 'skills'), { recursive: true })
    writeFileSync(stateFile, '{not json')

    expect(() => ensureGlobalSkillsSeeded(userData, resourcesPath)).toThrow(/seed state/i)
    expect(existsSync(seededSkill)).toBe(false)
  })
})
