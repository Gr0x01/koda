import { describe, expect, it } from 'vitest'
import { importWithRetry } from './lazyWithRetry'

// The retry is the whole point: a chunk fetch that loses the race to a Vite re-optimize (or a stale
// hash) must self-heal on a fresh attempt instead of throwing to the error boundary.
describe('importWithRetry', () => {
  it('resolves once the factory stops failing', async () => {
    let calls = 0
    const mod = await importWithRetry(async () => {
      calls++
      if (calls < 3) throw new Error('Failed to fetch dynamically imported module')
      return { default: 'ok' }
    })
    expect(mod).toEqual({ default: 'ok' })
    expect(calls).toBe(3) // failed twice, succeeded on the third (retries default = 2)
  })

  it('rethrows the last error after exhausting retries', async () => {
    let calls = 0
    await expect(
      importWithRetry(async () => {
        calls++
        throw new Error(`boom ${calls}`)
      }, 2),
    ).rejects.toThrow('boom 3')
    expect(calls).toBe(3) // 1 initial + 2 retries
  })

  it('does not retry when the first attempt succeeds', async () => {
    let calls = 0
    await importWithRetry(async () => {
      calls++
      return { default: 1 }
    })
    expect(calls).toBe(1)
  })
})
