import { describe, expect, it } from 'vitest'
import { sessionNeedsYou, type SessionNeedsYouSignals } from './session-attention'

const quiet: SessionNeedsYouSignals = {
  gate: false,
  working: false,
  terminalError: false,
  unseenAttention: false,
}

describe('shared session Needs You precedence', () => {
  const cases: Array<[string, SessionNeedsYouSignals, boolean]> = [
    ['a live gate outranks work', { ...quiet, gate: true, working: true }, true],
    ['work suppresses a terminal error', { ...quiet, working: true, terminalError: true }, false],
    ['work suppresses an unseen completion', { ...quiet, working: true, unseenAttention: true }, false],
    ['an idle terminal error needs the user', { ...quiet, terminalError: true }, true],
    ['an idle unseen completion needs the user', { ...quiet, unseenAttention: true }, true],
    ['an idle quiet session stays active', quiet, false],
  ]

  it.each(cases)('%s', (_name, signals, expected) => {
    expect(sessionNeedsYou(signals)).toBe(expected)
  })
})
