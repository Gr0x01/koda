import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexCleanFinishHooksJson } from './codex-clean-finish'
import {
  assembleGuardrailText,
  assemblePackRules,
  CODEX_PACK_SKILLS,
  codexPackMarker,
  GATED_PACK_SKILLS,
  loadPackRules,
  loadPresentation,
  MEMORY_HEAVY_CHARS,
  projectMemoryWeight,
  resolvePack,
  resolveStagingPack,
} from './pack'

// A project dir with no `.koda/guardrails.json` ⇒ nothing disabled, so we read the shipped pack as-is.
// assembleGuardrailText resolves the in-repo resources/pack via process.cwd() (dev path).
const cwd = tmpdir()
const bundledClaude = join(
  process.cwd(),
  'resources',
  'engine',
  `${process.platform}-${process.arch}`,
  'claude',
)

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

  it('includes the app-ask routing rule only when the mini-apps staging skill is wired', () => {
    const wired = assembleGuardrailText({ cwd, brokerWired: true, miniAppsWired: true })
    const bare = assembleGuardrailText({ cwd, brokerWired: true })
    // The routing rule names the staging skill — present only when that skill actually loads.
    expect(wired).toContain('create-mini-app')
    expect(bare).not.toContain('create-mini-app')
  })

  it('carries the pre-task skill check always (a skill nobody checks for might as well not ship)', () => {
    // Generalizes the critic lesson: rules that hope a skill triggers by description lose to defaults.
    const text = assembleGuardrailText({ cwd, brokerWired: false })
    expect(text).toContain('A skill that covers the task drives the task')
  })

  it('fits work to its topic before either engine edits', () => {
    for (const engine of ['claude', 'codex'] as const) {
      const text = assembleGuardrailText({ cwd, brokerWired: false, engine })
      expect(text).toContain('Fit the branch to the work before editing')
      expect(text).toContain('Talking or investigating makes no Git changes')
      expect(text).toContain('only when it belongs to this workstream')
      expect(text).toContain('materially different coding task')
      expect(text).toContain("human-named topic branch from the repository's main branch")
      expect(text).toContain('use a separate worktree when the current checkout belongs to another topic')
      expect(text).toContain('leave it untouched')
      expect(text).toContain('ask once before editing')
    }

    const pack = resolvePack()
    const presentation = loadPresentation(pack!.dir)
    expect(presentation?.find((principle) => principle.id === 'code')?.members).toContain(
      'finish-the-merge',
    )
  })

  it('carries the check-before-done pass always, and stands it down only when the user turned it off', () => {
    const on = assembleGuardrailText({ cwd, brokerWired: true })
    const off = assembleGuardrailText({ cwd, brokerWired: true, critiqueOff: true })
    // General behavior, not a mini-apps one: present with no capability wired at all. Both halves of
    // the step ship together — the critic on what the user looks at, the reviewer on a finished change.
    expect(on).toContain('Critique it before you call it good')
    expect(on).toContain('Something other than you looks at it before it')
    expect(on).not.toContain('pass is off right now')
    // Off contradicts the always-on rules rather than removing them (rules.json is static per id), and
    // the one toggle stands down BOTH halves — a reviewer that survived it would make the switch a lie.
    expect(off).toContain('Critique it before you call it good')
    expect(off).toContain('Something other than you looks at it before it')
    expect(off).toContain('pass is off right now')
    expect(off).toContain('no reviewer pass on a finished change')
    expect(off).toContain('neither `code-reviewer` nor `review-architecture`')
  })

  it('arms the critique pass on presenting-for-a-decision, and checks a self-authored bar against the project', () => {
    const text = assembleGuardrailText({ cwd, brokerWired: true })
    // The failure this widening fixes: rounds of work each read as "still in progress", so "before done"
    // never arms — while the user has already formed a view on what they were shown.
    expect(text).toContain("Presenting work for the user's opinion counts as finishing")
    // A bar the agent wrote itself can contradict a standard the project already set.
    expect(text).toContain("check it against the project's own written standards")
  })

  it('names the `critic` subagent in BOTH halves of the pass (an unnamed tool never gets reached for)', () => {
    const text = assembleGuardrailText({ cwd, brokerWired: true })
    // critique-before-done — the half that used to describe an anonymous "fresh critic".
    expect(text).toContain('hand it to the `critic` subagent before they see it')
    // outside-eyes-before-done — named `code-reviewer` but not its counterpart; that asymmetry was the bug.
    expect(text).toContain('gets the `critic` subagent instead')
    expect(text).toContain('hand the diff to the `code-reviewer` subagent')
    // Feature-sized work gets the wider-but-bounded integration check by name; the normal reviewer
    // remains diff-scoped and does not turn back into a repository bug hunt.
    expect(text).toContain('gets the `review-architecture` skill')
  })

  it('ships the critic subagent the rules name, with the tools to open a real artifact', () => {
    const pack = resolvePack()
    expect(pack).not.toBeNull()
    const agent = readFileSync(join(pack!.dir, 'agents', 'critic.md'), 'utf8')
    expect(agent).toContain('name: critic')
    // It must be able to load the running page — a critic that can only read source is the failure itself.
    expect(agent).toContain('mcp__playwright__browser_navigate')
    expect(agent).toContain('background: false')
    expect(agent).toContain('disallowedTools: Write, Edit, NotebookEdit, Bash, Agent, Task')
  })

  it('ships a bounded architecture review skill to both engines', () => {
    const pack = resolvePack()
    expect(pack).not.toBeNull()
    const dir = join(pack!.dir, 'skills', 'review-architecture')
    const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const metadata = readFileSync(join(dir, 'agents', 'openai.yaml'), 'utf8')
    expect(skill).toContain('name: review-architecture')
    expect(skill).toContain('This inventory is the audit queue')
    expect(skill).toContain('both with file and line references')
    expect(skill).toContain('Stop when every item in the audit queue is accounted for')
    expect(metadata).toContain('$review-architecture')
    expect(CODEX_PACK_SKILLS).toContain('review-architecture')
  })

  it.skipIf(!existsSync(bundledClaude))('passes the bundled engine\'s strict plugin validator', () => {
    expect(() =>
      execFileSync(bundledClaude, ['plugin', 'validate', 'resources/pack', '--strict'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })

  it('uses the command-hook shape the engine accepts', () => {
    const pack = resolvePack()
    expect(pack).not.toBeNull()
    const config = JSON.parse(readFileSync(join(pack!.dir, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> }
    }
    const hook = config.hooks.PreToolUse[0].hooks[0]
    expect(hook).not.toHaveProperty('args')
    expect(hook.command).toBe(
      '/usr/bin/osascript -l JavaScript "${CLAUDE_PLUGIN_ROOT}/hooks/constrain-delegation.js"',
    )
  })

  it.skipIf(process.platform !== 'darwin')('keeps legacy agents foreground without changing Koda leaves', () => {
    const pack = resolvePack()
    expect(pack).not.toBeNull()
    const script = join(pack!.dir, 'hooks', 'constrain-delegation.js')
    const legacy = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script], {
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: {
          description: 'Inspect',
          prompt: 'Read the fixture.',
          subagent_type: 'legacy-reader',
          run_in_background: true,
          future_field: { preserved: true },
        },
      }),
      encoding: 'utf8',
    })
    expect(JSON.parse(legacy)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: {
          subagent_type: 'legacy-reader',
          run_in_background: false,
          future_field: { preserved: true },
        },
      },
    })

    const scout = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script], {
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'koda:scout', run_in_background: true },
      }),
      encoding: 'utf8',
    })
    expect(scout.trim()).toBe('')
  })

  it.skipIf(process.platform !== 'darwin')('blocks one dirty Git stop, then permits the continuation', () => {
    const pack = resolvePack()
    expect(pack).not.toBeNull()
    const hookDir = join(pack!.dir, 'codex-hooks')
    const config = JSON.parse(codexCleanFinishHooksJson()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    expect(config.hooks.Stop[0].hooks[0].command).toContain('${PLUGIN_ROOT}/hooks/clean-finish.js')

    const repo = mkdtempSync(join(tmpdir(), 'koda-clean-finish-'))
    const script = join(hookDir, 'clean-finish.js')
    const runHook = (stopHookActive = false): Record<string, unknown> => {
      const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script], {
        cwd: repo,
        input: JSON.stringify({ cwd: repo, stop_hook_active: stopHookActive }),
        encoding: 'utf8',
      })
      return JSON.parse(output || '{}') as Record<string, unknown>
    }

    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      execFileSync('git', ['config', 'user.email', 'test@koda.local'], { cwd: repo })
      execFileSync('git', ['config', 'user.name', 'Koda Test'], { cwd: repo })
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
      writeFileSync(join(repo, 'tracked.txt'), 'saved\n')
      execFileSync('git', ['add', '-A'], { cwd: repo })
      execFileSync('git', ['commit', '-qm', 'start'], { cwd: repo })

      expect(runHook()).toEqual({})

      writeFileSync(join(repo, 'tracked.txt'), 'dirty in this worktree\n')
      const blocked = runHook()
      expect(blocked).toMatchObject({ decision: 'block' })
      expect(blocked.reason).toContain('Do not commit pre-existing or unrelated changes')
      expect(runHook(true)).toEqual({})
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('drops a rule whose gate this code does not know (a gate that fails open is not a gate)', () => {
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

  it('includes the summon-pill rule only for a project with a registered mini app', () => {
    const faced = assembleGuardrailText({ cwd, brokerWired: true, miniAppProject: true })
    const plain = assembleGuardrailText({ cwd, brokerWired: true })
    // The faced-project rule names the claim-the-line handshake — present only with a registered app.
    expect(faced).toContain('koda:claim-agent-line')
    expect(plain).not.toContain('koda:claim-agent-line')
  })

  it('uses the advertised MCP tool names for both engines', () => {
    const claude = assembleGuardrailText({ cwd, brokerWired: true, engine: 'claude' })
    const codex = assembleGuardrailText({ cwd, brokerWired: true, engine: 'codex' })
    // Codex app-server advertises the same fully-qualified name as Claude.
    expect(claude).toContain('mcp__koda_broker__preview')
    expect(codex).toContain('mcp__koda_broker__preview')
    expect(codex).toContain("A declined call doesn't remove these tools")
  })

  it('teaches both engines to fan out without pretending Codex has Claude profiles', () => {
    const claude = assembleGuardrailText({ cwd, brokerWired: true, engine: 'claude' })
    const codex = assembleGuardrailText({ cwd, brokerWired: true, engine: 'codex' })
    expect(claude).toContain('Fan out independent work when it materially helps')
    expect(claude).toContain('`scout`')
    expect(claude).toContain('`worker`')
    expect(claude).not.toContain('roles are not limited to a fixed list')
    expect(codex).toContain('Fan out independent work when it materially helps')
    expect(codex).not.toContain('koda:fan-out-work')
    expect(codex).toContain('roles are not limited to a fixed list')
    expect(codex).toContain('Start every selected read-only child before waiting')
    expect(codex).toContain('If a child may mutate the tree')
    expect(codex).toContain('do not edit in the parent until it finishes')
    expect(codex).not.toContain('`worker`')

    const pack = resolvePack()
    const presentation = loadPresentation(pack!.dir)
    expect(presentation?.find((principle) => principle.id === 'code')?.members).toEqual(
      expect.arrayContaining(['delegate-independent-work', 'delegate-independent-work-codex']),
    )

    // Guardrail config mirrors the established Claude key onto the new Codex-specific key for existing
    // projects. Once expanded, either engine's assembled prompt stays free of delegation guidance.
    const rules = loadPackRules(pack!.dir)!
    const disabled = new Set(['rule:delegate-independent-work', 'rule:delegate-independent-work-codex'])
    expect(assemblePackRules(rules, disabled, { engine: 'claude' })).not.toContain(
      'Fan out independent work when it materially helps',
    )
    expect(assemblePackRules(rules, disabled, { engine: 'codex' })).not.toContain(
      'Fan out independent work when it materially helps',
    )

    const codexSkill = readFileSync(
      join(process.cwd(), 'resources', 'codex-skills', 'fan-out-work', 'SKILL.md'),
      'utf8',
    )
    expect(codexSkill).toContain('Use collaboration subagents')
    expect(codexSkill).toContain('runtime has available')
    const codexSkillInterface = readFileSync(
      join(process.cwd(), 'resources', 'codex-skills', 'fan-out-work', 'agents', 'openai.yaml'),
      'utf8',
    )
    expect(codexSkillInterface).toContain('allow_implicit_invocation: false')
  })

  it('ships bounded scout and isolated-worker leaf profiles', () => {
    const pack = resolvePack()
    expect(pack).not.toBeNull()
    const scout = readFileSync(join(pack!.dir, 'agents', 'scout.md'), 'utf8')
    const critic = readFileSync(join(pack!.dir, 'agents', 'critic.md'), 'utf8')
    const worker = readFileSync(join(pack!.dir, 'agents', 'worker.md'), 'utf8')
    expect(scout).toContain('tools: Read, Grep, Glob, Skill')
    expect(scout).toContain('disallowedTools: Write, Edit, NotebookEdit, Bash, Agent, Task')
    expect(scout).toContain('background: true')
    expect(critic).toContain('disallowedTools: Write, Edit, NotebookEdit, Bash, Agent, Task')
    expect(worker).toContain('isolation: worktree')
    expect(worker).toContain('disallowedTools: Agent, Task')
    expect(worker).toContain('background: true')
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

  it('shows the shape of Documents/ — folders and counts, nested, never filenames', () => {
    const proj = mkdtempSync(join(tmpdir(), 'koda-docs-'))
    mkdirSync(join(proj, 'Documents', 'design', 'audits'), { recursive: true })
    mkdirSync(join(proj, 'Documents', 'fonts'), { recursive: true })
    writeFileSync(join(proj, 'Documents', 'brief.md'), 'loose at the root')
    writeFileSync(join(proj, 'Documents', 'design', 'DESIGN.md'), 'a doc')
    writeFileSync(join(proj, 'Documents', 'design', 'mock.html'), 'not a doc')
    writeFileSync(join(proj, 'Documents', 'design', 'audits', 'sidebar.md'), 'a doc')
    writeFileSync(join(proj, 'Documents', 'fonts', 'x.woff2'), 'not a doc')
    const text = assembleGuardrailText({ cwd: proj, brokerWired: true })
    expect(text).toContain('- (loose at the `Documents/` root) — 1 doc')
    // Anchored on the newline so the assertions actually pin INDENT — the depth math is the part
    // most likely to break, and an unanchored `toContain` matches at any indent.
    expect(text).toContain('\n- design/ — 1 doc')
    expect(text).toContain('\n  - audits/ — 1 doc')
    // A folder with no documents still shows (it's a real place to file one), but by count, not name.
    expect(text).toContain('\n- fonts/ — 0 docs')
    expect(text).not.toContain('DESIGN.md')
  })

  it('keeps every top-level folder when a deep subtree overruns the cap, and says it was cut', () => {
    const proj = mkdtempSync(join(tmpdir(), 'koda-docs-'))
    // One fat subtree big enough to blow the nested budget, plus siblings after it alphabetically.
    for (let i = 0; i < 80; i++) mkdirSync(join(proj, 'Documents', 'aaa', `sub${i}`), { recursive: true })
    for (const name of ['mmm', 'zzz']) mkdirSync(join(proj, 'Documents', name), { recursive: true })
    const text = assembleGuardrailText({ cwd: proj, brokerWired: true })
    // The filing choice is which TOP-LEVEL folder — those must survive a greedy subtree.
    expect(text).toContain('\n- aaa/ — 0 docs')
    expect(text).toContain('\n- mmm/ — 0 docs')
    expect(text).toContain('\n- zzz/ — 0 docs')
    // And a cut list must never read as the whole shape.
    expect(text).toContain('more folders exist below this')
  })

  it('cannot have a folder name forge a second list entry', () => {
    const proj = mkdtempSync(join(tmpdir(), 'koda-docs-'))
    mkdirSync(join(proj, 'Documents', 'plans\n- invented'), { recursive: true })
    const text = assembleGuardrailText({ cwd: proj, brokerWired: true })
    expect(text).toContain('- plans - invented/ — 0 docs')
    expect(text).not.toContain('\n- invented/')
  })

  it('says nothing about Documents/ when the project has none yet (no shape to honor)', () => {
    const proj = mkdtempSync(join(tmpdir(), 'koda-docs-'))
    expect(assembleGuardrailText({ cwd: proj, brokerWired: true })).not.toContain('shape of this project')
  })
})

describe('gated mini-app recipe', () => {
  // create-mini-app is built but not shipped: it lives in the staging pack and reaches an engine only
  // when the mini-apps dogfood flag is on. These assertions guard that it stays OUT of the always-on
  // path so a normal release ships clean; flip them when the feature graduates into the main pack.
  it('keeps the create-mini-app skill in staging, not the main pack or the always-on Codex list', () => {
    const staging = resolveStagingPack()
    expect(staging).not.toBeNull()
    const skill = readFileSync(join(staging!.dir, 'skills', 'create-mini-app', 'SKILL.md'), 'utf8')
    expect(skill).toContain('name: create-mini-app')
    expect(skill).toContain('Install, start, stop, and inspect the app only through Koda')
    expect(GATED_PACK_SKILLS).toContain('create-mini-app')
    expect(CODEX_PACK_SKILLS).not.toContain('create-mini-app')
  })

  it('invalidates same-version Codex plugin caches when pack wiring or the mini-apps flag changes', () => {
    expect(codexPackMarker('0.1.4', false, false)).toMatch(/^0\.1\.4:pack\d+:pw0:ma0$/)
    expect(codexPackMarker('0.1.4', true, false)).toMatch(/^0\.1\.4:pack\d+:pw1:ma0$/)
    expect(codexPackMarker('0.1.4', false, true)).toMatch(/^0\.1\.4:pack\d+:pw0:ma1$/)
  })
})
