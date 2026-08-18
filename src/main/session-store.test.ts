import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// Retention reads a real setting; make it controllable per-test.
let retentionDays = 0
vi.mock('./settings', () => ({ loadArchiveRetentionDays: () => retentionDays }))

// The replay converter reads ~/.claude/projects; point homedir at a scratch dir so tests never
// touch (or depend on) the real engine home. Everything else on node:os stays real.
const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  return mkdtempSync(join(tmpdir(), 'koda-replay-home-'))
})
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => fakeHome }
})

// W1's "backup itself fails" case (ENOSPC) needs a way to make copyFileSync throw without touching the
// real filesystem semantics for everything else — override just that export, passthrough otherwise.
let copyFileImpl: ((...args: unknown[]) => unknown) | null = null
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    copyFileSync: (...args: unknown[]) => {
      if (copyFileImpl) return copyFileImpl(...args)
      return (actual.copyFileSync as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import {
  appStateHealth,
  archiveSession,
  deleteArchivedBody,
  ingestFullArchives,
  loadAppState,
  loadArchivedBody,
  loadArchivedMeta,
  loadProjectSessions,
  MAX_CORRUPT_BACKUPS,
  noteProjectClosed,
  noteProjectOpened,
  pruneGhostSessions,
  purgeProjectSessions,
  readClaudeConversationReplay,
  saveArchivedMeta,
  saveProjectSessions,
  saveWindowBounds,
  StoreReadError,
  writeArchivedBody,
  type StoreReadReport,
  withResumeCursorFallback,
} from './session-store'
import { log } from './logger'
import { ReplayEntrySchema } from '@shared/ipc'
import { mkdirSync } from 'node:fs'
import { appendRemoteReplay, loadRemoteReplay } from './remote-replay-store'

// The electron stub points getPath('userData') at tmpdir(); reconstruct the store paths the module
// derives (hash of the project path) so a test can plant a file and inspect the result.
const hash = (p: string): string => createHash('sha256').update(p).digest('hex').slice(0, 16)
const indexPath = (p: string): string => join(tmpdir(), `koda-archive-${hash(p)}.json`)
const bodiesDir = (p: string): string => join(tmpdir(), `koda-archive-${hash(p)}.bodies`)
const storePath = (p: string): string => join(tmpdir(), `koda-sessions-${hash(p)}.json`)

/** The copies session-store keeps of a file it couldn't read (`<name>.corrupt-<ts>.bak`). */
function corruptBackups(path: string): string[] {
  const prefix = `${basename(path)}.corrupt-`
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
    .map((n) => join(tmpdir(), n))
}

const created: string[] = []
function uniqueProject(): string {
  const p = `/koda-test/${Math.random().toString(36).slice(2)}-${process.hrtime.bigint()}`
  created.push(p)
  return p
}

afterEach(() => {
  retentionDays = 0
  copyFileImpl = null
  vi.restoreAllMocks()
  for (const p of created.splice(0)) {
    for (const f of [indexPath(p), storePath(p)]) {
      rmSync(f, { force: true })
      for (const b of corruptBackups(f)) rmSync(b, { force: true })
    }
    rmSync(`${indexPath(p)}.v1.bak`, { force: true })
    rmSync(`${indexPath(p)}.tmp`, { recursive: true, force: true }) // the index-write blocker below
    rmSync(`${storePath(p)}.tmp`, { recursive: true, force: true })
    rmSync(bodiesDir(p), { recursive: true, force: true })
  }
})

describe('archive storage split', () => {
  it('collapses repeated metadata rows by id and keeps the newest row', () => {
    const p = uniqueProject()
    saveArchivedMeta(p, [
      { id: 'same', label: 'Newest', cwd: '/proj', archivedAt: 30 },
      { id: 'other', label: 'Other', cwd: '/proj', archivedAt: 25 },
      { id: 'same', label: 'Older', cwd: '/proj', archivedAt: 20 },
    ])

    expect(loadArchivedMeta(p).map((meta) => [meta.id, meta.label])).toEqual([
      ['same', 'Newest'],
      ['other', 'Other'],
    ])
    const saved = JSON.parse(readFileSync(indexPath(p), 'utf8')) as { archived: { id: string }[] }
    expect(saved.archived.map((meta) => meta.id)).toEqual(['same', 'other'])
  })

  it('migrates a v1 blob: bodies split out, metadata baked, original backed up', () => {
    const p = uniqueProject()
    const s1Items = [
      { id: 5, kind: 'user', text: 'hello' },
      { id: 6, kind: 'assistant', markdown: 'hi there' },
      { id: 8, kind: 'subagent', children: [{ id: 20 }] },
    ]
    const v1 = {
      version: 1,
      archived: [
        { id: 's1', label: 'One', cwd: '/proj', archivedAt: 1000, items: s1Items },
        { id: 's2', label: 'Two', cwd: '/proj', archivedAt: 2000, items: [{ id: 9, kind: 'user', text: 'x' }] },
      ],
    }
    writeFileSync(indexPath(p), JSON.stringify(v1))

    const metas = loadArchivedMeta(p)

    expect(metas.map((m) => m.id)).toEqual(['s1', 's2'])
    // Bodies are stripped from the metadata index...
    expect((metas[0] as { items?: unknown }).items).toBeUndefined()
    // ...but a preview + maxItemId are baked in so the list and boot counter never need the body.
    expect(metas[0].preview).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'hi there' },
    ])
    expect(metas[0].maxItemId).toBe(20) // includes the subagent child id
    // The original blob is preserved as a backup (a real user's archives are irreplaceable).
    expect(existsSync(`${indexPath(p)}.v1.bak`)).toBe(true)
    // The index is now the light v2 form.
    expect(JSON.parse(readFileSync(indexPath(p), 'utf8')).version).toBe(2)
    // The full transcript is recoverable from its own body file.
    expect(loadArchivedBody(p, 's1')).toEqual(s1Items)
    expect(loadArchivedBody(p, 's2')).toEqual([{ id: 9, kind: 'user', text: 'x' }])
  })

  it('round-trips metadata and bodies, and delete removes only the body', () => {
    const p = uniqueProject()
    saveArchivedMeta(p, [{ id: 'a', label: 'A', cwd: '/x', archivedAt: 10 }])
    writeArchivedBody(p, 'a', [{ id: 1, kind: 'user', text: 'hi' }])

    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['a'])
    expect(loadArchivedBody(p, 'a')).toEqual([{ id: 1, kind: 'user', text: 'hi' }])

    deleteArchivedBody(p, 'a')
    expect(loadArchivedBody(p, 'a')).toBeNull() // gone → null (a failed read, NOT a genuine empty [])
    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['a']) // metadata untouched
  })

  it('bounds tool output on main-side hot and cold writes', () => {
    const p = uniqueProject()
    const long = `old-${'x'.repeat(4_000)}-LATEST`
    const items = [
      { id: 1, kind: 'tool', name: 'Bash', toolUseId: 'top', input: {}, result: long },
      {
        id: 2,
        kind: 'subagent',
        children: [
          { id: 3, kind: 'tool', name: 'Read', toolUseId: 'child', input: {}, result: long },
        ],
      },
    ]

    writeArchivedBody(p, 'cold', items)
    const cold = loadArchivedBody(p, 'cold') as typeof items
    const coldChild = (cold[1] as { children: { result?: string }[] }).children[0]
    expect(cold[0].result).toHaveLength(2_000)
    expect(coldChild?.result).toHaveLength(2_000)

    saveProjectSessions(p, {
      version: 3,
      activeId: 'hot',
      sessions: [{ id: 'hot', label: 'Hot', cwd: p, items }],
    })
    const hot = JSON.parse(readFileSync(storePath(p), 'utf8')) as {
      sessions: { items: typeof items }[]
    }
    const hotChild = (hot.sessions[0].items[1] as { children: { result?: string }[] }).children[0]
    expect(hot.sessions[0].items[0].result).toHaveLength(2_000)
    expect(hotChild?.result).toHaveLength(2_000)
  })

  it('distinguishes a genuinely empty body ([]) from a failed read (null)', () => {
    const p = uniqueProject()
    writeArchivedBody(p, 'empty', []) // a minimal/headless archive with no transcript
    expect(loadArchivedBody(p, 'empty')).toEqual([]) // clean read of an empty body → []
    expect(loadArchivedBody(p, 'missing')).toBeNull() // no file at all → null, so restore won't destroy it
  })

  it('folds a headless replay into an empty archive body before consuming both', () => {
    const p = uniqueProject()
    writeArchivedBody(p, 'headless', [])
    appendRemoteReplay(p, 'headless', {
      type: 'RemoteUserTurn',
      sessionId: 'headless',
      text: 'delegate this',
    })
    appendRemoteReplay(p, 'headless', {
      type: 'SubagentStarted',
      sessionId: 'headless',
      toolUseId: 'agent-1',
      subagentType: 'scout',
      description: 'Inspect',
    })
    appendRemoteReplay(p, 'headless', {
      type: 'SubagentCompleted',
      sessionId: 'headless',
      toolUseId: 'agent-1',
      outcome: 'completed',
      resultText: 'survived',
    })

    expect(loadArchivedBody(p, 'headless')).toEqual([
      expect.objectContaining({ kind: 'user', text: 'delegate this' }),
      expect.objectContaining({ kind: 'subagent', status: 'completed', resultText: 'survived' }),
    ])

    deleteArchivedBody(p, 'headless')
    expect(loadRemoteReplay(p, 'headless')).toEqual([])
  })

  it('ingests full archives newest-first, splitting each into a body', () => {
    const p = uniqueProject()
    saveArchivedMeta(p, [{ id: 'existing', label: 'E', cwd: '/x', archivedAt: 1 }])
    ingestFullArchives(p, [
      { id: 'fresh', label: 'F', cwd: '/x', archivedAt: 99, items: [{ id: 3, kind: 'user', text: 'yo' }] },
    ])

    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['fresh', 'existing'])
    expect(loadArchivedBody(p, 'fresh')).toEqual([{ id: 3, kind: 'user', text: 'yo' }])
  })

  it('re-ingesting the same archive replaces its metadata instead of duplicating the row', () => {
    const p = uniqueProject()
    const first = { id: 'retry', label: 'First', cwd: '/x', archivedAt: 1, items: [{ id: 1 }] }
    expect(ingestFullArchives(p, [first])).toBe(true)
    expect(ingestFullArchives(p, [{ ...first, label: 'Retried', archivedAt: 2 }])).toBe(true)

    expect(loadArchivedMeta(p).filter((meta) => meta.id === 'retry')).toEqual([
      expect.objectContaining({ label: 'Retried', archivedAt: 2 }),
    ])
  })

  it('keeps everything forever when retention is 0 (the default)', () => {
    const p = uniqueProject()
    const ancient = Date.now() - 3650 * 86_400_000
    saveArchivedMeta(p, [{ id: 'old', label: 'O', cwd: '/x', archivedAt: ancient }])
    writeArchivedBody(p, 'old', [{ id: 1 }])

    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['old'])
    expect(loadArchivedBody(p, 'old')).toEqual([{ id: 1 }])
  })

  it('purges archives past the retention window and unlinks their bodies', () => {
    retentionDays = 30
    const p = uniqueProject()
    const now = Date.now()
    saveArchivedMeta(p, [
      { id: 'old', label: 'O', cwd: '/x', archivedAt: now - 40 * 86_400_000 },
      { id: 'recent', label: 'R', cwd: '/x', archivedAt: now - 1 * 86_400_000 },
    ])
    writeArchivedBody(p, 'old', [{ id: 1 }])
    writeArchivedBody(p, 'recent', [{ id: 2 }])

    const kept = loadArchivedMeta(p)
    expect(kept.map((m) => m.id)).toEqual(['recent'])
    expect(loadArchivedBody(p, 'old')).toBeNull() // body unlinked
    expect(loadArchivedBody(p, 'recent')).toEqual([{ id: 2 }])
    // The pruned index is persisted, not just filtered in memory.
    expect(JSON.parse(readFileSync(indexPath(p), 'utf8')).archived.map((m: { id: string }) => m.id)).toEqual([
      'recent',
    ])
  })

  it('protects an expired archive-only legacy star until its project migration is acknowledged', () => {
    retentionDays = 30
    const p = uniqueProject()
    const ancient = Date.now() - 40 * 86_400_000
    saveArchivedMeta(p, [
      {
        id: 'old-star-owner',
        label: 'O',
        cwd: '/x',
        archivedAt: ancient,
        keptDocs: ['Documents/only-copy.md'],
      },
      {
        id: 'old-without-star',
        label: 'Purge me',
        cwd: '/x',
        archivedAt: ancient,
      },
    ])
    writeArchivedBody(p, 'old-star-owner', [{ id: 1 }])
    writeArchivedBody(p, 'old-without-star', [{ id: 2 }])

    expect(loadArchivedMeta(p).map((meta) => meta.id)).toEqual(['old-star-owner'])
    expect(loadArchivedBody(p, 'old-star-owner')).toEqual([{ id: 1 }])
    expect(loadArchivedBody(p, 'old-without-star')).toBeNull()

    expect(
      saveProjectSessions(p, {
        version: 3,
        activeId: null,
        sessions: [],
        starredDocs: ['Documents/only-copy.md'],
        legacyKeptDocsImported: ['Documents/only-copy.md'],
        legacyKeptDocsMigrationComplete: true,
      }),
    ).toBe(true)

    expect(loadArchivedMeta(p)).toEqual([])
    expect(loadArchivedBody(p, 'old-star-owner')).toBeNull()
  })

  // The purge is a delete, so it follows the delete order: index first, bodies only once the index took
  // it. Unlinking first and then failing to write leaves rows on disk whose transcripts are gone, and
  // the retention filter hides those rows on every load — so nothing looks wrong until the user sets
  // retention back to Forever and gets a list of chats that all open to nothing.
  it('a purge whose index write is refused keeps the bodies it was about to unlink', () => {
    retentionDays = 30
    const p = uniqueProject()
    const now = Date.now()
    saveArchivedMeta(p, [
      { id: 'old', label: 'O', cwd: '/x', archivedAt: now - 40 * 86_400_000 },
      { id: 'recent', label: 'R', cwd: '/x', archivedAt: now - 1 * 86_400_000 },
    ])
    writeArchivedBody(p, 'old', [{ id: 1 }])
    writeArchivedBody(p, 'recent', [{ id: 2 }])
    // writeFileAtomic stages through `<index>.tmp`; a directory there makes every write to this index
    // fail while leaving the index itself perfectly readable.
    mkdirSync(`${indexPath(p)}.tmp`, { recursive: true })

    const got = loadArchivedMeta(p)

    // Refusing means the purge did not happen at all, so what the caller sees still matches the file.
    const onDisk = JSON.parse(readFileSync(indexPath(p), 'utf8')).archived.map((m: { id: string }) => m.id)
    expect(onDisk).toEqual(['old', 'recent'])
    expect(got.map((m) => m.id)).toEqual(['old', 'recent'])
    expect(loadArchivedBody(p, 'old')).toEqual([{ id: 1 }]) // the transcript its row still points at
    expect(loadArchivedBody(p, 'recent')).toEqual([{ id: 2 }])
  })
})

