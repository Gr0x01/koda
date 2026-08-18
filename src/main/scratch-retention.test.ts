import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcChannels } from '@shared/channels'
import { registerWindow, unregisterWindow } from './window-registry'
import { SCRATCH_RETENTION_SWEEP_MS, startScratchRetentionSweep } from './scratch-retention'

const retention = vi.hoisted(() => ({ days: 1 }))
vi.mock('./settings', () => ({ loadScratchRetentionDays: () => retention.days }))
// The governor's own power/focus behavior has a dedicated suite; here every scheduled tick is due so
// this test isolates the retention timer → prune → renderer-notification path.
vi.mock('./probe-governor', () => ({
  governProbe: () => ({ due: () => true, ran: () => {}, release: () => {} }),
}))

const NOW = Date.parse('2026-08-15T18:00:00.000Z')
const WINDOW_ID = 6201

describe('scratch retention sweep', () => {
  let root: string
  let stop: (() => void) | null
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    retention.days = 1
    root = mkdtempSync(join(tmpdir(), 'koda-retention-sweep-'))
    send = vi.fn()
    registerWindow(
      {
        id: WINDOW_ID,
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      } as never,
      root,
    )
    stop = null
  })

  afterEach(() => {
    stop?.()
    unregisterWindow(WINDOW_ID)
    rmSync(root, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('removes a file after it crosses the age limit in a quiet open project', async () => {
    const dir = join(root, '.koda', 'scratch')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'almost-expired.webp')
    writeFileSync(path, 'image')
    const stamp = new Date(NOW - (23 * 60 + 50) * 60_000)
    utimesSync(path, stamp, stamp)

    stop = startScratchRetentionSweep()
    await vi.advanceTimersByTimeAsync(SCRATCH_RETENTION_SWEEP_MS)

    await vi.waitFor(() => expect(existsSync(path)).toBe(false))
    expect(send).toHaveBeenCalledWith(IpcChannels.scratchChanged)
  })
})
