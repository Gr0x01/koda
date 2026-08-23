import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createProjectFile,
  deleteProjectDocument,
  docExcerpt,
  invalidateDocsCache,
  listProjectDocs,
  queryLibrary,
  readProjectFile,
  readProjectImage,
  prepareProjectDocumentDelete,
  resolveProjectDocs,
  searchProject,
  writeProjectFile,
} from './fs-browse'
import { parseDocFrontmatter } from './doc-frontmatter'
import { readContainedRegularFile, readWholeContainedRegularFile } from './contained-read'

let root: string

/** Write a file, creating its parents. Paths are POSIX-relative to the temp project root. */
function file(rel: string, text: string): void {
  const full = join(root, ...rel.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'koda-library-')))
})
afterEach(() => {
  invalidateDocsCache(root)
  rmSync(root, { recursive: true, force: true })
})

/**
 * The Library's one correctness claim, and the trap the design doc calls out by name: the documents
 * walk and the search walk use DIFFERENT exclusion sets, so a Library built on `fs:search` surfaces
 * `CLAUDE.md`, vendored skill files and dependency READMEs that the Documents pane correctly hides.
 * Every file below contains the same needle, so anything missing from the result is missing because a
 * rule excluded it, not because it failed to match.
 */
describe('queryLibrary exclusions', () => {
  const NEEDLE = 'zkodaneedle'
  beforeEach(() => {
    // The user's own writing — the only rows that may come back.
    file('Documents/plans/launch.md', `---\ntitle: Launch plan\nkind: plan\n---\n\nShip it, ${NEEDLE}.\n`)
    file('Documents/site/audience.md', `# Audience\n\n${NEEDLE}\n`)
    file('README.md', `# Readme\n\n${NEEDLE}\n`)
    // Agent operating context, by NAME — the exclusion an excluded-dir rule cannot catch.
    file('CLAUDE.md', `Repository guidance. ${NEEDLE}\n`)
    file('AGENTS.md', `Agent guidance. ${NEEDLE}\n`)
    file('Documents/plans/AGENTS.md', `Nested agent guidance. ${NEEDLE}\n`)
    // Vendored legal boilerplate.
    file('LICENSE.md', `MIT, ${NEEDLE}\n`)
    file('resources/fonts/Inter-OFL.txt', `Open Font License ${NEEDLE}\n`)
    // Dependency + build trees.
    file('node_modules/left-pad/README.md', `# left-pad ${NEEDLE}\n`)
    file('dist/notes.md', `built ${NEEDLE}\n`)
    file('.koda/memory/active-context.md', `project knowledge ${NEEDLE}\n`)
    file('.claude/rules/style.md', `rule ${NEEDLE}\n`)
    file('memory-bank/history.md', `memory ${NEEDLE}\n`)
    // A skill bundle: the SKILL.md marker prunes the whole directory, siblings included.
    file('resources/pack/skills/documents/SKILL.md', `name: documents\n${NEEDLE}\n`)
    file('resources/pack/skills/documents/reference.md', `skill reference ${NEEDLE}\n`)
    // A plugin root: the `.claude-plugin/` marker prunes it the same way.
    file('resources/pack/.claude-plugin/plugin.json', '{}')
    file('resources/pack/rules.md', `plugin rule ${NEEDLE}\n`)
  })

  it('returns the user documents and nothing the Documents pane hides', async () => {
    const { docs } = await queryLibrary(root, { query: NEEDLE })
    expect(docs.map((d) => d.rel).sort()).toEqual(['Documents/plans/launch.md', 'Documents/site/audience.md', 'README.md'])
  })

  it('excludes the same set with no query, so the unfiltered library matches the docs list', async () => {
    const { docs } = await queryLibrary(root, {})
    const listed = await listProjectDocs(root)
    expect(docs.map((d) => d.rel).sort()).toEqual(listed.map((d) => d.rel).sort())
    expect(docs.some((d) => d.name === 'CLAUDE.md')).toBe(false)
  })

  it('drops a document that matches nothing', async () => {
    const { docs } = await queryLibrary(root, { query: 'nothingmatchesthis' })
    expect(docs).toEqual([])
  })

  it('finds a document by its authored title when the filename says nothing', async () => {
    file('Documents/notes-3.md', '---\ntitle: Phone tiers\nkind: decision\n---\n\nSettled.\n')
    invalidateDocsCache(root)
    const { docs } = await queryLibrary(root, { query: 'phone tiers' })
    expect(docs.map((d) => d.rel)).toContain('Documents/notes-3.md')
    expect(docs[0].nameMatch).toBe(true)
  })
})