describe('project-wide document stars', () => {
  it('round-trips an ordered shelf even when the project has no sessions', () => {
    const p = uniqueProject()
    const store = {
      version: 3 as const,
      activeId: null,
      sessions: [],
      starredDocs: ['Documents/brief.md', 'Documents/plans/launch.md'],
      legacyKeptDocsImported: ['Documents/brief.md'],
    }

    expect(saveProjectSessions(p, store)).toBe(true)
    expect(loadProjectSessions(p)).toEqual(store)
  })

  it('upgrades v2 in place while preserving per-session shelves for renderer migration', () => {
    const p = uniqueProject()
    writeFileSync(
      storePath(p),
      JSON.stringify({
        version: 2,
        projectPath: p,
        activeId: 'a',
        sessions: [
          {
            id: 'a',
            label: 'a',
            cwd: p,
            items: [],
            keptDocs: ['Documents/brief.md'],
          },
        ],
      }),
    )

    const loaded = loadProjectSessions(p)

    expect(loaded).toMatchObject({
      version: 3,
      activeId: 'a',
      sessions: [{ id: 'a', keptDocs: ['Documents/brief.md'] }],
    })
    expect(JSON.parse(readFileSync(storePath(p), 'utf8')).version).toBe(3)
  })

  it('moves an expired inline archive before the cold read and protects its only legacy star', () => {
    retentionDays = 30
    const p = uniqueProject()
    writeFileSync(
      storePath(p),
      JSON.stringify({
        version: 2,
        projectPath: p,
        activeId: null,
        sessions: [],
        archived: [
          {
            id: 'inline-old',
            label: 'Inline old',
            cwd: p,
            archivedAt: Date.now() - 40 * 86_400_000,
            items: [{ id: 1, kind: 'user', text: 'keep this' }],
            keptDocs: ['Documents/archive-only.md'],
          },
        ],
      }),
    )

    // The renderer now awaits this hot read before asking for the cold snapshot. The hot read moves
    // the inline archive first; because no acknowledged migration marker exists yet, retention returns
    // the row instead of deleting its sole star before hydration can see it.
    expect(loadProjectSessions(p)).toMatchObject({ version: 3, sessions: [] })
    expect(loadArchivedMeta(p)).toEqual([
      expect.objectContaining({
        id: 'inline-old',
        keptDocs: ['Documents/archive-only.md'],
      }),
    ])
    expect(loadArchivedBody(p, 'inline-old')).toEqual([{ id: 1, kind: 'user', text: 'keep this' }])
  })

  it('blocks hydration when an inline archive cannot reach the cold index', () => {
    const p = uniqueProject()
    const original = JSON.stringify({
      version: 2,
      projectPath: p,
      activeId: null,
      sessions: [],
      archived: [
        {
          id: 'inline-retry',
          label: 'Inline retry',
          cwd: p,
          archivedAt: 1,
          items: [{ id: 1, kind: 'user', text: 'irreplaceable' }],
          keptDocs: ['Documents/archive-only.md'],
        },
      ],
    })
    writeFileSync(storePath(p), original)
    // Atomic index writes stage through this path; occupying it with a directory makes the cold write
    // fail while the hot project file remains writable — the exact asymmetric failure that used to let
    // the renderer hydrate and then save away the inline copy.
    mkdirSync(`${indexPath(p)}.tmp`, { recursive: true })

    const err = catchError(() => loadProjectSessions(p))

    expect(err).toBeInstanceOf(StoreReadError)
    expect((err as StoreReadError).backupKept).toBe(false)
    expect(readFileSync(storePath(p), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(storePath(p), 'utf8')).archived[0].keptDocs).toEqual([
      'Documents/archive-only.md',
    ])
  })

  it('does not prune an otherwise-empty v3 session that still owns an unmigrated legacy star', () => {
    const p = uniqueProject()
    const appStatePath = join(tmpdir(), 'koda-app-state.json')
    writeFileSync(
      appStatePath,
      JSON.stringify({ version: 1, openProjects: [], recentProjects: [p], knownProjects: [p] }),
    )
    writeFileSync(
      storePath(p),
      JSON.stringify({
        version: 3,
        projectPath: p,
        activeId: 'a',
        sessions: [
          {
            id: 'a',
            label: 'a',
            cwd: p,
            items: [],
            keptDocs: ['Documents/only-copy.md'],
          },
        ],
      }),
    )

    try {
      pruneGhostSessions()
      expect(loadProjectSessions(p)?.sessions).toEqual([
        expect.objectContaining({ id: 'a', keptDocs: ['Documents/only-copy.md'] }),
      ])
    } finally {
      rmSync(appStatePath, { force: true })
    }
  })
})

