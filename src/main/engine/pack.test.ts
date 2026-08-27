import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assembleGuardrailText,
  assemblePackRules,
  CODEX_PACK_SKILLS,
  codexPackMarker,
  deepReviewPluginVersion,
  DEEP_REVIEW_PLUGIN_NAME,
  GATED_PACK_SKILLS,
  kodaPlaybooksExpected,
  loadPackRules,
  loadPresentation,
  MEMORY_HEAVY_CHARS,
  PROJECT_CARD_MAX_CHARS,
  projectMemoryWeight,
  readProjectCard,
  resolveDeepReviewPlugin,
  resolvePack,
  resolveStagingPack,
} from './pack'

const bundledClaude = join(
  process.cwd(),
  'resources',
  'engine',
  `${process.platform}-${process.arch}`,
  'claude',
)

function project(prefix = 'koda-context-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('ambient context assembly', () => {
  it('carries only the constitution, compact routes, and bounded project card', () => {
    const cwd = project()
    mkdirSync(join(cwd, '.koda', 'memory'), { recursive: true })
    mkdirSync(join(cwd, 'Documents', 'plans'), { recursive: true })
    writeFileSync(join(cwd, '.koda', 'memory', 'MEMORY.md'), 'MEMORY_SENTINEL')
    writeFileSync(join(cwd, '.koda', 'memory', 'active-context.md'), 'ACTIVE_SENTINEL')
    writeFileSync(join(cwd, 'Documents', 'plans', 'secret.md'), 'DOCUMENT_SENTINEL')
    writeFileSync(
      join(cwd, '.koda', 'memory', 'project-card.md'),
      'What: A small test project.\nNow: Proving routed context.\nCritical: Read the repo map before Git.',
    )

    for (const engine of ['claude', 'codex'] as const) {
      const text = assembleGuardrailText({ cwd, brokerWired: true, engine })
      expect(text).toContain('# How to work in Koda')
      expect(text).toContain('# Project card')
      expect(text).toContain('What: A small test project.')
      expect(text).toContain('load `finish-work`')
      expect(text).not.toContain('MEMORY_SENTINEL')
      expect(text).not.toContain('ACTIVE_SENTINEL')
      expect(text).not.toContain('DOCUMENT_SENTINEL')
      expect(text.length).toBeLessThan(5_000)
    }
  })

  it('routes Koda-specific goals through the live broker directory only when it exists', () => {
    const cwd = project()
    const wired = assembleGuardrailText({ cwd, brokerWired: true })
    const standalone = assembleGuardrailText({ cwd, brokerWired: false })
    expect(wired).toContain('mcp__koda_broker__capabilities')
    expect(standalone).not.toContain('mcp__koda_broker__capabilities')
    expect(wired.length).toBeLessThan(5_000)
  })

  it('bounds and sanitizes the card, and fails soft to the folder name', () => {
    const cwd = project('project card ')
    mkdirSync(join(cwd, '.koda', 'memory'), { recursive: true })
    writeFileSync(
      join(cwd, '.koda', 'memory', 'project-card.md'),
      `What: ${'w'.repeat(600)}\nNow: now\u0000 forged\nCritical: critical`,
    )
    const card = readProjectCard(cwd)
    expect(card.length).toBeLessThanOrEqual(PROJECT_CARD_MAX_CHARS)
    expect(card).not.toContain('\u0000')
    expect(card).toContain('Before changing files, read an existing `CLAUDE.md` or `AGENTS.md`')

    const fallback = readProjectCard(project('plain project '))
    expect(fallback).toContain('Project folder `plain project ')
  })

  it('preserves a valid long Critical route inside the assembled budget', () => {
    const cwd = project()
    mkdirSync(join(cwd, '.koda', 'memory'), { recursive: true })
    const critical =
      'The private internal repo is canonical; public code moves only through the publish script. Model calls and billing stay engine-owned. Read repo-topology before Git or release work.'
    writeFileSync(
      join(cwd, '.koda', 'memory', 'project-card.md'),
      `What: Koda is a conversation-first Mac app with an iPhone control head.\nNow: Mini-app make-and-run is the product focus.\nCritical: ${critical}`,
    )

    const card = readProjectCard(cwd)
    expect(card).toContain(`Critical: ${critical}`)
    expect(card).toContain('Read repo-topology before Git or release work.')
    expect(card.length).toBeLessThanOrEqual(PROJECT_CARD_MAX_CHARS)
  })

  it('removes the review route when the preference is off instead of adding a contradiction', () => {
    const cwd = project()
    const on = assembleGuardrailText({ cwd, brokerWired: true, critiqueOn: true })
    const off = assembleGuardrailText({ cwd, brokerWired: true })
    expect(on).toContain('load `review-work`')
    expect(on).toContain('One matching pass total is the default')
    expect(on).toContain('Deep Review is explicit-only')
    expect(off).not.toContain('load `review-work`')
    expect(off.toLowerCase()).not.toContain('stand down')
  })

  it('adds the compact parent-orchestrator route only for opted-in sessions on both engines', () => {
    const cwd = project()
    for (const engine of ['claude', 'codex'] as const) {
      const adaptive = assembleGuardrailText({ cwd, brokerWired: true, engine })
      const orchestrator = assembleGuardrailText({
        cwd,
        brokerWired: true,
        engine,
        orchestratorSession: true,
      })
      expect(adaptive).not.toContain('Load `fan-out-work`')
      expect(orchestrator).toContain('Lead through delegation')
      expect(orchestrator).toContain('Load `fan-out-work`')
      expect(orchestrator).toContain('do short or dependent work directly')
      expect(orchestrator).not.toContain('fresh-judgment lane')
      expect(orchestrator.length).toBeLessThan(5_000)
    }
  })

  it('removes a route when the native playbook it names is disabled', () => {
    const rules = loadPackRules(resolvePack()!.dir)!
    const text = assemblePackRules(
      rules,
      new Set(['skill:fan-out-work', 'skill:finish-work', 'skill:review-work', 'skill:create-mini-app']),
      { miniAppsWired: true, orchestratorSession: true, critiqueOn: true },
    )
    expect(text).not.toContain('load `fan-out-work`')
    expect(text).not.toContain('load `finish-work`')
    expect(text).not.toContain('load `review-work`')
    expect(text).not.toContain('load `create-mini-app`')
  })

  it('distinguishes an intentionally disabled playbook catalog from a load failure', () => {
    const cwd = project()
    mkdirSync(join(cwd, '.koda'), { recursive: true })
    writeFileSync(
      join(cwd, '.koda', 'guardrails.json'),
      JSON.stringify({ disabled: CODEX_PACK_SKILLS.map((name) => `skill:${name}`), overrides: {} }),
    )
    expect(kodaPlaybooksExpected(cwd)).toBe(false)
    expect(kodaPlaybooksExpected(cwd, { includeBrowser: true })).toBe(true)
    expect(kodaPlaybooksExpected(cwd, { includeGated: true })).toBe(true)
  })

  it('removes a route when two project folders ambiguously claim its playbook identity', () => {
    const cwd = project()
    for (const directory of ['first-review', 'second-review']) {
      const skillDir = join(cwd, '.claude', 'skills', directory)
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: review-work\ndescription: Ambiguous review playbook\n---\n',
      )
    }

    const text = assembleGuardrailText({ cwd, brokerWired: true, critiqueOn: true })
    expect(text).not.toContain('load `review-work`')
  })

  it('drops a rule whose delivery gate this code does not know', () => {
    const rules = {
      title: 'T',
      preamble: 'P',
      groups: [
        {
          id: 'always',
          heading: 'Always',
          rules: [
            { id: 'plain', kind: 'preference' as const, text: 'ungated rule' },
            {
              id: 'future',
              kind: 'preference' as const,
              text: 'gated on something newer',
              requires: 'not-a-gate-yet' as never,
            },
          ],
        },
      ],
    }
    const text = assemblePackRules(rules, new Set(), { brokerWired: true })
    expect(text).toContain('ungated rule')
    expect(text).not.toContain('gated on something newer')
  })

  it('keeps presentation toggles mapped only to live rule ids', () => {
    const pack = resolvePack()!
    const rules = loadPackRules(pack.dir)!
    const presentation = loadPresentation(pack.dir)!
    const ids = new Set(rules.groups.flatMap((group) => group.rules.map((rule) => rule.id)))
    expect(rules.groups.find((group) => group.id === 'constitution')?.rules).toHaveLength(12)
    expect(rules.groups.find((group) => group.id === 'routes')?.rules).toHaveLength(5)
    expect(presentation.map((principle) => principle.id)).toEqual([
      'work-like-this',
      'thinks-it-through',
      'keep-it-clean',
      'careful-where-it-counts',
      'code',
      'working-in-koda',
    ])
    // `critique-before-done` belonged to this stable principle before the routed-context migration.
    // Keeping it here preserves existing disabled/customized project settings across the upgrade.
    expect(presentation.find((principle) => principle.id === 'work-like-this')?.members).toContain(
      'critique-before-done',
    )
    expect(presentation.find((principle) => principle.id === 'code')?.members).not.toContain(
      'critique-before-done',
    )
    for (const principle of presentation)
      for (const member of principle.members) expect(ids.has(member), `${principle.id}:${member}`).toBe(true)
  })
})

