import { describe, it, expect } from 'vitest'
import {
  checkpointLabel,
  destructiveGit,
  isAlwaysConfirm,
  isMutating,
  isEditTool,
  protectedTarget,
} from './policy'
import { ApprovalGate } from './gate'

/**
 * policy.ts is pure classification with no I/O — the cheapest place to pin the guardrail invariants.
 * The destructive-git tripwire forces a confirm the posture would otherwise skip, so a pattern that
 * stops matching must fail here rather than in production.
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

  it('separates remote damage from local, so the confirm can be worded honestly', () => {
    // Already on a server Koda can't reach back into.
    expect(bash('git push --force origin main')?.scope).toBe('remote')
    expect(bash('git push origin +main')?.scope).toBe('remote')
    // Still in this checkout, so the old tip is generally still in the reflog.
    expect(bash('git rebase -i main')?.scope).toBe('local')
    expect(bash('git reset --hard HEAD~3')?.scope).toBe('local')
    expect(bash('git branch -D feature')?.scope).toBe('local')
  })

  it('never blocks the way OUT of an in-progress operation', () => {
    // Refusing these preserves nothing (the rewrite is already half-applied) and strands the repo
    // mid-operation, which is how a non-Git user ends up in a terminal.
    expect(bash('git rebase --abort')).toBeNull()
    expect(bash('git rebase --continue')).toBeNull()
    expect(bash('git rebase --skip')).toBeNull()
    expect(bash('git rebase --quit')).toBeNull()
    expect(bash('git merge --abort')).toBeNull()
    expect(bash('git cherry-pick --abort')).toBeNull()
    expect(bash('git revert --abort')).toBeNull()
    expect(bash('GIT_EDITOR=true git rebase --continue')).toBeNull()
    // Starting one is still where the tripwire belongs.
    expect(bash('git rebase origin/main')?.what).toBe('rebase (history rewrite)')
  })

  it('does not let an exempt exit vouch for the rest of a compound command', () => {
    // The exemption speaks for its own command only. Chaining a destructive op behind a harmless
    // exit must not buy that op a free pass — in Auto that would be an unprompted force-push.
    expect(bash('git rebase --continue && git push --force origin main')?.what).toBe('force-push')
    expect(bash('git rebase --abort; git reset --hard HEAD~5')?.what).toBe('hard reset')
    expect(bash('git merge --abort || git branch -D feature')?.what).toBe('branch force-delete')
    // Newlines end a command too, and are the shape a multi-line Bash block actually arrives in.
    expect(bash('git rebase --continue\ngit push --force origin main')?.what).toBe('force-push')
    // Order doesn't matter: the destructive op is judged wherever it sits.
    expect(bash('git push --force origin main && git rebase --continue')?.what).toBe('force-push')
    // And the exemption still holds when nothing destructive rides along.
    expect(bash('git rebase --continue && npm test')).toBeNull()
    expect(bash('git add -A && git rebase --continue')).toBeNull()
  })

  it('sees a destructive op nested in a command substitution', () => {
    // The shell runs a substitution BEFORE the command hosting it, so an exempt outer command must
    // not vouch for whatever is nested inside it. Otherwise `--continue $(…)` is a free pass.
    expect(bash('git rebase --continue $(git push --force origin main)')?.what).toBe('force-push')
    expect(bash('git rebase --abort `git push --force origin main`')?.what).toBe('force-push')
    expect(bash('echo $(git reset --hard HEAD~9)')?.what).toBe('hard reset')
    // A subshell is the same story.
    expect(bash('(git push --force origin main)')?.what).toBe('force-push')
    // A harmless substitution alongside an exit still clears.
    expect(bash('git rebase --continue $(date +%s)')).toBeNull()
  })

  it('still sees a command split across a line continuation', () => {
    // Segments end at a newline, but a backslash-newline is one command wearing two lines. Splitting
    // there would hand back a `git push \` fragment and a `--force …` fragment, neither of which
    // matches, and the force-push would walk straight through.
    expect(bash('git push \\\n  --force origin main')?.what).toBe('force-push')
    expect(bash('git reset \\\n  --hard HEAD~2')?.what).toBe('hard reset')
    expect(bash('git push \\\r\n  --force origin main')?.what).toBe('force-push')
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

  it('catches a protected path anywhere in one multi-file edit', () => {
    expect(
      protectedTarget('Write', {
        file_path: 'src/ordinary.ts',
        file_paths: ['src/ordinary.ts', '.koda/guardrails.json'],
      })?.what,
    ).toBe("this project's guardrail switches")
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

  it('a protected later path in a Codex-style multi-file edit still forces the Auto ask', async () => {
    const { gate, pushed } = makeGate()
    const decision = gate.decide('s1', {
      toolUseId: 'multi-protected',
      toolName: 'Write',
      input: {
        file_path: 'src/ordinary.ts',
        file_paths: ['src/ordinary.ts', '.koda/safety.git/config'],
      },
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(pushed).toHaveLength(1)
    expect((pushed[0] as { reason?: string }).reason).toContain('recovery store')
    gate.resolve('multi-protected', { kind: 'allow' })
    expect((await decision).kind).toBe('allow')
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
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'mcp__koda_broker__capabilities'])
      expect(isMutating(t)).toBe(false)
  })

  it('treats edits, commands, and UNKNOWN tools as mutating (checkpoint first)', () => {
    for (const t of ['Write', 'Edit', 'Bash', 'SomeToolWeHaveNeverSeen']) expect(isMutating(t)).toBe(true)
  })

  it('recognizes only the known editors as edit tools (acceptEdits scope)', () => {
    expect(isEditTool('Edit')).toBe(true)
    expect(isEditTool('MultiEdit')).toBe(true)
    expect(isEditTool('Bash')).toBe(false)
  })

  /**
   * `keep_document` writes a file into the user's project, and it is deliberately absent from every
   * list in this module — the fail-closed default is already the behavior it wants. Pinned because the
   * absence reads as an oversight otherwise, and because adding it to READ_ONLY_TOOLS to "match the
   * other broker tools" would silently drop the checkpoint that makes a kept document undoable.
   */
  it('leaves keep_document on the fail-closed default: checkpointed, and not an auto-passing edit', () => {
    expect(isMutating('mcp__koda_broker__keep_document')).toBe(true)
    expect(isEditTool('mcp__koda_broker__keep_document')).toBe(false)
    // Not an always-confirm either: the user asked for the document, so Auto should not re-ask.
    expect(isAlwaysConfirm('mcp__koda_broker__keep_document')).toBe(false)
  })
})