// The defect these pin: a read failure that returns an empty-looking success. The renderer can't tell
// that from a genuinely empty store, hydrates it, and its debounced save writes the emptiness back over
// the user's real file ~500ms later with no interaction at all. The realistic trigger is schema/version
// drift (a user reinstalls an older build, a new build tightens a field), not disk corruption.
describe('a store that failed to load is never reported as empty', () => {
  it('a project with no files yet reads as empty, not as a failure', () => {
    const p = uniqueProject()
    expect(loadProjectSessions(p)).toBeNull() // nothing ever saved here — safe to start empty
    expect(loadArchivedMeta(p)).toEqual([])
  })

  it('an unparseable session store throws and warns instead of returning no sessions', () => {
    const p = uniqueProject()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(storePath(p), '{"version":2,"activeId":null,"sessions":[{"id":"a"') // torn file
    expect(() => loadProjectSessions(p)).toThrow()
    expect(warn.mock.calls.some(([, msg]) => msg.includes('refusing to report it as empty'))).toBe(true)
  })

  it('a session store that no longer matches the schema throws (version drift, not corruption)', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    // Written by a newer build, read back by an older one after a .dmg reinstall.
    writeFileSync(storePath(p), JSON.stringify({ version: 4, activeId: null, sessions: [], projectPath: p }))
    expect(() => loadProjectSessions(p)).toThrow()
  })

  it('keeps the unreadable session store as .corrupt-<ts>.bak before anything can replace it', () => {
    const p = uniqueProject()
    const original = '{"version":2,"activeId":null,"sessions":[{"id":"a"'
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(storePath(p), original)
    expect(() => loadProjectSessions(p)).toThrow()

    const backups = corruptBackups(storePath(p))
    expect(backups).toHaveLength(1)
    expect(readFileSync(backups[0], 'utf8')).toBe(original)
    // The save path is the thing that would replace it; the copy still holds the original bytes after.
    saveProjectSessions(p, { version: 3, activeId: null, sessions: [] })
    expect(readFileSync(storePath(p), 'utf8')).not.toBe(original)
    expect(readFileSync(backups[0], 'utf8')).toBe(original)
  })

  it('an unparseable archive index throws and warns instead of reading as no archives', () => {
    const p = uniqueProject()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(indexPath(p), '{"version":2,"archived":[{"id":"a"')
    expect(() => loadArchivedMeta(p)).toThrow()
    expect(warn.mock.calls.some(([, msg]) => msg.includes('refusing to report it as empty'))).toBe(true)
    expect(corruptBackups(indexPath(p))).toHaveLength(1)
  })

  it('an archive index that is neither v2 nor v1 throws rather than dropping every archive', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(indexPath(p), JSON.stringify({ version: 9, archived: [] }))
    expect(() => loadArchivedMeta(p)).toThrow()
  })

  it('keeps the good archive rows when one is malformed, warns, and backs the index up', () => {
    const p = uniqueProject()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 2,
        archived: [
          { id: 'a', label: 'A', cwd: '/x', archivedAt: 1 },
          { id: 'drifted', label: 'B', cwd: '/x' }, // no archivedAt — a row from another build
          { id: 'c', label: 'C', cwd: '/x', archivedAt: 3 },
        ],
      }),
    )

    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['a', 'c']) // one bad row costs only itself
    expect(warn.mock.calls.some(([, msg]) => msg.includes('dropped 1 unreadable archive row'))).toBe(true)
    // Dropping rows means the next save writes a SHORTER index, so the original must be kept aside.
    const backups = corruptBackups(indexPath(p))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(readFileSync(backups[0], 'utf8')).archived).toHaveLength(3)
  })
})

