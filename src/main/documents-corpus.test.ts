/**
 * The frontmatter tripwire: every document under `Documents/` carries the metadata the Library reads.
 *
 * The document workspace's whole argument is that a reader finds a document by recognizing it rather
 * than by knowing where it lives, and the only thing that makes that possible is authored metadata —
 * the `title` shown instead of a filename, the one `description` that says what the document is for,
 * and the `kind` the filter row is built from. A document that lands without them reads as the file
 * tree the surface exists to replace, and it does so quietly: nothing errors, the row just gets worse.
 *
 * The corpus was backfilled once and a one-off pass decays the same week, which this repository has
 * already proved for a different rule (`shared/engine-name-branches.test.ts`). So the pass is a test.
 * It lives beside `doc-frontmatter.ts` because that module owns both halves of the convention (the
 * reader below, and the block `createProjectFile` writes at birth), and plain `vitest run` picks it up,
 * so CI already runs it with no workflow change.
 *
 * It deliberately parses through `parseDocFrontmatter` rather than with its own regex. A second reader
 * would drift from the one the product uses, and then a document could pass the test and still render
 * blank in the Library — which is the only failure worth catching here.
 *
 * When it fails, the fix is to write the three fields, not to widen `EXCLUDED`. A `description` that
 * restates the title is worse than none: it fills the slot that would otherwise show a useful excerpt.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocFrontmatter } from './doc-frontmatter'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DOCS = join(ROOT, 'Documents')

/**
 * Repo-relative path → why this document is exempt. A reason is required: an entry without one is how
 * a temporary exception becomes permanent, and this list is the one place the differentiator can be
 * hollowed out a file at a time.
 */
const EXCLUDED: Record<string, string> = {
  'Documents/design/DESIGN.md':
    'its frontmatter is design tokens (colors, typography, motion) — a different job that happens to share a syntax, and `parseDocFrontmatter` is built to read it as "no document metadata" rather than half-parse it',
}

function markdownFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) markdownFiles(full, into)
    else if (entry.toLowerCase().endsWith('.md')) into.push(full)
  }
  return into
}

/** `path — which fields are missing`, ready to read straight out of a failing diff. */
function documentsMissingMetadata(): string[] {
  const gaps: string[] = []
  for (const file of markdownFiles(DOCS)) {
    const path = relative(ROOT, file).split('\\').join('/')
    if (path in EXCLUDED) continue
    const fm = parseDocFrontmatter(readFileSync(file, 'utf8'))
    const missing = (['title', 'description', 'kind'] as const).filter((field) => !fm[field])
    if (missing.length) gaps.push(`${path} — missing ${missing.join(', ')}`)
  }
  return gaps.sort()
}

describe('Documents/ frontmatter', () => {
  it('gives every document a title, a description, and a kind', () => {
    expect(
      documentsMissingMetadata(),
      'A document landed without the metadata the Library reads. Add a `title`, a one-sentence ' +
        '`description` saying what the document is FOR (never a restatement of the title), and one of ' +
        'the six kinds: plan, decision, research, guide, reference, note. See ' +
        'Documents/architecture/document-workspace.md.',
    ).toEqual([])
  })

  it('keeps its exclusion list pointing at files that still exist', () => {
    // A renamed or deleted exclusion must not quietly rot: without this, the entry survives its file
    // and the path that replaced it is unguarded by an exemption nobody reads any more.
    const missing = Object.keys(EXCLUDED).filter((path) => {
      try {
        statSync(join(ROOT, path))
        return false
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })

  it('actually catches a document that skipped the convention (the tripwire has teeth)', () => {
    // Guards the reader, not the corpus: if `parseDocFrontmatter` ever started returning a value for
    // an absent field, the scan above would pass on an empty library and say nothing.
    const bare = parseDocFrontmatter('# Launch plan\n\nSome writing.\n')
    expect([bare.title, bare.description, bare.kind]).toEqual([undefined, undefined, undefined])

    const partial = parseDocFrontmatter('---\ntitle: Launch plan\n---\n\nSome writing.\n')
    expect(partial.title).toBe('Launch plan')
    expect([partial.description, partial.kind]).toEqual([undefined, undefined])

    // An unrecognized kind is not a kind. It degrades to absent rather than failing the file, which is
    // right for the listing and must still read as a gap here.
    const typo = parseDocFrontmatter('---\ntitle: T\ndescription: D\nkind: memo\n---\n')
    expect(typo.kind).toBeUndefined()
  })

  it('finds the corpus it claims to scan', () => {
    // A wrong ROOT (a moved test file, a changed build layout) would make an empty scan look like a
    // clean one. The floor is deliberately low; it only has to prove the walk found something.
    expect(markdownFiles(DOCS).length).toBeGreaterThan(20)
  })
})