/**
 * The recovery timeline is read by someone who has never seen a tool name, so the label is the whole
 * product surface of a checkpoint. `keep_document` carries no `file_path` and no `command`, so the
 * generic path produced `before mcp__koda_broker__keep_document` — the exact leak the module already
 * names as a reason to keep internal tools out of the timeline.
 */
describe('checkpointLabel', () => {
  it('says what a kept document was, in the user\'s own words', () => {
    expect(checkpointLabel('mcp__koda_broker__keep_document', { title: 'Branch management notes' })).toBe(
      'before keeping "Branch management notes" as a document',
    )
    expect(checkpointLabel('mcp__koda_broker__keep_document', {})).toBe('before keeping a document')
    // Never the raw MCP name, whatever the input.
    expect(checkpointLabel('mcp__koda_broker__keep_document', { body: 'x' })).not.toContain('mcp__')
  })

  it('clamps a long title so one row cannot take over the timeline', () => {
    const label = checkpointLabel('mcp__koda_broker__keep_document', { title: 'x'.repeat(120) })
    expect(label.length).toBeLessThan(120)
    expect(label.endsWith('\u2026" as a document')).toBe(true)
  })

  it('still labels the ordinary tools by their target', () => {
    expect(checkpointLabel('Write', { file_path: 'notes.md' })).toBe('before Write: notes.md')
    expect(checkpointLabel('Bash', { command: 'npm install' })).toBe('before Bash: npm install')
    expect(checkpointLabel('Glob', {})).toBe('before Glob')
  })
})
