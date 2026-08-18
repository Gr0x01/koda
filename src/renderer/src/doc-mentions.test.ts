import { describe, expect, it } from 'vitest'
import { docMention, docMentionLabel, expandDocMentionLabels, hasDocMention } from './doc-mentions'

const docs = [
  { path: '/p/Documents/Goal sessions.md', name: 'Goal sessions.md', rel: 'Documents/Goal sessions.md' },
  {
    path: '/p/Documents/release/release-plan.md',
    name: 'release-plan.md',
    rel: 'Documents/release/release-plan.md',
  },
]

describe('document mentions', () => {
  it('uses one label rule for display and expansion', () => {
    expect(docMentionLabel('Goal sessions.md')).toBe('Goal sessions')
    expect(docMention(docMentionLabel('Goal sessions.md'))).toBe('@"Goal sessions"')
  })

  it('expands a quoted label containing spaces to the exact quoted path', () => {
    expect(expandDocMentionLabels('Read @"Goal sessions" before starting.', docs)).toBe(
      'Read @"Documents/Goal sessions.md" before starting.',
    )
  })

  it('keeps existing one-token mentions and hand-written paths working', () => {
    expect(expandDocMentionLabels('Use @release-plan and @src/main/index.ts.', docs)).toBe(
      'Use @Documents/release/release-plan.md and @src/main/index.ts.',
    )
  })

  it('round-trips legal filenames containing quotes and backslashes', () => {
    const odd = [
      { path: '/p/Documents/Bob "draft" \\ notes.md', name: 'Bob "draft" \\ notes.md', rel: 'Documents/Bob "draft" \\ notes.md' },
    ]
    const mention = docMention(docMentionLabel(odd[0].name))
    expect(mention).toBe('@"Bob \\"draft\\" \\\\ notes"')
    expect(expandDocMentionLabels(`Read ${mention}.`, odd)).toBe(
      'Read @"Documents/Bob \\"draft\\" \\\\ notes.md".',
    )
  })
})

describe('hasDocMention — the gate before paying for the document list', () => {
  it('sees a token worth resolving, quoted or bare', () => {
    expect(hasDocMention('read @release-plan')).toBe(true)
    expect(hasDocMention('read @"Goal sessions"')).toBe(true)
    // Slash-shaped too: resolving it is the only way to learn it names nothing.
    expect(hasDocMention('npm i @tanstack/react-query')).toBe(true)
  })

  it('stays false for text with no reference in it', () => {
    expect(hasDocMention('plain text')).toBe(false)
    expect(hasDocMention('mail rb@example.com')).toBe(false)
    expect(hasDocMention('have a look at @')).toBe(false)
    expect(hasDocMention('')).toBe(false)
  })
})