describe('readClaudeConversationReplay', () => {
  const CWD = '/koda-test/replay-proj'
  const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const LIVE = 'live-id-1'

  function writeConversation(lines: unknown[]): void {
    const dir = join(fakeHome, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    )
  }

  it('rebuilds the conversation as valid ReplayEntry events keyed to the live id', () => {
    writeConversation([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'find me cat6 cable' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure — searching now.' },
            { type: 'tool_use', id: 'tu1', name: 'WebSearch', input: { query: 'cat6 shielded 500ft' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'results…' }] }],
        },
      },
      // Noise the converter must skip: subagent sidechain, meta line, engine bookkeeping, a torn tail.
      { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'subagent chatter' }] } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local command output' } },
      { type: 'queue-operation', op: 'x' },
      { type: 'user', message: { role: 'user', content: 'plain string turn' } },
      '{"type":"assistant","message":{"content":[{"type":"te', // torn mid-write line
    ])

    const events = readClaudeConversationReplay(CWD, SESSION, LIVE)
    for (const e of events) expect(ReplayEntrySchema.safeParse(e).success).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      'RemoteUserTurn', // the human's ask
      'AssistantBlock', // prose (thinking skipped)
      'ToolRequested', // the search card
      'ToolResult', // its output
      'RemoteUserTurn', // string-content turn (sidechain/meta/bookkeeping all skipped)
    ])
    expect(events.every((e) => e.sessionId === LIVE)).toBe(true)
    expect((events[0] as { text: string }).text).toBe('find me cat6 cable')
    expect((events[1] as { markdown: string }).markdown).toBe('Sure — searching now.')
  })

  it('returns [] for a session with no conversation on disk', () => {
    expect(readClaudeConversationReplay(CWD, 'ffffffff-0000-0000-0000-000000000000', LIVE)).toEqual([])
  })
})

