import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProjectDocumentDelete } from '../fs-browse'
import { ensureRepo, runGit } from './repo'
import { checkpoint, listCheckpoints } from './checkpoint'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'koda-checkpoint-'))
  await ensureRepo(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('checkpoint on a brand-new project', () => {
  // The 2026-08-02 intake failure: a fresh EMPTY project stages nothing, and the first checkpoint
  // died on git's "nothing to commit" (both fresh health projects hit it, first turn, every time).
  // An empty first checkpoint must instead anchor the timeline with an empty root commit.
  it('succeeds on an empty work tree (the fresh-intake case)', async () => {
    const result = await checkpoint(dir, 'Setting up the project')
    expect(result.skipped).toBe(false)
    expect(result.id).toMatch(/^[0-9a-f]{40}$/)
    expect((await listCheckpoints(dir)).map((c) => c.label)).toEqual(['Setting up the project'])
  })

  it('does not litter empty commits once a root exists', async () => {
    const root = await checkpoint(dir, 'Setting up the project')
    const again = await checkpoint(dir, 'Another turn, still no files')
    expect(again.skipped).toBe(true)
    expect(again.id).toBe(root.id)
    expect(await listCheckpoints(dir)).toHaveLength(1)
  })

  it('still records real first content normally', async () => {
    await writeFile(join(dir, 'notes.md'), 'hello')
    const result = await checkpoint(dir, 'First real work')
    expect(result.skipped).toBe(false)
    const after = await checkpoint(dir, 'No changes since')
    expect(after.skipped).toBe(true)
    expect(after.id).toBe(result.id)
  })

  it('ignores document presentation sidecars', async () => {
    const root = await checkpoint(dir, 'Setting up the project')
    await mkdir(join(dir, '.koda', 'docmeta'), { recursive: true })
    await writeFile(join(dir, '.koda', 'docmeta', 'layout.json'), '{"tableWidths":[120]}')

    const afterLayoutChange = await checkpoint(dir, 'Resize a table')

    expect(afterLayoutChange.skipped).toBe(true)
    expect(afterLayoutChange.id).toBe(root.id)
  })

  it('force-captures exactly one ignored document and verifies it in the returned checkpoint', async () => {
    await mkdir(join(dir, 'Documents'), { recursive: true })
    await writeFile(join(dir, '.gitignore'), '/Documents/private.md\n')
    const file = join(dir, 'Documents', 'private.md')
    await writeFile(file, 'private draft\n')
    const requiredFile = await prepareProjectDocumentDelete(dir, file)

    const result = await checkpoint(dir, 'delete private.md', { requiredFile })
    const { stdout: body } = await runGit(dir, ['show', `${result.id}:Documents/private.md`])
    const { stdout: tree } = await runGit(dir, [
      'ls-tree',
      '-z',
      result.id,
      '--',
      ':(literal)Documents/private.md',
    ])

    expect(result.skipped).toBe(false)
    expect(body).toBe('private draft\n')
    expect(tree).toMatch(/^100(?:644|755) blob [0-9a-f]{40,64}\tDocuments\/private\.md\0$/)

    const unchanged = await checkpoint(dir, 'delete private.md again', { requiredFile })
    expect(unchanged.skipped).toBe(true)
    expect(unchanged.id).toBe(result.id)
  })

  it('refuses a required file whose pre-check identity no longer names the same inode', async () => {
    await mkdir(join(dir, 'Documents'), { recursive: true })
    const file = join(dir, 'Documents', 'replace-me.md')
    await writeFile(file, 'version one\n')
    const requiredFile = await prepareProjectDocumentDelete(dir, file)
    await rename(file, `${file}.old`)
    await writeFile(file, 'version two\n')

    await expect(checkpoint(dir, 'delete replace-me.md', { requiredFile })).rejects.toThrow(
      'changed before it could be protected',
    )
  })
})
