// The pricing contract: a dollar exists only with a citation (table row, named rate, or nothing —
// and nothing means null, never zero), and the table lifecycle degrades honestly:
// fresh cache → refetch → stale cache → unavailable.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'koda-usage-pricing-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
vi.mock('../logger', () => ({ log: { info: () => {}, warn: () => {} } }))

const { loadRateTable, parseRateTable, priceScanBuckets, LITELLM_URL } = await import('./usage-pricing')
import type { ScanBucket } from './usage-scan'

const cacheFile = join(dir, 'koda-usage-rates.json')

const LITELLM_DOC = {
  'gpt-5.3-codex': {
    input_cost_per_token: 0.00000125,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.000000125,
  },
  'anthropic/claude-opus-5': {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
  },
  'half-priced-model': { input_cost_per_token: 0.000001 },
  'sample_spec': { not: 'a rate' },
}

function okFetch(doc: unknown = LITELLM_DOC): typeof fetch {
  return vi.fn(async (url: unknown) => {
    expect(url).toBe(LITELLM_URL)
    return { ok: true, status: 200, json: async () => doc } as Response
  }) as unknown as typeof fetch
}

const failFetch = (() => {
  throw new Error('offline')
}) as unknown as typeof fetch

function bucket(model: string, over: Partial<ScanBucket> = {}): ScanBucket {
  return {
    hourStartMs: Date.parse('2026-08-19T18:00:00.000Z'),
    day: '2026-08-19',
    engine: 'claude',
    model,
    origin: 'outside',
    uncachedInput: 1000,
    cachedInput: 10_000,
    cacheCreation: 2000,
    output: 500,
    reasoning: 0,
    records: 3,
    ...over,
  }
}

beforeEach(() => rmSync(cacheFile, { force: true }))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('parseRateTable', () => {
  it('keeps fully-priced entries under bare keys, drops half-priced ones, defaults cache rates', () => {
    const rates = parseRateTable(LITELLM_DOC)
    expect(Object.keys(rates).sort()).toEqual(['claude-opus-5', 'gpt-5.3-codex'])
    // No cache_creation rate published → defaults to the input rate, never zero.
    expect(rates['gpt-5.3-codex'].cacheCreation).toBe(0.00000125)
    expect(rates['claude-opus-5'].cacheCreation).toBe(0.00000625)
  })

  it('never lets a reseller row or document order change a first-party price', () => {
    const rates = parseRateTable({
      // Unprefixed real rate, then a pricier reseller copy LATER in the document.
      'gpt-real': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      'openrouter/openai/gpt-real': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000006 },
      // First-party prefix later must not beat the unprefixed row either.
      'openai/gpt-real': { input_cost_per_token: 0.000009, output_cost_per_token: 0.000009 },
      // A model published ONLY under its first-party prefix still prices.
      'anthropic/claude-only-prefixed': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
      // Reseller-only names never enter the table at all.
      'azure/us/gpt-azure-only': { input_cost_per_token: 0.0000022, output_cost_per_token: 0.0000088 },
      'bedrock/us-gov-west-1/claude-gov': { input_cost_per_token: 0.0000036, output_cost_per_token: 0.000018 },
    })
    expect(rates['gpt-real'].input).toBe(0.000001)
    expect(rates['claude-only-prefixed'].input).toBe(0.000005)
    expect(rates['gpt-azure-only']).toBeUndefined()
    expect(rates['claude-gov']).toBeUndefined()
  })
})

describe('loadRateTable lifecycle', () => {
  it('fetches, persists, and then serves the day-fresh cache without refetching', async () => {
    const fetcher = okFetch()
    const first = await loadRateTable(fetcher)
    expect(first.provenance.status).toBe('fresh')
    expect(first.provenance.knownModels).toBe(2)
    const second = await loadRateTable(failFetch)
    expect(second.provenance.status).toBe('fresh')
    expect(second.rates['gpt-5.3-codex']).toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('serves a stale cache as cached when the refresh fails', async () => {
    await loadRateTable(okFetch())
    const stale = JSON.parse(readFileSync(cacheFile, 'utf8'))
    stale.fetchedAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(cacheFile, JSON.stringify(stale))
    const table = await loadRateTable(failFetch)
    expect(table.provenance.status).toBe('cached')
    expect(table.rates['claude-opus-5']).toBeDefined()
  })

  it('reports unavailable with an empty table when there is no cache and no network', async () => {
    const table = await loadRateTable(failFetch)
    expect(table.provenance.status).toBe('unavailable')
    expect(Object.keys(table.rates)).toEqual([])
  })
})

describe('priceScanBuckets', () => {
  it('prices from the table with exact arithmetic and cites tableRated', async () => {
    const table = await loadRateTable(okFetch())
    const [b] = priceScanBuckets([bucket('claude-opus-5')], table)
    expect(b.costSource).toBe('tableRated')
    // 1000×5e-6 + 10000×5e-7 + 2000×6.25e-6 + 500×2.5e-5 = 0.035
    expect(b.costUsd).toBeCloseTo(0.035, 10)
    // 10000×(5e-6 − 5e-7) − 2000×(6.25e-6 − 5e-6) = 0.0425
    expect(b.cacheSavingsUsd).toBeCloseTo(0.0425, 10)
  })

  it('falls back to the named published rate and cites published', async () => {
    const table = await loadRateTable(failFetch)
    const [b] = priceScanBuckets([bucket('claude-opus-4-8')], table)
    expect(b.costSource).toBe('published')
    expect(b.costUsd).toBeGreaterThan(0)
  })

  it('never invents a dollar: unknown models carry null cost, not zero', async () => {
    const table = await loadRateTable(failFetch)
    const priced = priceScanBuckets([bucket('unknown'), bucket('some-new-model')], table)
    for (const b of priced) {
      expect(b.costSource).toBe('unpriced')
      expect(b.costUsd).toBeNull()
      expect(b.cacheSavingsUsd).toBeNull()
    }
  })
})