describe('cached document paths stay contained at read time', () => {
  it('refuses a file swapped to an outside symlink after the document walk was cached', async () => {
    file('Documents/safe.md', 'ordinary words\n')
    await listProjectDocs(root) // cache the lexical path
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'koda-library-outside-')))
    const outside = join(outsideDir, 'secret.md')
    writeFileSync(outside, 'outside-secret-needle\n')
    const cached = join(root, 'Documents', 'safe.md')
    rmSync(cached)
    symlinkSync(outside, cached)

    const result = await queryLibrary(root, { query: 'outside-secret-needle' })

    expect(result.docs).toEqual([])
    expect(result.truncated).toBe(true)
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('uses the same opened-handle containment for normal file and image reads', async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'koda-read-outside-')))
    const outsideText = join(outsideDir, 'secret.md')
    const outsideImage = join(outsideDir, 'secret.png')
    writeFileSync(outsideText, 'outside text')
    writeFileSync(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const textLink = join(root, 'document.md')
    const imageLink = join(root, 'picture.png')
    symlinkSync(outsideText, textLink)
    symlinkSync(outsideImage, imageLink)

    await expect(readProjectFile(root, textLink)).rejects.toThrow()
    await expect(readProjectImage(root, imageLink)).rejects.toThrow()
    await expect(readWholeContainedRegularFile(root, imageLink)).rejects.toThrow()
    rmSync(outsideDir, { recursive: true, force: true })
  })

  /**
   * Containment is about where a path RESOLVES, not about whether its leaf is a link. Koda writes the
   * `CLAUDE.md` → `AGENTS.md` link itself (guidelines.healGuidelinesPair), `browseDir` lists a link as
   * an ordinary file row, and `containedReal` — which writes and the phone's excerpt still use —
   * resolves one, so a reader that refuses the whole class makes the desktop editor fail on a row the
   * phone happily renders.
   */
  it('reads a symlink whose target stays inside the project', async () => {
    file('AGENTS.md', 'agent guidance\n')
    file('Documents/assets/real.png', 'PNG-BYTES')
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
    symlinkSync(join(root, 'Documents', 'assets', 'real.png'), join(root, 'shortcut.png'))

    const read = await readProjectFile(root, 'CLAUDE.md')
    expect(read.content).toBe('agent guidance\n')
    expect(read.path).toBe(join(root, 'AGENTS.md')) // reported as what it resolved to, like containedReal

    // The preview protocol and the phone's image reader open through the same door.
    expect((await readWholeContainedRegularFile(root, 'CLAUDE.md')).bytes.toString('utf8')).toBe('agent guidance\n')
    expect((await readProjectImage(root, 'shortcut.png'))?.buf.toString('utf8')).toBe('PNG-BYTES')
  })

  it('still refuses an in-project name that links out of the project', async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'koda-link-outside-')))
    writeFileSync(join(outsideDir, 'secret.md'), 'outside-secret\n')
    symlinkSync(join(outsideDir, 'secret.md'), join(root, 'escape.md'))

    // The containment check, not an ELOOP from the open flags, is what has to be doing the refusing.
    await expect(readProjectFile(root, 'escape.md')).rejects.toThrow('path escapes project root')
    await expect(readWholeContainedRegularFile(root, 'escape.md')).rejects.toThrow('path escapes project root')
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('refuses a non-regular file instead of waiting on it', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')])
    mkdirSync(join(root, 'folder'))
    // A FIFO has no writer here, so a read that opens it blocking never returns: this test failing by
    // TIMEOUT rather than by assertion is the regression it exists to catch.
    await expect(readContainedRegularFile(root, 'pipe', 1_000)).rejects.toThrow('not a regular file')
    await expect(readContainedRegularFile(root, 'folder', 1_000)).rejects.toThrow('not a regular file')
  })

  it('refuses to call a growing file a complete stable read', async () => {
    file('Documents/growing.md', 'before')
    await expect(
      readContainedRegularFile(root, 'Documents/growing.md', 1_000, () => {
        appendFileSync(join(root, 'Documents', 'growing.md'), ' after-open')
      }),
    ).rejects.toThrow('file changed while it was being read')
  })
})

