import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptLegacyDocStars,
  createDocument,
  createInteractiveDocument,
  INTERACTIVE_SOURCE_MARKER,
  readDocShelf,
  readDocShelfForRecovery,
  rebaseDocStars,
  reconcileDocShelfAfterRestore,
  setDocStar,
  starDocument,
} from './doc-commands'
import { parseDocFrontmatter } from './doc-frontmatter'
import { htmlPlainText, parseHtmlDocumentMetadata } from './html-document'

/**
 * The shelf is the first durable document state Koda moved out of the renderer, and the two failures
 * that move is answering are both here: a star used to be addressed by where the project folder was
 * (so moving it lost every one), and the repair after a rename depended on a live window noticing.
 * These run the command directly against a real project directory, which is the level main owns.
 */

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'koda-shelf-')))
  mkdirSync(join(root, 'Documents', 'plans'), { recursive: true })
  writeFileSync(join(root, 'Documents', 'brief.md'), '# Brief\n')
  writeFileSync(join(root, 'Documents', 'plans', 'launch.md'), '# Launch\n')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const shelfFile = (): string => join(root, '.koda', 'doc-shelf.json')

describe('the shelf lives in the project, not beside it', () => {
  it('round-trips a star through the project file', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })

    expect(JSON.parse(readFileSync(shelfFile(), 'utf8'))).toEqual({
      version: 1,
      starred: ['Documents/brief.md'],
      settled: ['Documents/brief.md'],
    })
    expect((await readDocShelf(root)).starred).toEqual(['Documents/brief.md'])
  })

  it('keeps the user’s order, and re-stars at the end like the surface does', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    await setDocStar(root, { path: 'Documents/plans/launch.md', starred: true })
    await setDocStar(root, { path: 'Documents/brief.md', starred: false })
    const shelf = await setDocStar(root, { path: 'Documents/brief.md', starred: true })

    expect(shelf.starred).toEqual(['Documents/plans/launch.md', 'Documents/brief.md'])
  })

  it('accepts an absolute path inside the project and stores it relative', async () => {
    // Relative storage is what survives the project being moved — an absolute path would not.
    const shelf = await setDocStar(root, { path: join(root, 'Documents', 'brief.md'), starred: true })

    expect(shelf.starred).toEqual(['Documents/brief.md'])
  })

  it('reads fail-open when the shelf file is corrupt', async () => {
    mkdirSync(join(root, '.koda'), { recursive: true })
    writeFileSync(shelfFile(), '{ not json')

    expect(await readDocShelf(root)).toEqual({ version: 1, starred: [], settled: [] })
  })

  /**
   * The display read above and the read half of a write are different questions, and answering both
   * with "empty" is how a shelf dies: merge one star into an empty guess, write it, and the file that
   * could not be read a moment ago is now genuinely a single-entry shelf. One unreadable moment must
   * not become a permanent deletion, so a write refuses rather than guesses.
   */
  it('refuses to write over a shelf it could not read', async () => {
    mkdirSync(join(root, '.koda'), { recursive: true })
    writeFileSync(shelfFile(), '{ half-written')

    await expect(setDocStar(root, { path: 'Documents/brief.md', starred: true })).rejects.toThrow(
      /shelf/,
    )
    expect(readFileSync(shelfFile(), 'utf8')).toBe('{ half-written')
  })

  it('still treats a genuinely absent shelf as an empty one', async () => {
    // The distinction that makes the refusal above safe: nothing there is a fact, not a failure.
    expect((await setDocStar(root, { path: 'Documents/brief.md', starred: true })).starred).toEqual([
      'Documents/brief.md',
    ])
  })

  it('serializes concurrent writers instead of letting one overwrite the other', async () => {
    await Promise.all([
      setDocStar(root, { path: 'Documents/brief.md', starred: true }),
      setDocStar(root, { path: 'Documents/plans/launch.md', starred: true }),
    ])

    expect((await readDocShelf(root)).starred).toHaveLength(2)
  })
})

