import type { RateLimitInfo } from './ipc'

export const RATE_LIMIT_WARNING_PERCENT = 75

export function rateLimitBand(percent: number): string {
  if (percent >= 100) return 'rejected'
  if (percent >= RATE_LIMIT_WARNING_PERCENT) return 'warning'
  return 'allowed'
}

const SOURCE_RANK: Record<NonNullable<RateLimitInfo['source']>, number> = {
  disk: 0,
  stream: 1,
  // A partial poll lacks prune authority, but every row it DID parse is the same direct measured fact
  // as a complete snapshot. Equal rank lets that readable row refresh without erasing absent siblings.
  poll: 3,
  snapshot: 3,
}

export function reconcileRateLimitWindows(
  current: Record<string, RateLimitInfo>,
  incoming: RateLimitInfo,
  authoritativeTypes?: string[],
  now = Date.now(),
): { windows: Record<string, RateLimitInfo>; accepted: boolean } {
  const info: RateLimitInfo = {
    ...incoming,
    observedAt: incoming.observedAt ?? now,
    source: incoming.source ?? (authoritativeTypes ? 'snapshot' : 'stream'),
  }
  const previous = current[info.rateLimitType]
  if (previous) {
    const incomingRank = SOURCE_RANK[info.source!]
    const previousRank = SOURCE_RANK[previous.source ?? 'disk']
    const older = info.observedAt! < (previous.observedAt ?? 0)
    // Codex can race a sparse push against an active snapshot read and briefly report a lower percent
    // with a newer local timestamp. Inside one reset window usage is cumulative, so never let that
    // transport ordering artifact make the user's gauge run backwards.
    const regressedSameWindow =
      info.resetsAt === previous.resetsAt &&
      info.usedPercent != null &&
      previous.usedPercent != null &&
      info.usedPercent < previous.usedPercent
    // Within one measured reset window, a sparse event cannot displace a fuller source merely because
    // it arrived later. A genuinely new reset is a new fact and is allowed through.
    const weakerSameWindow = info.resetsAt === previous.resetsAt && incomingRank < previousRank
    if (older || weakerSameWindow || regressedSameWindow) return { windows: current, accepted: false }
  }

  const base = authoritativeTypes
    ? Object.fromEntries(Object.entries(current).filter(([type]) => authoritativeTypes.includes(type)))
    : { ...current }
  base[info.rateLimitType] = info
  return { windows: base, accepted: true }
}

export function liveRateLimitWindows(
  windows: Record<string, RateLimitInfo> | undefined,
  nowSec = Date.now() / 1000,
): Record<string, RateLimitInfo> {
  if (!windows) return {}
  return Object.fromEntries(Object.entries(windows).filter(([, info]) => info.resetsAt > nowSec))
}
