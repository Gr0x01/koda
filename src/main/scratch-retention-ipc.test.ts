import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcChannels } from '@shared/channels'

const settingsState = vi.hoisted(() => ({ retentionDays: 30 }))

vi.mock('./settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings')>()
  const snapshot = () => ({
    ...actual.loadSettings(),
    hasOnboarded: true,
    scratchRetentionDays: settingsState.retentionDays,
  })
  return {
    ...actual,
    loadSettings: snapshot,
    loadScratchRetentionDays: () => settingsState.retentionDays,
    updateSettings: (patch: { scratchRetentionDays?: number }) => {
      if (patch.scratchRetentionDays !== undefined) {
        settingsState.retentionDays = Math.max(0, Math.floor(patch.scratchRetentionDays))
      }
      return snapshot()
    },
  }
})

// The phone-control seam opens sockets during registration; retention does not depend on it.
vi.mock('./remote-control', () => ({
  initRemoteControl: () => {},
  disposeRemoteControl: async () => {},
  remoteStatusWatchHooks: () => ({}),
  registerRemoteIpcHandlers: () => {},
}))

const OPEN_A = 6101
const OPEN_B = 6102
const CLOSED_UNTIL_LISTED = 6103
const sender = (id: number) => ({ __win: { id } })

let roots: string[]
let registry: typeof import('./window-registry')
let ipc: typeof import('./ipc')
let invokeIpc: (channel: string, sender: unknown, ...args: unknown[]) => Promise<unknown>
const scratchChanges = new Map<number, ReturnType<typeof vi.fn>>()

function fakeWindow(id: number): never {
  const send = vi.fn()
  scratchChanges.set(id, send)
  return {
    id,
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send },
  } as never
}

function seedOld(root: string): string {
  const dir = join(root, '.koda', 'scratch')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'old.webp')
  writeFileSync(path, 'old')
  const ancient = new Date(0)
  utimesSync(path, ancient, ancient)
  return path
}

beforeAll(async () => {
  settingsState.retentionDays = 30
  roots = [0, 1, 2].map(() => mkdtempSync(join(tmpdir(), 'koda-retention-ipc-')))
  registry = await import('./window-registry')
  registry.registerWindow(fakeWindow(OPEN_A), roots[0])
  registry.registerWindow(fakeWindow(OPEN_B), roots[1])
  ipc = await import('./ipc')
  ipc.registerIpcHandlers()
  ;({ invokeIpc } = await import('electron' as string))
})

afterAll(async () => {
  registry.unregisterWindow(OPEN_A)
  registry.unregisterWindow(OPEN_B)
  registry.unregisterWindow(CLOSED_UNTIL_LISTED)
  await ipc.disposeEngineSessions()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('scratch retention IPC', () => {
  it('cleans every open project on a setting change and a closed project on its next first page', async () => {
    const openA = seedOld(roots[0])
    const openB = seedOld(roots[1])
    const closed = seedOld(roots[2])

    await invokeIpc(IpcChannels.settingsSet, sender(OPEN_A), { scratchRetentionDays: 1 })

    expect(existsSync(openA)).toBe(false)
    expect(existsSync(openB)).toBe(false)
    expect(existsSync(closed)).toBe(true)
    expect(scratchChanges.get(OPEN_A)).toHaveBeenCalledWith(IpcChannels.scratchChanged)
    expect(scratchChanges.get(OPEN_B)).toHaveBeenCalledWith(IpcChannels.scratchChanged)

    registry.registerWindow(fakeWindow(CLOSED_UNTIL_LISTED), roots[2])
    const page = await invokeIpc(IpcChannels.scratchList, sender(CLOSED_UNTIL_LISTED), {
      offset: 0,
      limit: 30,
    })
    expect(page).toEqual({ images: [], total: 0 })
    expect(existsSync(closed)).toBe(false)
  })
})
