import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listGuardrails,
  removeGuardrailItem,
  saveGuardrail,
  saveItemBody,
} from './guardrails'
import { projectSkillCollisionNames } from './project-skills'

const roots: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-guardrail-items-'))
  roots.push(root)
  return root
}

function writeSkill(root: string, directory: string, name: string): string {
  const file = join(root, '.claude', 'skills', directory, 'SKILL.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `---\nname: ${name}\ndescription: Test skill\n---\n\nDo the work.\n`)
  return file
}

function catalogResources(root: string, ids: string[]): string {
  const resourcesPath = join(root, 'test-resources')
  const catalogDir = join(resourcesPath, 'skills-catalog')
  mkdirSync(catalogDir, { recursive: true })
  writeFileSync(
    join(catalogDir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      source: '',
      license: '',
      skills: ids.map((id) => ({ id })),
    }),
  )
  return resourcesPath
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pack presentation', () => {
  it('keeps the personal orchestrator route out of the public Guardrails surface', () => {
    const layer = listGuardrails(project())

    expect(layer.rules.some((rule) => rule.title === 'More')).toBe(false)
    expect(layer.rules.map((rule) => rule.body).join('\n')).not.toContain('Lead through delegation')
  })
})

describe('project skill identity', () => {
  it('uses the frontmatter identity for Settings even when an old directory differs', () => {
    const root = project()
    writeSkill(root, 'old-folder-name', 'code-work')
    mkdirSync(join(root, '.koda'), { recursive: true })
    writeFileSync(
      join(root, '.koda', 'guardrails.json'),
      JSON.stringify({ disabled: ['skill:code-work'], overrides: {} }),
    )

    const skill = listGuardrails(root).skills.find((item) => item.name === 'code-work')
    expect(skill).toMatchObject({
      scope: 'project',
      name: 'code-work',
      enabled: false,
      toggleKey: 'skill:code-work',
    })
  })

  it('lets the gallery own only its exact catalog directory, not a legacy folder with that identity', () => {
    const root = project()
    const resourcesPath = catalogResources(root, ['code-work'])
    const legacyFile = writeSkill(root, 'old-folder-name', 'code-work')

    expect(
      listGuardrails(root, resourcesPath).skills.find(
        (item) => item.scope === 'project' && item.name === 'code-work',
      ),
    ).toMatchObject({ openPath: legacyFile })

    rmSync(dirname(legacyFile), { recursive: true, force: true })
    writeSkill(root, 'code-work', 'code-work')
    expect(
      listGuardrails(root, resourcesPath).skills.some(
        (item) => item.scope === 'project' && item.name === 'code-work',
      ),
    ).toBe(false)
  })

  it('does not surface a user-controlled invalid frontmatter name as a skill identity', () => {
    const root = project()
    writeSkill(root, 'safe-folder', '../../outside')

    expect(listGuardrails(root).skills.some((item) => item.openPath?.includes('safe-folder'))).toBe(false)
  })

  it('does not expose either project skill when two directories claim one identity', () => {
    const root = project()
    writeSkill(root, 'first-folder', 'code-work')
    writeSkill(root, 'second-folder', 'code-work')

    expect(listGuardrails(root).skills.filter((item) => item.name === 'code-work')).toEqual([])
    expect(projectSkillCollisionNames(root)).toEqual(['code-work'])
  })

  it('does not create or edit through an ambiguous project skill identity', async () => {
    const root = project()
    writeSkill(root, 'first-folder', 'code-work')
    writeSkill(root, 'second-folder', 'code-work')
    let boundaryCalled = false
    const boundary = async <T>(write: () => T | Promise<T>): Promise<T> => {
      boundaryCalled = true
      return write()
    }

    await expect(
      saveGuardrail(
        root,
        { kind: 'skill', text: '---\nname: code-work\ndescription: Third copy\n---\n' },
        boundary,
      ),
    ).rejects.toThrow('already exists')
    await expect(
      saveItemBody(
        root,
        { kind: 'skill', name: 'code-work' },
        '---\nname: code-work\ndescription: Edited\n---\n',
        boundary,
      ),
    ).rejects.toThrow('Multiple project skill folders')
    expect(boundaryCalled).toBe(false)
    expect(existsSync(join(root, '.claude', 'skills', 'code-work'))).toBe(false)
  })

  it('rejects a new skill whose frontmatter name would diverge from its directory', async () => {
    const root = project()
    let boundaryCalled = false
    const boundary = async <T>(write: () => T | Promise<T>): Promise<T> => {
      boundaryCalled = true
      return write()
    }

    await expect(
      saveGuardrail(
        root,
        { kind: 'skill', text: '---\nname: My Skill\ndescription: Test\n---\n\nDo it.\n' },
        boundary,
      ),
    ).rejects.toThrow('try `my-skill`')
    expect(boundaryCalled).toBe(false)
  })

  it('keeps edits and removal attached to an existing skill frontmatter identity', async () => {
    const root = project()
    const file = writeSkill(root, 'old-folder-name', 'code-work')
    const boundary = async <T>(write: () => T | Promise<T>): Promise<T> => write()

    await expect(
      saveItemBody(
        root,
        { kind: 'skill', name: 'code-work' },
        '---\nname: renamed-work\ndescription: Test\n---\n',
        boundary,
      ),
    ).rejects.toThrow('Keep this skill’s `name:` as `code-work`')

    await saveItemBody(
      root,
      { kind: 'skill', name: 'code-work' },
      '---\nname: code-work\ndescription: Updated\n---\n',
      boundary,
    )
    expect(readFileSync(file, 'utf8')).toContain('description: Updated')
    expect(existsSync(join(root, '.claude', 'skills', 'code-work'))).toBe(false)

    await removeGuardrailItem(root, { kind: 'skill', name: 'code-work' }, boundary)
    expect(existsSync(file)).toBe(false)
  })
})
