import { describe, expect, it } from 'vitest'
import { namingEvidence, shouldRegenerateName, userMessages } from './session-naming'
import type { Entry } from '../transcript/Transcript'

function user(id: number, text: string): Entry {
  return { id, kind: 'user', text }
}
function assistant(id: number, markdown: string): Entry {
  return { id, kind: 'assistant', markdown }
}

describe('shouldRegenerateName', () => {
  it('never re-names on the opening turn (that is the initial naming turn)', () => {
    expect(shouldRegenerateName(0)).toBe(false)
    expect(shouldRegenerateName(1)).toBe(false)
  })

  it('re-names at the sparse crossings, not every turn', () => {
    const crossings = Array.from({ length: 42 }, (_, i) => i).filter(shouldRegenerateName)
    expect(crossings).toEqual([2, 5, 10, 20, 30, 40])
  })
})

describe('namingEvidence', () => {
  const thread: Entry[] = [
    user(1, 'can you research how our checkout page loses users'),
    assistant(2, 'I read the funnel analytics.'),
    user(3, 'ok now build the fix for the abandoned cart step'),
    assistant(4, 'Edited cart.tsx.'),
    user(5, 'review that and open a PR'),
    assistant(6, 'Opened PR #12 with the cart fix.'),
  ]

  it('leads with the user messages, in the order they were sent', () => {
    const evidence = namingEvidence(thread)
    expect(evidence.indexOf('What the user asked for')).toBe(0)
    expect(evidence.indexOf('research how our checkout page')).toBeLessThan(
      evidence.indexOf('build the fix'),
    )
    expect(evidence.indexOf('build the fix')).toBeLessThan(evidence.indexOf('open a PR'))
  })

  it('carries what the agent did as a smaller tail below the user messages', () => {
    const evidence = namingEvidence(thread)
    expect(evidence).toContain('What the agent did most recently')
    expect(evidence.indexOf('What the user asked for')).toBeLessThan(
      evidence.indexOf('What the agent did most recently'),
    )
    expect(evidence).toContain('Opened PR #12')
  })

  it('ignores image-only turns, which never say what the work is', () => {
    expect(userMessages([user(1, '(image)'), user(2, 'fix the importer')])).toEqual([
      'fix the importer',
    ])
  })

  it('is empty for a thread with nothing to name yet', () => {
    expect(namingEvidence([])).toBe('')
  })
})
