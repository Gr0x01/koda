import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProjectDocumentDelete } from '../fs-browse'
import { ensureRepo, runGit } from './repo'
import { checkpoint, LARGE_FILE_BYTES, listCheckpoints } from './checkpoint'
import { restore } from './restore'

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

// The 2026-09-28 hub failure: a session at a folder of projects snapshotted a 1.9 GB file, hit the
// timeout, and orphaned a partial pack on every tool call until the disk filled.
describe('checkpoint on large trees', () => {
  const tracked = async (id: string) =>
    (await runGit(dir, ['ls-tree', '-r', '--name-only', '-z', id])).stdout.split('\0').filter(Boolean)
  // Sparse: reports the size without writing it, and the cap means git never reads it.
  const makeLarge = (path: string) => truncate(path, LARGE_FILE_BYTES + 1)

  it("leaves a child project's own safety store out of the parent's snapshot", async () => {
    await mkdir(join(dir, 'child', '.koda', 'safety.git'), { recursive: true })
    await writeFile(join(dir, 'child', '.koda', 'safety.git', 'HEAD'), 'ref: refs/heads/master\n')
    await writeFile(join(dir, 'child', 'notes.md'), 'hello')

    const result = await checkpoint(dir, 'hub turn')

    expect(await tracked(result.id)).toEqual(['child/notes.md'])
  })

  // The 2026-09-29 hub failure: one child repo with no commit yet made every hub checkpoint fatal.
  it("leaves child git repos out of the parent's snapshot, even one with no commit yet", async () => {
    await mkdir(join(dir, 'fresh'))
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'fresh') })
    await writeFile(join(dir, 'fresh', 'a.md'), 'x')
    await writeFile(join(dir, 'notes.md'), 'hello')

    const result = await checkpoint(dir, 'hub turn')

    expect(await tracked(result.id)).toEqual(['notes.md'])
  })

  it('skips files over the size cap and captures them again once they shrink', async () => {
    await writeFile(join(dir, 'small.md'), 'hello')
    await writeFile(join(dir, 'huge [v2].zip'), '')
    await makeLarge(join(dir, 'huge [v2].zip'))

    const first = await checkpoint(dir, 'with a huge file')
    expect(await tracked(first.id)).toEqual(['small.md'])

    await writeFile(join(dir, 'huge [v2].zip'), 'small now')
    const second = await checkpoint(dir, 'huge file shrank')
    expect(await tracked(second.id)).toEqual(['huge [v2].zip', 'small.md'])
  })

  it('stops following a tracked file once it grows past the cap instead of keeping a stale copy', async () => {
    await writeFile(join(dir, 'asset.bin'), 'small')
    await writeFile(join(dir, 'keep.md'), 'hello')
    await checkpoint(dir, 'asset is small')

    await makeLarge(join(dir, 'asset.bin'))
    await writeFile(join(dir, 'keep.md'), 'changed')
    const after = await checkpoint(dir, 'asset grew')

    expect(await tracked(after.id)).toEqual(['keep.md'])
  })

  it('restoring past a file that outgrew the cap leaves its current contents alone', async () => {
    await writeFile(join(dir, 'asset.bin'), 'small')
    await writeFile(join(dir, 'keep.md'), 'v1')
    const before = await checkpoint(dir, 'asset is small')
    await makeLarge(join(dir, 'asset.bin'))
    await writeFile(join(dir, 'keep.md'), 'v2')

    await restore(dir, before.id)

    expect((await stat(join(dir, 'asset.bin'))).size).toBe(LARGE_FILE_BYTES + 1)
    expect(await readFile(join(dir, 'keep.md'), 'utf8')).toBe('v1')
  })

  it('cleans up after a failed checkpoint so the next one succeeds', async () => {
    await writeFile(join(dir, 'notes.md'), 'hello')
    const store = join(dir, '.koda', 'safety.git')
    // What a killed `add -A` leaves: a partial pack and the index lock that blocks every later run.
    await writeFile(join(store, 'index.lock'), '')
    await writeFile(join(store, 'objects', 'pack', 'tmp_pack_orphan'), 'partial')

    await expect(checkpoint(dir, 'blocked by the lock')).rejects.toThrow()
    expect(existsSync(join(store, 'index.lock'))).toBe(false)
    expect(existsSync(join(store, 'objects', 'pack', 'tmp_pack_orphan'))).toBe(false)

    const retry = await checkpoint(dir, 'after cleanup')
    expect(await tracked(retry.id)).toEqual(['notes.md'])
  })
})
