/**
 * Rates and cost arithmetic for scanned whole-subscription usage (usage-wave U2).
 *
 * Koda-driven turns carry the engine's own measured cost and never come here. Scanned outside-Koda
 * buckets (usage-scan.ts) arrive as bare token counts, so pricing them needs a rate per model. Rates
 * resolve in citation order:
 *   1. `tableRated` — LiteLLM's public price table (the same file ccusage and T3 Code price
 *      against), fetched at most daily and cached on disk, so price drift corrects itself.
 *   2. `published` — the named rates in `shared/model-pricing.ts` when the table lacks the model
 *      or the network never cooperated.
 *   3. `unpriced` — tokens count, dollars never render. `costUsd` is null, not zero, so a consumer
 *      cannot sum an unpriced bucket into a total by accident.
 * Every priced figure stays a measured fact times a citable rate — no projection, no estimate. The
 * provenance record says which citation the user is looking at and how old it is; the UI renders it.
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import { publishedRate, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from '@shared/model-pricing'
import { log } from '../logger'
import type { PricedScanBucket, RatesProvenance, ScanCostSource } from '@shared/ipc'
import type { ScanBucket } from './usage-scan'

/** USD per single token (LiteLLM's own unit — no per-MTok conversion to mix up). */
export interface RatePerToken {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

// The wire shapes (PricedScanBucket, RatesProvenance, ScanCostSource) live in shared/ipc.ts —
// this module fills the pricing fields the scanner's buckets lack.
export type { RatesProvenance, ScanCostSource } from '@shared/ipc'

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const RATES_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

type StoredRates = { version: 1; fetchedAt: number; rates: Record<string, RatePerToken> }

function filePath(): string {
  return join(app.getPath('userData'), 'koda-usage-rates.json')
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** LiteLLM publishes both `claude-opus-5` and `anthropic/claude-opus-5`; keys resolve bare. */
function normalizeTableKey(name: string): string {
  const slash = name.lastIndexOf('/')
  return (slash >= 0 ? name.slice(slash + 1) : name).trim().toLowerCase()
}

/**
 * Providers whose prefixed rows may stand in for a model's real list price. Everything else —
 * azure/, bedrock/, openrouter/, replicate/, vercel_ai_gateway/, regional gov-cloud variants — is
 * a RESELLER rate for the same bare name, and the live table carries dozens of those at up to 3x
 * the first-party price (verified 2026-08-21). Skipping them beats last-write-wins roulette.
 */
const FIRST_PARTY_PREFIXES = new Set(['anthropic', 'openai'])

/**
 * Project the LiteLLM document into rates. Entries missing either base rate are dropped whole: a
 * half-priced model would silently under-report, which is worse than unpriced. Absent cache rates
 * default to the plain input rate (harmless for providers that do not discount cache reads).
 * Collisions resolve deterministically: an unprefixed key always beats a prefixed one, and only
 * first-party prefixes participate at all, so document order can never change a price.
 */
export function parseRateTable(document: unknown): Record<string, RatePerToken> {
  const rates: Record<string, RatePerToken> = {}
  const fromUnprefixed = new Set<string>()
  if (typeof document !== 'object' || document === null) return rates
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const slash = name.indexOf('/')
    const provider = slash >= 0 ? name.slice(0, slash).toLowerCase() : null
    if (provider !== null && !FIRST_PARTY_PREFIXES.has(provider)) continue
    const entry = raw as Record<string, unknown>
    const input = finite(entry['input_cost_per_token'])
    const output = finite(entry['output_cost_per_token'])
    if (input === null || output === null) continue
    const bare = normalizeTableKey(name)
    if (provider !== null && fromUnprefixed.has(bare)) continue
    if (provider === null) fromUnprefixed.add(bare)
    rates[bare] = {
      input,
      output,
      cacheRead: finite(entry['cache_read_input_token_cost']) ?? input,
      cacheCreation: finite(entry['cache_creation_input_token_cost']) ?? input,
    }
  }
  return rates
}

export interface RateTable {
  rates: Record<string, RatePerToken>
  provenance: RatesProvenance
}

function readStored(): StoredRates | null {
  try {
    const p = JSON.parse(readFileSync(filePath(), 'utf8'))
    if (p && typeof p === 'object' && typeof p.fetchedAt === 'number' && p.rates && typeof p.rates === 'object')
      return p as StoredRates
  } catch {
    // Missing or corrupt cache is just "no table yet"; the named local rates keep pricing.
  }
  return null
}

function provenance(status: RatesProvenance['status'], stored: StoredRates | null): RatesProvenance {
  return {
    status,
    source: 'LiteLLM model_prices_and_context_window.json',
    fetchedAt: stored?.fetchedAt ?? null,
    knownModels: stored ? Object.keys(stored.rates).length : 0,
  }
}

let inFlight: Promise<RateTable> | null = null

/**
 * The current rate table: disk cache under a day old wins outright, otherwise one bounded refetch,
 * otherwise whatever older cache exists, otherwise an empty table marked unavailable. Concurrent
 * callers share one refresh. `fetchImpl` is the test seam.
 */
export function loadRateTable(fetchImpl: typeof fetch = fetch): Promise<RateTable> {
  if (inFlight) return inFlight
  const job = (async (): Promise<RateTable> => {
    const stored = readStored()
    if (stored && Date.now() - stored.fetchedAt < RATES_TTL_MS)
      return { rates: stored.rates, provenance: provenance('fresh', stored) }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const response = await fetchImpl(LITELLM_URL, { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) throw new Error(`rate table fetch returned ${response.status}`)
      const rates = parseRateTable(await response.json())
      if (Object.keys(rates).length === 0) throw new Error('rate table parsed to zero models')
      const next: StoredRates = { version: 1, fetchedAt: Date.now(), rates }
      try {
        writeFileAtomic(filePath(), JSON.stringify(next))
      } catch (err) {
        log.warn('usage', 'rate table cache write failed', err instanceof Error ? err.message : err)
      }
      return { rates, provenance: provenance('fresh', next) }
    } catch (err) {
      log.warn('usage', 'rate table refresh failed', err instanceof Error ? err.message : err)
      if (stored) return { rates: stored.rates, provenance: provenance('cached', stored) }
      return { rates: {}, provenance: provenance('unavailable', null) }
    }
  })()
  inFlight = job.finally(() => {
    inFlight = null
  })
  return inFlight
}

/** A scanned model id resolved to a rate and its citation, or unpriced. Exact matches only — a
 *  fuzzy match would be a guess wearing a citation. */
function resolveRate(model: string, table: Record<string, RatePerToken>): { rate: RatePerToken; source: ScanCostSource } | null {
  const fromTable = table[normalizeTableKey(model)]
  if (fromTable) return { rate: fromTable, source: 'tableRated' }
  const named = publishedRate(model)
  if (named) {
    const input = named.inputPerMTok / 1_000_000
    return {
      rate: {
        input,
        output: named.outputPerMTok / 1_000_000,
        cacheRead: input * (named.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER),
        cacheCreation: input * CACHE_WRITE_MULTIPLIER,
      },
      source: 'published',
    }
  }
  return null
}

/** Price scanned buckets against a loaded table. Pure; call sites decide when to load/refresh. */
export function priceScanBuckets(buckets: ScanBucket[], table: RateTable): PricedScanBucket[] {
  return buckets.map((b) => {
    const resolved = resolveRate(b.model, table.rates)
    if (!resolved) return { ...b, costUsd: null, cacheSavingsUsd: null, costSource: 'unpriced' }
    const { rate, source } = resolved
    const costUsd =
      b.uncachedInput * rate.input +
      b.cachedInput * rate.cacheRead +
      b.cacheCreation * rate.cacheCreation +
      b.output * rate.output
    const cacheSavingsUsd =
      b.cachedInput * (rate.input - rate.cacheRead) - b.cacheCreation * (rate.cacheCreation - rate.input)
    return { ...b, costUsd, cacheSavingsUsd, costSource: source }
  })
}