describe('what may go on the shelf', () => {
  it('refuses a path outside the project', async () => {
    await expect(setDocStar(root, { path: '../escape.md', starred: true })).rejects.toThrow(/no document/)
  })

  it('refuses a symlink that leaves the project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'koda-outside-')))
    writeFileSync(join(outside, 'secret.md'), '# Secret\n')
    symlinkSync(join(outside, 'secret.md'), join(root, 'Documents', 'link.md'))
    try {
      await expect(setDocStar(root, { path: 'Documents/link.md', starred: true })).rejects.toThrow(
        /no document/,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a folder and a path with no file behind it', async () => {
    await expect(setDocStar(root, { path: 'Documents/plans', starred: true })).rejects.toThrow(/folder/)
    await expect(setDocStar(root, { path: 'Documents/ghost.md', starred: true })).rejects.toThrow(
      /no document/,
    )
  })

  it('still unstars a document that is already gone', async () => {
    // The shortcuts most worth removing are the ones whose file no longer exists; requiring the file
    // here would strand a row the user can see and cannot clear.
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    rmSync(join(root, 'Documents', 'brief.md'))

    expect((await setDocStar(root, { path: 'Documents/brief.md', starred: false })).starred).toEqual([])
  })

  it('answers the agent in its own terms', async () => {
    expect(await starDocument(root, { path: 'Documents/brief.md', starred: true })).toEqual({
      path: 'Documents/brief.md',
      starred: true,
    })
  })
})

describe('a Koda rename or delete carries the shelf with it', () => {
  it('follows a renamed document and a moved folder’s descendants', async () => {
    await setDocStar(root, { path: 'Documents/plans/launch.md', starred: true })

    const shelf = await rebaseDocStars(root, join(root, 'Documents', 'plans'), join(root, 'Documents', 'shipping'))

    expect(shelf.starred).toEqual(['Documents/shipping/launch.md'])
    // Both spellings are settled, so a legacy source read later cannot reintroduce the old path.
    expect(shelf.settled).toEqual(['Documents/plans/launch.md', 'Documents/shipping/launch.md'])
  })

  it('drops a deleted document and everything under a deleted folder', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    await setDocStar(root, { path: 'Documents/plans/launch.md', starred: true })

    await rebaseDocStars(root, join(root, 'Documents', 'plans'), null)

    expect((await readDocShelf(root)).starred).toEqual(['Documents/brief.md'])
  })

  it('leaves the shelf alone when the change touched nothing starred', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })

    const shelf = await rebaseDocStars(root, join(root, 'Documents', 'other.md'), null)

    expect(shelf.starred).toEqual(['Documents/brief.md'])
    expect(shelf.settled).toEqual(['Documents/brief.md'])
  })
})

/**
 * Recovery moves the shelf because the shelf is checkpointed content, and that is wanted — a restored
 * document should arrive with its shortcut. The dangerous half is the silent one: a checkpoint taken
 * before the shelf existed carries no shelf at all, so the restore deletes the file. Reading that as
 * "the user had no stars" and publishing it as truth wipes the shelf on any rewind into last week.
 */
describe('recovery rewinds the shelf without inventing an empty one', () => {
  it('carries the shelf across a restore whose target never had one', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    const before = await readDocShelfForRecovery(root)

    rmSync(shelfFile()) // what restore does when the target predates the shelf
    await reconcileDocShelfAfterRestore(root, before)

    expect((await readDocShelf(root)).starred).toEqual(['Documents/brief.md'])
  })

  it('leaves a restored shelf exactly as the checkpoint wrote it', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    const before = await readDocShelfForRecovery(root)

    // A target that DOES carry a shelf speaks for itself, including an older, deliberately smaller one.
    writeFileSync(shelfFile(), JSON.stringify({ version: 1, starred: ['Documents/plans/launch.md'], settled: [] }))
    await reconcileDocShelfAfterRestore(root, before)

    expect((await readDocShelf(root)).starred).toEqual(['Documents/plans/launch.md'])
  })

  it('accepts a restored shelf that is deliberately empty', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    const before = await readDocShelfForRecovery(root)

    writeFileSync(shelfFile(), JSON.stringify({ version: 1, starred: [], settled: ['Documents/brief.md'] }))
    await reconcileDocShelfAfterRestore(root, before)

    // An empty shelf that is present is a real answer — the user had unstarred everything by then.
    expect((await readDocShelf(root)).starred).toEqual([])
  })

  it('invents nothing when the shelf could not be read before the restore', async () => {
    mkdirSync(join(root, '.koda'), { recursive: true })
    writeFileSync(shelfFile(), '{ unreadable')
    const before = await readDocShelfForRecovery(root)
    expect(before).toBeNull()

    rmSync(shelfFile())
    await reconcileDocShelfAfterRestore(root, before)

    expect(existsSync(shelfFile())).toBe(false)
  })

  it('does not overwrite a star made between the restore and the repair', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    const before = await readDocShelfForRecovery(root)

    rmSync(shelfFile())
    await setDocStar(root, { path: 'Documents/plans/launch.md', starred: true })
    await reconcileDocShelfAfterRestore(root, before)

    expect((await readDocShelf(root)).starred).toEqual(['Documents/plans/launch.md'])
  })
})

