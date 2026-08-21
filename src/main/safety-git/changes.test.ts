import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpoint } from './checkpoint'
import { checkpointFileDiff, checkpointFileDiffText } from './changes'
import { ensureRepo } from './repo'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'koda-checkpoint-diff-'))
  await ensureRepo(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('checkpoint-backed file diffs', () => {
  it('uses the safety store even when the project has no user Git repository', async () => {
    await writeFile(join(dir, 'note.txt'), 'before\n')
    const base = await checkpoint(dir, 'Before editing')
    await writeFile(join(dir, 'note.txt'), 'after\n')

    const pair = await checkpointFileDiff(dir, base.id, 'note.txt')
    const text = await checkpointFileDiffText(dir, base.id, 'note.txt')

    expect(pair).toMatchObject({ before: 'before\n', after: 'after\n', binary: false })
    expect(text.truncated).toBe(false)
    expect(text.diff).toContain('-before')
    expect(text.diff).toContain('+after')
  })

  it('refuses a path outside the project', async () => {
    const base = await checkpoint(dir, 'Empty project')
    await expect(checkpointFileDiffText(dir, base.id, '../outside.txt')).rejects.toThrow(
      'path must stay inside the project',
    )
  })
})