describe('purgeProjectSessions', () => {
  const engineDir = (p: string): string =>
    join(fakeHome, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'))

  it('removes the hot store, archive/replay bodies, and the engine jsonl dir', () => {
    const p = uniqueProject()
    writeFileSync(storePath(p), JSON.stringify({ version: 1, sessions: [] }))
    writeFileSync(indexPath(p), JSON.stringify({ version: 2, archived: [] }))
    mkdirSync(bodiesDir(p), { recursive: true })
    writeFileSync(join(bodiesDir(p), 'body.json'), '{}')
    mkdirSync(engineDir(p), { recursive: true })
    writeFileSync(join(engineDir(p), 'sess.jsonl'), '{}')
    appendRemoteReplay(p, 'remote-session', {
      type: 'RemoteUserTurn',
      sessionId: 'remote-session',
      text: 'private prompt',
    })
    expect(loadRemoteReplay(p, 'remote-session')).toHaveLength(1)

    purgeProjectSessions(p)

    expect(existsSync(storePath(p))).toBe(false)
    expect(existsSync(indexPath(p))).toBe(false)
    expect(existsSync(bodiesDir(p))).toBe(false)
    expect(existsSync(engineDir(p))).toBe(false)
    expect(loadRemoteReplay(p, 'remote-session')).toEqual([])
  })

  it('is a no-op (no throw) when nothing exists on disk', () => {
    expect(() => purgeProjectSessions(uniqueProject())).not.toThrow()
  })
})

// C2: archiving a session must never delete it from both the hot store AND the archive at once. The
// realistic trigger is a present-but-unreadable archive index — ingestFullArchives (via
// loadArchivedMeta) throws on that; the bug was throwing AFTER the hot-store row was already dropped.
describe('archiveSession keeps the row alive until the archive write actually lands (C2)', () => {
  const session = (id: string): { id: string; label: string; cwd: string; userNamed: boolean; items: unknown[] } => ({
    id,
    label: 'S',
    cwd: '/x',
    userNamed: false,
    items: [],
  })

  it('a throwing archive ingest leaves the session in the hot store — never gone from both places', () => {
    const p = uniqueProject()
    const store = { version: 3 as const, activeId: 's1', sessions: [session('s1')] }
    saveProjectSessions(p, store)
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(indexPath(p), '{"version":2,"archived":[{"id":"a"') // present but unreadable

    expect(() => archiveSession(p, store, session('s1'), 's1')).toThrow()
    // The buggy ordering called saveProjectSessions (without s1) BEFORE this throw, so s1 vanished from
    // both the hot store and the archive. Fixed: the throw happens before the hot store is ever touched.
    expect(loadProjectSessions(p)?.sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('on a clean archive write, removes the row from the hot store and adds it to the archive', () => {
    const p = uniqueProject()
    const store = {
      version: 3 as const,
      activeId: 's1',
      sessions: [session('s1')],
      starredDocs: ['Documents/brief.md'],
      legacyKeptDocsImported: ['Documents/brief.md'],
    }
    saveProjectSessions(p, store)

    expect(archiveSession(p, store, session('s1'), 's1')).toBe(true)
    expect(loadProjectSessions(p)?.sessions).toEqual([])
    expect(loadProjectSessions(p)).toMatchObject({
      starredDocs: ['Documents/brief.md'],
      legacyKeptDocsImported: ['Documents/brief.md'],
    })
    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['s1'])
  })

  it('repairs a stale hot row when the same id is already durably archived', () => {
    const p = uniqueProject()
    const stale = session('stale')
    const live = session('live')
    saveProjectSessions(p, {
      version: 3,
      activeId: stale.id,
      sessions: [stale, live],
    })
    saveArchivedMeta(p, [
      { id: stale.id, label: stale.label, cwd: stale.cwd, archivedAt: Date.now() },
    ])
    writeArchivedBody(p, stale.id, stale.items)

    const loaded = loadProjectSessions(p)

    expect(loaded?.sessions.map((row) => row.id)).toEqual(['live'])
    expect(loaded?.activeId).toBeNull()
    const repaired = JSON.parse(readFileSync(storePath(p), 'utf8')) as {
      activeId: string | null
      sessions: { id: string }[]
    }
    expect(repaired.sessions.map((row) => row.id)).toEqual(['live'])
    expect(repaired.activeId).toBeNull()
  })

  it('lets a legacy inline archive migrate before it tombstones the stale hot twin', () => {
    const p = uniqueProject()
    const stale = session('stale')
    saveProjectSessions(p, { version: 3, activeId: stale.id, sessions: [stale] })
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 1,
        archived: [
          {
            ...stale,
            items: [{ id: 7, kind: 'user', text: 'durable archive' }],
            archivedAt: Date.now(),
          },
        ],
      }),
    )

    expect(loadProjectSessions(p)?.sessions).toEqual([])
    expect(loadArchivedBody(p, stale.id)).toEqual([
      { id: 7, kind: 'user', text: 'durable archive' },
    ])
    expect(JSON.parse(readFileSync(indexPath(p), 'utf8')).version).toBe(2)
  })

  it('repairs an expired legacy archive twin before retention removes its migrated body', () => {
    retentionDays = 30
    const p = uniqueProject()
    const stale = session('stale')
    saveProjectSessions(p, { version: 3, activeId: stale.id, sessions: [stale] })
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 1,
        archived: [
          {
            ...stale,
            items: [{ id: 7, kind: 'user', text: 'durable archive' }],
            archivedAt: Date.now() - 40 * 86_400_000,
          },
        ],
      }),
    )

    expect(loadProjectSessions(p)?.sessions).toEqual([])
    expect(loadArchivedMeta(p)).toEqual([])
    expect(loadArchivedBody(p, stale.id)).toBeNull()
    const repaired = JSON.parse(readFileSync(storePath(p), 'utf8')) as { sessions: unknown[] }
    expect(repaired.sessions).toEqual([])
  })

  it('keeps the hot row when archive metadata has no readable transcript body', () => {
    const p = uniqueProject()
    const stale = session('stale')
    saveProjectSessions(p, { version: 3, activeId: stale.id, sessions: [stale] })
    saveArchivedMeta(p, [
      { id: stale.id, label: stale.label, cwd: stale.cwd, archivedAt: Date.now() },
    ])

    const report: StoreReadReport = { dropped: 0 }
    expect(loadProjectSessions(p, report)?.sessions.map((row) => row.id)).toEqual([stale.id])
    expect(report.unreadableArchiveBodyIds).toEqual([stale.id])
    const onDisk = JSON.parse(readFileSync(storePath(p), 'utf8')) as { sessions: { id: string }[] }
    expect(onDisk.sessions.map((row) => row.id)).toEqual([stale.id])
  })

  it('repairs an expired archive twin before retention deletes its tombstone and body', () => {
    retentionDays = 30
    const p = uniqueProject()
    const stale = session('stale')
    saveProjectSessions(p, { version: 3, activeId: stale.id, sessions: [stale] })
    saveArchivedMeta(p, [
      {
        id: stale.id,
        label: stale.label,
        cwd: stale.cwd,
        archivedAt: Date.now() - 40 * 86_400_000,
      },
    ])
    writeArchivedBody(p, stale.id, stale.items)

    expect(loadProjectSessions(p)?.sessions).toEqual([])
    expect(loadArchivedMeta(p)).toEqual([])
    expect(loadArchivedBody(p, stale.id)).toBeNull()
    const repaired = JSON.parse(readFileSync(storePath(p), 'utf8')) as { sessions: unknown[] }
    expect(repaired.sessions).toEqual([])
  })

  it('defers retention when the stale hot-row repair could not reach disk', () => {
    retentionDays = 30
    const p = uniqueProject()
    const stale = session('stale')
    saveProjectSessions(p, { version: 3, activeId: stale.id, sessions: [stale] })
    saveArchivedMeta(p, [
      {
        id: stale.id,
        label: stale.label,
        cwd: stale.cwd,
        archivedAt: Date.now() - 40 * 86_400_000,
      },
    ])
    writeArchivedBody(p, stale.id, stale.items)
    mkdirSync(`${storePath(p)}.tmp`)

    // Memory may honor the archive for this run, but the old hot bytes are still on disk. The cold
    // tombstone therefore has to survive too, ready for the next boot's repair retry.
    expect(loadProjectSessions(p)?.sessions).toEqual([])
    expect(loadArchivedMeta(p).map((meta) => meta.id)).toEqual([stale.id])
    expect(loadArchivedBody(p, stale.id)).toEqual(stale.items)
    const stillStale = JSON.parse(readFileSync(storePath(p), 'utf8')) as { sessions: { id: string }[] }
    expect(stillStale.sessions.map((row) => row.id)).toEqual([stale.id])
  })

  it('a refused body write leaves the only transcript in the hot store', () => {
    const p = uniqueProject()
    const store = { version: 3 as const, activeId: 's1', sessions: [session('s1')] }
    saveProjectSessions(p, store)
    // Block creation of the bodies directory with a regular file. The writer must report failure,
    // splitArchive must throw, and archiveSession must never reach the hot-store removal.
    writeFileSync(bodiesDir(p), 'not a directory')

    expect(() => archiveSession(p, store, session('s1'), 's1')).toThrow(/body could not be persisted/)
    expect(loadProjectSessions(p)?.sessions.map((s) => s.id)).toEqual(['s1'])
    expect(loadArchivedMeta(p)).toEqual([])
  })
})