describe('adopting the star sources that predate the shelf', () => {
  it('adopts what the ledger allows and answers with the durable shelf', async () => {
    const shelf = await adoptLegacyDocStars(root, {
      starred: ['Documents/brief.md', 'Documents/plans/launch.md'],
      settled: ['Documents/brief.md'],
    })

    expect(shelf.starred).toEqual(['Documents/brief.md', 'Documents/plans/launch.md'])
    // The caller's ledger is inherited whole — it is the tombstone that outlives the legacy copy.
    expect(shelf.settled).toEqual(['Documents/brief.md', 'Documents/plans/launch.md'])
    expect(existsSync(shelfFile())).toBe(true)
  })

  it('refuses to re-adopt a path this project already decided about', async () => {
    await setDocStar(root, { path: 'Documents/brief.md', starred: true })
    await setDocStar(root, { path: 'Documents/brief.md', starred: false })

    // A stale legacy copy — an archive that only became readable now, or a blob whose deletion failed.
    const shelf = await adoptLegacyDocStars(root, { starred: ['Documents/brief.md'], settled: [] })

    expect(shelf.starred).toEqual([])
  })

  it('is idempotent, so a migration that runs every launch adds nothing twice', async () => {
    const legacy = { starred: ['Documents/brief.md'], settled: [] }
    await adoptLegacyDocStars(root, legacy)
    const shelf = await adoptLegacyDocStars(root, legacy)

    expect(shelf.starred).toEqual(['Documents/brief.md'])
  })

  it('ignores a legacy path that points outside the project', async () => {
    const shelf = await adoptLegacyDocStars(root, {
      starred: ['../elsewhere.md', 'Documents/brief.md'],
      settled: [],
    })

    expect(shelf.starred).toEqual(['Documents/brief.md'])
  })
})

const read = (rel: string): string => readFileSync(join(root, ...rel.split('/')), 'utf8')

/**
 * The ledger's oldest gap, closed: until this command, a document the agent made was born by raw
 * `Write` — no title block, no kind, no provenance — while every document the Library's own button
 * made carried all three. One command with two formats is what keeps them equal, and the assertions
 * below are deliberately symmetric across the formats for that reason: whatever markdown gets in its
 * frontmatter, HTML has to get in its `koda:` meta tags, read back by Koda's own reader rather than by
 * a regex written for the test.
 */
