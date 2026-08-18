import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  amendDocFrontmatter,
  docDateStamp,
  inferDocKind,
  isDocFrontmatterBlock,
  parseDocFrontmatter,
  readDocMetadata,
  splitFrontmatter,
  writeDocFrontmatter,
} from './doc-frontmatter'

/**
 * The metadata substrate the whole document workspace reads from. Two properties matter more than any
 * individual field: a malformed block degrades to undefined rather than throwing (one bad file must
 * never blank the user's Documents list), and what this module WRITES is what it can READ back.
 */
describe('frontmatter parsing', () => {
  it('reads the four authored fields', () => {
    const fm = parseDocFrontmatter(
      ['---', 'title: The Document Workspace', 'description: How Koda presents documents.', 'date: 2026-08-13', 'kind: research', 'source: sess-42', '---', '', '# Body'].join('\n'),
    )
    expect(fm).toEqual({
      title: 'The Document Workspace',
      description: 'How Koda presents documents.',
      kind: 'research',
      source: 'sess-42',
    })
  })

  it('reads CRLF files and quoted values', () => {
    const fm = parseDocFrontmatter('---\r\ntitle: "Phone tiers: what we settled"\r\nkind: \'decision\'\r\n---\r\nbody')
    expect(fm.title).toBe('Phone tiers: what we settled')
    expect(fm.kind).toBe('decision')
  })

  it('folds a block-scalar description', () => {
    const fm = parseDocFrontmatter(
      ['---', 'title: Launch', 'description: >', '  A long sentence that the author', '  wrapped across two lines.', 'kind: plan', '---', 'body'].join('\n'),
    )
    expect(fm.description).toBe('A long sentence that the author wrapped across two lines.')
    expect(fm.kind).toBe('plan')
  })

  it('degrades a malformed block to undefined instead of throwing', () => {
    const malformed = [
      '---',
      'title: [unclosed, "sequence',
      '  : : :',
      'description',
      '\tkind: plan',
      '---',
      'body',
    ].join('\n')
    let fm!: ReturnType<typeof parseDocFrontmatter>
    expect(() => (fm = parseDocFrontmatter(malformed))).not.toThrow()
    // `title:` parsed to a literal string rather than a sequence — a scalar reader is allowed to be
    // wrong about YAML it doesn't model. What it may NOT do is throw or invent a kind.
    expect(fm.description).toBeUndefined()
    expect(fm.kind).toBeUndefined()
  })

  it('treats an unterminated block, an unknown kind and an empty file as no metadata', () => {
    expect(parseDocFrontmatter('---\ntitle: Never closed\n\nbody')).toEqual({})
    expect(parseDocFrontmatter('')).toEqual({})
    expect(parseDocFrontmatter('# Just a heading\n')).toEqual({})
    expect(parseDocFrontmatter('---\ntitle: X\nkind: design\n---\n').kind).toBeUndefined()
  })

  it('ignores nested structures, so design tokens do not read as document metadata', () => {
    const designTokens = ['---', 'colors:', '  ink: "#101418"', '  title: not-a-doc-title', 'typography:', '  kind: display', '---', 'body'].join('\n')
    expect(parseDocFrontmatter(designTokens)).toEqual({})
  })

  it('round-trips what it writes, including a title YAML would otherwise mangle', () => {
    for (const title of ['Untitled 2', 'Phone tiers: what we settled', '#2 draft', 'true', '2026', 'a "quoted" name']) {
      const block = writeDocFrontmatter({ title, date: '2026-08-13', kind: 'note' })
      expect(parseDocFrontmatter(block).title, `round-trip of ${title}`).toBe(title)
      expect(parseDocFrontmatter(block).kind).toBe('note')
    }
  })

  it('writes source only when there is one', () => {
    expect(writeDocFrontmatter({ title: 'X', date: '2026-08-13', kind: 'note' })).not.toContain('source:')
    expect(parseDocFrontmatter(writeDocFrontmatter({ title: 'X', date: '2026-08-13', kind: 'note', source: 's-1' })).source).toBe('s-1')
  })

  it('leaves description for the agent to author', () => {
    expect(writeDocFrontmatter({ title: 'X', date: '2026-08-13', kind: 'note' })).not.toContain('description:')
  })

  it('stamps the local date, not UTC', () => {
    expect(docDateStamp(new Date(2026, 7, 13, 21, 30))).toBe('2026-08-13')
  })
})

