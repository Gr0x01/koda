/**
 * Parser guard for the `/usage` prose (usage-poll.ts). The engine-contract test proves the CURRENT
 * engine's wording still parses; these fixtures pin the edge cases that wording carries — a bare-hour
 * reset with no minutes, a per-model weekly, and the year the output never prints.
 */
import { describe, it, expect } from 'vitest'
import { __parseUsageForTest, authoritativeUsageTypes } from './usage-poll'

const { parseLine, parseReset, parseResult } = __parseUsageForTest

describe('usage /usage parsing', () => {
  const now = new Date(2026, 7, 2, 5, 10).getTime() // Aug 2 2026, 5:10am local

  it('reads the three plan windows the engine prints', () => {
    const lines = [
      'Current session: 47% used · resets Aug 2 at 6:49am (America/Chicago)',
      'Current week (all models): 36% used · resets Aug 5 at 7am (America/Chicago)',
      'Current week (Fable): 48% used · resets Aug 5 at 7am (America/Chicago)',
    ]
    const parsed = lines.map((l) => parseLine(l, now))
    expect(parsed.map((p) => p?.rateLimitType)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
    expect(parsed.map((p) => p?.usedPercent)).toEqual([47, 36, 48])
    // 6:49am today, and 7:00am three days out — the tz annotation is stripped, not parsed as time.
    expect(parsed[0]!.resetsAt).toBe(Math.round(new Date(2026, 7, 2, 6, 49).getTime() / 1000))
    expect(parsed[1]!.resetsAt).toBe(Math.round(new Date(2026, 7, 5, 7, 0).getTime() / 1000))
  })

  it('bands the fill the way the server does (warning at 75, rejected at the cap)', () => {
    const at = (pct: number) => parseLine(`Current session: ${pct}% used · resets Aug 2 at 6:49am`, now)?.status
    expect(at(20)).toBe('allowed')
    expect(at(74)).toBe('allowed')
    expect(at(75)).toBe('warning')
    expect(at(100)).toBe('rejected')
  })

  it('picks the year across a December rollover (the output never prints one)', () => {
    const dec = new Date(2026, 11, 30, 22, 0).getTime()
    // A weekly window resetting Jan 3 belongs to NEXT year, not the one that just ended.
    expect(parseReset('Jan 3 at 7am', dec)).toBe(Math.round(new Date(2027, 0, 3, 7, 0).getTime() / 1000))
  })

  it('ignores prose that is not a window line', () => {
    expect(parseLine('You are currently using your subscription to power your Claude Code usage', now)).toBeUndefined()
    expect(parseLine('Last 24h · 1896 requests · 20 sessions', now)).toBeUndefined()
    expect(parseLine('  71% of your usage was at >150k context', now)).toBeUndefined()
    // A window whose reset time we can't read is dropped rather than rendered with a made-up time.
    expect(parseLine('Current session: 47% used · resets sometime soon', now)).toBeUndefined()
  })

  it('marks a snapshot partial when one named window cannot be read', () => {
    const parsed = parseResult(
      [
        'Current session: 47% used · resets Aug 2 at 6:49am',
        'Current week (all models): format changed upstream',
      ].join('\n'),
      now,
    )

    expect(parsed.windows.map((window) => window.rateLimitType)).toEqual(['five_hour'])
    expect(parsed.complete).toBe(false)
  })

  it('keeps unrelated prose from weakening a complete snapshot', () => {
    const parsed = parseResult(
      [
        'You are currently using your subscription to power your Claude Code usage',
        'Current session: 47% used · resets Aug 2 at 6:49am',
        'Current week (all models): 36% used · resets Aug 5 at 7am',
      ].join('\n'),
      now,
    )

    expect(parsed.complete).toBe(true)
  })

  it('never gives prune authority to a truncated baseline snapshot', () => {
    const parsed = parseResult('Current session: 47% used · resets Aug 2 at 6:49am', now)

    expect(parsed.windows.map((window) => window.rateLimitType)).toEqual(['five_hour'])
    expect(parsed.complete).toBe(false)
  })

  it('preserves an omitted model window until its known reset', () => {
    const result = parseResult(
      [
        'Current session: 47% used · resets Aug 2 at 6:49am',
        'Current week (all models): 36% used · resets Aug 5 at 7am',
      ].join('\n'),
      now,
    )

    expect(
      authoritativeUsageTypes(result, {
        seven_day_fable: {
          rateLimitType: 'seven_day_fable',
          resetsAt: now / 1000 + 60,
          status: 'allowed',
        },
      }, now / 1000),
    ).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])

    expect(
      authoritativeUsageTypes(result, {
        seven_day_fable: {
          rateLimitType: 'seven_day_fable',
          resetsAt: now / 1000 - 1,
          status: 'allowed',
        },
      }, now / 1000),
    ).toEqual(['five_hour', 'seven_day'])
  })
})
