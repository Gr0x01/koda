import { describe, expect, it } from 'vitest'
import { classifyStageHref, parseSessionHref, sessionHref } from './stage-links'

describe('shared Stage link classification', () => {
  it('keeps session doors identical across desktop and phone', () => {
    const href = sessionHref('chat with spaces')
    expect(href).toBe('koda://session/chat%20with%20spaces')
    expect(parseSessionHref(href)).toBe('chat with spaces')
    expect(classifyStageHref(href)).toEqual({ kind: 'session', sessionId: 'chat with spaces' })
  })

  it('separates files, anchors, external links, and unsafe schemes', () => {
    expect(classifyStageHref('src/app.ts:12:3')).toEqual({ kind: 'file' })
    expect(classifyStageHref('file:///project/plan.md#L4')).toEqual({ kind: 'file' })
    expect(classifyStageHref('#decision')).toEqual({ kind: 'anchor' })
    expect(classifyStageHref('https://example.com')).toEqual({ kind: 'external' })
    expect(classifyStageHref('javascript:12')).toEqual({ kind: 'unsupported' })
    expect(classifyStageHref('custom://thing')).toEqual({ kind: 'unsupported' })
  })
})