describe('resolveProjectDocs exact shortcut refresh', () => {
  it('resolves more than the discovery display cap in request order', async () => {
    const rels = Array.from({ length: 325 }, (_, index) => `Documents/exact/doc-${index}.md`)
    for (const rel of rels) file(rel, `# ${rel}\n`)

    const docs = await resolveProjectDocs(root, rels)

    expect(docs).toHaveLength(325)
    expect(docs.map((doc) => doc.rel)).toEqual(rels)
  })

  it('returns only exact existing regular files that share the Library walk eligibility rules', async () => {
    file(
      'Documents/keep.md',
      '---\ntitle: Kept title\ndescription: Current metadata.\nkind: guide\nsource: sess-3\n---\n\nBody.\n',
    )
    file('.claude/rules/hidden.md', '# Hidden\n')
    file('resources/tool/SKILL.md', '---\nname: tool\n---\n')
    file('resources/tool/reference.md', '# Tool context\n')
    file('Documents/AGENTS.md', '# Agent context\n')
    file('Documents/target.md', '# Target\n')
    symlinkSync(join(root, 'Documents', 'target.md'), join(root, 'Documents', 'shortcut.md'))

    const docs = await resolveProjectDocs(root, [
      'Documents/keep.md',
      'Documents/missing.md',
      '.claude/rules/hidden.md',
      'resources/tool/reference.md',
      'Documents/AGENTS.md',
      'Documents/shortcut.md',
      '../escape.md',
      'Documents/../Documents/keep.md',
    ])

    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      path: realpathSync(join(root, 'Documents', 'keep.md')),
      rel: 'Documents/keep.md',
      name: 'keep.md',
      title: 'Kept title',
      description: 'Current metadata.',
      kind: 'guide',
      source: 'sess-3',
    })
    expect(Number.isFinite(docs[0].mtimeMs)).toBe(true)
    expect((await listProjectDocs(root)).map((doc) => doc.rel).sort()).toEqual([
      'Documents/keep.md',
      'Documents/target.md',
    ])
  })
})

describe('document deletion keeps the checkpointed lexical file identity', () => {
  it('unlinks an unchanged regular Library document', async () => {
    file('Documents/ordinary.md', 'ordinary\n')
    const path = join(root, 'Documents', 'ordinary.md')
    const prepared = await prepareProjectDocumentDelete(root, path)

    await deleteProjectDocument(root, prepared)

    expect(existsSync(path)).toBe(false)
  })

  it('refuses a leaf symlink instead of deleting its target', async () => {
    file('Documents/target.md', 'keep me\n')
    const target = join(root, 'Documents', 'target.md')
    const link = join(root, 'Documents', 'shortcut.md')
    symlinkSync(target, link)

    await expect(prepareProjectDocumentDelete(root, link)).rejects.toThrow('not a regular file')
    expect(readFileSync(target, 'utf8')).toBe('keep me\n')
    expect(existsSync(link)).toBe(true)
  })

  it('refuses a replacement inode installed after the pre-check', async () => {
    file('Documents/swap.md', 'old bytes\n')
    const path = join(root, 'Documents', 'swap.md')
    const prepared = await prepareProjectDocumentDelete(root, path)
    renameSync(path, `${path}.old`)
    writeFileSync(path, 'new bytes\n')

    await expect(deleteProjectDocument(root, prepared)).rejects.toThrow(
      'document changed before it could be deleted',
    )
    expect(readFileSync(path, 'utf8')).toBe('new bytes\n')
  })

  it('refuses a same-inode, same-size rewrite after the pre-check', async () => {
    file('Documents/changed.md', 'before\n')
    const path = join(root, 'Documents', 'changed.md')
    utimesSync(path, 1, 1)
    const prepared = await prepareProjectDocumentDelete(root, path)
    writeFileSync(path, 'after!\n')
    utimesSync(path, 2, 2)

    await expect(deleteProjectDocument(root, prepared)).rejects.toThrow(
      'document changed before it could be deleted',
    )
    expect(readFileSync(path, 'utf8')).toBe('after!\n')
  })

  it('restores a replacement swapped in after the final pre-check instead of unlinking it', async () => {
    file('Documents/final-race.md', 'checkpointed bytes\n')
    const path = join(root, 'Documents', 'final-race.md')
    const movedOriginal = `${path}.checkpointed`
    const prepared = await prepareProjectDocumentDelete(root, path)

    await expect(
      deleteProjectDocument(root, prepared, {
        afterFinalPrecheck: () => {
          renameSync(path, movedOriginal)
          writeFileSync(path, 'replacement survives\n')
        },
      }),
    ).rejects.toThrow('document changed before it could be deleted; the replacement was restored')

    expect(readFileSync(path, 'utf8')).toBe('replacement survives\n')
    expect(readFileSync(movedOriginal, 'utf8')).toBe('checkpointed bytes\n')
    expect(readdirSync(join(root, 'Documents')).some((name) => name.startsWith('.koda-delete-'))).toBe(
      false,
    )
  })

  it('refuses excluded internal Markdown even when it is a regular contained file', async () => {
    file('.koda/safety.git/private.md', 'internal\n')

    await expect(
      prepareProjectDocumentDelete(root, join(root, '.koda', 'safety.git', 'private.md')),
    ).rejects.toThrow('not a Library document')
  })
})

