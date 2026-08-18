/**
 * Published per-token list prices, used for ONE derived figure: how much the cache saved.
 *
 * Everything else in the Usage view is the engine's own measured cost. This table exists because the
 * engine reports a single `costUSD` per model and never says what the same tokens would have cost
 * without the cache — that counterfactual is `measured tokens × published rate`, so we need the rates.
 * Nothing here is a projection: no forecast, no burn rate, no "at this pace" (see the usage-tracker
 * lesson — measured facts only).
 *
 * SOURCE, and the rule for editing it: the Anthropic list prices below are the `claude-api` skill's
 * "Current Models" table (cached 2026-06-24), which mirrors
 * https://platform.claude.com/docs/en/pricing. The cache multipliers are that skill's
 * `shared/prompt-caching.md` economics section: a cache read is ~0.1x the base input price and a
 * 5-minute cache write is 1.25x. A model we cannot cite a published rate for is NOT priced — it gets
 * a tokens-only row rather than an invented number. That includes every OpenAI/Codex model (Koda has
 * no published-rate source wired for them) and every engine alias (`opus`, `sonnet`, `opusplan`, …),
 * which resolve to a concrete model we can't see from the id alone.
 */

/** $ per million tokens, at the published list rate. */
export type PublishedRate = {
  inputPerMTok: number
  outputPerMTok: number
  /** Where this pair came from, shown nowhere but kept so the next editor can re-verify it. */
  source: string
}

/** A cached input token bills at ~0.1x the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1
/** Writing the 5-minute cache costs 1.25x the base input rate — the premium the savings must clear. */
export const CACHE_WRITE_MULTIPLIER = 1.25

const ANTHROPIC_LIST = 'claude-api skill, Current Models table (cached 2026-06-24)'

/**
 * Keyed by the model FAMILY left after `normalizeModelId` strips the vendor prefix, the context-window
 * suffix, and the release datestamp. Add a row only with a citable published price.
 */
const RATES: Record<string, PublishedRate> = {
  'fable-5': { inputPerMTok: 10, outputPerMTok: 50, source: ANTHROPIC_LIST },
  'mythos-5': { inputPerMTok: 10, outputPerMTok: 50, source: ANTHROPIC_LIST },
  'opus-5': { inputPerMTok: 5, outputPerMTok: 25, source: ANTHROPIC_LIST },
  'opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, source: ANTHROPIC_LIST },
  'opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, source: ANTHROPIC_LIST },
  'opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, source: ANTHROPIC_LIST },
  // Sonnet 5 carries an introductory $2/$10 through 2026-08-31. We price at the standing list rate on
  // purpose: this figure answers "what would the full API rate have been", and a date-triggered rate
  // would silently change the number one night with nothing in the UI to explain it.
  'sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, source: ANTHROPIC_LIST },
  'sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, source: ANTHROPIC_LIST },
  'haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, source: ANTHROPIC_LIST },
}

/**
 * Engine model id → the family key used above. `claude-opus-5[1m]` → `opus-5`;
 * `claude-haiku-4-5-20251001` → `haiku-4-5`. The 1M context window is standard-priced on every model
 * in the table, so the suffix is dropped rather than treated as a tier.
 */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/\[\d+m\]$/, '')
    .replace(/-\d{6,}$/, '')
}

/** The published rate for a model id, or `null` when we have no citable price for it. */
export function publishedRate(id: string): PublishedRate | null {
  return RATES[normalizeModelId(id)] ?? null
}

/**
 * What the cache saved on one model's measured tokens, in USD, or `null` when the model is unpriced.
 *
 * Both sides are the same arithmetic over the same measured token counts, so only the per-token rate
 * differs: without a cache every prompt token bills at the full input rate; with it, reads bill at
 * 0.1x and writes cost a 1.25x premium. The difference is therefore
 * `cacheRead x 0.9 x input − cacheWrite x 0.25 x input`. It can go negative on a session that wrote
 * far more cache than it ever read back; that is a real (small) loss, not an error, and the UI says so.
 */
export function cacheSavingsUsd(
  id: string,
  tokens: { cacheReadTokens: number; cacheCreationTokens: number },
): number | null {
  const rate = publishedRate(id)
  if (!rate) return null
  const perToken = rate.inputPerMTok / 1_000_000
  const saved = tokens.cacheReadTokens * (1 - CACHE_READ_MULTIPLIER) * perToken
  const premium = tokens.cacheCreationTokens * (CACHE_WRITE_MULTIPLIER - 1) * perToken
  return saved - premium
}
