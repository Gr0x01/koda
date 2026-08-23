import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { preparePresentFile, resolveStageLink } from './stage-presentation'

const roots: string[] = []
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'koda-stage-'))
  roots.push(root)
  mkdirSync(join(root, 'Documents'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'Documents', 'Build plan.md'), '# Plan')
  writeFileSync(join(root, 'Documents', 'Rollout.html'), '<!doctype html><p>Rollout</p>')
  writeFileSync(join(root, 'Documents', 'Notes.mdx'), '# Notes')
  writeFileSync(join(root, 'src', 'app.ts'), 'one\ntwo\nthree\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('preparePresentFile', () => {
  it('chooses document/file views and preserves a valid source location', () => {
    const root = project()
    expect(preparePresentFile(root, { path: 'Documents/Build plan.md' })).toMatchObject({
      path: 'Documents/Build plan.md',
      view: 'document',
    })
    expect(preparePresentFile(root, { path: 'src/app.ts', line: 2, column: 3 })).toMatchObject({
      path: 'src/app.ts',
      view: 'file',
      line: 2,
      column: 3,
    })
  })

  it('follows the shared format contract for which files have a document view', () => {
    const root = project()
    // HTML has a real rendered surface now, so the agent may present one as a document.
    expect(preparePresentFile(root, { path: 'Documents/Rollout.html' })).toMatchObject({
      path: 'Documents/Rollout.html',
      view: 'document',
    })
    expect(preparePresentFile(root, { path: 'Documents/Rollout.html', view: 'document' })).toMatchObject({
      view: 'document',
    })
    // `.mdx` no longer does: the Dock opens it as source, and one file must not have two answers.
    expect(preparePresentFile(root, { path: 'Documents/Notes.mdx' })).toMatchObject({
      path: 'Documents/Notes.mdx',
      view: 'file',
    })
    expect(() => preparePresentFile(root, { path: 'Documents/Notes.mdx', view: 'document' })).toThrow()
  })

  it('rejects absolute, traversing, missing, and incompatible presentation requests', () => {
    const root = project()
    expect(() => preparePresentFile(root, { path: join(root, 'src/app.ts') })).toThrow()
    expect(() => preparePresentFile(root, { path: '../outside.ts' })).toThrow()
    expect(() => preparePresentFile(root, { path: 'missing.ts' })).toThrow()
    expect(() => preparePresentFile(root, { path: 'src/app.ts', view: 'document' })).toThrow()
    expect(() => preparePresentFile(root, { path: 'src/app.ts', column: 2 })).toThrow()
  })
})

describe('resolveStageLink', () => {
  it('resolves relative, file URL, hash, and colon locations', () => {
    const root = project()
    expect(resolveStageLink(root, 'src/app.ts#L2C3')).toMatchObject({
      kind: 'file',
      path: 'src/app.ts',
      line: 2,
      column: 3,
    })
    expect(resolveStageLink(root, 'src/app.ts:3')).toMatchObject({ kind: 'file', path: 'src/app.ts', line: 3 })
    expect(resolveStageLink(root, pathToFileURL(join(root, 'Documents', 'Build plan.md')).href)).toMatchObject({
      kind: 'file',
      path: 'Documents/Build plan.md',
    })
  })

  it('lets an exact colon filename win over location parsing', () => {
    const root = project()
    writeFileSync(join(root, 'src', 'notes:12'), 'literal filename')
    const target = resolveStageLink(root, 'src/notes:12')
    expect(target).toMatchObject({
      kind: 'file',
      path: 'src/notes:12',
    })
    expect(target).not.toHaveProperty('line')
  })

  it('declines traversal and symlink escape, and labels missing files', () => {
    const root = project()
    const outside = mkdtempSync(join(tmpdir(), 'koda-stage-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'escape.txt'))
    expect(resolveStageLink(root, '../secret.txt').kind).toBe('declined')
    expect(resolveStageLink(root, 'src/escape.txt').kind).toBe('declined')
    expect(resolveStageLink(root, 'src/missing.ts').kind).toBe('missing')
  })
})