/**
 * Build output is not writing. Measured on the Koda repository itself: 78 of the 166 documents the
 * Library offered were Xcode link-file lists and SwiftPM checkouts, and querying "install" returned ten
 * `*-DebugDylibInstallName-normal-arm64.txt` rows above the first thing RB had actually written. Each
 * case below is a real generated tree, so a future edit that drops one of these names has to fail here.
 */
describe('queryLibrary excludes generated trees', () => {
  const NEEDLE = 'zkodaneedle'
  beforeEach(() => {
    file('Documents/notes.md', `The user's own writing, ${NEEDLE}.\n`)
    // Xcode / SwiftPM / CocoaPods / Carthage.
    file('ios/DerivedData/Build/Products/App-DebugDylibInstallName-normal-arm64.md', NEEDLE)
    file('ios/DerivedData/SourcePackages/checkouts/keychain-swift/README.md', NEEDLE)
    file('ios/App/SourcePackages/checkouts/some-dep/CHANGELOG.md', NEEDLE)
    file('.build/checkouts/swift-log/README.md', NEEDLE)
    file('ios/Pods/Alamofire/README.md', NEEDLE)
    file('Carthage/Checkouts/Result/README.md', NEEDLE)
    // The rest of the mainstream generated trees.
    file('android/.gradle/notes.md', NEEDLE)
    file('coverage/lcov-report/summary.md', NEEDLE)
    file('bower_components/jquery/README.md', NEEDLE)
    file('web/.svelte-kit/generated/notes.md', NEEDLE)
    // Apple's own "this is derived, don't index it" marker, which holds when a project points derived
    // data somewhere the name list can't anticipate.
    file('ios/CustomBuildRoot/Intermediates.noindex/App.build/link-list.md', NEEDLE)
  })

  it('returns only the user document', async () => {
    const { docs } = await queryLibrary(root, { query: NEEDLE })
    expect(docs.map((d) => d.rel)).toEqual(['Documents/notes.md'])
  })

  it('keeps a source directory that merely SITS beside build output', async () => {
    // The reason `*.xcodeproj` / `Package.resolved` / `Podfile` are not prune markers: they mark the
    // user's source root. Pruning on one would empty the Library of a Swift package repository.
    file('ios/App/App.xcodeproj/project.pbxproj', '// generated')
    file('ios/App/README.md', `How this app is built, ${NEEDLE}.\n`)
    file('Package.resolved', '{}')
    file('NOTES.md', `Top-level notes, ${NEEDLE}.\n`)
    invalidateDocsCache(root)
    const { docs } = await queryLibrary(root, { query: NEEDLE })
    expect(docs.map((d) => d.rel).sort()).toEqual(['Documents/notes.md', 'NOTES.md', 'ios/App/README.md'])
  })
})

/**
 * `.txt` is the default extension for machine output — build link-file lists, daemon logs, captured
 * transcripts — and no directory rule catches them, because a tool writes its dump wherever it runs.
 * After the generated-tree exclusions above, every remaining `.txt` in this repository's corpus was a
 * `tailscaled.log*.txt` or a captured engine turn. So the Library's extension set is narrower than the
 * Find overlay's: Find still reaches a `.txt`, the Library no longer calls one a document.
 */