// W1: the backup a row-drop depends on must not be a one-shot resource that a single benign drop
// permanently consumes, and the drop itself must not proceed on an unconfirmed backup.
describe('the corrupt-backup rule survives more than one boot (W1)', () => {
  it('a second, later drop with DIFFERENT content gets its own backup instead of finding the slot already used', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    // Boot A: one drifted row among the good ones.
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 2,
        archived: [
          { id: 'a', label: 'A', cwd: '/x', archivedAt: 1 },
          { id: 'drifted-1', label: 'B', cwd: '/x' }, // no archivedAt — a row from another build
        ],
      }),
    )
    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['a'])
    expect(corruptBackups(indexPath(p))).toHaveLength(1)

    // Boot B, months later: new archives accumulated meanwhile, and a DIFFERENT row is now drifted.
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 2,
        archived: [
          { id: 'a', label: 'A', cwd: '/x', archivedAt: 1 },
          { id: 'fresh', label: 'F', cwd: '/x', archivedAt: 50 },
          { id: 'drifted-2', label: 'C', cwd: '/x' }, // a different bad row
        ],
      }),
    )
    expect(loadArchivedMeta(p).map((m) => m.id)).toEqual(['a', 'fresh'])

    // The old rule ("any .bak already exists → skip") would leave boot B with NO backup at all, so
    // 'drifted-2' would be gone with no recoverable copy. Content-keyed backups give boot B its own.
    expect(corruptBackups(indexPath(p))).toHaveLength(2)
  })

  it('bounds the pile at MAX_CORRUPT_BACKUPS instead of growing forever', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    for (let i = 0; i < MAX_CORRUPT_BACKUPS + 3; i++) {
      writeFileSync(indexPath(p), `not json at all, attempt ${i}`)
      expect(() => loadArchivedMeta(p)).toThrow()
    }
    expect(corruptBackups(indexPath(p)).length).toBe(MAX_CORRUPT_BACKUPS)
  })

  it('refuses to drop rows when the pre-drop backup itself fails, rather than losing them silently (ENOSPC)', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 2,
        archived: [
          { id: 'a', label: 'A', cwd: '/x', archivedAt: 1 },
          { id: 'drifted', label: 'B', cwd: '/x' },
        ],
      }),
    )
    copyFileImpl = () => {
      throw new Error('ENOSPC')
    }
    expect(() => loadArchivedMeta(p)).toThrow()
    expect(corruptBackups(indexPath(p))).toHaveLength(0) // the failed copy left nothing behind
  })
})

// W2: a zero-length (or whitespace-only) file holds no data and has nothing to protect — it must read
// like an absent file, not like corruption (else the project bricks forever over an empty file).
describe('a zero-length store file reads as absent, not corrupt (W2)', () => {
  it('loadProjectSessions treats an empty file like no file at all, and stays writable afterward', () => {
    const p = uniqueProject()
    writeFileSync(storePath(p), '')
    expect(loadProjectSessions(p)).toBeNull()
    expect(corruptBackups(storePath(p))).toHaveLength(0) // nothing to protect — no backup taken

    // Not bricked: a normal save afterward lands fine (the old bug refused to save over it forever).
    saveProjectSessions(p, { version: 3, activeId: null, sessions: [] })
    expect(loadProjectSessions(p)).toEqual({ version: 3, activeId: null, sessions: [] })
  })

  it('whitespace-only counts as empty too', () => {
    const p = uniqueProject()
    writeFileSync(storePath(p), '   \n\t  ')
    expect(loadProjectSessions(p)).toBeNull()
  })

  it('loadArchivedMeta treats an empty index like no index at all', () => {
    const p = uniqueProject()
    writeFileSync(indexPath(p), '')
    expect(loadArchivedMeta(p)).toEqual([])
    expect(corruptBackups(indexPath(p))).toHaveLength(0)
  })
})

// W5: per-row tolerance was applied to archives but not to the session list, where the named trigger
// (a newer build's approvalMode value) actually hits.
describe('one drifted session field costs only itself, not the whole project (W5)', () => {
  it('keeps the good sessions when one row is malformed, warns, and backs the store up', () => {
    const p = uniqueProject()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      storePath(p),
      JSON.stringify({
        version: 3,
        activeId: 'b',
        projectPath: p,
        sessions: [
          { id: 'a', label: 'A', cwd: '/x', items: [] },
          { id: 'drifted', label: 'B', cwd: '/x', items: [], approvalMode: 'not-a-real-enum-value' },
          { id: 'c', label: 'C', cwd: '/x', items: [] },
        ],
      }),
    )

    const loaded = loadProjectSessions(p)
    expect(loaded?.sessions.map((s) => s.id)).toEqual(['a', 'c']) // one bad row costs only itself
    expect(warn.mock.calls.some(([, msg]) => msg.includes('dropped 1 unreadable session row'))).toBe(true)
    // Dropping rows means the next save writes a SHORTER store, so the original must be backed up first.
    const backups = corruptBackups(storePath(p))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(readFileSync(backups[0], 'utf8')).sessions).toHaveLength(3)
  })
})

