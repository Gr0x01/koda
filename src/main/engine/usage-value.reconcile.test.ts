import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { loadUsageHistory, recordTurnUsage } from './usage-history'
import type { ModelTurnUsage, UsageHistoryDay } from '@shared/ipc'
import { buildUsageValue, engineOfModel } from '@shared/usage-value'

/**
 * The Usage view must never show a number the tracker cannot account for. These tests drive the real
 * recorder, read back the real stored rollups, and assert that what the view renders re-adds to the
 * tracker's own sums — for both engines — rather than to a fixture the view helped write.
 */

// Its OWN userData dir: the shared stub points every suite at the system temp dir, and vitest runs test
// files in parallel, so usage-history.test.ts's cleanup would otherwise delete this suite's rollup
// mid-run.
const { userData } = vi.hoisted(() => ({
  userData: `${(process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/koda-usage-value-${process.pid}`,
}))

vi.mock('electron', async () => {
  const stub = await vi.importActual<typeof import('electron')>('electron')
  const { mkdirSync } = await import('node:fs')
  return {
    ...stub,
    app: {
      ...stub.app,
      getPath: () => {
        mkdirSync(userData, { recursive: true })
        return userData
      },
    },
  }
})

const historyFile = join(userData, 'koda-usage-history.json')

afterEach(() => {
  rmSync(historyFile, { force: true })
  rmSync(`${historyFile}.corrupt.bak`, { force: true })
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function turn(model: string, over: Partial<ModelTurnUsage> = {}): ModelTurnUsage {
  return {
    model,
    costUsd: 0.5,
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 40_000,
    cacheCreationTokens: 5_000,
    ...over,
  }
}

/** The tracker's own answer, recomputed straight off its stored rollups. */
function trackerSums(days: UsageHistoryDay[]) {
  const cost: Record<string, number> = {}
  const tokens: Record<string, number> = {}
  let total = 0
  for (const day of days) {
    total += day.costUsd
    for (const [engineId, c] of Object.entries(day.byEngine ?? {})) {
      cost[engineId] = (cost[engineId] ?? 0) + c
    }
    for (const [model, m] of Object.entries(day.byModel ?? {})) {
      const engineId = engineOfModel(model)
      tokens[engineId] =
        (tokens[engineId] ?? 0) +
        m.inputTokens +
        m.outputTokens +
        m.cacheReadTokens +
        m.cacheCreationTokens
    }
  }
  return { cost, tokens, total }
}

describe('usage value reconciles against the tracker', () => {
  it('matches the stored history cost and token sums for both engines', async () => {
    recordTurnUsage([turn('claude-opus-5[1m]')], 0.5, 'claude')
    recordTurnUsage([turn('claude-haiku-4-5-20251001', { costUsd: 0.02 })], 0.02, 'claude')
    recordTurnUsage([turn('gpt-5-codex', { costUsd: 0.3 })], 0.3, 'codex')
    recordTurnUsage([turn('gpt-5-codex', { costUsd: 0.11 })], 0.11, 'codex')
    await flushWrites()

    const days = loadUsageHistory()
    const expected = trackerSums(days)
    const value = buildUsageValue(days)

    // Both engines are present, and each headline is the tracker's own per-engine sum.
    expect(Object.keys(value.byEngine).sort()).toEqual(['claude', 'codex'])
    expect(value.byEngine.claude.costUsd).toBeCloseTo(expected.cost.claude, 10)
    expect(value.byEngine.codex.costUsd).toBeCloseTo(expected.cost.codex, 10)

    // Nothing invented, nothing dropped: the engine cards re-add to the tracker's grand total.
    const headlineTotal = Object.values(value.byEngine).reduce((sum, e) => sum + e.costUsd, 0)
    expect(headlineTotal).toBeCloseTo(expected.total, 10)

    // Per-model rows re-add to the same money, per engine, and their shares close at 100%.
    expect(value.byEngine.claude.modelCostUsd).toBeCloseTo(expected.cost.claude, 10)
    expect(value.byEngine.codex.modelCostUsd).toBeCloseTo(expected.cost.codex, 10)
    for (const engine of Object.values(value.byEngine)) {
      const fromRows = engine.models.reduce((sum, m) => sum + m.costUsd, 0)
      expect(fromRows).toBeCloseTo(engine.modelCostUsd, 10)
      // Shares are shares of the PRICED total, so they close at 1 on an engine that has one and at 0
      // on a tokens-only engine, which shows no share bars at all.
      const shares = engine.models.reduce((sum, m) => sum + m.costShare, 0)
      expect(shares).toBeCloseTo(engine.pricedCostUsd > 0 ? 1 : 0, 10)
    }

    // Token totals match too, per engine.
    expect(value.byEngine.claude.totalTokens).toBe(expected.tokens.claude)
    expect(value.byEngine.codex.totalTokens).toBe(expected.tokens.codex)

    // The chart's columns are the stored days verbatim.
    expect(value.daily).toHaveLength(days.length)
    expect(value.daily.reduce((sum, d) => sum + d.costUsd, 0)).toBeCloseTo(expected.total, 10)
    expect(value.daily.reduce((sum, d) => sum + d.turns, 0)).toBe(
      days.reduce((sum, d) => sum + d.turns, 0),
    )
  })

  it('prices only what it can cite, and leaves Codex models on tokens', async () => {
    recordTurnUsage([turn('claude-opus-5[1m]')], 0.5, 'claude')
    recordTurnUsage([turn('gpt-5-codex', { costUsd: 0.3 })], 0.3, 'codex')
    await flushWrites()

    const value = buildUsageValue(loadUsageHistory())

    const opus = value.byEngine.claude.models.find((m) => m.model === 'claude-opus-5[1m]')
    expect(opus?.priced).toBe(true)
    // 40,000 cache reads at 0.9 x $5/MTok, less 5,000 cache writes at 0.25 x $5/MTok.
    expect(value.byEngine.claude.cacheSavingsUsd).toBeCloseTo(
      40_000 * 0.9 * 5e-6 - 5_000 * 0.25 * 5e-6,
      12,
    )
    expect(value.byEngine.claude.unpricedTokens).toBe(0)

    // Codex has no published-rate source wired, so it reports tokens and NO derived dollar figure.
    expect(value.byEngine.codex.models.every((m) => !m.priced)).toBe(true)
    expect(value.byEngine.codex.cacheSavingsUsd).toBeNull()
    expect(value.byEngine.codex.unpricedTokens).toBe(value.byEngine.codex.totalTokens)
  })

  it('keeps an engine tokens-only even though the tracker recorded a cost for it', async () => {
    // The exact trap: the Codex driver reports a cost estimate, the tracker stores it faithfully, and a
    // surface that branches on recorded cost would print dollars for a provider we cannot price. Every
    // field a renderer is allowed to branch on must say "unpriced" while the recorded cost is nonzero.
    recordTurnUsage([turn('claude-opus-5[1m]')], 0.5, 'claude')
    recordTurnUsage([turn('gpt-5-codex', { costUsd: 0.42 })], 0.42, 'codex')
    await flushWrites()

    const value = buildUsageValue(loadUsageHistory())
    const codex = value.byEngine.codex

    // The recorded cost is real and still reconciles — it is simply not something we may render.
    expect(codex.costUsd).toBeGreaterThan(0)
    expect(codex.modelCostUsd).toBeGreaterThan(0)
    expect(codex.models.every((m) => m.costUsd > 0)).toBe(true)

    // …and every dollar-gating field says no.
    expect(codex.priced).toBe(false)
    expect(codex.pricedCostUsd).toBe(0)
    expect(codex.pricedCostPerActiveDayUsd).toBe(0)
    expect(codex.models.every((m) => m.costShare === 0)).toBe(true)
    expect(codex.models.every((m) => !m.priced)).toBe(true)
    expect(codex.cacheSavingsUsd).toBeNull()

    // The chart is dollar-denominated in cost mode, so it plots priced cost only.
    for (const point of value.daily) {
      const codexToday = point.byEngine.find((e) => e.engineId === 'codex')
      expect(codexToday?.costUsd).toBeGreaterThan(0)
      expect(codexToday?.pricedCostUsd).toBe(0)
      // The day's plotted dollars exclude the unpriced engine but its tokens still count.
      expect(point.pricedCostUsd).toBeCloseTo(value.byEngine.claude.pricedCostUsd, 10)
      expect(point.pricedCostUsd).toBeLessThan(point.costUsd)
      expect(codexToday?.totalTokens).toBeGreaterThan(0)
    }

    // Claude, which we can cite, keeps its dollars.
    expect(value.byEngine.claude.priced).toBe(true)
    expect(value.byEngine.claude.pricedCostUsd).toBeCloseTo(value.byEngine.claude.modelCostUsd, 10)
  })
})
