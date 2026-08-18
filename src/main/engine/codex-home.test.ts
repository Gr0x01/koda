import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/koda-test' } }))
vi.mock('../settings', () => ({ loadMiniAppsEnabled: () => false }))
vi.mock('../logger', () => ({ log: { info: () => {}, warn: () => {} } }))

const {
  codexHomeSetupKey,
  codexInstalledPluginIds,
  codexMarketplaceJson,
  codexPluginJson,
  codexSkillConfig,
} = await import('./codex-home')

function skill(dir: string, name = basename(dir)): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`)
}

describe('Codex plugin manifest', () => {
  it('ships playbooks without a blocking stop hook', () => {
    const manifest = JSON.parse(codexPluginJson('0.1.10'))
    expect(manifest).toMatchObject({ name: 'koda', skills: './skills/' })
    expect(manifest).not.toHaveProperty('hooks')
  })

  it('installs Deep Review as a distinct first-party plugin when bundled', () => {
    const marketplace = JSON.parse(codexMarketplaceJson(true))
    expect(marketplace.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'koda', category: 'Productivity' }),
        expect.objectContaining({ name: 'deep-review', category: 'Developer Tools' }),
      ]),
    )
    for (const plugin of marketplace.plugins) {
      expect(plugin.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_INSTALL' })
    }
  })

  it('parses installed plugin ids without confusing malformed output for an empty inventory', () => {
    expect(
      codexInstalledPluginIds(
        JSON.stringify({ installed: [{ pluginId: 'koda@koda-market' }, { pluginId: 'deep-review@koda-market' }] }),
      ),
    ).toEqual(new Set(['koda@koda-market', 'deep-review@koda-market']))
    expect(codexInstalledPluginIds('{}')).toBeNull()
    expect(codexInstalledPluginIds('not json')).toBeNull()
  })

  it('keys both the in-process flight and persisted marker by immutable materialization sources', () => {
    expect(codexHomeSetupKey({ appVersion: '0.1.10', resourcesPath: '/a' })).not.toBe(
      codexHomeSetupKey({ appVersion: '0.1.10', resourcesPath: '/b' }),
    )
  })
})

describe('Codex native skill configuration', () => {
  it('disables a shadowed bundled playbook and exposes the project fork', () => {
    const home = mkdtempSync(join(tmpdir(), 'koda-codex-home-'))
    const project = mkdtempSync(join(tmpdir(), 'koda-project-'))
    const installed = join(home, 'plugins', 'cache', 'koda-market', 'koda', '0.1.10', 'skills')
    skill(join(installed, 'code-work'))
    skill(join(installed, 'documents'))
    skill(join(project, '.claude', 'skills', 'code-work'))

    expect(codexSkillConfig(project, '0.1.10', { home })).toEqual([
      { path: join(project, '.claude', 'skills', 'code-work', 'SKILL.md'), enabled: true },
      { path: join(installed, 'code-work', 'SKILL.md'), enabled: false },
    ].sort((a, b) => a.path.localeCompare(b.path)))
  })

  it('maps project toggles onto both bundled and project playbook paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'koda-codex-home-'))
    const project = mkdtempSync(join(tmpdir(), 'koda-project-'))
    const installed = join(home, 'plugins', 'cache', 'koda-market', 'koda', '0.1.10', 'skills')
    skill(join(installed, 'documents'))
    skill(join(installed, 'code-work'))
    skill(join(project, '.claude', 'skills', 'code-work'))
    mkdirSync(join(project, '.koda'), { recursive: true })
    writeFileSync(
      join(project, '.koda', 'guardrails.json'),
      JSON.stringify({ disabled: ['skill:documents', 'skill:code-work'], overrides: {} }),
    )

    expect(codexSkillConfig(project, '0.1.10', { home })).toEqual([
      { path: join(project, '.claude', 'skills', 'code-work', 'SKILL.md'), enabled: false },
      { path: join(installed, 'code-work', 'SKILL.md'), enabled: false },
      { path: join(installed, 'documents', 'SKILL.md'), enabled: false },
    ].sort((a, b) => a.path.localeCompare(b.path)))
  })

  it('uses frontmatter identity for a mismatched-directory project off-switch', () => {
    const home = mkdtempSync(join(tmpdir(), 'koda-codex-home-'))
    const project = mkdtempSync(join(tmpdir(), 'koda-project-'))
    const installed = join(home, 'plugins', 'cache', 'koda-market', 'koda', '0.1.10', 'skills')
    skill(join(installed, 'code-work'))
    skill(join(project, '.claude', 'skills', 'old-folder-name'), 'code-work')
    mkdirSync(join(project, '.koda'), { recursive: true })
    writeFileSync(
      join(project, '.koda', 'guardrails.json'),
      JSON.stringify({ disabled: ['skill:code-work'], overrides: {} }),
    )

    expect(codexSkillConfig(project, '0.1.10', { home })).toEqual([
      { path: join(project, '.claude', 'skills', 'old-folder-name', 'SKILL.md'), enabled: false },
      { path: join(installed, 'code-work', 'SKILL.md'), enabled: false },
    ].sort((a, b) => a.path.localeCompare(b.path)))
  })

  it('does not enable ambiguous project copies that claim the same skill identity', () => {
    const home = mkdtempSync(join(tmpdir(), 'koda-codex-home-'))
    const project = mkdtempSync(join(tmpdir(), 'koda-project-'))
    const installed = join(home, 'plugins', 'cache', 'koda-market', 'koda', '0.1.10', 'skills')
    skill(join(installed, 'code-work'))
    skill(join(project, '.claude', 'skills', 'first-folder'), 'code-work')
    skill(join(project, '.claude', 'skills', 'second-folder'), 'code-work')

    expect(codexSkillConfig(project, '0.1.10', { home })).toEqual([
      { path: join(installed, 'code-work', 'SKILL.md'), enabled: false },
    ])
  })

  it('ignores an invalid disabled skill identity instead of resolving it as a path', () => {
    const home = mkdtempSync(join(tmpdir(), 'koda-codex-home-'))
    const project = mkdtempSync(join(tmpdir(), 'koda-project-'))
    const installed = join(home, 'plugins', 'cache', 'koda-market', 'koda', '0.1.10', 'skills')
    skill(join(installed, '..', 'outside'))
    mkdirSync(join(project, '.koda'), { recursive: true })
    writeFileSync(
      join(project, '.koda', 'guardrails.json'),
      JSON.stringify({ disabled: ['skill:../outside'], overrides: {} }),
    )

    expect(codexSkillConfig(project, '0.1.10', { home })).toEqual([])
  })

  it('keeps concurrent sessions with different optional capabilities isolated in native config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'koda-codex-home-'))
    const project = mkdtempSync(join(tmpdir(), 'koda-project-'))
    const installed = join(home, 'plugins', 'cache', 'koda-market', 'koda', '0.1.10', 'skills')
    skill(join(installed, 'browser-verify'))
    skill(join(installed, 'create-mini-app'))
    skill(join(installed, 'app-data'))

    const [plain, fullyWired] = await Promise.all([
      Promise.resolve().then(() =>
        codexSkillConfig(project, '0.1.10', {
          home,
          playwrightWired: false,
          miniAppsWired: false,
        }),
      ),
      Promise.resolve().then(() =>
        codexSkillConfig(project, '0.1.10', {
          home,
          playwrightWired: true,
          miniAppsWired: true,
        }),
      ),
    ])

    expect(plain).toEqual(
      ['app-data', 'browser-verify', 'create-mini-app'].map((name) => ({
        path: join(installed, name, 'SKILL.md'),
        enabled: false,
      })),
    )
    expect(fullyWired).toEqual([])
  })
})
