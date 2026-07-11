import { describe, it, expect } from 'vitest'
import { destructiveGit, isMutating, isEditTool } from './policy'

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