describe('creating a document in the format the ask needs', () => {
  it('births a markdown document through the existing frontmatter path', async () => {
    const created = await createDocument(
      root,
      {
        format: 'markdown',
        title: 'Branch management notes',
        kind: 'decision',
        description: 'What we settled about branch names.',
        body: '# Branches\n\nOne branch per piece of work.',
      },
      'session-9',
    )

    expect(created).toEqual({
      created: true,
      path: 'Documents/Branch management notes.md',
      title: 'Branch management notes',
      format: 'markdown',
      kind: 'decision',
    })
    expect(parseDocFrontmatter(read(created.path))).toEqual({
      title: 'Branch management notes',
      description: 'What we settled about branch names.',
      kind: 'decision',
      source: 'session-9',
    })
    expect(read(created.path)).toContain('One branch per piece of work.')
  })

  it('births an HTML document carrying the same four facts as koda: meta tags', async () => {
    const created = await createDocument(
      root,
      {
        format: 'html',
        title: 'Frost date explorer',
        kind: 'research',
        description: 'Which planting window survives a late freeze.',
        body: '<p>Two sliders and a table.</p>',
      },
      'session-9',
    )

    expect(created).toEqual({
      created: true,
      path: 'Documents/Frost date explorer.html',
      title: 'Frost date explorer',
      format: 'html',
      kind: 'research',
    })
    const html = read(created.path)
    const fm = parseHtmlDocumentMetadata(html)
    expect(fm.title).toBe('Frost date explorer')
    expect(fm.description).toBe('Which planting window survives a late freeze.')
    expect(fm.kind).toBe('research')
    expect(fm.source).toBe('session-9')
    expect(fm.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(htmlPlainText(html, 600)).toContain('Two sliders and a table.')
  })

  it('files into a topic folder, creating it, and takes that folder’s kind when none is authored', async () => {
    const created = await createDocument(root, {
      format: 'html',
      title: 'Route comparison',
      folder: 'documents/decisions',
    })

    // The home segment is rewritten to Koda's spelling, so a case-sensitive volume cannot end up with
    // two sibling homes — the same defense keep_document relies on, now shared rather than copied.
    expect(created.path).toBe('Documents/decisions/Route comparison.html')
    expect(created.kind).toBe('decision')
  })

  it('dedupes rather than clobbering, and reports the name it actually got', async () => {
    await createDocument(root, { format: 'html', title: 'Report' })
    const second = await createDocument(root, { format: 'html', title: 'Report' })

    expect(second.path).toBe('Documents/Report 2.html')
    expect(second.title).toBe('Report 2')
    // The page's own <title> follows the deduped name, so the Library never shows two identical rows.
    expect(parseHtmlDocumentMetadata(read(second.path)).title).toBe('Report 2')
  })

  it('refuses a format Koda cannot author, and a folder that escapes Documents/', async () => {
    await expect(createDocument(root, { format: 'docx', title: 'X' })).rejects.toThrow(/format is required/)
    await expect(createDocument(root, { format: 'markdown', title: '  ' })).rejects.toThrow(/title is required/)
    await expect(createDocument(root, { format: 'html', title: 'X', kind: 'memo' })).rejects.toThrow(/kind must be/)
    await expect(
      createDocument(root, { format: 'html', title: 'X', folder: '../outside' }),
    ).rejects.toThrow(/inside Documents/)
    expect(existsSync(join(root, 'Documents', 'X.html'))).toBe(false)
  })
})

/**
 * The Slice 2 seam, built with Slice 1 so the Stage action and the agent's tool call are one command
 * from the first day. Its sharpest edge is what it does NOT do: touching the source document here
 * would make one call two writes with one failure mode — a link left pointing at a file that was never
 * created — so the link belongs to whoever asked.
 */
describe('turning a passage into an interactive view', () => {
  it('files the view beside its source and reports a project-relative path', async () => {
    const result = await createInteractiveDocument(root, {
      sourcePath: 'Documents/plans/launch.md',
      selection: '| Route | Days |\n| --- | --- |\n| Air | 2 |',
      title: 'Route comparison',
    })

    expect(result).toEqual({ ok: true, htmlPath: 'Documents/plans/Route comparison.html' })
  })

  it('carries the selection as seed content under a comment naming the source', async () => {
    const result = await createInteractiveDocument(root, {
      sourcePath: 'Documents/plans/launch.md',
      selection: 'Air freight beats sea by 12 days.',
      title: 'Route comparison',
    })
    if (!result.ok) throw new Error(result.reason)
    const html = read(result.htmlPath)

    expect(html).toContain(`<!-- ${INTERACTIVE_SOURCE_MARKER} Documents/plans/launch.md -->`)
    expect(htmlPlainText(html, 600)).toContain('Air freight beats sea by 12 days.')
    expect(parseHtmlDocumentMetadata(html).title).toBe('Route comparison')
  })

  it('leaves the source document byte-for-byte alone', async () => {
    const before = read('Documents/plans/launch.md')

    await createInteractiveDocument(root, {
      sourcePath: 'Documents/plans/launch.md',
      selection: 'A passage.',
      title: 'View',
    })

    expect(read('Documents/plans/launch.md')).toBe(before)
  })

  it('escapes the selection instead of executing it', async () => {
    const result = await createInteractiveDocument(root, {
      sourcePath: 'Documents/brief.md',
      selection: '<script>alert(1)</script>',
      title: 'Escaped',
    })
    if (!result.ok) throw new Error(result.reason)

    // The selection is a passage of the user's markdown, not markup. Embedding it raw would make any
    // document that quotes a code sample into a script the sandbox then has to defend against.
    expect(read(result.htmlPath)).not.toMatch(/<script\b/i)
  })

  it('falls back to the Documents/ home when the source lives outside it', async () => {
    writeFileSync(join(root, 'README.md'), '# Readme\n')

    const result = await createInteractiveDocument(root, {
      sourcePath: 'README.md',
      selection: 'A passage.',
      title: 'From the readme',
    })

    // An artifact filed beside a source outside `Documents/` would not be admitted to the Library at
    // all — a document nothing can find is worse than one filed a folder away from its source.
    expect(result).toEqual({ ok: true, htmlPath: 'Documents/From the readme.html' })
  })

  it('answers a refusal as a result rather than throwing', async () => {
    expect(
      await createInteractiveDocument(root, { sourcePath: 'Documents/ghost.md', selection: 'x', title: 'T' }),
    ).toEqual({ ok: false, reason: expect.stringContaining('no document at') })
    expect(
      await createInteractiveDocument(root, { sourcePath: 'Documents/plans', selection: 'x', title: 'T' }),
    ).toEqual({ ok: false, reason: expect.stringContaining('folder') })
    expect(
      await createInteractiveDocument(root, { sourcePath: 'Documents/brief.md', selection: '  ', title: 'T' }),
    ).toEqual({ ok: false, reason: expect.stringContaining('selection is required') })
    expect(
      await createInteractiveDocument(root, { sourcePath: '../escape.md', selection: 'x', title: 'T' }),
    ).toEqual({ ok: false, reason: expect.stringContaining('no document at') })
  })
})