/**
 * The seam that keeps `createProjectFile` the ONE creation path: a document is born with the fields
 * Koda can derive, then the field only its author can supply is written into the block it already has.
 * A caller that rebuilt the whole block instead would be a second creation path, and the substrate
 * design exists to stop there being one.
 */
describe('amendDocFrontmatter', () => {
  const born = '---\ntitle: Branch notes\ndate: 2026-08-13\nkind: note\nsource: sess-1\n---\n\n'

  it('replaces a known key in place and leaves every other line alone', () => {
    const once = amendDocFrontmatter(born, { description: 'What we settled about branches.', kind: 'decision' })
    const twice = amendDocFrontmatter(once, { description: 'A better sentence.' })
    expect(twice.match(/^description:/gm)).toHaveLength(1)
    expect(twice.match(/^kind:/gm)).toHaveLength(1)
    const fm = parseDocFrontmatter(twice)
    expect(fm).toEqual({
      title: 'Branch notes',
      description: 'A better sentence.',
      kind: 'decision',
      source: 'sess-1',
    })
    expect(twice).toContain('date: 2026-08-13')
  })

  it('quotes a description YAML would otherwise mangle, and preserves the body', () => {
    const raw = amendDocFrontmatter('---\ntitle: X\n---\n\n# Body\n', { description: 'Phone tiers: what we settled' })
    expect(parseDocFrontmatter(raw).description).toBe('Phone tiers: what we settled')
    expect(splitFrontmatter(raw).body).toBe('\n# Body\n')
  })

  it('is a no-op when there is nothing to write', () => {
    expect(amendDocFrontmatter(born, {})).toBe(born)
    expect(amendDocFrontmatter(born, { description: '   ' })).toBe(born)
  })
})

describe('splitFrontmatter', () => {
  it('reconstructs the original exactly', () => {
    const raw = '---\ntitle: X\n---\n\n# Heading\n\nBody.\n'
    const { block, body } = splitFrontmatter(raw)
    expect(block).toBe('title: X')
    expect(body).toBe('\n# Heading\n\nBody.\n')
  })

  it('passes a bare document through untouched', () => {
    expect(splitFrontmatter('# Heading\n')).toEqual({ block: '', body: '# Heading\n' })
  })
})

describe('kind inference (the fallback, and nothing more)', () => {
  it('maps a folder that literally names a kind, under the Documents home or not', () => {
    expect(inferDocKind('Documents/plans/launch.md')).toBe('plan')
    expect(inferDocKind('Documents/decisions/branches.md')).toBe('decision')
    expect(inferDocKind('Documents/research/audience.md')).toBe('research')
    expect(inferDocKind('Documents/guides/setup.md')).toBe('guide')
    expect(inferDocKind('Documents/reference/api.md')).toBe('reference')
    expect(inferDocKind('guides/setup.md')).toBe('guide')
  })

  it('falls back to note for a topic folder, the home itself, and the project root', () => {
    // Folders are TOPICS: mapping `site/` or `architecture/` to a kind would invent a second taxonomy
    // to disagree with the authored one, which is what killed folder-derived kind in the first place.
    expect(inferDocKind('Documents/site/audience-research.md')).toBe('note')
    expect(inferDocKind('Documents/architecture/overview.md')).toBe('note')
    expect(inferDocKind('Documents/loose.md')).toBe('note')
    expect(inferDocKind('README.md')).toBe('note')
  })
})

