import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { keepDocument, type KeepDocumentArgs } from './keep-document'
import { docDateStamp, parseDocFrontmatter, splitFrontmatter } from './doc-frontmatter'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'koda-keep-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A well-formed call, so each test names only the field it is about. */
function args(overrides: Partial<KeepDocumentArgs> = {}): KeepDocumentArgs {
  return {
    title: 'Branch management notes',
    description: 'What we settled about naming branches and when one gets deleted.',
    kind: 'decision',
    body: '# Branch management\n\nOne branch per piece of work.\n',
    ...overrides,
  }
}

function read(rel: string): string {
  return readFileSync(join(root, ...rel.split('/')), 'utf8')
}

describe('a kept conversation is born through the same path as any other document', () => {
  it('carries the authored fields plus the ones only Koda can supply', async () => {
    const kept = await keepDocument(root, args(), 'sess-42')
    expect(kept).toEqual({
      kept: true,
      path: 'Documents/Branch management notes.md',
      title: 'Branch management notes',
      kind: 'decision',
    })

    const raw = read(kept.path)
    const fm = parseDocFrontmatter(raw)
    expect(fm.title).toBe('Branch management notes')
    expect(fm.description).toBe('What we settled about naming branches and when one gets deleted.')
    // The whole reason this is a broker tool and not a Write: the session id is provenance the agent
    // cannot know, so a hand-written document could never carry it.
    expect(fm.source).toBe('sess-42')
    expect(raw).toMatch(/^---\ntitle: /)
    expect(raw).toContain(`date: ${docDateStamp()}`)
    expect(splitFrontmatter(raw).body).toBe('\n# Branch management\n\nOne branch per piece of work.\n')
  })

  it('lets the authored kind beat the one the destination folder implied', async () => {
    // `Documents/plans/` infers `plan`; a decision filed there is still a decision, and the Library's
    // kind filter is only worth having if the authored answer wins.
    const kept = await keepDocument(root, args({ folder: 'Documents/plans' }), 'sess-1')
    expect(kept.path).toBe('Documents/plans/Branch management notes.md')
    expect(parseDocFrontmatter(read(kept.path)).kind).toBe('decision')
    expect(read(kept.path).match(/^kind:/gm)).toHaveLength(1)
  })

  it('files into a genuinely new topic folder, and scopes a bare one under Documents/', async () => {
    const kept = await keepDocument(root, args({ folder: 'onboarding' }), 'sess-1')
    expect(kept.path).toBe('Documents/onboarding/Branch management notes.md')
  })

  it('never overwrites a document already kept under the same name', async () => {
    const first = await keepDocument(root, args(), 'sess-1')
    const second = await keepDocument(root, args({ body: 'A later pass.' }), 'sess-2')
    expect(second.path).not.toBe(first.path)
    // The result reports the name the document actually got, so the agent can't tell the user a title
    // that isn't on the page.
    expect(second.title).toBe('Branch management notes 2')
    expect(parseDocFrontmatter(read(second.path)).title).toBe('Branch management notes 2')
    expect(read(first.path)).toContain('One branch per piece of work.')
  })

  it('drops a frontmatter block the agent wrote into the body, rather than stacking two', async () => {
    const kept = await keepDocument(
      root,
      args({ body: '---\ntitle: Mine\nkind: note\n---\n\n# Real body\n' }),
      'sess-1',
    )
    const raw = read(kept.path)
    expect(raw.match(/^---$/gm)).toHaveLength(2)
    expect(raw).not.toContain('title: Mine')
    expect(raw.trimEnd().endsWith('# Real body')).toBe(true)
  })
})

/**
 * `---` is markdown's thematic break as well as a frontmatter fence, so stripping on the fences alone
 * silently deleted the first thing the user wrote — no warning, no way to tell from the result. Only a
 * block that actually parses as document metadata may be dropped.
 */
describe('a body that merely LOOKS like frontmatter is kept', () => {
  it('keeps a rule-delimited pull quote that opens the body', async () => {
    const quote = '---\n\n"The only way out is through."\n\n---\n\nAnd then the notes.\n'
    const kept = await keepDocument(root, args({ body: quote }), 'sess-1')
    const raw = read(kept.path)
    expect(raw).toContain('"The only way out is through."')
    expect(raw).toContain('And then the notes.')
  })

  it('keeps a block whose only key is prose that happens to have a colon', async () => {
    // `Note: …` parses as a key/value pair, which is exactly why the test is for RECOGNIZED keys.
    const kept = await keepDocument(
      root,
      args({ body: '---\nNote: the only way out is through.\n---\n\nBody follows.\n' }),
      'sess-1',
    )
    expect(read(kept.path)).toContain('Note: the only way out is through.')
  })

  it('still drops a real metadata block, whichever recognized key it leads with', async () => {
    for (const lead of ['title: Mine', 'kind: note', 'date: 2001-01-01', 'source: sess-9', 'description: A thing']) {
      const kept = await keepDocument(root, args({ body: `---\n${lead}\n---\n\n# Real body\n` }), 'sess-1')
      const raw = read(kept.path)
      // Exactly one block — the one Koda gave the document — and the body is only the agent's words.
      expect(raw.match(/^---$/gm)).toHaveLength(2)
      expect(splitFrontmatter(raw).body.trim()).toBe('# Real body')
      expect(splitFrontmatter(raw).body).not.toContain(lead)
    }
  })
})

