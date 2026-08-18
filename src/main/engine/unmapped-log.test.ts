import { readFileSync, rmSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { flushUnmappedLog, logUnmappedEvent, resetUnmappedLogCounts, unmappedLogPath } from './unmapped-log'

/**
 * The unmapped log is the "never silently swallowed" half of the lossless contract. It holds engine
 * payloads, so it is bounded in every direction: per entry, per method, and (in the module) per file.
 */
describe('unmapped engine-event log', () => {
  beforeEach(() => resetUnmappedLogCounts())

  /** The log is append-only across runs by design, so a case owns its file before it writes. */
  function fresh(sessionId: string): string {
    rmSync(unmappedLogPath(sessionId), { force: true })
    return sessionId
  }

  function lines(sessionId: string): Record<string, unknown>[] {
    return readFileSync(unmappedLogPath(sessionId), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('records the engine, its method, its ids, and the payload', async () => {
    logUnmappedEvent(fresh('log-basic'), {
      source: 'codex',
      method: 'thread/somethingNew',
      ids: { threadId: 't-1' },
      payload: { detail: 'unknown shape' },
    })
    // Writing is off the hot path (queued, fire-and-forget), so a reader settles the queue first.
    await flushUnmappedLog()
    expect(lines('log-basic').at(-1)).toMatchObject({
      sessionId: 'log-basic',
      source: 'codex',
      method: 'thread/somethingNew',
      ids: { threadId: 't-1' },
      payload: { detail: 'unknown shape' },
    })
  })

  it('caps one chatty method so it cannot crowd out a rare one', async () => {
    fresh('log-cap')
    for (let i = 0; i < 30; i++)
      logUnmappedEvent('log-cap', { source: 'claude', method: 'chatty', payload: { i } })
    logUnmappedEvent('log-cap', { source: 'claude', method: 'rare', payload: { once: true } })
    await flushUnmappedLog()

    const written = lines('log-cap')
    expect(written.filter((l) => l.method === 'chatty')).toHaveLength(20)
    expect(written.filter((l) => l.method === 'rare')).toHaveLength(1)
    // The last entry of a capped method says so, so a reader knows the count is a floor, not a total.
    expect(written.filter((l) => l.method === 'chatty').at(-1)).toMatchObject({ capped: true })
  })

  it('truncates a huge payload instead of writing a tool result to disk', async () => {
    logUnmappedEvent(fresh('log-big'), { source: 'claude', method: 'huge', payload: { blob: 'x'.repeat(50_000) } })
    await flushUnmappedLog()
    const payload = lines('log-big').at(-1)?.payload
    expect(typeof payload).toBe('string')
    expect(String(payload)).toMatch(/…\[truncated \d+ chars\]$/)
    expect(String(payload).length).toBeLessThan(4200)
  })
})
