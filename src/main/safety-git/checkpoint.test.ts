import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRepo } from './repo'
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
})
