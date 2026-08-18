/**
 * The Usage view's arithmetic, in one pure place so it can be tested against the tracker's own stored
 * history instead of being re-derived inside JSX.
 *
 * Every number here is a sum or a ratio over measured facts an engine reported and its provider
 * adapter normalized: authoritative per-turn cost when available, plus token/cache splits.
 * The single derived figure is cache savings, which is `measured tokens x published rate`
 * (`model-pricing.ts`). There is deliberately NO projection, pace, forecast, or personal-ceiling
 * estimate — that was built once, rejected, and reverted; do not reintroduce it.
 */
import type { ModelSpend, UsageHistoryDay } from './ipc'
import { cacheSavingsUsd, publishedRate } from './model-pricing'

/** A two-brand heuristic for attributing a model id to an engine, NOT a model-version assertion —
 *  extend the Claude set when a third engine lands. Lives here (not in the renderer) so the view and
 *  its reconciliation test split the history exactly the same way. */
const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default', 'best'])
export function engineOfModel(id: string): 'claude' | 'codex' {
  const low = id.toLowerCase()
  return low.startsWith('claude-') || CLAUDE_ALIASES.has(low) ? 'claude' : 'codex'
}

export type TokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Every token the engine counted for this slice — the tokens-mode chart and per-model rows use it. */
  totalTokens: number
}

export type ModelValue = TokenTotals & {
  model: string
  /** The engine's own measured cost for this model. RENDER ONLY when `priced` — see `EngineValue.priced`. */
  costUsd: number
  /**
   * This model's share of its engine's PRICED cost, 0..1. Zero for an unpriced model, so the shares of
   * the models a card actually shows dollars for close at 100% against the headline. Dividing by the
   * engine's recorded cost instead would dilute every share by money the card never displays.
   */
  costShare: number
  /** True when `model-pricing.ts` has a citable published rate. False ⇒ show tokens, never a dollar. */
  priced: boolean
}

export type EngineValue = TokenTotals & {
  engineId: string
  /**
   * Recorded cost, summed from the tracker's OWN per-engine attribution (`day.byEngine`).
   * RECONCILIATION ONLY — never render it. It includes cost the engine estimated for models we have
   * no published rate for, which is exactly the money a card must not put a dollar sign on.
   * `pricedCostUsd` is the renderable figure.
   */
  costUsd: number
  /** The same recorded cost re-summed from the per-model buckets, for reconciliation. Also not for
   *  rendering, for the same reason as `costUsd`. */
  modelCostUsd: number
  /** What the cache saved across this engine's PRICED models, or `null` when none can be priced. */
  cacheSavingsUsd: number | null
  /**
   * Whether ANY model this engine ran has a published rate. THE ONLY thing a surface may branch on to
   * decide between a dollar and a token count.
   *
   * Recorded cost is not that signal: the Codex driver reports a `costEstimate` the tracker faithfully
   * stores, so `costUsd > 0` is true for an engine whose every model we refuse to price. A renderer
   * that reads the cost instead of this flag prints dollars for exactly the provider the tokens-only
   * contract exists to protect.
   */
  priced: boolean
  /**
   * Measured cost attributable to models with a published rate — 0 on a tokens-only engine, and lower
   * than `costUsd` on an engine that mixed a citable model with an alias we cannot price. THE dollar
   * figure a surface renders.
   */
  pricedCostUsd: number
  /** Tokens on models we have no published rate for — the honest denominator for "tokens only". */
  unpricedTokens: number
  /** Days in the window on which this engine actually ran anything. Never a calendar count. */
  activeDays: number
  /** `pricedCostUsd / activeDays` — a measured average over days that happened, not a rate going
   *  forward. There is deliberately no recorded-cost average: it would be a renderable-looking dollar
   *  built from money we cannot cite a rate for. */
  pricedCostPerActiveDayUsd: number
  tokensPerActiveDay: number
  /** Biggest cost first, then biggest token count (so unpriced models still order sensibly). */
  models: ModelValue[]
}

/**
 * One day's column in the chart. `costUsd` is the day's authoritative recorded total — the figure that
 * has to reconcile with the tracker. `pricedCostUsd` is the part of it we can stand behind at a
 * published rate, and it is what a dollar-denominated surface must plot: an engine that reports a cost
 * estimate for models we refuse to price contributes to the first and not the second.
 */
export type DailyPoint = {
  date: string
  costUsd: number
  pricedCostUsd: number
  totalTokens: number
  turns: number
  byEngine: { engineId: string; costUsd: number; pricedCostUsd: number; totalTokens: number }[]
}

export type UsageValue = {
  byEngine: Record<string, EngineValue>
  /** Oldest to newest — chart order. */
  daily: DailyPoint[]
  /** Days in the window that recorded any turn at all. */
  activeDays: number
}

function emptyTokens(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  }
}

function addSpend(into: TokenTotals, m: ModelSpend): void {
  into.inputTokens += m.inputTokens
  into.outputTokens += m.outputTokens
  into.cacheReadTokens += m.cacheReadTokens
  into.cacheCreationTokens += m.cacheCreationTokens
  into.totalTokens += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens
}

