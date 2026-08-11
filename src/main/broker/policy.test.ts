import { describe, it, expect } from 'vitest'
import { destructiveGit, isMutating, isEditTool, protectedTarget } from './policy'
import { ApprovalGate } from './gate'

/**
 * policy.ts is pure classification with no I/O — the cheapest place to pin the guardrail invariants.
 * The destructive-git tripwire is a security boundary (it's the hard DENY that safety-git can't undo),
 * so a pattern that stops matching must fail here rather than in production.
 */

describe('destructiveGit tripwire', () => {
  const bash = (command: string) => destructiveGit('Bash', { command })

  it('catches the history-rewriting ops safety-git cannot recover', () => {
    expect(bash('git push --force origin main')?.what).toBe('force-push')
    expect(bash('git push -f')?.what).toBe('force-push')
    expect(bash('git push origin +main')?.what).toBe('force-push (+refspec)')
    expect(bash('git reset --hard HEAD~3')?.what).toBe('hard reset')
    expect(bash('git rebase -i main')?.what).toBe('rebase (history rewrite)')
    expect(bash('git branch -D feature')?.what).toBe('branch force-delete')
    expect(bash('git branch --delete --force feature')?.what).toBe('branch force-delete')
    expect(bash('git tag -d v1.0')?.what).toBe('tag delete')
  })

  it('lets safe git through — the tripwire is not a blanket git block', () => {
    expect(bash('git push origin main')).toBeNull()
    expect(bash('git commit -m "wip"')).toBeNull()
    expect(bash('git status')).toBeNull()
    // Safe delete refuses unmerged work — it's the routine merge cleanup the agent is told to do.
    expect(bash('git branch -d merged')).toBeNull()
    expect(bash('git branch --delete merged')).toBeNull()
  })

  it('only scans Bash — the engine edit tools cannot run git', () => {
    expect(destructiveGit('Edit', { command: 'git push --force' })).toBeNull()
    expect(destructiveGit('Write', { file_path: 'x' })).toBeNull()
  })
})

describe('protectedTarget self-protection tier (forced ask, even in Auto)', () => {
  const bash = (command: string) => protectedTarget('Bash', { command })

  it('catches edits aimed at Koda\'s own machinery', () => {
    expect(protectedTarget('Edit', { file_path: '/p/.koda/guardrails.json' })?.what).toBe(
      "this project's guardrail switches",
    )
    expect(protectedTarget('Write', { file_path: '.koda/safety.git/config' })?.what).toBe(
      "this project's recovery store",
    )
    expect(
      protectedTarget('Write', {
        file_path: '/Users/x/Library/Application Support/Koda/koda-settings.json',
      })?.what,
    ).toBe("Koda's app settings")
  })

  it('catches Bash aimed at the same targets, including deleting .koda wholesale', () => {
    expect(bash('echo "{}" > .koda/guardrails.json')?.what).toBe("this project's guardrail switches")
    expect(bash('rm -rf .koda/safety.git')?.what).toBe("this project's recovery store")
    expect(bash('rm -rf .koda')?.what).toContain('recovery store')
    expect(bash('rm -rf ../myproject/.koda/')?.what).toContain('recovery store')
    expect(bash('sed -i "" "s/auto/ask/" "$HOME/Library/Application Support/Koda/koda-settings.json"')?.what).toBe(
      "Koda's app settings",
    )
    expect(bash('touch "/Applications/Koda.app/Contents/Resources/x"')?.what).toBe("Koda's app bundle")
  })

  it('review regressions: chaining, quoting, whole-bundle delete, case-mangling', () => {
    expect(bash('rm -rf .koda; git init')?.what).toContain('recovery store') // ;-chain, not just &&
    expect(bash('rm -rf ".koda"')?.what).toContain('recovery store') // quoted bare target
    expect(bash("rm -rf '.koda'")?.what).toContain('recovery store')
    expect(bash('rm -rf /Applications/Koda.app')?.what).toBe("Koda's app bundle") // whole bundle, not just inside Contents/
    expect(bash('rm -rf /Applications/Koda.app/Contents')?.what).toBe("Koda's app bundle")
    expect(bash('rm -rf .KODA')?.what).toContain('recovery store') // macOS fs is case-insensitive
    expect(protectedTarget('Edit', { file_path: '.KODA/Guardrails.json' })?.what).toBe(
      "this project's guardrail switches",
    )
  })

  it('read-shaped Bash on guardrails/settings stays frictionless; write shapes ask', () => {
    // Mentions in greps/cats are daily dogfood in the koda repo — only write shapes surface.
    expect(bash('grep -rn "koda-settings.json" src/')).toBeNull()
    expect(bash('cat .koda/guardrails.json')).toBeNull()
    expect(bash('cp default.json .koda/guardrails.json')?.what).toBe("this project's guardrail switches")
    expect(bash('tee "$HOME/Library/Application Support/Koda/koda-settings.json" < new.json')?.what).toBe(
      "Koda's app settings",
    )
  })

  it('leaves normal .koda work frictionless — scratch, memory, docmeta stay unmatched', () => {
    expect(protectedTarget('Write', { file_path: '.koda/memory/MEMORY.md' })).toBeNull()
    expect(protectedTarget('Write', { file_path: '.koda/scratch/mock.html' })).toBeNull()
    expect(bash('rm -rf .koda/scratch/constellation')).toBeNull()
    expect(bash('mkdir -p .koda/memory && ls .koda')).toBeNull()
    expect(bash('git status')).toBeNull()
    // Project files that merely mention koda are not Koda's machinery.
    expect(protectedTarget('Edit', { file_path: 'src/main/settings.ts' })).toBeNull()
    expect(bash('grep -rn koda-settings src/main/settings.ts')).toBeNull()
  })

  it('never fires on reads or unknown tools without paths', () => {
    expect(protectedTarget('Read', { file_path: '.koda/guardrails.json' })).toBeNull()
    expect(protectedTarget('Grep', { pattern: 'guardrails.json' })).toBeNull()
    expect(protectedTarget('Bash', {})).toBeNull()
  })
})

