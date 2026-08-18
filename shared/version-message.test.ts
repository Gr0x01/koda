import { describe, expect, it } from 'vitest'
import { cleanVersionSubject, fallbackVersionMessage, type VersionMessageFile } from './version-message'

// The floor is what a save is named whenever no model wrote one — a Codex session, the toggle off, a
// missed turn — AND what the composer is seeded with before any turn is even requested. Both sides
// call this exact function, so these cases are the contract between them.

const f = (path: string, status: VersionMessageFile['status'] = 'modified'): VersionMessageFile => ({
  path,
  status,
})

describe('fallbackVersionMessage', () => {
  it('names the one file a single-file change touched', () => {
    expect(fallbackVersionMessage([f('src/main/user-git.ts')])).toBe('Update src/main/user-git.ts')
    expect(fallbackVersionMessage([f('docs/plan.md', 'untracked')])).toBe('Add docs/plan.md')
    expect(fallbackVersionMessage([f('old.txt', 'deleted')])).toBe('Delete old.txt')
  })

  it('says where a multi-file change happened when the files agree on a directory', () => {
    expect(
      fallbackVersionMessage([f('src/main/a.ts'), f('src/main/b.ts'), f('src/main/c.ts')]),
    ).toBe('Update 3 files in src/main')
  })

  it('drops the directory when the change is spread across the project', () => {
    expect(fallbackVersionMessage([f('src/a.ts'), f('docs/b.md')])).toBe('Update 2 files')
  })

  it('keeps the verb honest for a mixed change set', () => {
    // Adds plus deletes is not "Add" and not "Delete"; only a set that agrees earns a specific verb.
    expect(fallbackVersionMessage([f('a.ts', 'added'), f('b.ts', 'deleted')])).toBe('Update 2 files')
    expect(fallbackVersionMessage([f('a.ts', 'added'), f('b.ts', 'untracked')])).toBe('Add 2 files')
  })

  it('states a clipped count as a floor rather than as a fact', () => {
    // The status list is capped, so the number the renderer holds is a minimum. Saying "200 files"
    // when it was 4,000 is the quiet lie this "+" exists to avoid.
    expect(fallbackVersionMessage([f('src/a.ts'), f('src/b.ts')], true)).toBe(
      'Update 2+ files in src',
    )
    expect(fallbackVersionMessage([f('src/a.ts')], true)).toBe('Update 1+ files in src')
  })

  it('never returns an empty string', () => {
    expect(fallbackVersionMessage([])).toBe('Save the current changes')
  })
})

describe('cleanVersionSubject', () => {
  it('normalizes the same one-line subject for every writer', () => {
    expect(cleanVersionSubject('  "Subject: Fix phone naming."  ')).toBe('Fix phone naming')
    expect(cleanVersionSubject('Fix naming — and persistence')).toBe('Fix naming, and persistence')
  })

  it('rejects a body, refusal, or run-on before it reaches project history', () => {
    expect(cleanVersionSubject('Fix phone naming\n\nExplain the change')).toBeNull()
    expect(cleanVersionSubject('I cannot help with that')).toBeNull()
    expect(cleanVersionSubject('word '.repeat(20))).toBeNull()
  })
})
