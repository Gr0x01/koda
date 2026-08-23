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
import type { ModelSpend, PricedScanBucket, ScanCostSource, UsageHistoryDay } from './ipc'
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

// ── Whole-subscription scan view-model (the Usage page, usage-wave U3) ─────────────
// Same posture as buildUsageValue above: pure arithmetic over measured buckets so every rendered
// figure reconciles in a plain Node test. The scan's dollars differ from the tracker's in one way —
// they are ALL citable by construction (usage-pricing.ts sets costUsd null otherwise), so here
// `costUsd == pricedCostUsd` on every point and the unpriced share is carried as tokens.

export type ScanModelRow = {
  model: string
  engine: string
  totalTokens: number
  /** Null ⇒ this row renders tokens, never a dollar. */
  costUsd: number | null
  /** Share of the PRICED total, 0 for an unpriced row — shares close at 100% against the headline. */
  costShare: number
  costSource: ScanCostSource
}

export type ScanEngineRow = {
  engineId: string
  pricedCostUsd: number
  totalTokens: number
  costShare: number
  tokenShare: number
}

export type ScanUsageValue = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  totalTokens: number
  records: number
  /** The headline: every dollar in it carries a citation. */
  pricedCostUsd: number
  cacheSavingsUsd: number | null
  unpricedTokens: number
  /** Descending by priced cost, then tokens. */
  byEngine: ScanEngineRow[]
  models: ScanModelRow[]
  /** Day columns for the chart, oldest→newest. `turns` carries record counts. */
  daily: DailyPoint[]
  /** Hour columns for the rolling-24h view; `date` is the bucket's ISO hour start. */
  hourly: DailyPoint[]
  activeDays: number
  tokensPerActiveDay: number
  pricedPerActiveDayUsd: number
  /** Token split for the "through Koda / outside" line. */
  originTokens: { koda: number; outside: number }
}

function bucketTokens(b: PricedScanBucket): number {
  return b.uncachedInput + b.cachedInput + b.cacheCreation + b.output
}

export function buildScanUsageValue(buckets: PricedScanBucket[]): ScanUsageValue {
  const value: ScanUsageValue = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    records: 0,
    pricedCostUsd: 0,
    cacheSavingsUsd: null,
    unpricedTokens: 0,
    byEngine: [],
    models: [],
    daily: [],
    hourly: [],
    activeDays: 0,
    tokensPerActiveDay: 0,
    pricedPerActiveDayUsd: 0,
    originTokens: { koda: 0, outside: 0 },
  }

  const engines = new Map<string, { cost: number; tokens: number }>()
  const models = new Map<string, ScanModelRow>()
  const byDay = new Map<string, DailyPoint>()
  const byHour = new Map<number, DailyPoint>()

  const pointEngine = (point: DailyPoint, engineId: string): DailyPoint['byEngine'][number] => {
    let row = point.byEngine.find((e) => e.engineId === engineId)
    if (!row) {
      row = { engineId, costUsd: 0, pricedCostUsd: 0, totalTokens: 0 }
      point.byEngine.push(row)
    }
    return row
  }

  for (const b of buckets) {
    const tokens = bucketTokens(b)
    value.inputTokens += b.uncachedInput
    value.outputTokens += b.output
    value.cacheReadTokens += b.cachedInput
    value.cacheCreationTokens += b.cacheCreation
    value.reasoningTokens += b.reasoning
    value.totalTokens += tokens
    value.records += b.records
    value.originTokens[b.origin] += tokens
    if (b.costUsd == null) value.unpricedTokens += tokens
    else value.pricedCostUsd += b.costUsd
    if (b.cacheSavingsUsd != null) value.cacheSavingsUsd = (value.cacheSavingsUsd ?? 0) + b.cacheSavingsUsd

    const engine = engines.get(b.engine) ?? { cost: 0, tokens: 0 }
    engine.cost += b.costUsd ?? 0
    engine.tokens += tokens
    engines.set(b.engine, engine)

    const modelKey = `${b.engine}:${b.model}`
    const model =
      models.get(modelKey) ??
      ({ model: b.model, engine: b.engine, totalTokens: 0, costUsd: null, costShare: 0, costSource: b.costSource } as ScanModelRow)
    model.totalTokens += tokens
    if (b.costUsd != null) model.costUsd = (model.costUsd ?? 0) + b.costUsd
    models.set(modelKey, model)

    const day =
      byDay.get(b.day) ??
      ({ date: b.day, costUsd: 0, pricedCostUsd: 0, totalTokens: 0, turns: 0, byEngine: [] } as DailyPoint)
    day.costUsd += b.costUsd ?? 0
    day.pricedCostUsd += b.costUsd ?? 0
    day.totalTokens += tokens
    day.turns += b.records
    const dayEngine = pointEngine(day, b.engine)
    dayEngine.costUsd += b.costUsd ?? 0
    dayEngine.pricedCostUsd += b.costUsd ?? 0
    dayEngine.totalTokens += tokens
    byDay.set(b.day, day)

    const hour =
      byHour.get(b.hourStartMs) ??
      ({
        date: new Date(b.hourStartMs).toISOString(),
        costUsd: 0,
        pricedCostUsd: 0,
        totalTokens: 0,
        turns: 0,
        byEngine: [],
      } as DailyPoint)
    hour.costUsd += b.costUsd ?? 0
    hour.pricedCostUsd += b.costUsd ?? 0
    hour.totalTokens += tokens
    hour.turns += b.records
    const hourEngine = pointEngine(hour, b.engine)
    hourEngine.costUsd += b.costUsd ?? 0
    hourEngine.pricedCostUsd += b.costUsd ?? 0
    hourEngine.totalTokens += tokens
    byHour.set(b.hourStartMs, hour)
  }

  value.daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  value.hourly = [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p)
  value.activeDays = value.daily.filter((d) => d.totalTokens > 0).length
  value.tokensPerActiveDay = value.activeDays > 0 ? value.totalTokens / value.activeDays : 0
  value.pricedPerActiveDayUsd = value.activeDays > 0 ? value.pricedCostUsd / value.activeDays : 0

  value.byEngine = [...engines.entries()]
    .map(([engineId, e]) => ({
      engineId,
      pricedCostUsd: e.cost,
      totalTokens: e.tokens,
      costShare: value.pricedCostUsd > 0 ? e.cost / value.pricedCostUsd : 0,
      tokenShare: value.totalTokens > 0 ? e.tokens / value.totalTokens : 0,
    }))
    .sort((a, b) => b.pricedCostUsd - a.pricedCostUsd || b.totalTokens - a.totalTokens)

  value.models = [...models.values()]
    .map((m) => ({
      ...m,
      costShare: m.costUsd != null && value.pricedCostUsd > 0 ? m.costUsd / value.pricedCostUsd : 0,
    }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.totalTokens - a.totalTokens)

  return value
}