describe('the Library scope is markdown, not every text file', () => {
  it('offers a .txt in Find but never in the Library', async () => {
    file('Documents/real.md', 'Prose about tailscaled.\n')
    file('spike/tsnet-state/tailscaled.log1.txt', 'tailscaled started\n')
    file('ios/App/build/App-LinkFileList-normal-arm64.txt', 'tailscaled\n')
    const { docs } = await queryLibrary(root, { query: 'tailscaled' })
    expect(docs.map((d) => d.rel)).toEqual(['Documents/real.md'])
    // Still fully reachable in the Find overlay's Docs scope — only the "this is your document" claim
    // is withdrawn.
    const found = await searchProject(root, 'tailscaled', 'docs')
    expect(found.files.map((f) => f.rel)).toContain('spike/tsnet-state/tailscaled.log1.txt')
  })

  it('keeps the prose formats that have no machine-output tradition', async () => {
    file('Documents/a.markdown', 'zneedle\n')
    file('Documents/b.mdx', 'zneedle\n')
    file('Documents/c.rst', 'zneedle\n')
    file('Documents/d.org', 'zneedle\n')
    const { docs } = await queryLibrary(root, { query: 'zneedle' })
    expect(docs.map((d) => d.name).sort()).toEqual(['a.markdown', 'b.mdx', 'c.rst', 'd.org'])
  })
})

/**
 * HTML joins the corpus DELIBERATELY, which is a different admission rule from prose and has to stay
 * one (typed-documents plan, Architecture §2). `.html` is the most common non-document extension there
 * is — build output, coverage reports, email templates, vendored docs — so a project-wide rule would
 * bury the user's writing the first time anyone ran a build. `Documents/` is the one folder whose
 * contents the user put there on purpose, so that is where, and only where, an `.html` file counts.
 */
describe('deliberate HTML admission', () => {
  it('admits an .html under Documents/ and refuses the identical file anywhere else', async () => {
    file('Documents/report.html', '<html><head><title>Frost report</title></head><body><p>zneedle</p></body></html>')
    file('dist/report.html', '<html><head><title>Built</title></head><body><p>zneedle</p></body></html>')
    file('emails/welcome.html', '<html><head><title>Welcome</title></head><body><p>zneedle</p></body></html>')
    file('coverage/index.html', '<html><head><title>Coverage</title></head><body><p>zneedle</p></body></html>')

    const { docs } = await queryLibrary(root, { query: 'zneedle' })

    expect(docs.map((d) => d.rel)).toEqual(['Documents/report.html'])
  })

  it('carries the same rule down into Documents/ subfolders, and holds for .htm', async () => {
    file('Documents/reviews/q3.html', '<html><head><title>Q3</title></head><body><p>zneedle</p></body></html>')
    file('Documents/legacy.htm', '<html><head><title>Legacy</title></head><body><p>zneedle</p></body></html>')

    const { docs } = await queryLibrary(root, { query: 'zneedle' })

    expect(docs.map((d) => d.rel).sort()).toEqual(['Documents/legacy.htm', 'Documents/reviews/q3.html'])
  })

  it('does not admit a Documents/ folder that is not the project’s home', async () => {
    // The home is the top-level `Documents/`. A `docs/Documents/` inside a vendored tree is somebody
    // else's folder that happens to share a name, and admitting it reopens the build-output door.
    file('site/Documents/generated.html', '<html><head><title>Gen</title></head><body><p>zneedle</p></body></html>')

    const { docs } = await queryLibrary(root, { query: 'zneedle' })

    expect(docs).toEqual([])
  })

  it('gives an admitted artifact the same authored row a markdown document gets', async () => {
    file(
      'Documents/explorer.html',
      [
        '<!doctype html><html><head><title>Frost date explorer</title>',
        '<meta name="koda:description" content="Which planting window survives a late freeze." />',
        '<meta name="koda:kind" content="research" />',
        '<meta name="koda:date" content="2026-08-20" />',
        '<style>body { color: zneedle; }</style></head>',
        '<body><h1>Frost date explorer</h1><p>Two sliders and a table.</p>',
        '<script>const secret = "zneedle"</script></body></html>',
      ].join('\n'),
    )

    const [doc] = await listProjectDocs(root)

    expect(doc.title).toBe('Frost date explorer')
    expect(doc.description).toBe('Which planting window survives a late freeze.')
    expect(doc.kind).toBe('research')
    // The excerpt is the page's prose. A Library row that previewed a stylesheet or a script would be
    // the file tree this surface exists to replace.
    const { docs } = await queryLibrary(root, {})
    expect(docs[0].excerpt).toContain('Two sliders and a table.')
    expect(docs[0].excerpt).not.toContain('color:')
    expect(docs[0].excerpt).not.toContain('const secret')
  })

  it('keeps listing the rest of the Library when one artifact is unreadable', async () => {
    file('Documents/good.md', '# Good\n')
    file('Documents/broken.html', '<html><head><title>Never closed')

    const rels = (await listProjectDocs(root)).map((d) => d.rel).sort()

    // The broken artifact is still a row — it just has no authored metadata to show.
    expect(rels).toEqual(['Documents/broken.html', 'Documents/good.md'])
    const broken = (await listProjectDocs(root)).find((d) => d.rel === 'Documents/broken.html')
    expect(broken?.title).toBeUndefined()
  })

  it('refreshes an admitted artifact through the exact-path resolver too', async () => {
    file('Documents/report.html', '<html><head><title>Frost report</title></head><body><p>Text.</p></body></html>')
    file('dist/report.html', '<html><head><title>Built</title></head><body><p>Text.</p></body></html>')

    const docs = await resolveProjectDocs(root, ['Documents/report.html', 'dist/report.html'])

    // The remembered-shortcut door has to answer admission identically to the walk, or a star could
    // keep a row alive that discovery correctly refuses.
    expect(docs.map((d) => d.rel)).toEqual(['Documents/report.html'])
    expect(docs[0].title).toBe('Frost report')
  })
})

