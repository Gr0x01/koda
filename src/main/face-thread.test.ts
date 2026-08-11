import { describe, expect, it } from 'vitest'
import {
  APP_SUMMON_KEY,
  appSummonThread,
  faceDayKey,
  faceDayLabel,
  rememberAppSummonThread,
  type ThreadStore,
} from '@shared/face-thread'

/** A localStorage stand-in — the module is browser code, the rules it encodes aren't. */
function store(seed?: unknown): ThreadStore & { raw: () => string | null } {
  let value = seed === undefined ? null : JSON.stringify(seed)
  return {
    getItem: (k) => (k === APP_SUMMON_KEY ? value : null),
    setItem: (k, v) => {
      if (k === APP_SUMMON_KEY) value = v
    },
    raw: () => value,
  }
}

const DIR = '/Users/rb/Koda/Health and Fitness/apps/health-fitness'

describe('faceDayLabel / faceDayKey', () => {
  it('names a day the same way on both heads, whatever the locale', () => {
    // The two heads never see each other's thread map, so an exact string match on this label is how
    // one head recognises the day thread the other opened. A locale-formatted date would break that.
    expect(faceDayLabel('Health & Fitness', new Date(2026, 7, 5, 9, 0))).toBe('Health & Fitness · Wed, Aug 5')
    expect(faceDayKey(new Date(2026, 7, 5, 9, 0))).toBe('2026-08-05')
  })

  it('is stable across the whole day and rolls at local midnight', () => {
    const morning = new Date(2026, 7, 5, 0, 0, 0)
    const lateNight = new Date(2026, 7, 5, 23, 59, 59)
    const nextDay = new Date(2026, 7, 6, 0, 0, 0)
    expect(faceDayKey(morning)).toBe(faceDayKey(lateNight))
    expect(faceDayLabel('App', morning)).toBe(faceDayLabel('App', lateNight))
    expect(faceDayKey(nextDay)).not.toBe(faceDayKey(morning))
    expect(faceDayLabel('App', nextDay)).toBe('App · Thu, Aug 6')
  })

  it('zero-pads the key so keys sort as dates', () => {
    expect(faceDayKey(new Date(2026, 0, 9))).toBe('2026-01-09')
  })
})

describe('the app summon thread map', () => {
  it("joins the same day's thread and abandons yesterday's", () => {
    const s = store()
    rememberAppSummonThread(s, DIR, 'sess-tue', '2026-08-05')
    expect(appSummonThread(s, DIR, '2026-08-05')).toBe('sess-tue')
    expect(appSummonThread(s, DIR, '2026-08-06')).toBeNull()
  })

  it('keeps one entry per app — a new day replaces the old, it does not pile up', () => {
    const s = store()
    rememberAppSummonThread(s, DIR, 'sess-tue', '2026-08-05')
    rememberAppSummonThread(s, DIR, 'sess-wed', '2026-08-06')
    expect(Object.keys(JSON.parse(s.raw() ?? '{}'))).toEqual([DIR])
    expect(appSummonThread(s, DIR, '2026-08-06')).toBe('sess-wed')
  })

  it('holds one forever-thread when day sessions are off', () => {
    const s = store()
    rememberAppSummonThread(s, DIR, 'sess-forever', null)
    expect(appSummonThread(s, DIR, null)).toBe('sess-forever')
  })

  it('reads a pre-day-threads entry (a bare session id) as an unstamped thread', () => {
    // RB's existing map holds the old shape; turning day threads on must not throw, it must just
    // start today's thread instead of resurrecting the endless one.
    const s = store({ [DIR]: 'sess-legacy' })
    expect(appSummonThread(s, DIR, null)).toBe('sess-legacy')
    expect(appSummonThread(s, DIR, '2026-08-05')).toBeNull()
  })

  it('survives a corrupt or absent map rather than breaking the ask line', () => {
    const broken: ThreadStore = { getItem: () => 'not json', setItem: () => {} }
    expect(appSummonThread(broken, DIR, '2026-08-05')).toBeNull()
    const readOnly: ThreadStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => rememberAppSummonThread(readOnly, DIR, 'sess', '2026-08-05')).not.toThrow()
  })

  it('keeps apps separate', () => {
    const s = store()
    rememberAppSummonThread(s, DIR, 'sess-hf', '2026-08-05')
    rememberAppSummonThread(s, '/other/apps/baby-meals', 'sess-bm', '2026-08-05')
    expect(appSummonThread(s, DIR, '2026-08-05')).toBe('sess-hf')
    expect(appSummonThread(s, '/other/apps/baby-meals', '2026-08-05')).toBe('sess-bm')
  })
})
