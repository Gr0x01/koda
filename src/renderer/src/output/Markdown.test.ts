import { describe, expect, it } from 'vitest'
import { markdownUrlTransform } from './Markdown'

describe('assistant markdown URL transformation', () => {
  it('preserves Koda-local file and session identities for the Stage resolver', () => {
    expect(markdownUrlTransform('file:///project/notes.md#L12C3', 'href')).toBe(
      'file:///project/notes.md#L12C3',
    )
    expect(markdownUrlTransform('koda://session/abc', 'href')).toBe('koda://session/abc')
    expect(markdownUrlTransform('src/app.ts:12:3', 'href')).toBe('src/app.ts:12:3')
    expect(markdownUrlTransform('Documents/plan.md', 'href')).toBe('Documents/plan.md')
  })

  it('keeps active schemes sanitized even when they resemble a source location', () => {
    expect(markdownUrlTransform('javascript:12', 'href')).toBe('')
    expect(markdownUrlTransform('vbscript:12', 'href')).toBe('')
    expect(markdownUrlTransform('data:text/html,hello', 'href')).toBe('')
  })

  it('allows only image data URLs in source attributes', () => {
    expect(markdownUrlTransform('data:image/png;base64,abc', 'src')).toBe(
      'data:image/png;base64,abc',
    )
    expect(markdownUrlTransform('data:text/html,hello', 'src')).toBe('')
  })
})