/**
 * Both walks report a partial RESULT and stop on a hard CAP, and those are different facts. Sharing one
 * flag between them ended the walk at the first ordinary file — a long matching line, a directory the
 * process cannot read — and reported "no matches" for a project full of them. These pin the split.
 */
describe('a partial result does not end the walk', () => {
  it('keeps searching past a file whose matching line is longer than the preview window', async () => {
    file('Documents/aaa-first.md', `start ${'x'.repeat(400)} zneedle ${'y'.repeat(400)} end\n`)
    file('Documents/zzz-last.md', 'zneedle\n')
    const found = await searchProject(root, 'zneedle', 'all')
    // The long line is windowed, not dropped, so BOTH files are still reported and the answer is whole.
    expect(found.files.map((f) => f.rel).sort()).toEqual(['Documents/aaa-first.md', 'Documents/zzz-last.md'])
    expect(found.truncated).toBe(false)
  })

  it('keeps listing documents past a directory it cannot read, and says the list is partial', async () => {
    file('Documents/aaa/keep.md', 'first\n')
    file('Documents/zzz-last.md', 'last\n')
    const blocked = join(root, 'Documents', 'aaa')
    execFileSync('chmod', ['000', blocked])
    try {
      invalidateDocsCache(root)
      const { docs, truncated } = await queryLibrary(root, {})
      expect(docs.map((d) => d.rel)).toContain('Documents/zzz-last.md')
      expect(truncated).toBe(true)
    } finally {
      execFileSync('chmod', ['755', blocked])
    }
  })
})

/**
 * The frontmatter block is plumbing, not content. `readDocMetadata` already refuses to put it in a
 * preview; scanning the raw file put it back through the other door, as a match preview and an ask
 * citation reading `Phone tiers · line 2` quoting `title: Phone tiers`. That hits the LIKELIEST query,
 * because the title is what a user remembers.
 */
describe('queryLibrary does not search the frontmatter block', () => {
  beforeEach(() => {
    file(
      'Documents/tiers.md',
      '---\ntitle: Phone tiers\ndescription: What each tier costs.\nkind: decision\n---\n\nIntro line.\nThe tiers are Free, Connect and Live.\n',
    )
  })

  it('never quotes a metadata line as something the document said', async () => {
    const { docs } = await queryLibrary(root, { query: 'phone tiers' })
    const doc = docs.find((d) => d.rel === 'Documents/tiers.md')!
    // The title still finds the document — through the authored title, which is where it belongs.
    expect(doc.nameMatch).toBe(true)
    expect(doc.matches).toEqual([])
  })

  it('does not match a key that appears only in the frontmatter', async () => {
    const { docs } = await queryLibrary(root, { query: 'description:' })
    expect(docs).toEqual([])
  })

  it('keeps body line numbers absolute, so a citation opens the right line', async () => {
    const { docs } = await queryLibrary(root, { query: 'Free, Connect' })
    const [match] = docs.find((d) => d.rel === 'Documents/tiers.md')!.matches
    expect(match.preview).toBe('The tiers are Free, Connect and Live.')
    expect(match.line).toBe(8) // ---,title,description,kind,---,blank,Intro line → line 8
  })

  it('numbers from line 1 when the document has no frontmatter', async () => {
    file('Documents/bare.md', 'First line mentions tiers.\n')
    invalidateDocsCache(root)
    const { docs } = await queryLibrary(root, { query: 'mentions tiers' })
    expect(docs.find((d) => d.rel === 'Documents/bare.md')!.matches[0].line).toBe(1)
  })

  it('still scans a body that opens with a thematic break', async () => {
    // `---` is markdown's horizontal rule too. Only a real metadata block may be skipped.
    file('Documents/quote.md', '---\n\n"The only way out is through."\n\n---\n\nAnd the tiers follow.\n')
    invalidateDocsCache(root)
    const { docs } = await queryLibrary(root, { query: 'only way out' })
    expect(docs.map((d) => d.rel)).toContain('Documents/quote.md')
  })

  it('leaves the Find overlay scanning the whole file, frontmatter included', async () => {
    const found = await searchProject(root, 'description:', 'docs')
    expect(found.files.map((f) => f.rel)).toContain('Documents/tiers.md')
    expect(found.files.find((f) => f.rel === 'Documents/tiers.md')!.matches[0].line).toBe(3)
  })
})

