import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Retention would otherwise read the real settings file out of userData; pin it to "keep forever" so an
// archived conversation planted in a test is never purged out from under the assertion.
vi.mock('./settings', () => ({ loadArchiveRetentionDays: () => 0 }))

import { invalidateDocsCache } from './fs-browse'
import { deleteArchivedBody, saveArchivedMeta, writeArchivedBody } from './session-store'
import { searchLibrary, splitTerms } from './library-search'

/**
 * The retrieval seam, exercised the way the feature is: a needle planted in a DOCUMENT and the same
 * needle planted in a CONVERSATION, live and archived.
 *
 * The conversation half is the point. Asking across documents is what Notion Q&A has done since 2023;
 * asking across the sessions is the half nobody else can copy, and it is also the half most likely to
 * quietly stop working, because those transcripts live in three different places in userData and none
 * of them is in the project the user is looking at.
 */

let root: string

/** Write a project file, creating its parents. `rel` is POSIX-relative to the temp project root. */
function file(rel: string, text: string): void {
  const full = join(root, ...rel.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

/** The hot store's filename is a hash of the project path (session-store.ts) — reconstruct it so a
 *  test can plant live sessions exactly where the reader looks for them. */
function plantHotSessions(sessions: unknown[]): void {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
  writeFileSync(
    join(tmpdir(), `koda-sessions-${hash}.json`),
    JSON.stringify({ version: 3, activeId: null, projectPath: root, sessions }),
  )
}

/** One live session row, with the renderer's opaque transcript items inline. */
function liveSession(id: string, label: string, items: unknown[]): unknown {
  return { id, label, cwd: root, lastActivityAt: Date.now(), items }
}

/** Archive a conversation the way the product does: body to its own file, metadata to the index. */
function plantArchive(id: string, label: string, items: unknown[]): void {
  writeArchivedBody(root, id, items)
  saveArchivedMeta(root, [{ id, label, cwd: root, archivedAt: Date.now() }])
}

const said = (text: string): unknown => ({ kind: 'user', text })
const replied = (markdown: string): unknown => ({ kind: 'assistant', markdown })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'koda-libsearch-')))
})
afterEach(() => {
  invalidateDocsCache(root)
  rmSync(root, { recursive: true, force: true })
})

describe('splitTerms', () => {
  it('reduces a question to its content words', () => {
    expect(splitTerms('What did we decide about phone tiers?')).toEqual(
      expect.arrayContaining(['decide', 'phone', 'tiers']),
    )
    expect(splitTerms('What did we decide about phone tiers?')).not.toContain('about')
    expect(splitTerms('What did we decide about phone tiers?')).not.toContain('what')
  })

  it('answers nothing for a question with no content words', () => {
    expect(splitTerms('what is it about?')).toEqual([])
  })

  it("keeps this audience's real two-letter terms", () => {
    // "what did we decide about the ui" must not degrade into a search for "decide".
    expect(splitTerms('what did we decide about the ui')).toEqual(expect.arrayContaining(['decide', 'ui']))
  })
})

