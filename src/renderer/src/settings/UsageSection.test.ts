// The Usage page's citable-dollar guard, successor to the retired ProvidersSection.test.ts: the
// server-rendered surfaces may print a dollar ONLY for a bucket that carries a citation
// (tableRated/published), and an unpriced bucket renders as tokens with its refusal said out loud.
// Rendering (not just the view-model) is what's asserted, because B3's dollar leaks lived in JSX
// where view-model tests couldn't see them.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PricedScanBucket } from '@shared/ipc'
import { buildScanUsageValue } from '@shared/usage-value'
import { Hero, MetricsStrip, ModelTable } from './UsageSection'

const HOUR = Date.parse('2026-08-19T18:00:00.000Z')

function bucket(over: Partial<PricedScanBucket>): PricedScanBucket {
  return {
    hourStartMs: HOUR,
    day: '2026-08-19',
    engine: 'claude',
    model: 'claude-opus-5',
    origin: 'koda',
    uncachedInput: 1000,
    cachedInput: 10_000,
    cacheCreation: 500,
    output: 800,
    reasoning: 100,
    records: 4,
    costUsd: null,
    cacheSavingsUsd: null,
    costSource: 'unpriced',
    ...over,
  }
}

/** One table-rated Claude bucket, one published-rate Codex bucket, one unpriced model. */
const MIXED: PricedScanBucket[] = [
  bucket({ model: 'claude-opus-5', costUsd: 4.1, cacheSavingsUsd: null, costSource: 'tableRated' }),
  bucket({ engine: 'codex', model: 'gpt-5.2-codex', origin: 'outside', costUsd: 2.4, costSource: 'published' }),
  bucket({ model: 'claude-mystery-preview', costUsd: null, costSource: 'unpriced' }),
]

const value = buildScanUsageValue(MIXED)

describe('the rendered usage page', () => {
  it('sums only citable dollars into the headline', () => {
    const html = renderToStaticMarkup(createElement(Hero, { value }))
    expect(html).toMatch(/data-testid="usage-headline"[^>]*>\$6\.50/)
    // The unpriced bucket's tokens are in the token totals but no invented dollar appears anywhere.
    expect(html).not.toContain('$8')
    expect(html).not.toContain('$7')
  })

  it('renders an unpriced model as a spoken refusal, never a dollar', () => {
    const html = renderToStaticMarkup(createElement(ModelTable, { value }))
    expect(html).toContain('no citable rate · tokens only')
    expect(html).toContain('$4.10')
    expect(html).toContain('$2.40')
    // Exactly the two citable dollars — a third $ would be an invented one.
    expect(html.match(/\$/g)).toHaveLength(2)
  })

  it('shows a dash for cache savings when no bucket could cite a rate for them', () => {
    const html = renderToStaticMarkup(createElement(MetricsStrip, { value, window: '30d' }))
    expect(html).toContain('Cache savings')
    expect(html).toContain('no citable rate')
    expect(html.match(/\$/g)).toBeNull()
  })

  it('reconciles the builder against the buckets it was fed', () => {
    expect(value.pricedCostUsd).toBeCloseTo(6.5, 10)
    // 3 buckets × (1000 + 10000 + 500 + 800)
    expect(value.totalTokens).toBe(3 * 12_300)
    expect(value.unpricedTokens).toBe(12_300)
    expect(value.records).toBe(12)
    expect(value.originTokens.koda).toBe(2 * 12_300)
    expect(value.originTokens.outside).toBe(12_300)
    expect(value.daily).toHaveLength(1)
    expect(value.daily[0].pricedCostUsd).toBeCloseTo(6.5, 10)
    expect(value.daily[0].totalTokens).toBe(3 * 12_300)
    expect(value.hourly).toHaveLength(1)
    expect(value.activeDays).toBe(1)
    expect(value.models.map((m) => m.model)).toEqual([
      'claude-opus-5',
      'gpt-5.2-codex',
      'claude-mystery-preview',
    ])
    const shares = value.models.map((m) => m.costShare)
    expect(shares[0] + shares[1]).toBeCloseTo(1, 10)
    expect(shares[2]).toBe(0)
  })
})
