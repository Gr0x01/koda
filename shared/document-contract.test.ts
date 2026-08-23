import { describe, expect, it } from 'vitest'
import {
  docFormatCapabilities,
  isLibraryAdmittedDocumentPath,
  isLibraryDocumentPath,
  isUnderDocumentsHome,
  resolveDocFormat,
  splitDocumentFrontmatter,
} from './document-contract'
import { DocFormatCapabilitiesSchema, DocFormatSchema } from './ipc'

describe('shared document eligibility', () => {
  it('keeps the Library and kept-document shelf on the same authored formats', () => {
    for (const path of ['a.md', 'A.MARKDOWN', 'notes/x.mdx', 'draft.rst', 'outline.org'])
      expect(isLibraryDocumentPath(path)).toBe(true)
    for (const path of ['capture.txt', 'source.ts', 'README']) expect(isLibraryDocumentPath(path)).toBe(false)
  })
})

/**
 * Two admission rules, and the whole design rests on them staying unequal. Prose is admitted wherever
 * it sits because a `.md` is almost always somebody writing. `.html` is admitted only under
 * `Documents/` because it is almost always a machine: build output, coverage reports, email templates,
 * vendored docs. A project-wide HTML rule buries the user's writing the first time anyone runs a build.
 */
describe('deliberate admission', () => {
  it('keeps prose admitted anywhere in the project, unchanged', () => {
    for (const rel of ['README.md', 'src/notes.md', 'Documents/brief.md', 'spike/x.rst'])
      expect(isLibraryAdmittedDocumentPath(rel)).toBe(true)
  })

  it('admits HTML only under the project’s Documents/ home', () => {
    for (const rel of ['Documents/report.html', 'Documents/reviews/q3.HTML', 'documents/legacy.htm'])
      expect(isLibraryAdmittedDocumentPath(rel)).toBe(true)
    for (const rel of [
      'dist/index.html',
      'coverage/index.html',
      'emails/welcome.html',
      'report.html',
      // A `Documents/` nested inside somebody else's tree shares a name, not a meaning.
      'site/Documents/generated.html',
      // The home itself is a folder, not a document.
      'Documents',
    ])
      expect(isLibraryAdmittedDocumentPath(rel)).toBe(false)
  })

  it('answers the home question on the first segment only', () => {
    expect(isUnderDocumentsHome('Documents/a.html')).toBe(true)
    expect(isUnderDocumentsHome('./Documents/a.html')).toBe(true)
    expect(isUnderDocumentsHome('Documents\\a.html')).toBe(true)
    expect(isUnderDocumentsHome('site/Documents/a.html')).toBe(false)
    expect(isUnderDocumentsHome('Documents')).toBe(false)
  })

  it('does not let admission drift from the format table', () => {
    // The format half comes from `resolveDocFormat`, so "may this be admitted" and "which surface
    // opens it" can never answer the same file differently.
    for (const rel of ['Documents/sample.docx', 'Documents/sample.pdf', 'Documents/notes.txt'])
      expect(isLibraryAdmittedDocumentPath(rel)).toBe(false)
  })
})

describe('document format resolution', () => {
  it('resolves the format-aware extensions regardless of case', () => {
    expect(resolveDocFormat('/p/Documents/plan.md')).toBe('markdown')
    expect(resolveDocFormat('PLAN.MD')).toBe('markdown')
    expect(resolveDocFormat('notes/outline.markdown')).toBe('markdown')
    expect(resolveDocFormat('report.html')).toBe('html')
    expect(resolveDocFormat('C:\\work\\report.HTM')).toBe('html')
    expect(resolveDocFormat('deliverable.DocX')).toBe('docx')
    expect(resolveDocFormat('/p/handoff.pdf')).toBe('pdf')
  })

  it('resolves everything else to the fallback text surface', () => {
    // `.mdx` is Library-eligible but not CommonMark, so it gets read + plain edit, never a rich
    // round-trip claim. `.rst`/`.org` are the same shape of decision.
    for (const path of ['notes.mdx', 'guide.rst', 'outline.org', 'capture.txt'])
      expect(resolveDocFormat(path)).toBe('text')
    // Admission and format stay independent questions.
    expect(isLibraryDocumentPath('notes.mdx')).toBe(true)
    for (const path of ['src/main.ts', 'Makefile', '/p/.gitignore', 'archive.zip', 'shot.png'])
      expect(resolveDocFormat(path)).toBe('text')
  })

  it('has a format for every path and a capability row for every format', () => {
    for (const format of DocFormatSchema.options) {
      const caps = docFormatCapabilities(format)
      expect(DocFormatCapabilitiesSchema.parse(caps)).toEqual(caps)
      // Exactly the six agreed capabilities — a seventh must be a deliberate contract change.
      expect(Object.keys(caps).sort()).toEqual([
        'canAgentApply',
        'canDirectEdit',
        'canExport',
        'canRead',
        'canRunScripts',
        'canSelect',
      ])
    }
  })
})

describe('document format capabilities', () => {
  it('pins the product model exactly', () => {
    expect(docFormatCapabilities('markdown')).toEqual({
      canRead: true,
      canSelect: true,
      canDirectEdit: true,
      canAgentApply: true,
      canExport: true,
      canRunScripts: false,
    })
    expect(docFormatCapabilities('html')).toEqual({
      canRead: true,
      canSelect: true,
      canDirectEdit: false,
      canAgentApply: true,
      canExport: true,
      canRunScripts: true,
    })
    expect(docFormatCapabilities('docx')).toEqual({
      canRead: true,
      canSelect: true,
      canDirectEdit: false,
      canAgentApply: false,
      canExport: true,
      canRunScripts: false,
    })
    expect(docFormatCapabilities('pdf')).toEqual({
      canRead: true,
      canSelect: true,
      canDirectEdit: false,
      canAgentApply: false,
      canExport: false,
      canRunScripts: false,
    })
    expect(docFormatCapabilities('text')).toEqual({
      canRead: true,
      canSelect: true,
      canDirectEdit: true,
      canAgentApply: false,
      canExport: false,
      canRunScripts: false,
    })
  })

  it('lets only the sandboxed HTML surface run scripts', () => {
    const runners = DocFormatSchema.options.filter((f) => docFormatCapabilities(f).canRunScripts)
    expect(runners).toEqual(['html'])
  })

  it('never offers an apply handler for a format it cannot edit or regenerate', () => {
    for (const format of DocFormatSchema.options) {
      const caps = docFormatCapabilities(format)
      if (caps.canAgentApply) expect(caps.canDirectEdit || caps.canExport).toBe(true)
    }
  })

  it('refuses to hand back a mutable table', () => {
    const caps = docFormatCapabilities('pdf') as { canDirectEdit: boolean }
    expect(() => {
      caps.canDirectEdit = true
    }).toThrow()
    expect(docFormatCapabilities('pdf').canDirectEdit).toBe(false)
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
