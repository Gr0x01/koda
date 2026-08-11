import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_UNDO_POINT, undoPointRefusal } from '@shared/ipc'
import { IpcChannels } from '@shared/channels'

/**
 * A failed safety-git checkpoint must reach the user (debt item 17). `safeCheckpoint` is fail-soft and
 * reports failure ONLY through its return value, so a caller that drops the boolean leaves the person
 * believing every change has an undo behind it when it doesn't.
 *
 * These run the SHIPPED handler bodies: `registerIpcHandlers()` registers into the test electron
 * stub's recording `ipcMain`, and `invokeIpc` calls one the way the renderer would. The checkpoint is
 * forced to fail by stubbing the session manager's `checkpointProjectEdit`, which is exactly what a
 * broken/unwritable safety store produces (`safeCheckpoint` catches and returns false).
 *
 * The POSITIVE CONTROL matters as much as the failures: with a healthy checkpoint every one of these
 * paths must succeed silently. A change that warned on every save would otherwise pass the whole file.
 */

// The phone-control seam opens sockets at registration; nothing here goes near it.
vi.mock('./remote-control', () => ({
  initRemoteControl: () => {},
  disposeRemoteControl: async () => {},
  remoteStatusWatchHooks: () => ({}),
  registerRemoteIpcHandlers: () => {},
}))

const WIN_ID = 4217
const sender = { __win: { id: WIN_ID } }

let root: string
let ipc: typeof import('./ipc')
let invokeIpc: (channel: string, sender: unknown, ...args: unknown[]) => Promise<unknown>

/** Force the pre-edit checkpoint to fail (as an unwritable safety store does) for one call. */
async function withBrokenCheckpoint<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(ipc.getEngineSessions(), 'checkpointProjectEdit').mockResolvedValue(false)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

/** The healthy path: a checkpoint that succeeds, without touching real git. */
async function withGoodCheckpoint<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(ipc.getEngineSessions(), 'checkpointProjectEdit').mockResolvedValue(true)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'koda-undo-point-'))
  const registry = await import('./window-registry')
  registry.registerWindow({ id: WIN_ID } as never, root)
  ipc = await import('./ipc')
  ipc.registerIpcHandlers()
  ;({ invokeIpc } = await import('electron' as string))
})

afterAll(async () => {
  await ipc.disposeEngineSessions()
  rmSync(root, { recursive: true, force: true })
})

/** A fresh file for one case, so the cases can't mask each other. */
function seedFile(name: string, content = 'original\n'): string {
  const path = join(root, name)
  writeFileSync(path, content, 'utf8')
  return path
}

