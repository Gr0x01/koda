import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkpoint } from './checkpoint'
import { ensureRepo } from './repo'
import { createCheckpointSandbox, removeCheckpointSandbox } from './sandbox'

describe('checkpoint sandbox', () => {
  let project = ''
  let sandbox = ''

  afterEach(async () => {
    if (sandbox) await removeCheckpointSandbox(sandbox).catch(() => {})
    if (project) await removeCheckpointSandbox(project).catch(() => {})
  })

  it('materializes the chosen safety snapshot without sharing the live working tree', async () => {
    project = await mkdtemp(join(tmpdir(), 'koda-rem-source-'))
    await writeFile(join(project, 'problem.md'), 'checkpoint version\n')
    await ensureRepo(project)
    const point = await checkpoint(project, 'before REM')

    await writeFile(join(project, 'problem.md'), 'later live edit\n')
    sandbox = await createCheckpointSandbox(project, point.id)

    expect(await readFile(join(sandbox, 'problem.md'), 'utf8')).toBe('checkpoint version\n')
    await writeFile(join(sandbox, 'problem.md'), 'REM accident\n')
    expect(await readFile(join(project, 'problem.md'), 'utf8')).toBe('later live edit\n')
  })
})