describe('searchLibrary across both corpora', () => {
  const NEEDLE = 'zkodaneedle'

  it('finds a needle planted in a document', async () => {
    file('Documents/decisions/tiers.md', `---\ntitle: Phone tier ladder\nkind: decision\n---\n\nWe settled on ${NEEDLE} for the middle tier.\n`)
    const { refs } = await searchLibrary(root, `what did we decide about ${NEEDLE}`)
    const doc = refs.find((r) => r.kind === 'document')
    expect(doc).toBeDefined()
    expect(doc?.label).toBe('Phone tier ladder')
    expect(doc?.rel).toBe('Documents/decisions/tiers.md')
    expect(doc?.path).toBe(join(root, 'Documents', 'decisions', 'tiers.md'))
    // A citation needs somewhere to land in the file and something to quote.
    expect(doc?.passages[0]?.line).toBeGreaterThan(0)
    expect(doc?.passages[0]?.text).toContain(NEEDLE)
  })

  it('finds a needle planted in a LIVE conversation — the half no document tool has', async () => {
    plantHotSessions([liveSession('sess-live', 'Pricing ladder', [said(`so what about ${NEEDLE}`), replied('We settled it.')])])
    const { refs } = await searchLibrary(root, `what did we decide about ${NEEDLE}`)
    const session = refs.find((r) => r.kind === 'session')
    expect(session).toBeDefined()
    expect(session?.sessionId).toBe('sess-live')
    expect(session?.label).toBe('Pricing ladder')
    expect(session?.archived).toBe(false)
    expect(session?.passages[0]?.text).toContain(NEEDLE)
  })

  it('finds a needle planted in an ARCHIVED conversation', async () => {
    // Archived is the normal resting state of finished work, so a search that only reads the hot store
    // answers "we never discussed it" about most of what there is to find.
    plantArchive('sess-cold', 'Old pricing thread', [said(`we agreed on ${NEEDLE}`)])
    const { refs } = await searchLibrary(root, `what did we agree about ${NEEDLE}`)
    const session = refs.find((r) => r.kind === 'session')
    expect(session?.sessionId).toBe('sess-cold')
    expect(session?.archived).toBe(true)
  })

  it('returns both corpora for one question, and narrows on scope', async () => {
    file('Documents/notes.md', `A note about ${NEEDLE}.\n`)
    plantHotSessions([liveSession('sess-live', 'Live thread', [said(`about ${NEEDLE}`)])])

    const all = await searchLibrary(root, NEEDLE)
    expect(all.refs.map((r) => r.kind).sort()).toEqual(['document', 'session'])

    const docsOnly = await searchLibrary(root, NEEDLE, { scope: 'documents' })
    expect(docsOnly.refs.every((r) => r.kind === 'document')).toBe(true)
    expect(docsOnly.refs).toHaveLength(1)

    const sessionsOnly = await searchLibrary(root, NEEDLE, { scope: 'sessions' })
    expect(sessionsOnly.refs.every((r) => r.kind === 'session')).toBe(true)
    expect(sessionsOnly.refs).toHaveLength(1)
  })

  it('inherits the documents list exclusions rather than forking them', async () => {
    // The trap document-workspace.md names by name: the doc walk and the search walk use different
    // exclusion sets, and a Library built on the search walk surfaces agent operating context.
    file('CLAUDE.md', `Repository guidance mentioning ${NEEDLE}.\n`)
    file('node_modules/dep/README.md', `A dependency readme mentioning ${NEEDLE}.\n`)
    file('Documents/real.md', `The user's own writing about ${NEEDLE}.\n`)
    const { refs } = await searchLibrary(root, NEEDLE)
    expect(refs.filter((r) => r.kind === 'document').map((r) => r.rel)).toEqual(['Documents/real.md'])
  })

  it('reads conversation prose and not tool output', async () => {
    // Deliberate: a tool card's content is file bodies and command output — the weakest evidence for
    // "what did we decide", the bulk of the bytes, and the text most likely to have been written by
    // something other than the user.
    plantHotSessions([
      liveSession('sess-tool', 'Tool noise', [
        said('run the tests'),
        { kind: 'tool', toolUseId: 't1', name: 'Bash', input: {}, result: `output containing ${NEEDLE}` },
      ]),
    ])
    const { refs } = await searchLibrary(root, NEEDLE)
    expect(refs).toHaveLength(0)
  })

  it('ranks a source that answers more of the question above one that repeats a single word', async () => {
    file('Documents/broad.md', 'We decided the phone tiers ladder together.\n')
    file('Documents/narrow.md', 'phone phone phone phone phone phone\n')
    const { refs } = await searchLibrary(root, 'what did we decide about phone tiers')
    expect(refs[0]?.rel).toBe('Documents/broad.md')
    expect(refs[0]?.termsMatched).toBeGreaterThan(refs[1]?.termsMatched ?? 0)
  })

  it('gives every ref a distinct citable id', async () => {
    file('Documents/one.md', `${NEEDLE}\n`)
    file('Documents/two.md', `${NEEDLE}\n`)
    plantHotSessions([liveSession('sess-a', 'A', [said(NEEDLE)]), liveSession('sess-b', 'B', [said(NEEDLE)])])
    const { refs } = await searchLibrary(root, NEEDLE)
    expect(new Set(refs.map((r) => r.id)).size).toBe(refs.length)
    expect(refs.map((r) => r.id).sort()).toEqual(['d1', 'd2', 's1', 's2'])
  })

  it('finds nothing when nothing matches, and says so with an empty list', async () => {
    file('Documents/notes.md', 'Nothing relevant here.\n')
    const { refs, truncated } = await searchLibrary(root, 'quantum ferret harmonics')
    expect(refs).toEqual([])
    expect(truncated).toBe(false)
  })

  it('survives a corrupt row in the hot store rather than failing the whole search', async () => {
    // `listHotSessions` is the lean read, so these rows never went through Zod. One drifted row must
    // cost this walk one conversation, not the answer.
    plantHotSessions([
      { id: 42, label: null, items: 'not an array' },
      null,
      { id: 'sess-ok', label: 'Good thread', cwd: root, items: [said(NEEDLE)] },
    ])
    const { refs, truncated } = await searchLibrary(root, NEEDLE)
    expect(refs.map((r) => r.sessionId)).toEqual(['sess-ok'])
    expect(truncated).toBe(true)
  })

  it('does not reinterpret a present unknown engine as a legacy Claude transcript', async () => {
    plantHotSessions([{ id: 'future-engine', label: 'Future thread', cwd: root, engineId: 'future', items: [] }])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([])
    expect(truncated).toBe(true)
  })

  it('survives a project with no session store at all', async () => {
    file('Documents/notes.md', `Only a document holds ${NEEDLE}.\n`)
    const { refs } = await searchLibrary(root, NEEDLE)
    expect(refs).toHaveLength(1)
  })

  it('marks the result partial when the acknowledged hot-session snapshot is not current', async () => {
    plantHotSessions([liveSession('sess-a', 'A', [said(NEEDLE)])])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, {
      scope: 'sessions',
      hotSessionsComplete: false,
    })

    expect(refs.map((ref) => ref.sessionId)).toEqual(['sess-a'])
    expect(truncated).toBe(true)
  })

  it('marks an unreadable archived body as partial instead of calling the corpus complete', async () => {
    plantArchive('sess-cold', 'Missing body', [said(NEEDLE)])
    deleteArchivedBody(root, 'sess-cold')

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([])
    expect(truncated).toBe(true)
  })

  it('marks a dropped malformed archive row as partial', async () => {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
    writeFileSync(
      join(tmpdir(), `koda-archive-${hash}.json`),
      JSON.stringify({ version: 2, archived: [{ id: 42, label: null }] }),
    )

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([])
    expect(truncated).toBe(true)
  })

  it('marks every match-hiding conversation cap as partial', async () => {
    const oldTurns = [said(NEEDLE), ...Array.from({ length: 1_200 }, (_, i) => said(`recent ${i}`))]
    const longTurn = said('x'.repeat(4_100) + NEEDLE)
    plantHotSessions([
      liveSession('too-many', 'Long thread', oldTurns),
      liveSession('too-long', 'Long paste', [longTurn]),
    ])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([])
    expect(truncated).toBe(true)
  })

  it('bounds the number of hot conversations inspected', async () => {
    plantHotSessions([
      ...Array.from({ length: 120 }, (_, i) => liveSession(`recent-${i}`, `Recent ${i}`, [said('noise')])),
      liveSession('past-cap', 'Past cap', [said(NEEDLE)]),
    ])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([])
    expect(truncated).toBe(true)
  })

  it('lets a readable archive outrank its stale hot twin', async () => {
    plantHotSessions([liveSession('overlap', 'Stale hot copy', [said(NEEDLE)])])
    plantArchive('overlap', 'Cold overlap', [said(NEEDLE)])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs.map((ref) => ref.sessionId)).toEqual(['overlap'])
    expect(refs[0]).toMatchObject({ label: 'Cold overlap', archived: true })
    expect(truncated).toBe(false)
  })

  it('keeps the hot transcript searchable when archive metadata has no body', async () => {
    plantHotSessions([liveSession('overlap', 'Only readable copy', [said(NEEDLE)])])
    saveArchivedMeta(root, [
      { id: 'overlap', label: 'Broken archive', cwd: root, archivedAt: Date.now() },
    ])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([expect.objectContaining({ label: 'Only readable copy', archived: false })])
    expect(truncated).toBe(true)
  })

  it('skips an oversized archived transcript before parsing it', async () => {
    plantArchive('huge', 'Huge archive', [said(`${'x'.repeat(2_100_000)}${NEEDLE}`)])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([])
    expect(truncated).toBe(true)
  })

  it('keeps the hot fallback when its archived twin exceeds the bounded search reader', async () => {
    plantHotSessions([liveSession('overlap', 'Readable hot fallback', [said(NEEDLE)])])
    plantArchive('overlap', 'Oversized archive', [said(`${'x'.repeat(2_100_000)}${NEEDLE}`)])

    const { refs, truncated } = await searchLibrary(root, NEEDLE, { scope: 'sessions' })

    expect(refs).toEqual([
      expect.objectContaining({
        sessionId: 'overlap',
        label: 'Readable hot fallback',
        archived: false,
      }),
    ])
    expect(truncated).toBe(true)
  })

  it('marks omitted terms and omitted ranked sources as partial', async () => {
    for (let i = 0; i < 13; i++) file(`Documents/${i}.md`, 'alpha beta gamma delta epsilon zeta eta\n')

    const result = await searchLibrary(root, 'alpha beta gamma delta epsilon zeta eta', {
      scope: 'documents',
    })

    expect(result.refs).toHaveLength(12)
    expect(result.truncated).toBe(true)
  })
})

/**
 * Admission and retrieval are one question, answered once. `searchLibrary` reaches the documents
 * corpus only through `queryLibrary`, which walks the same list the Library shows — so a format the
 * Library admits is a format an ask can cite, with no second walk to keep in agreement. These pin that
 * the new format arrived through that seam rather than beside it.
 */
describe('an admitted HTML artifact is citable', () => {
  it('returns a deliberate artifact as a document ref, labelled by its own <title>', async () => {
    file(
      'Documents/frost.html',
      '<html><head><title>Frost date explorer</title></head><body><p>The last freeze usually lands in April.</p></body></html>',
    )

    const { refs } = await searchLibrary(root, 'freeze April', { scope: 'documents' })

    expect(refs).toEqual([
      expect.objectContaining({ kind: 'document', rel: 'Documents/frost.html', label: 'Frost date explorer' }),
    ])
  })

  it('leaves an .html outside Documents/ out of the corpus entirely', async () => {
    file(
      'dist/frost.html',
      '<html><head><title>Built</title></head><body><p>The last freeze lands in April.</p></body></html>',
    )

    expect((await searchLibrary(root, 'freeze April', { scope: 'documents' })).refs).toEqual([])
  })
})