// C1: the drop above returns a SUCCESS, so saving stays on and the shortened list is written back ~500ms
// later. The count is therefore the user's only notice that a chat left the list, and it has to leave
// this module to be shown at all — a log line is not a user-facing surface.
describe('a partial drop reports how many rows it set aside (C1)', () => {
  it('loadProjectSessions counts the dropped session rows into the report', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      storePath(p),
      JSON.stringify({
        version: 3,
        activeId: 'a',
        projectPath: p,
        sessions: [
          { id: 'a', label: 'A', cwd: '/x', items: [] },
          { id: 'drifted', label: 'B', cwd: '/x', items: [], approvalMode: 'not-a-real-enum-value' },
          { id: 'drifted-2', label: 'C', cwd: '/x', items: [], approvalMode: 'also-not-real' },
        ],
      }),
    )

    const report: StoreReadReport = { dropped: 0 }
    expect(loadProjectSessions(p, report)?.sessions.map((s) => s.id)).toEqual(['a'])
    expect(report.dropped).toBe(2)
  })

  it('loadArchivedMeta counts the dropped archive rows into the report', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 2,
        archived: [
          { id: 'a', label: 'A', cwd: '/x', archivedAt: 1 },
          { id: 'drifted', label: 'B', cwd: '/x' }, // no archivedAt — a row from another build
        ],
      }),
    )

    const report: StoreReadReport = { dropped: 0 }
    expect(loadArchivedMeta(p, report).map((m) => m.id)).toEqual(['a'])
    expect(report.dropped).toBe(1)
  })

  it('the preliminary tombstone read does not hide a malformed archive row from the reported load', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    saveProjectSessions(p, { version: 3, activeId: null, sessions: [] })
    writeFileSync(
      indexPath(p),
      JSON.stringify({
        version: 2,
        archived: [
          { id: 'same', label: 'Newest', cwd: '/x', archivedAt: 30 },
          { id: 'drifted', label: 'Unreadable', cwd: '/x' },
          { id: 'same', label: 'Older', cwd: '/x', archivedAt: 20 },
        ],
      }),
    )

    loadProjectSessions(p)
    const report: StoreReadReport = { dropped: 0 }
    expect(loadArchivedMeta(p, report).map((meta) => meta.id)).toEqual(['same'])
    expect(report.dropped).toBe(1)
  })

  it('a clean read reports no drops at all', () => {
    const p = uniqueProject()
    saveProjectSessions(p, { version: 3, activeId: null, sessions: [] })
    const report: StoreReadReport = { dropped: 0 }
    loadProjectSessions(p, report)
    expect(report.dropped).toBe(0)
  })
})

// W1: the banner tells the user Koda "kept a copy beside it". keepCorrupt returns whether that copy
// actually landed, and every throw path used to discard that answer — so the promise was made even in
// the two cases where no copy exists. A promised recovery file that isn't there is worse than none.
describe('a failed read reports whether a copy was actually kept (W1)', () => {
  it('reports backupKept when the copy did land', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(storePath(p), '{"version":2,"activeId":null,"sessions":[{"id":"a"') // torn file

    const err = catchError(() => loadProjectSessions(p))
    expect(err).toBeInstanceOf(StoreReadError)
    expect((err as StoreReadError).backupKept).toBe(true)
    expect(corruptBackups(storePath(p))).toHaveLength(1) // and the claim is true
  })

  it('reports backupKept false when copying the store fails (ENOSPC, a read-only userData)', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(storePath(p), '{"version":2,"activeId":null,"sessions":[{"id":"a"')
    copyFileImpl = () => {
      throw new Error('ENOSPC: no space left on device')
    }

    const err = catchError(() => loadProjectSessions(p))
    expect((err as StoreReadError).backupKept).toBe(false)
    expect(corruptBackups(storePath(p))).toHaveLength(0) // nothing to promise the user
  })

  it('reports backupKept false when the store itself cannot be read (EACCES/EIO)', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(storePath(p), '{"version":2,"activeId":null,"sessions":[]}')
    // The backup path has no `content` to fall back on here, so it re-reads a file that just proved
    // unreadable and fails for the same reason. This is the case that reaches keepCorrupt empty-handed.
    chmodSync(storePath(p), 0o000)
    try {
      const err = catchError(() => loadProjectSessions(p))
      expect(err).toBeInstanceOf(StoreReadError)
      expect((err as StoreReadError).backupKept).toBe(false)
      expect(corruptBackups(storePath(p))).toHaveLength(0)
    } finally {
      chmodSync(storePath(p), 0o600)
    }
  })

  it('reports backupKept false when the archive index cannot be copied either', () => {
    const p = uniqueProject()
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(indexPath(p), '{"version":2,"archived":[{"id":"a"')
    copyFileImpl = () => {
      throw new Error('ENOSPC: no space left on device')
    }

    const err = catchError(() => loadArchivedMeta(p))
    expect((err as StoreReadError).backupKept).toBe(false)
  })
})