describe('gate wiring: self-protection survives Auto-approve', () => {
  const makeGate = () => {
    const pushed: unknown[] = []
    const gate = new ApprovalGate(
      async () => true, // checkpoint always succeeds
      (req) => pushed.push(req),
      () => {},
      () => {},
      () => {},
    )
    gate.setDefaultMode('auto')
    return { gate, pushed }
  }

  it('a protected edit in Auto posture pushes an ask (with the reason) instead of auto-allowing', async () => {
    const { gate, pushed } = makeGate()
    const decision = gate.decide('s1', {
      toolUseId: 't1',
      toolName: 'Edit',
      input: { file_path: '.koda/guardrails.json', old_string: 'a', new_string: 'b' },
    })
    // The ask was pushed (not auto-allowed); resolve it so the promise settles.
    await new Promise((r) => setTimeout(r, 0))
    expect(pushed).toHaveLength(1)
    expect((pushed[0] as { reason?: string }).reason).toContain('guardrail switches')
    gate.resolve('t1', { kind: 'allow' })
    expect((await decision).kind).toBe('allow')
  })

  it('an ordinary edit in Auto still auto-allows — the tier adds no friction elsewhere', async () => {
    const { gate, pushed } = makeGate()
    const decision = await gate.decide('s1', {
      toolUseId: 't2',
      toolName: 'Edit',
      input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
    })
    expect(decision.kind).toBe('allow')
    expect(pushed).toHaveLength(0)
  })

  it('a bare user deny carries the standing register; an explicit reason passes through', async () => {
    const { gate } = makeGate()
    gate.setDefaultMode('ask')
    const d1 = gate.decide('s1', { toolUseId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    await new Promise((r) => setTimeout(r, 0))
    gate.resolve('r1', { kind: 'deny' })
    const first = await d1
    expect(first.kind === 'deny' && first.reason).toContain('Do not retry it, rephrase it')
    const d2 = gate.decide('s1', { toolUseId: 'r2', toolName: 'Bash', input: { command: 'ls' } })
    await new Promise((r) => setTimeout(r, 0))
    gate.resolve('r2', { kind: 'deny', reason: 'use fd instead' })
    const second = await d2
    expect(second.kind === 'deny' && second.reason).toBe('use fd instead')
  })

  it("deny voices per tool: a question's deny stays bare, a plan's deny says keep planning", async () => {
    const { gate } = makeGate()
    // AskUserQuestion always pends (even in Auto); its deny means "answer in the composer" — no register.
    const q = gate.decide('s1', { toolUseId: 'q1', toolName: 'AskUserQuestion', input: { questions: [] } })
    await new Promise((r) => setTimeout(r, 0))
    gate.resolve('q1', { kind: 'deny' })
    const qd = await q
    expect(qd.kind === 'deny' && qd.reason).toBeUndefined()
    // ExitPlanMode always confirms; its deny must invite a revised plan, never forbid re-presenting.
    const p = gate.decide('s1', { toolUseId: 'p1', toolName: 'ExitPlanMode', input: { plan: 'x' } })
    await new Promise((r) => setTimeout(r, 0))
    gate.resolve('p1', { kind: 'deny' })
    const pd = await p
    expect(pd.kind === 'deny' && pd.reason).toContain('keep planning')
    expect(pd.kind === 'deny' && pd.reason).not.toContain('Do not retry')
  })

  it('an unattended (dream) session gets a deny, never a hanging ask', async () => {
    const { gate, pushed } = makeGate()
    gate.setUnattended('s1', true)
    const decision = await gate.decide('s1', {
      toolUseId: 't3',
      toolName: 'Write',
      input: { file_path: '.koda/guardrails.json', content: '{}' },
    })
    expect(decision.kind).toBe('deny')
    expect(pushed).toHaveLength(0)
  })
})

describe('mutation classification is fail-closed', () => {
  it('treats reads as non-mutating (no checkpoint needed)', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch']) expect(isMutating(t)).toBe(false)
  })

  it('treats edits, commands, and UNKNOWN tools as mutating (checkpoint first)', () => {
    for (const t of ['Write', 'Edit', 'Bash', 'SomeToolWeHaveNeverSeen']) expect(isMutating(t)).toBe(true)
  })

  it('recognizes only the known editors as edit tools (acceptEdits scope)', () => {
    expect(isEditTool('Edit')).toBe(true)
    expect(isEditTool('MultiEdit')).toBe(true)
    expect(isEditTool('Bash')).toBe(false)
  })
})
