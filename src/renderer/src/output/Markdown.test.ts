import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isPathShapedInlineCode, LocalLinkContext, Markdown, markdownUrlTransform } from './Markdown'

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

describe('path-shaped inline code', () => {
  it.each([
    '.env.local',
    'src/foo.ts',
    'src/foo.ts:42',
    'src/foo.ts:42:7',
    './Documents/plan.md',
    '../shared/types.ts',
    '~/notes/today.md',
    '/etc/paperless/config',
    'archive.7z',
  ])('accepts %s', (value) => {
    expect(isPathShapedInlineCode(value)).toBe(true)
  })

  it.each([
    'README',
    'https://example.com/file.ts',
    'file:///project/file.ts',
    'example.com/file.ts',
    'www.example.com/docs',
    'custom:thing.ts',
    'user@host:path/to/file.ts',
    '@scope/name',
    'react@1.2.3',
    '1.2.3',
    'v2.4.0-beta.1',
    'key=value.ts',
    'two words.md',
    'src/*.ts',
    'src/$name.ts',
    'src/a|b.ts',
    'src/out>file.ts',
    'src/file.ts#L12',
    'src//file.ts',
    'src/folder/',
    'src/file.ts:0',
  ])('rejects %s', (value) => {
    expect(isPathShapedInlineCode(value)).toBe(false)
  })

  it('keeps ordinary code markup when no desktop link handler is present', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: '`src/foo.ts`' }))
    expect(html).toContain('<code class="rounded border border-border bg-surface')
    expect(html).not.toContain('<button')
  })

  it('uses a native button only for candidates when the desktop link handler is present', () => {
    const handler = () => true
    const path = renderToStaticMarkup(
      createElement(
        LocalLinkContext.Provider,
        { value: handler },
        createElement(Markdown, { children: '`src/foo.ts:42`' }),
      ),
    )
    const ordinary = renderToStaticMarkup(
      createElement(
        LocalLinkContext.Provider,
        { value: handler },
        createElement(Markdown, { children: '`npm install`' }),
      ),
    )
    expect(path).toContain('<button type="button" aria-label="Open src/foo.ts:42"')
    expect(ordinary).not.toContain('<button')
  })
})