// Item 24: koda-app-state.json shares the same "unreadable read -> empty success -> write clobbers real
// file" defect shape as the session/archive stores above, but nothing downstream can refuse to persist
// on its behalf (there's no renderer for this file) -- the refusal has to be enforced main-side, inside
// every mutator.
describe('app state: an unreadable read never lets the next write clobber it', () => {
  const appStatePath = join(tmpdir(), 'koda-app-state.json')
  const appStateBackups = (): string[] => corruptBackups(appStatePath)

  function cleanAppState(): void {
    rmSync(appStatePath, { force: true })
    for (const b of appStateBackups()) rmSync(b, { force: true })
  }

  beforeEach(cleanAppState)
  afterEach(cleanAppState)

  it('no file yet reads as empty, not as a failure', () => {
    expect(loadAppState()).toEqual({ version: 1, openProjects: [], recentProjects: [], knownProjects: [] })
  })

  it('an unparseable app state file is never overwritten by an automatic write', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const original = '{"version":1,"openProjects":[],"recentProjects":["/a"' // torn file
    writeFileSync(appStatePath, original)

    noteProjectClosed('/koda-test/some-project') // a window closing -- nobody asked for this

    expect(readFileSync(appStatePath, 'utf8')).toBe(original) // untouched -- the write was skipped
    expect(warn.mock.calls.some(([, msg]) => String(msg).includes('refusing to let a write clobber it'))).toBe(
      true,
    )
  })

  // The other half of that refusal, and the reason it isn't a dead end. Refusing EVERY write meant the
  // project a user picked by hand was forgotten again at the next launch, and the next, forever, behind
  // a ProjectHome that reads as a fresh install. A user-initiated open is consent to replace a file that
  // has already been copied aside.
  it('a project the user opens rebuilds the list, and the unreadable original is kept beside it', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const original = '{"version":1,"openProjects":[],"recentProjects":["/a"'
    writeFileSync(appStatePath, original)

    noteProjectOpened('/koda-test/new-project')

    const saved = JSON.parse(readFileSync(appStatePath, 'utf8'))
    expect(saved.openProjects).toEqual(['/koda-test/new-project'])
    expect(saved.recentProjects).toEqual(['/koda-test/new-project'])
    expect(saved.knownProjects).toEqual(['/koda-test/new-project']) // the phone's list restarts too
    // Replacing it is only acceptable because the original is still recoverable.
    const backups = appStateBackups()
    expect(backups).toHaveLength(1)
    expect(readFileSync(backups[0], 'utf8')).toBe(original)
  })

  it('a user-initiated open still refuses when no copy of the unreadable file could be kept', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const original = '{"version":1,"openProjects":[],"recentProjects":["/a"'
    writeFileSync(appStatePath, original)
    // A failed copy (ENOSPC, a read-only userData) means the live file is the ONLY copy, which is
    // precisely when replacing it would be the loss this refusal exists to prevent.
    copyFileImpl = () => {
      throw new Error('ENOSPC')
    }

    noteProjectOpened('/koda-test/new-project')

    expect(readFileSync(appStatePath, 'utf8')).toBe(original)
  })

  it('reports the unreadable list to the renderer, and stops once a load succeeds', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(appStatePath, '{"version":1,"openProjects":[],"recentProjects":["/a"')

    loadAppState() // what boot does -- the empty result it returns looks exactly like a fresh install
    expect(appStateHealth()).toEqual({ unreadable: true, backupKept: true })

    // The latch reports what the last strict READ found, so the recovery write leaves it set and the
    // next read clears it. In the app that read is immediate (buildAppMenu re-reads recents right after
    // an open), which is what stops the notice outliving the problem on a later ProjectHome window.
    noteProjectOpened('/koda-test/new-project')
    loadAppState()
    expect(appStateHealth()).toEqual({ unreadable: false, backupKept: null })
  })

  it('a version-mismatched app state (downgrade) is never overwritten by saveWindowBounds', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const original = JSON.stringify({ version: 2, openProjects: [], recentProjects: ['/a'], knownProjects: ['/a'] })
    writeFileSync(appStatePath, original)

    saveWindowBounds({ x: 0, y: 0, width: 100, height: 100 })

    expect(readFileSync(appStatePath, 'utf8')).toBe(original)
  })

  it('keeps the unreadable app state as .corrupt-<hash>.bak before anything can replace it', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const original = '{"version":1,"openProjects":[],"recentProjects":["/a"'
    writeFileSync(appStatePath, original)

    noteProjectClosed('/koda-test/whatever') // a write path -- must not clobber, but must back up first

    const backups = appStateBackups()
    expect(backups).toHaveLength(1)
    expect(readFileSync(backups[0], 'utf8')).toBe(original)
  })

  it('one drifted entry in recentProjects costs only itself, and the write still lands', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      appStatePath,
      JSON.stringify({
        version: 1,
        openProjects: [],
        recentProjects: ['/good-1', 42, '/good-2'], // a drifted non-string row
        knownProjects: ['/good-1', '/good-2'],
      }),
    )

    const loaded = loadAppState()
    expect(loaded.recentProjects).toEqual(['/good-1', '/good-2']) // the bad row cost only itself
    expect(
      warn.mock.calls.some(([, msg]) => String(msg).includes('dropped 1 unreadable recent-project row')),
    ).toBe(true)
    expect(appStateBackups()).toHaveLength(1) // the original (with the bad row) is still recoverable

    // A row drop is a SUCCESSFUL load (unlike a throw), so a write proceeds -- same contract as the
    // per-project session store: the shorter, valid list is what actually gets saved.
    noteProjectOpened('/good-3')
    const saved = JSON.parse(readFileSync(appStatePath, 'utf8'))
    expect(saved.recentProjects).toEqual(['/good-3', '/good-1', '/good-2'])
  })

  it('one drifted entry in knownProjects costs only itself', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(
      appStatePath,
      JSON.stringify({
        version: 1,
        openProjects: [],
        recentProjects: [],
        knownProjects: ['/good-1', { not: 'a string' }, '/good-2'],
      }),
    )

    expect(loadAppState().knownProjects).toEqual(['/good-1', '/good-2'])
  })
})

/** The thrown value itself is the assertion target here (`toThrow` only sees the message). */
function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw, got a clean return')
}

/**
 * Resume state moved into a driver-owned blob. Rows saved before that (and headless phone rows, whose
 * transcript main never persists) carry no cursor, so the store rebuilds one from what the row can
 * prove — otherwise every existing chat would silently restart clean on the next launch.
 */
describe('resume cursor fallback for rows saved without one', () => {
  it('rebuilds a Codex cursor from the old engineNativeId field', () => {
    expect(
      withResumeCursorFallback({ id: 's1', cwd: '/tmp/p', engineId: 'codex', engineNativeId: 'thread-1', items: [{}] }),
    ).toMatchObject({ resumeCursor: { engine: 'codex', resumable: true, data: { threadId: 'thread-1', turns: 1 } } })
  })

  it('rebuilds a Claude cursor from the session id and its transcript', () => {
    expect(withResumeCursorFallback({ id: 's2', cwd: '/tmp/p', items: [{}] })).toMatchObject({
      resumeCursor: { engine: 'claude', resumable: true, data: { sessionId: 's2', turns: 1 } },
    })
  })

  it('leaves a row with nothing to reattach to restarting clean', () => {
    expect(withResumeCursorFallback({ id: 's3', cwd: '/tmp/koda-no-conversation-here', items: [] })).toMatchObject({
      resumeCursor: { engine: 'claude', resumable: false, data: { turns: 0 } },
    })
    // A Codex row with no thread id has nothing to rebuild from at all.
    expect(withResumeCursorFallback({ id: 's4', cwd: '/tmp/p', engineId: 'codex', items: [{}] })).not.toHaveProperty(
      'resumeCursor',
    )
  })

  it('never overwrites a cursor the driver already reported', () => {
    const row = { id: 's5', cwd: '/tmp/p', items: [{}], resumeCursor: { engine: 'claude', resumable: false, data: {} } }
    expect(withResumeCursorFallback(row)).toBe(row)
  })
})