describe('queryLibrary shape', () => {
  beforeEach(() => {
    file('Documents/plans/launch.md', '---\ntitle: Launch plan\ndescription: What ships first.\nkind: plan\n---\n\nBody.\n')
    file('Documents/site/audience.md', '---\ntitle: Audience\nkind: research\n---\n\nWho this is for.\n')
    file('Documents/guides/setup.md', '# Setup\n\nNo frontmatter here.\n')
    file('Documents/loose.md', '# Loose\n\nAlso none.\n')
  })

  it('resolves a kind for every document: authored wins, else the folder, else note', async () => {
    const { docs } = await queryLibrary(root, {})
    const byRel = new Map(docs.map((d) => [d.rel, d]))
    expect(byRel.get('Documents/site/audience.md')!.resolvedKind).toBe('research') // authored beats the `site` folder
    expect(byRel.get('Documents/site/audience.md')!.kind).toBe('research')
    expect(byRel.get('Documents/guides/setup.md')!.resolvedKind).toBe('guide') // inferred
    expect(byRel.get('Documents/guides/setup.md')!.kind).toBeUndefined() // and marked as inferred
    expect(byRel.get('Documents/loose.md')!.resolvedKind).toBe('note')
  })

  it('filters by resolvedKind, so an unauthored document stays reachable through its folder', async () => {
    const plans = await queryLibrary(root, { kinds: ['plan'] })
    expect(plans.docs.map((d) => d.rel)).toEqual(['Documents/plans/launch.md'])
    const guides = await queryLibrary(root, { kinds: ['guide'] })
    expect(guides.docs.map((d) => d.rel)).toEqual(['Documents/guides/setup.md'])
    const both = await queryLibrary(root, { kinds: ['plan', 'research'] })
    expect(both.docs.map((d) => d.rel).sort()).toEqual(['Documents/plans/launch.md', 'Documents/site/audience.md'])
  })

  it('carries the authored description and a prose excerpt for the ones without one', async () => {
    const { docs } = await queryLibrary(root, {})
    const launch = docs.find((d) => d.rel === 'Documents/plans/launch.md')!
    expect(launch.description).toBe('What ships first.')
    expect(launch.excerpt).not.toContain('title:') // never the metadata block
    const setup = docs.find((d) => d.rel === 'Documents/guides/setup.md')!
    expect(setup.description).toBeUndefined()
    expect(setup.excerpt).toContain('No frontmatter here.')
  })

  it('honours limit and reports the cut as truncated', async () => {
    const { docs, truncated } = await queryLibrary(root, { limit: 2 })
    expect(docs).toHaveLength(2)
    expect(truncated).toBe(true)
    expect((await queryLibrary(root, {})).truncated).toBe(false)
  })

  it('echoes the query back verbatim so a stale response can be dropped', async () => {
    expect((await queryLibrary(root, { query: '  Launch  ' })).query).toBe('  Launch  ')
    expect((await queryLibrary(root, {})).query).toBe('')
  })
})