type EngineAccumulator = {
  cost: number
  modelCost: number
  tokens: TokenTotals
  activeDays: number
  models: Map<string, ModelSpend>
}

function emptyEngine(): EngineAccumulator {
  return { cost: 0, modelCost: 0, tokens: emptyTokens(), activeDays: 0, models: new Map() }
}

/**
 * Fold stored daily rollups into the shape the Usage view renders. `days` is `loadUsageHistory()`'s
 * output (newest first); pass a slice to window it. Engines with no recorded activity are absent
 * rather than present-and-zero, so a card never claims a provider ran when it didn't.
 */
export function buildUsageValue(days: UsageHistoryDay[]): UsageValue {
  const engines = new Map<string, EngineAccumulator>()
  const daily: DailyPoint[] = []
  let activeDays = 0

  const get = (id: string): EngineAccumulator => {
    const existing = engines.get(id)
    if (existing) return existing
    const fresh = emptyEngine()
    engines.set(id, fresh)
    return fresh
  }

  for (const day of days) {
    const dayEngines = new Map<
      string,
      { costUsd: number; pricedCostUsd: number; totalTokens: number }
    >()
    const touched = new Set<string>()

    for (const [engineId, cost] of Object.entries(day.byEngine ?? {})) {
      get(engineId).cost += cost
      dayEngines.set(engineId, { costUsd: cost, pricedCostUsd: 0, totalTokens: 0 })
      touched.add(engineId)
    }

    for (const [model, spend] of Object.entries(day.byModel ?? {})) {
      const engineId = engineOfModel(model)
      const acc = get(engineId)
      acc.modelCost += spend.costUsd
      addSpend(acc.tokens, spend)
      const prior = acc.models.get(model)
      acc.models.set(model, {
        costUsd: (prior?.costUsd ?? 0) + spend.costUsd,
        inputTokens: (prior?.inputTokens ?? 0) + spend.inputTokens,
        outputTokens: (prior?.outputTokens ?? 0) + spend.outputTokens,
        cacheReadTokens: (prior?.cacheReadTokens ?? 0) + spend.cacheReadTokens,
        cacheCreationTokens: (prior?.cacheCreationTokens ?? 0) + spend.cacheCreationTokens,
      })
      const bucket = dayEngines.get(engineId) ?? { costUsd: 0, pricedCostUsd: 0, totalTokens: 0 }
      bucket.totalTokens +=
        spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheCreationTokens
      if (publishedRate(model) != null) bucket.pricedCostUsd += spend.costUsd
      dayEngines.set(engineId, bucket)
      touched.add(engineId)
    }

    for (const engineId of touched) get(engineId).activeDays += 1
    if (day.turns > 0) activeDays += 1

    const byEngineToday = [...dayEngines.entries()].map(([engineId, v]) => ({ engineId, ...v }))
    daily.push({
      date: day.date,
      costUsd: day.costUsd,
      pricedCostUsd: byEngineToday.reduce((sum, e) => sum + e.pricedCostUsd, 0),
      totalTokens:
        day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheCreationTokens,
      turns: day.turns,
      byEngine: byEngineToday,
    })
  }

  daily.sort((a, b) => a.date.localeCompare(b.date))

  const byEngine: Record<string, EngineValue> = {}
  for (const [engineId, acc] of engines) {
    // Priced totals first: `costShare` divides by the priced cost, so it cannot be computed in the
    // same pass that discovers it.
    let savings: number | null = null
    let unpricedTokens = 0
    let pricedCostUsd = 0
    for (const [model, spend] of acc.models) {
      const saved = cacheSavingsUsd(model, spend)
      if (saved != null) savings = (savings ?? 0) + saved
      if (publishedRate(model) != null) pricedCostUsd += spend.costUsd
      else
        unpricedTokens +=
          spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheCreationTokens
    }

    const models: ModelValue[] = []
    for (const [model, spend] of acc.models) {
      const priced = publishedRate(model) != null
      models.push({
        model,
        costUsd: spend.costUsd,
        // An unpriced model has no share OF SPEND, because none of its cost is in the spend shown.
        costShare: priced && pricedCostUsd > 0 ? spend.costUsd / pricedCostUsd : 0,
        priced,
        inputTokens: spend.inputTokens,
        outputTokens: spend.outputTokens,
        cacheReadTokens: spend.cacheReadTokens,
        cacheCreationTokens: spend.cacheCreationTokens,
        totalTokens:
          spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheCreationTokens,
      })
    }
    models.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)
    byEngine[engineId] = {
      engineId,
      costUsd: acc.cost,
      modelCostUsd: acc.modelCost,
      cacheSavingsUsd: savings,
      priced: models.some((m) => m.priced),
      pricedCostUsd,
      unpricedTokens,
      activeDays: acc.activeDays,
      pricedCostPerActiveDayUsd: acc.activeDays > 0 ? pricedCostUsd / acc.activeDays : 0,
      tokensPerActiveDay: acc.activeDays > 0 ? acc.tokens.totalTokens / acc.activeDays : 0,
      models,
      ...acc.tokens,
    }
  }

  return { byEngine, daily, activeDays }
}