describe('readDocMetadata', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'koda-fm-')))
  const file = (name: string, text: string): string => {
    const p = join(dir, name)
    writeFileSync(p, text)
    return p
  }

  it('returns prose for the excerpt, never the metadata block', async () => {
    const p = file('doc.md', '---\ntitle: Launch\nkind: plan\n---\n\nThe first real sentence.\n')
    const { fm, excerpt } = await readDocMetadata(p)
    expect(fm.title).toBe('Launch')
    expect(excerpt?.trimStart().startsWith('The first real sentence.')).toBe(true)
    expect(excerpt).not.toContain('title:')
  })

  it('reads only the head of a huge file', async () => {
    const p = file('big.md', '---\ntitle: Big\n---\n\n' + 'x'.repeat(5_000_000))
    const { fm, excerpt } = await readDocMetadata(p)
    expect(fm.title).toBe('Big')
    expect(excerpt!.length).toBeLessThanOrEqual(600)
  })

  it('is empty rather than an error for a file that is not there', async () => {
    await expect(readDocMetadata(join(dir, 'ghost.md'))).resolves.toEqual({ fm: {} })
  })

  it('refuses a cached path that has become a symlink outside its project', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-fm-root-')))
    const outside = file('outside.md', '---\ntitle: Secret\n---\n\noutside words\n')
    const link = join(project, 'doc.md')
    symlinkSync(outside, link)
    await expect(readDocMetadata(link, 600, project)).resolves.toEqual({ fm: {} })
    rmSync(project, { recursive: true, force: true })
  })

  it('keeps a thematic-break passage in the excerpt', async () => {
    const p = file('quote.md', '---\n\n"The only way out is through."\n\n---\n\nAfterward.\n')
    const { fm, excerpt } = await readDocMetadata(p)
    expect(fm).toEqual({})
    expect(excerpt).toContain('The only way out is through.')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})

/**
 * `---` is markdown's thematic break as well as a frontmatter fence, so "does this file open with a
 * `---` block?" is not the same question as "does this file carry document metadata?". Anything that
 * DELETES the block has to ask the second one — `keepDocument` strips it from a body, and the Library's
 * content scan skips it — and a wrong answer either buries the plumbing in a citation or silently eats
 * the first thing the user wrote.
 */
describe('telling metadata apart from a rule-delimited passage', () => {
  it('recognizes a block carrying any of the keys Koda writes', () => {
    for (const key of ['title: A', 'description: B', 'kind: note', 'date: 2026-08-13', 'source: sess-1']) {
      expect(isDocFrontmatterBlock(`---\n${key}\n---\n\nbody\n`)).toBe(true)
    }
    // Alongside unrelated keys, and case-insensitively — the reader lowercases keys.
    expect(isDocFrontmatterBlock('---\nauthor: RB\nTitle: A\n---\nbody')).toBe(true)
  })

  it('refuses a pull quote fenced by thematic breaks', () => {
    expect(isDocFrontmatterBlock('---\n\n"The only way out is through."\n\n---\n\nAnd then the notes.\n')).toBe(false)
    // A colon alone is not enough: `Note: …` is prose that parses as a key/value pair.
    expect(isDocFrontmatterBlock('---\nNote: the only way out is through.\n---\nbody')).toBe(false)
  })

  it('refuses a file with no leading block, and an empty one', () => {
    expect(isDocFrontmatterBlock('# Just a heading\n')).toBe(false)
    expect(isDocFrontmatterBlock('---\n\n---\nbody')).toBe(false)
    expect(isDocFrontmatterBlock('')).toBe(false)
  })

  it('agrees with what a document is BORN with', () => {
    expect(isDocFrontmatterBlock(writeDocFrontmatter({ title: 'A', date: '2026-08-13', kind: 'note' }))).toBe(true)
  })
})
