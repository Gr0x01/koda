import { describe, expect, it } from 'vitest'
import { isLibraryDocumentPath, splitDocumentFrontmatter } from './document-contract'

describe('shared document eligibility', () => {
  it('keeps the Library and kept-document shelf on the same authored formats', () => {
    for (const path of ['a.md', 'A.MARKDOWN', 'notes/x.mdx', 'draft.rst', 'outline.org'])
      expect(isLibraryDocumentPath(path)).toBe(true)
    for (const path of ['capture.txt', 'source.ts', 'README']) expect(isLibraryDocumentPath(path)).toBe(false)
  })
})

describe('shared leading-frontmatter split', () => {
  it('holds Koda metadata aside byte-for-byte', () => {
    const raw = '---\r\ntitle: A\r\nkind: note\r\n---\r\n# Body\r\n'
    expect(splitDocumentFrontmatter(raw)).toEqual({
      kind: 'koda',
      block: 'title: A\r\nkind: note',
      frontmatter: '---\r\ntitle: A\r\nkind: note\r\n---\r\n',
      body: '# Body\r\n',
    })
  })

  it('preserves other YAML while leaving it outside Koda metadata', () => {
    const raw = '---\ncolors:\n  ink: "#111"\ntypography:\n  body: Arsenal\n---\n# Design\n'
    const split = splitDocumentFrontmatter(raw)
    expect(split.kind).toBe('yaml')
    expect(split.frontmatter).toContain('colors:')
    expect(split.body).toBe('# Design\n')
  })

  it('keeps a thematic-break passage and an ambiguous prose key editable', () => {
    for (const raw of [
      '---\n\n"The only way out is through."\n\n---\n\nAfterward.\n',
      '---\nNote: the only way out is through.\n---\nBody follows.\n',
    ]) {
      const split = splitDocumentFrontmatter(raw)
      expect(split.kind).toBe('prose')
      expect(split.frontmatter).toBe('')
      expect(split.body).toBe(raw)
    }
  })
})