describe('routed playbooks', () => {
  it('ships every shared Codex playbook with native interface metadata', () => {
    const pack = resolvePack()!
    for (const name of CODEX_PACK_SKILLS) {
      const dir = join(pack.dir, 'skills', name)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain(`name: ${name}`)
      expect(readFileSync(join(dir, 'agents', 'openai.yaml'), 'utf8')).toContain(`$${name}`)
    }
  })

  it('relocates task procedure into its single native owner', () => {
    const pack = resolvePack()!
    const skill = (name: string): string => readFileSync(join(pack.dir, 'skills', name, 'SKILL.md'), 'utf8')
    expect(skill('documents')).toContain('Inspect the live `Documents/` folder')
    expect(skill('documents')).toContain('Extend it before creating a parallel')
    expect(skill('code-work')).toContain('before the first substantive write')
    expect(skill('code-work')).toContain('invoke `git-work`')
    expect(skill('code-work')).toContain('at least 14 full days')
    expect(skill('finish-work')).toContain('Finish the actual task, not the entire surrounding worktree')
    expect(skill('finish-work')).toContain('Spend at most one review pass')
    expect(skill('finish-work')).toContain('rerun only the proof that repair invalidated')
    expect(skill('review-work')).toContain('Do not self-activate merely because code changed')
    expect(skill('review-work')).toContain("the task's whole fresh-review budget")
    expect(skill('verify')).toContain('retry it once')
    expect(skill('fan-out-work')).toContain('generic shared-tree children')
    expect(skill('memory')).toContain('project-card.md` is the only memory content carried')
    expect(skill('memory')).toContain('Critical: optional trigger plus one high-consequence path to read')
    expect(skill('frontend-design')).toContain('mcp__koda_broker__preview_file')
    expect(skill('frontend-design')).toContain('Skip this mock for bounded work in an established interface')
  })

  it('ships bounded critic, reviewer, scout, and isolated-worker specialists', () => {
    const pack = resolvePack()!
    const critic = readFileSync(join(pack.dir, 'agents', 'critic.md'), 'utf8')
    const reviewer = readFileSync(join(pack.dir, 'agents', 'code-reviewer.md'), 'utf8')
    const scout = readFileSync(join(pack.dir, 'agents', 'scout.md'), 'utf8')
    const worker = readFileSync(join(pack.dir, 'agents', 'worker.md'), 'utf8')
    expect(critic).toContain('disallowedTools: Write, Edit, NotebookEdit, Bash, Agent, Task')
    expect(reviewer).toContain('disallowedTools: Agent, Task')
    expect(scout).toContain('background: true')
    expect(worker).toContain('isolation: worktree')
  })

  it.skipIf(!existsSync(bundledClaude))('passes the bundled engine strict plugin validator', () => {
    expect(() =>
      execFileSync(bundledClaude, ['plugin', 'validate', 'resources/pack', '--strict'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })

  // The hook is dual-runtime: osascript JXA on macOS (packaged app), node on Linux CI. Both
  // entrypoints share decide(), so the same case table runs through whichever runtimes exist here.
  const constrainDelegation = (runHook: (payload: unknown) => string): void => {
    const legacy = runHook({
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'legacy-reader',
        run_in_background: true,
        future_field: { preserved: true },
      },
    })
    expect(JSON.parse(legacy)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: { run_in_background: false, future_field: { preserved: true } },
      },
    })

    for (const subagentType of ['koda:scout', 'koda:worker', 'deep-review:detective', 'deep-review:finding-judge']) {
      const leaf = runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: subagentType, run_in_background: true },
      })
      expect(leaf.trim()).toBe('')
    }
  }

  const hookScript = (): string => join(resolvePack()!.dir, 'hooks', 'constrain-delegation.js')

  it('keeps legacy agents foreground without changing approved leaves (node runtime)', () => {
    constrainDelegation((payload) =>
      execFileSync(process.execPath, [hookScript()], { input: JSON.stringify(payload), encoding: 'utf8' }),
    )
  })

  it.skipIf(process.platform !== 'darwin')('keeps legacy agents foreground without changing approved leaves (osascript runtime)', () => {
    constrainDelegation((payload) =>
      execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', hookScript()], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
      }),
    )
  })
})

