import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadUsageHistory, recordTurnUsage } from './usage-history'
import { log } from '../logger'

const historyFile = join(tmpdir(), 'koda-usage-history.json')
const backupFile = `${historyFile}.corrupt.bak`

async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(historyFile, { force: true })
  rmSync(backupFile, { force: true })
})

describe('usage history integrity', () => {
  it('preserves an unreadable 90-day record instead of replacing it on the next turn', async () => {
    const original = '{"version":1,"days":{"2026-05-12": broken'
    writeFileSync(historyFile, original)
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    recordTurnUsage(undefined, 1.25)
    await flushWrites()

    expect(readFileSync(historyFile, 'utf8')).toBe(original)
    expect(readFileSync(backupFile, 'utf8')).toBe(original)
    expect(warn.mock.calls.some(([, message]) => String(message).includes('preserving it'))).toBe(true)
  })

  it('still creates history normally on first use', async () => {
    recordTurnUsage(undefined, 1.25)
    await flushWrites()

    expect(existsSync(historyFile)).toBe(true)
    expect(loadUsageHistory()).toMatchObject([{ costUsd: 1.25, turns: 1 }])
  })
})
