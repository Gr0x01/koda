import { describe, expect, it, vi } from 'vitest'
import { buildNamingPrompt, canNameOnEngine, generateSessionName, parseNamingReply } from './naming'

vi.mock('./binary', () => ({
  resolveEnginePath: () => {
    throw new Error('offline naming test')
  },
}))

// The prompt split is the load-bearing part (T3 research doc → "Special flows"): the initial prompt
// separates the subject from incidental instructions, and the regenerate prompt carries the evidence
// hierarchy plus the "stage progression is not a subject change" rule taught by counter-example.

describe('buildNamingPrompt', () => {
  it('teaches the initial prompt to drop incidental instructions', () => {
    const prompt = buildNamingPrompt({ kind: 'initial', evidence: 'fix the cart' })
    expect(prompt).toContain('SUBJECT')
    expect(prompt).toContain('Incidental instructions')
    expect(prompt).toContain('<evidence>\nfix the cart\n</evidence>')
    // The initial prompt has no history to weigh, so it must not carry the hierarchy or a stale title.
    expect(prompt).not.toContain('own the subject')
    expect(prompt).not.toContain('Current title')
  })

  it('gives the regenerate prompt the evidence hierarchy and the stage-progression rule', () => {
    const prompt = buildNamingPrompt({
      kind: 'regenerate',
      evidence: 'the thread so far',
      currentTitle: 'Checkout Drop-off',
    })
    expect(prompt).toContain("The user's own messages own the subject")
    expect(prompt).toMatch(/research, planning, building, review, CI, and merge.*HAS NOT CHANGED SUBJECTS/s)
    expect(prompt).toContain('Current title: Checkout Drop-off')
    // Worked counter-examples, not just assertions — both directions.
    expect(prompt).toContain('"Open A Pull Request" is wrong')
    expect(prompt).toContain('The subject genuinely moved')
  })
})

describe('parseNamingReply', () => {
  it('reads a bare schema-constrained object', () => {
    expect(parseNamingReply('{"title":"Checkout Drop-off","overview":"Find and fix the abandoned cart step."}')).toEqual(
      { title: 'Checkout Drop-off', overview: 'Find and fix the abandoned cart step.' },
    )
  })

  it('unwraps a normalized payload returned as a JSON string', () => {
    const asString = JSON.stringify(
      '{"title":"Photo Importer Speed","overview":"Make the photo import faster."}',
    )
    expect(parseNamingReply(asString)?.overview).toBe('Make the photo import faster.')
  })

  it('finds the object inside a fenced answer', () => {
    const fenced = '```json\n{"title":"Invoice Sending","overview":"Fix invoices that never send."}\n```'
    expect(parseNamingReply(fenced)?.title).toBe('Invoice Sending')
  })

  it('strips the decorations small models add', () => {
    const noisy = '{"title":"  \\"Checkout Drop-off.\\"  ","overview":"Research the funnel — then fix it."}'
    expect(parseNamingReply(noisy)).toEqual({
      title: 'Checkout Drop-off',
      // Em dashes are Koda's one banned punctuation mark in shipped copy.
      overview: 'Research the funnel, then fix it.',
    })
  })

  it('rejects a refusal, a paragraph, and an unparseable answer', () => {
    expect(parseNamingReply('{"title":"I cannot help with that","overview":"x"}')).toBeNull()
    expect(
      parseNamingReply(`{"title":"${'word '.repeat(12).trim()}","overview":"x"}`),
    ).toBeNull()
    expect(parseNamingReply('sorry, no JSON here')).toBeNull()
  })

  it('drops an over-long overview but keeps the title', () => {
    const long = 'word '.repeat(40).trim()
    expect(parseNamingReply(`{"title":"Invoice Sending","overview":"${long}"}`)).toEqual({
      title: 'Invoice Sending',
      overview: '',
    })
  })
})

describe('generateSessionName', () => {
  it('falls back to the caller floor when the engine cannot answer', async () => {
    // The mocked missing binary takes the same arm as every real failure (not signed in, timeout, a
    // wedged child). Naming must never reject and never leave a session nameless.
    const named = await generateSessionName(
      {
        kind: 'initial',
        evidence: 'fix the login redirect loop',
        engineId: 'claude',
        model: 'haiku',
      },
      async (text) => `floor: ${text.slice(0, 10)}`,
    )
    expect(named).toEqual({ title: 'floor: fix the lo', overview: '' })
  })

  it('routes Codex through the same generation capability and still falls back on a miss', async () => {
    expect(canNameOnEngine('codex')).toBe(true)
    expect(canNameOnEngine('claude')).toBe(true)
    const named = await generateSessionName(
      { kind: 'initial', evidence: 'rename this thread', engineId: 'codex', model: 'haiku' },
      async () => 'On-device Name',
    )
    expect(named).toEqual({ title: 'On-device Name', overview: '' })
  })

  // The floor is a first-words title, and a regenerate's evidence is the caller's framed digest
  // ("What the user asked for, in order: …"). Handing that to the floor named threads after the
  // framing itself, and every intermittent engine miss read to the user as the name changing on its
  // own. A regenerate that can't reach its engine must answer with nothing instead.
  it('keeps a named thread named when a regenerate misses', async () => {
    const floor = vi.fn(async () => 'First Few Words Of The Digest')
    const named = await generateSessionName(
      {
        kind: 'regenerate',
        evidence: 'What the user asked for, in order:\n- speed up the photo importer',
        currentTitle: 'Photo Importer Speed',
        engineId: 'codex', // the mocked missing binary is the deterministic miss
        model: 'haiku',
      },
      floor,
    )
    expect(named).toEqual({ title: '', overview: '' })
    expect(floor).not.toHaveBeenCalled()
  })
})
