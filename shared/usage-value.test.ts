import { describe, expect, it } from 'vitest'

import type { UsageHistoryDay } from './ipc'
import { buildUsageValue } from './usage-value'
import { cacheSavingsUsd, publishedRate } from './model-pricing'

// The tracker-backed reconciliation lives in src/main/engine/usage-value.reconcile.test.ts (it needs the
// real recorder). These cover the arithmetic that has no recorder path: multi-day windows and pricing.

describe('per-active-day normalization', () => {
  const spend = {
    costUsd: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
  }
  const day = (date: string): UsageHistoryDay => ({
    date,
    costUsd: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
    turns: 2,
    byModel: { 'claude-sonnet-4-6': spend },
    byEngine: { claude: 1 },
  })

  it('divides by days that actually ran, not by calendar days in the window', () => {
    // Three recorded days spread over two weeks — a calendar divisor would read a fifth of this.
    const value = buildUsageValue([day('2026-08-12'), day('2026-08-05'), day('2026-07-29')])
    expect(value.activeDays).toBe(3)
    expect(value.byEngine.claude.activeDays).toBe(3)
    expect(value.byEngine.claude.pricedCostPerActiveDayUsd).toBeCloseTo(1, 10)
    expect(value.byEngine.claude.tokensPerActiveDay).toBeCloseTo(100, 10)
    // Oldest first, so the chart reads left to right in time.
    expect(value.daily.map((d) => d.date)).toEqual(['2026-07-29', '2026-08-05', '2026-08-12'])
  })

  it('reports no average rather than dividing by zero on an empty history', () => {
    const value = buildUsageValue([])
    expect(value.activeDays).toBe(0)
    expect(value.daily).toEqual([])
    expect(value.byEngine).toEqual({})
  })

  it('keeps a legacy untagged day at its real cost even with no engine split to draw', () => {
    const legacy: UsageHistoryDay = { ...day('2026-08-01'), byEngine: undefined }
    const value = buildUsageValue([legacy])
    expect(value.daily[0].costUsd).toBe(1)
    // The model bucket still attributes tokens; only the money has no stamped owner.
    expect(value.byEngine.claude.costUsd).toBe(0)
    expect(value.byEngine.claude.modelCostUsd).toBe(1)
  })
})

describe('priced marking is what a surface may branch on', () => {
  const spend = (costUsd: number) => ({
    costUsd,
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 100,
    cacheCreationTokens: 100,
  })

  /** One citable model at $2 and one alias we cannot price at $1 — recorded cost $3. */
  const MIXED: UsageHistoryDay[] = [
    {
      date: '2026-08-12',
      costUsd: 3,
      inputTokens: 200,
      outputTokens: 200,
      cacheReadTokens: 200,
      cacheCreationTokens: 200,
      turns: 2,
      byModel: { 'claude-opus-5': spend(2), opusplan: spend(1) },
      byEngine: { claude: 3 },
    },
  ]

  it('marks an engine priced on its citable models and keeps the rest on tokens', () => {
    const claude = buildUsageValue(MIXED).byEngine.claude
    expect(claude.priced).toBe(true)
    // Only the citable model's money counts as priced; the alias's tokens go to the tokens bucket.
    expect(claude.pricedCostUsd).toBe(2)
    expect(claude.unpricedTokens).toBe(400)
    expect(claude.models.find((m) => m.model === 'opusplan')?.priced).toBe(false)
    expect(buildUsageValue(MIXED).daily[0].pricedCostUsd).toBe(2)
    expect(buildUsageValue(MIXED).daily[0].costUsd).toBe(3)
  })

  it('renders every dollar from the priced total, never the recorded one', () => {
    const value = buildUsageValue(MIXED)
    const claude = value.byEngine.claude

    // The two differ here, so a surface reading the wrong one is visible rather than coincidental.
    expect(claude.costUsd).toBe(3)
    expect(claude.modelCostUsd).toBe(3)
    expect(claude.pricedCostUsd).toBe(2)

    // Headline dollars.
    expect(claude.pricedCostUsd).not.toBe(claude.costUsd)

    // Per-active-day dollars: $2 over the one active day, not $3. There is no recorded-cost average
    // field to reach for by mistake.
    expect(claude.activeDays).toBe(1)
    expect(claude.pricedCostPerActiveDayUsd).toBe(2)
    expect(claude).not.toHaveProperty('costPerActiveDayUsd')

    // Shares are shares of what the headline shows: the priced models close at 100% on their own,
    // and the unpriced model claims none of it.
    const priced = claude.models.filter((m) => m.priced)
    expect(priced.reduce((sum, m) => sum + m.costShare, 0)).toBeCloseTo(1, 10)
    expect(claude.models.find((m) => m.model === 'opusplan')?.costShare).toBe(0)
    // The citable model is 100% of the shown spend, not the 67% that $2-of-$3 would have given.
    expect(claude.models.find((m) => m.model === 'claude-opus-5')?.costShare).toBe(1)
  })

  it('never marks an engine priced on recorded cost alone', () => {
    const value = buildUsageValue([
      {
        date: '2026-08-12',
        costUsd: 9.99,
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 100,
        cacheCreationTokens: 100,
        turns: 1,
        byModel: { 'gpt-5-codex': spend(9.99) },
        byEngine: { codex: 9.99 },
      },
    ])
    expect(value.byEngine.codex.costUsd).toBe(9.99)
    expect(value.byEngine.codex.priced).toBe(false)
    expect(value.byEngine.codex.pricedCostUsd).toBe(0)
    expect(value.daily[0].pricedCostUsd).toBe(0)
  })
})

describe('published rates', () => {
  it('normalizes context-window and datestamp suffixes to one family rate', () => {
    expect(publishedRate('claude-opus-5[1m]')).toEqual(publishedRate('claude-opus-5'))
    expect(publishedRate('claude-haiku-4-5-20251001')?.inputPerMTok).toBe(1)
  })

  it('refuses to price an alias or an unknown model', () => {
    for (const id of ['opus', 'sonnet', 'opusplan', 'default', 'gpt-5-codex', 'o4-mini']) {
      expect(publishedRate(id)).toBeNull()
      expect(cacheSavingsUsd(id, { cacheReadTokens: 1e6, cacheCreationTokens: 0 })).toBeNull()
    }
  })

  it('reports a net loss rather than hiding it when writes outrun reads', () => {
    const saved = cacheSavingsUsd('claude-opus-5', {
      cacheReadTokens: 1_000,
      cacheCreationTokens: 100_000,
    })
    expect(saved).toBeLessThan(0)
  })

  it('prices Sonnet 5 at the made-permanent $2/$10 list rate', () => {
    expect(publishedRate('claude-sonnet-5')?.inputPerMTok).toBe(2)
    expect(publishedRate('claude-sonnet-5')?.outputPerMTok).toBe(10)
  })

  it('applies Fable 5.1\'s published 0.025x cache-read rate to savings', () => {
    // 1M cache reads at $10/MTok input: standard 0.1x saves $9; 5.1's 0.025x saves $9.75.
    const saved = cacheSavingsUsd('claude-fable-5-1', {
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    })
    expect(saved).toBeCloseTo(9.75, 10)
    const standard = cacheSavingsUsd('claude-fable-5', {
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    })
    expect(standard).toBeCloseTo(9, 10)
  })
})