describe('standalone Deep Review plugin', () => {
  it('ships one shared review workflow to both native plugin formats', () => {
    const plugin = resolveDeepReviewPlugin()!
    const claudeManifest = JSON.parse(readFileSync(join(plugin.dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    const codexManifest = JSON.parse(readFileSync(join(plugin.dir, '.codex-plugin', 'plugin.json'), 'utf8'))
    expect(plugin.dir).toContain(`/plugins/${DEEP_REVIEW_PLUGIN_NAME}`)
    expect(deepReviewPluginVersion(plugin)).toBe('0.1.2')
    expect(claudeManifest).toMatchObject({ name: 'deep-review', version: '0.1.2' })
    expect(codexManifest).toMatchObject({ name: 'deep-review', version: claudeManifest.version })
    const skill = readFileSync(join(plugin.dir, 'skills', 'deep-review', 'SKILL.md'), 'utf8')
    expect(skill).toContain('score readiness from 1–5')
    expect(skill).toContain('Cross-provider')
    expect(skill).toContain('Self-review cannot earn')
    expect(skill).toContain('up to five scored passes only when the user explicitly asks')
    expect(skill).toContain('Treat an invocation without repair language')
    const openAiMetadata = readFileSync(join(plugin.dir, 'skills', 'deep-review', 'agents', 'openai.yaml'), 'utf8')
    expect(openAiMetadata).toContain('default_prompt: "Use $deep-review:deep-review')
    expect(openAiMetadata).toContain('allow_implicit_invocation: false')
    const guide = readFileSync(join(process.cwd(), 'Documents', 'guides', 'deep-review-workflow.md'), 'utf8')
    expect(guide).toContain('/deep-review:deep-review')
    expect(guide).toContain('$deep-review:deep-review')
    expect(readFileSync(join(plugin.dir, 'agents', 'detective.md'), 'utf8')).toContain('background: true')
    expect(readFileSync(join(plugin.dir, 'agents', 'finding-judge.md'), 'utf8')).toContain(
      'confidence at least 80',
    )
  })

  it.skipIf(!existsSync(bundledClaude))('passes the bundled Claude strict plugin validator', () => {
    expect(() =>
      execFileSync(bundledClaude, ['plugin', 'validate', 'resources/plugins/deep-review', '--strict'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })
})

describe('memory library health', () => {
  it('weighs the on-demand navigation pair without injecting it', () => {
    const absent = project('koda-mem-')
    expect(projectMemoryWeight(absent)).toEqual({ present: false, chars: 0, heavy: false })

    const cwd = project('koda-mem-')
    mkdirSync(join(cwd, '.koda', 'memory'), { recursive: true })
    writeFileSync(join(cwd, '.koda', 'memory', 'MEMORY.md'), '- [A note](a.md) — small index')
    writeFileSync(join(cwd, '.koda', 'memory', 'active-context.md'), 'Currently: fine.')
    expect(projectMemoryWeight(cwd)).toMatchObject({ present: true, heavy: false })
    writeFileSync(join(cwd, '.koda', 'memory', 'active-context.md'), 'x'.repeat(MEMORY_HEAVY_CHARS))
    expect(projectMemoryWeight(cwd)).toMatchObject({ present: true, heavy: true })
  })
})

describe('gated mini-app recipe', () => {
  it('keeps create-mini-app in staging until the feature graduates', () => {
    const staging = resolveStagingPack()!
    expect(readFileSync(join(staging.dir, 'skills', 'create-mini-app', 'SKILL.md'), 'utf8')).toContain(
      'name: create-mini-app',
    )
    expect(GATED_PACK_SKILLS).toContain('create-mini-app')
    expect(CODEX_PACK_SKILLS).not.toContain('create-mini-app')
  })

  it('keys the immutable Codex catalog by content versions, not per-session capability flags', () => {
    expect(codexPackMarker('0.1.10', null)).toMatch(/^0\.1\.10:pack\d+:drnone$/)
    expect(codexPackMarker('0.1.10', '0.2.0')).not.toBe(codexPackMarker('0.1.10', '0.1.0'))
  })
})