describe('listProjectDocs metadata', () => {
  it('returns the authored fields, and stays listable when the frontmatter is malformed', async () => {
    file('Documents/good.md', '---\ntitle: Good\ndescription: One honest sentence.\nkind: decision\nsource: sess-7\n---\n\nBody.\n')
    file('Documents/broken.md', '---\ntitle: [unclosed, "seq\n  : : :\nkind: not-a-kind\n---\n\nStill a document.\n')
    file('Documents/bare.md', '# No frontmatter at all\n')
    const docs = await listProjectDocs(root)
    const byName = new Map(docs.map((d) => [d.name, d]))
    expect(byName.get('good.md')).toMatchObject({
      title: 'Good',
      description: 'One honest sentence.',
      kind: 'decision',
      source: 'sess-7',
    })
    // The whole point of degrading rather than throwing: one bad file must not blank the list.
    expect(byName.size).toBe(3)
    expect(byName.get('broken.md')!.kind).toBeUndefined()
    expect(byName.get('bare.md')!.title).toBeUndefined()
  })
})

describe('a document is born with its metadata', () => {
  it('writes title, date and kind, and leaves description for the agent', async () => {
    const path = await createProjectFile(root, 'Launch plan')
    const raw = readFileSync(path, 'utf8')
    const fm = parseDocFrontmatter(raw)
    expect(fm.title).toBe('Launch plan')
    expect(fm.kind).toBe('note')
    expect(fm.description).toBeUndefined()
    expect(raw).toMatch(/^---\ntitle: Launch plan\ndate: \d{4}-\d{2}-\d{2}\nkind: note\n---\n/)
  })

  it('infers the kind from the destination folder', async () => {
    mkdirSync(join(root, 'Documents', 'plans'), { recursive: true })
    const path = await createProjectFile(root, 'Launch', join(root, 'Documents', 'plans'))
    expect(parseDocFrontmatter(readFileSync(path, 'utf8')).kind).toBe('plan')
  })

  it('titles a deduped file by the name it actually got', async () => {
    await createProjectFile(root)
    const second = await createProjectFile(root)
    expect(second.endsWith('Untitled 2.md')).toBe(true)
    expect(parseDocFrontmatter(readFileSync(second, 'utf8')).title).toBe('Untitled 2')
  })

  it('records the originating session when one is given', async () => {
    const path = await createProjectFile(root, 'From a session', undefined, 'sess-99')
    expect(parseDocFrontmatter(readFileSync(path, 'utf8')).source).toBe('sess-99')
  })

  it('is immediately readable as a document by the Library', async () => {
    await listProjectDocs(root) // prime an empty cache before the mutation
    await createProjectFile(root, 'Brand new')
    const { docs } = await queryLibrary(root, { query: 'brand new' })
    expect(docs.map((d) => d.title)).toEqual(['Brand new'])
    expect(docs[0].resolvedKind).toBe('note')
  })

  it('invalidates cached metadata when an existing document is saved', async () => {
    file('Documents/renamed.md', '---\ntitle: Before\nkind: note\n---\n\nBody.\n')
    expect((await listProjectDocs(root))[0]?.title).toBe('Before')
    await writeProjectFile(
      root,
      join(root, 'Documents', 'renamed.md'),
      '---\ntitle: After\nkind: note\n---\n\nBody.\n',
    )
    expect((await listProjectDocs(root))[0]?.title).toBe('After')
  })

  it('does not let an invalidated in-flight walk repopulate the cache', async () => {
    file('Documents/before.md', '# Before\n')
    const staleWalk = listProjectDocs(root)

    // `listProjectDocs` captures its generation synchronously, then yields to readdir. This models a
    // successful mutation notification arriving while that cold walk is in flight. The direct write
    // after it settles is intentionally unannounced: if the invalidated walk poisoned the cache, the
    // second list will miss it for the whole TTL.
    invalidateDocsCache(root)
    await staleWalk
    file('Documents/after.md', '# After\n')

    expect((await listProjectDocs(root)).map((doc) => doc.name)).toContain('after.md')
  })
})

describe('docExcerpt', () => {
  it('previews the prose, not the metadata block', async () => {
    file('Documents/doc.md', '---\ntitle: Launch\nkind: plan\n---\n\nThe first real sentence.\n')
    const excerpt = await docExcerpt(root, 'Documents/doc.md')
    expect(excerpt).toContain('The first real sentence.')
    expect(excerpt).not.toContain('kind: plan')
  })

  it('refuses a path outside the project', async () => {
    await expect(docExcerpt(root, '../escape.md')).resolves.toBeUndefined()
  })
})
