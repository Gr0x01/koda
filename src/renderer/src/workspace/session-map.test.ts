import { describe, expect, it } from 'vitest'
import { ageLabel, groupSessions, sessionGroup } from './session-map'
import type { SessionState, SessionStatus } from './store'

// The map's promise is that it only reports what was OBSERVED: a thread is under "Needs you" because
// something is actually pending in it, and its age is a reading of `lastActivityAt` rather than a
// state anyone filed. These tests pin the ranking of the waiting arms and the age buckets.

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    label: 'Checkout drop-off',
    userNamed: false,
    cwd: '/tmp/project',
    items: [],
    streaming: '',
    busy: false,
    errored: false,
    draft: '',
    attachments: [],
    live: false,
    attention: false,
    approvalMode: 'ask',
    engineId: 'claude',
    spendUsd: 0,
    byModel: {},
    ...overrides,
  }
}

describe('sessionGroup', () => {
  it('keeps a quiet session active however long it has been quiet', () => {
    expect(sessionGroup(session({ lastActivityAt: NOW - DAY }), 'idle')).toBe('active')
    expect(sessionGroup(session({ lastActivityAt: NOW - 90 * DAY }), 'idle')).toBe('active')
    expect(sessionGroup(session(), 'idle')).toBe('active')
  })

  it('puts anything needing the user in the waiting group, however old', () => {
    const stale = session({ lastActivityAt: NOW - 30 * DAY })
    expect(sessionGroup(stale, 'waiting')).toBe('waiting')
    expect(sessionGroup(stale, 'error')).toBe('waiting')
    expect(sessionGroup({ ...stale, attention: true }, 'idle')).toBe('waiting')
  })

  it('keeps a working session active even if its last stamp is old', () => {
    const working = session({ lastActivityAt: NOW - 30 * DAY, busy: true })
    expect(sessionGroup(working, 'thinking')).toBe('active')
  })

  // The shape that pinned a thread under "Needs you" with nothing for the user to do: a backgrounded
  // turn ends (raising the unseen mark) while a delegated agent keeps running, so the thread is marked
  // AND working. Only the user opening it clears the mark, so it stayed there reporting "Agent still
  // working…" until clicked.
  it('keeps a marked session active while it is still working', () => {
    const marked = session({ lastActivityAt: NOW, attention: true })
    expect(sessionGroup(marked, 'thinking')).toBe('active')
    expect(sessionGroup({ ...marked, busy: true }, 'idle')).toBe('active')
    // Still unseen once the work stops, so it lands back under Needs you without a click.
    expect(sessionGroup(marked, 'idle')).toBe('waiting')
  })

  it('surfaces a live gate during work but defers terminal errors until work settles', () => {
    const working = session({ lastActivityAt: NOW, busy: true })
    expect(sessionGroup(working, 'waiting')).toBe('waiting')
    expect(sessionGroup(working, 'error')).toBe('active')
    expect(sessionGroup({ ...working, busy: false }, 'error')).toBe('waiting')
  })
})

describe('groupSessions', () => {
  it('splits the list two ways and preserves order within each part', () => {
    const list = [
      session({ id: 'a', lastActivityAt: NOW - 30 * DAY }),
      session({ id: 'b', lastActivityAt: NOW - 60 * 1000 }),
      session({ id: 'c', lastActivityAt: NOW - 10 * DAY }),
      session({ id: 'd', lastActivityAt: NOW - 5 * MINUTE, attention: true }),
    ]
    const statusOf = (): SessionStatus => 'idle'
    const grouped = groupSessions(list, statusOf)
    expect(grouped.active.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(grouped.waiting.map((s) => s.id)).toEqual(['d'])
  })
})

describe('ageLabel', () => {
  it('reads in minutes and hours before it reaches days', () => {
    expect(ageLabel(NOW - 20 * 1000, NOW)).toBe('just now')
    expect(ageLabel(NOW, NOW)).toBe('just now')
    expect(ageLabel(NOW - 90 * 1000, NOW)).toBe('a minute ago')
    expect(ageLabel(NOW - 20 * MINUTE, NOW)).toBe('20 minutes ago')
    expect(ageLabel(NOW - 59 * MINUTE, NOW)).toBe('59 minutes ago')
    expect(ageLabel(NOW - 70 * MINUTE, NOW)).toBe('an hour ago')
    expect(ageLabel(NOW - 8 * HOUR, NOW)).toBe('8 hours ago')
    expect(ageLabel(NOW - 23 * HOUR, NOW)).toBe('23 hours ago')
  })

  it('reads in days, then weeks, then months', () => {
    expect(ageLabel(NOW - 25 * HOUR, NOW)).toBe('a day ago')
    expect(ageLabel(NOW - 4 * DAY, NOW)).toBe('4 days ago')
    expect(ageLabel(NOW - 21 * DAY, NOW)).toBe('3 weeks ago')
    expect(ageLabel(NOW - 90 * DAY, NOW)).toBe('3 months ago')
  })

  it('says nothing at all for a session with no observed activity', () => {
    expect(ageLabel(undefined, NOW)).toBe('')
  })

  // The tick that refreshes the labels can fire a hair before a stamp written on the same turn, and a
  // negative elapsed would read as a month ago.
  it('never reads a stamp from the future as an age', () => {
    expect(ageLabel(NOW + 5 * MINUTE, NOW)).toBe('just now')
  })
})