/**
 * The editorial bar this feature is built around is RB's own: a quiet session earns one dated line and
 * never a padded summary, and "an empty result is a valid result; manufacturing content to fill it is
 * the failure". Substance is not machine-checkable, so the bar itself lives in the tool description and
 * the shipped playbook. What IS checkable is the one mechanical half the design writes down — a
 * description that restates the title fills the only line the Library has with nothing.
 */
describe('the bar it can actually enforce', () => {
  it('refuses a description that only restates the title, punctuation and case aside', async () => {
    await expect(keepDocument(root, args({ description: 'Branch-management notes.' }), 'x')).rejects.toThrow(
      /restates the title/,
    )
    expect(existsSync(join(root, 'Documents', 'Branch management notes.md'))).toBe(false)
  })

  it('accepts a genuinely short description — one dated line is a valid document', async () => {
    const kept = await keepDocument(
      root,
      args({ description: 'Nothing was decided; kept for the date.', body: '2026-08-13 — nothing worked, nothing changed.' }),
      'x',
    )
    expect(read(kept.path).trimEnd().endsWith('2026-08-13 — nothing worked, nothing changed.')).toBe(true)
  })

  it('refuses an empty body, and says what to do instead of filling it', async () => {
    await expect(keepDocument(root, args({ body: '   \n\n' }), 'x')).rejects.toThrow(/nothing durable/)
    await expect(keepDocument(root, args({ body: '---\ntitle: only frontmatter\n---\n' }), 'x')).rejects.toThrow(
      /nothing durable/,
    )
  })

  it('requires the authored fields, and rejects a kind outside the closed six', async () => {
    await expect(keepDocument(root, args({ title: '  ' }), 'x')).rejects.toThrow(/title is required/)
    await expect(keepDocument(root, args({ description: '' }), 'x')).rejects.toThrow(/description is required/)
    await expect(keepDocument(root, args({ kind: 'design' }), 'x')).rejects.toThrow(/plan, decision, research/)
    await expect(keepDocument(root, args({ title: 'x'.repeat(121) }), 'x')).rejects.toThrow(/too long/)
  })
})

describe('containment', () => {
  it('refuses to file outside the project', async () => {
    await expect(keepDocument(root, args({ folder: '../elsewhere' }), 'x')).rejects.toThrow(/inside Documents/)
    await expect(keepDocument(root, args({ folder: 'Documents/../../elsewhere' }), 'x')).rejects.toThrow(
      /inside Documents/,
    )
    expect(existsSync(join(dirname(root), 'elsewhere'))).toBe(false)
  })

  it('refuses a symlinked Documents/ that points out of the project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'koda-outside-')))
    try {
      symlinkSync(outside, join(root, 'Documents'), 'dir')
      await expect(keepDocument(root, args({ folder: 'Documents/plans' }), 'x')).rejects.toThrow(/escapes the project/)
      // Refused before `mkdir -p` followed the symlink, so nothing at all landed on the far side.
      expect(existsSync(join(outside, 'plans'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('files an absolute-looking folder relative to the project instead of the disk', async () => {
    mkdirSync(join(root, 'Documents'), { recursive: true })
    const kept = await keepDocument(root, args({ folder: '/Documents/decisions' }), 'x')
    expect(kept.path).toBe('Documents/decisions/Branch management notes.md')
  })

  /**
   * The home segment is matched case-insensitively but must be REWRITTEN to Koda's spelling. Passing
   * `documents/` through verbatim is invisible on macOS and a genuine second Documents home on any
   * case-sensitive volume — which is what the Linux lab worker runs, and what a user on a
   * case-sensitive APFS volume has.
   */
  it('normalizes a differently-cased Documents/ onto the one home', async () => {
    const kept = await keepDocument(root, args({ folder: 'documents/decisions' }), 'x')
    expect(kept.path).toBe('Documents/decisions/Branch management notes.md')
    expect(readdirSync(root)).toEqual(['Documents'])

    const shouted = await keepDocument(root, args({ folder: 'DOCUMENTS', title: 'Second' }), 'x')
    expect(shouted.path).toBe('Documents/Second.md')
    expect(readdirSync(root)).toEqual(['Documents'])
  })
})