function seedSkill(name: string, body = '---\nname: keeper\n---\nmine\n'): string {
  const dir = join(root, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
  return join(dir, 'SKILL.md')
}

describe('a failed pre-save checkpoint is surfaced, not swallowed', () => {
  it('a save still lands but reports that it has no recovery point', async () => {
    const path = seedFile('save-me.md')
    const res = (await withBrokenCheckpoint(() =>
      invokeIpc(IpcChannels.fsWriteFile, sender, { path, content: 'edited\n' }),
    )) as { path: string; checkpointed: boolean }

    // Refusing the save would strand the user's typed work, so it writes AND tells.
    expect(readFileSync(path, 'utf8')).toBe('edited\n')
    expect(res.checkpointed).toBe(false)
  })

  it('a delete is refused, and says so', async () => {
    const path = seedFile('delete-me.md')
    await expect(
      withBrokenCheckpoint(() => invokeIpc(IpcChannels.fsDeletePath, sender, { path })),
    ).rejects.toThrow(NO_UNDO_POINT)
    expect(existsSync(path)).toBe(true) // the refusal is real: the file is still there
  })

  it('a bulk replace is refused, and says so', async () => {
    const path = seedFile('replace-me.md', 'needle here\n')
    await expect(
      withBrokenCheckpoint(() =>
        invokeIpc(IpcChannels.fsReplaceAll, sender, { query: 'needle', replacement: 'thread', scope: 'all' }),
      ),
    ).rejects.toThrow(NO_UNDO_POINT)
    expect(readFileSync(path, 'utf8')).toBe('needle here\n')
  })

  it('overwriting a skill body is refused, and says so', async () => {
    const file = seedSkill('keeper')
    await expect(
      withBrokenCheckpoint(() =>
        invokeIpc(IpcChannels.guardrailsSaveItemBody, sender, {
          kind: 'skill',
          name: 'keeper',
          content: '---\nname: keeper\n---\nclobbered\n',
        }),
      ),
    ).rejects.toThrow(NO_UNDO_POINT)
    expect(readFileSync(file, 'utf8')).toContain('mine')
  })

  it('removing a project skill is refused, and says so', async () => {
    const file = seedSkill('doomed', '---\nname: doomed\n---\nbody\n')
    await expect(
      withBrokenCheckpoint(() =>
        invokeIpc(IpcChannels.guardrailsRemoveItem, sender, { kind: 'skill', name: 'doomed' }),
      ),
    ).rejects.toThrow(NO_UNDO_POINT)
    expect(existsSync(file)).toBe(true)
  })

  it('rewording a rule is refused, and says so', async () => {
    await expect(
      withBrokenCheckpoint(() =>
        invokeIpc(IpcChannels.guardrailsSetRuleOverride, sender, {
          principleId: 'safety-first',
          text: 'my own wording',
        }),
      ),
    ).rejects.toThrow(NO_UNDO_POINT)
  })

  it('every refusal names what did NOT happen, so the message is actionable', async () => {
    const path = seedFile('phrasing.md')
    const err = await withBrokenCheckpoint(() =>
      invokeIpc(IpcChannels.fsDeletePath, sender, { path }).then(
        () => null,
        (e: unknown) => e,
      ),
    )
    // The renderer recovers this exact sentence across the Electron boundary (undoPointRefusal).
    expect(undoPointRefusal(err)).toBe("Couldn't make an undo point, so nothing was deleted.")
  })
})

/**
 * POSITIVE CONTROL. Delete this block and the suite above still passes for a change that shouted on
 * every single edit — which would be its own bug (and would train the user to ignore the warning).
 */
describe('positive control: a healthy checkpoint says nothing at all', () => {
  it('a save reports a recovery point and shows no warning', async () => {
    const path = seedFile('quiet-save.md')
    const res = (await withGoodCheckpoint(() =>
      invokeIpc(IpcChannels.fsWriteFile, sender, { path, content: 'edited\n' }),
    )) as { checkpointed: boolean }
    expect(res.checkpointed).toBe(true)
  })

  it('a delete goes through', async () => {
    const path = seedFile('quiet-delete.md')
    await withGoodCheckpoint(() => invokeIpc(IpcChannels.fsDeletePath, sender, { path }))
    expect(existsSync(path)).toBe(false)
  })

  it('a bulk replace goes through', async () => {
    const path = seedFile('quiet-replace.md', 'needle here\n')
    await withGoodCheckpoint(() =>
      invokeIpc(IpcChannels.fsReplaceAll, sender, { query: 'needle', replacement: 'thread', scope: 'all' }),
    )
    expect(readFileSync(path, 'utf8')).toBe('thread here\n')
  })

  it('a skill body overwrite goes through', async () => {
    const file = seedSkill('quiet-skill', '---\nname: quiet-skill\n---\nbefore\n')
    await withGoodCheckpoint(() =>
      invokeIpc(IpcChannels.guardrailsSaveItemBody, sender, {
        kind: 'skill',
        name: 'quiet-skill',
        content: '---\nname: quiet-skill\n---\nafter\n',
      }),
    )
    expect(readFileSync(file, 'utf8')).toContain('after')
  })

  it('a skill removal goes through', async () => {
    const file = seedSkill('quiet-doomed', '---\nname: quiet-doomed\n---\nbody\n')
    await withGoodCheckpoint(() =>
      invokeIpc(IpcChannels.guardrailsRemoveItem, sender, { kind: 'skill', name: 'quiet-doomed' }),
    )
    expect(existsSync(file)).toBe(false)
  })
})

/**
 * The deliberately-silent paths. These only ADD (deduped names; import writes with 'wx'; rename refuses
 * to clobber), so a missing checkpoint destroys nothing and warning about it would be noise. Pinned so
 * a later "surface it everywhere" pass has to argue with a test rather than drift into shouting.
 */
describe('additive edits stay silent when the checkpoint fails', () => {
  it('a rename still happens', async () => {
    const from = seedFile('rename-from.md')
    const to = join(root, 'rename-to.md')
    await withBrokenCheckpoint(() => invokeIpc(IpcChannels.fsRenamePath, sender, { from, to }))
    expect(existsSync(to)).toBe(true)
    expect(existsSync(from)).toBe(false)
  })

  it('a duplicate still happens', async () => {
    const path = seedFile('dupe-me.md')
    await withBrokenCheckpoint(() => invokeIpc(IpcChannels.fsDuplicatePath, sender, { path }))
    expect(existsSync(join(root, 'dupe-me copy.md'))).toBe(true)
  })

  it('an import still happens', async () => {
    await withBrokenCheckpoint(() =>
      invokeIpc(IpcChannels.fsImportFiles, sender, {
        destDir: root,
        files: [{ name: 'dropped.txt', data: new Uint8Array([104, 105]) }],
      }),
    )
    expect(readFileSync(join(root, 'dropped.txt'), 'utf8')).toBe('hi')
  })
})
