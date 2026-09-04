import { describe, expect, it } from 'vitest'
import { prettyModel } from './usage-format'

describe('usage model labels', () => {
  it('formats Claude ids with context and date stamps stripped', () => {
    expect(prettyModel('claude-opus-4-8[1m]')).toBe('Opus 4.8 · 1M context')
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('keeps the tier word that tells same-version OpenAI models apart', () => {
    expect(prettyModel('gpt-5.5')).toBe('GPT-5.5')
    expect(prettyModel('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(prettyModel('gpt-5.6-terra')).toBe('GPT-5.6 Terra')
    expect(prettyModel('gpt-6-astra')).toBe('GPT-6 Astra')
    expect(prettyModel('gpt-reserve')).toBe('GPT Reserve')
  })
})
