import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

import {
  deleteArchivedBody,
  ingestFullArchives,
  loadArchivedBody,
  loadArchivedMeta,
  purgeProjectSessions,
  readClaudeConversationReplay,
  saveArchivedMeta,
  writeArchivedBody,
} from './session-store'
import { ReplayEntrySchema } from '@shared/ipc'
import { mkdirSync } from 'node:fs'

// The electron stub points getPath('userData') at tmpdir(); reconstruct the archive paths the module
// derives (hash of the project path) so a test can plant a v1 blob and inspect the result.
const hash = (p: string): string => createHash('sha256').update(p).digest('hex').slice(0, 16)
const indexPath = (p: string): string => join(tmpdir(), `koda-archive-${hash(p)}.json`)
const bodiesDir = (p: string): string => join(tmpdir(), `koda-archive-${hash(p)}.bodies`)

const created: string[] = []
function uniqueProject(): string {
  const p = `/koda-test/${Math.random().toString(36).slice(2)}-${process.hrtime.bigint()}`
  created.push(p)
  return p
}

afterEach(() => {
  retentionDays = 0
  for (const p of created.splice(0)) {
    rmSync(indexPath(p), { force: true })
    rmSync(`${indexPath(p)}.v1.bak`, { force: true })
    rmSync(bodiesDir(p), { recursive: true, force: true })
  }
})

describe('archive storage split', () => {
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

  it('distinguishes a genuinely empty body ([]) from a failed read (null)', () => {
    const p = uniqueProject()
    writeArchivedBody(p, 'empty', []) // a minimal/headless archive with no transcript
    expect(loadArchivedBody(p, 'empty')).toEqual([]) // clean read of an empty body → []
    expect(loadArchivedBody(p, 'missing')).toBeNull() // no file at all → null, so restore won't destroy it
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
  const storePath = (p: string): string => join(tmpdir(), `koda-sessions-${hash(p)}.json`)
  const engineDir = (p: string): string =>
    join(fakeHome, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'))

  it('removes the hot store, archive index/bodies, and the engine jsonl dir', () => {
    const p = uniqueProject()
    writeFileSync(storePath(p), JSON.stringify({ version: 1, sessions: [] }))
    writeFileSync(indexPath(p), JSON.stringify({ version: 2, archived: [] }))
    mkdirSync(bodiesDir(p), { recursive: true })
    writeFileSync(join(bodiesDir(p), 'body.json'), '{}')
    mkdirSync(engineDir(p), { recursive: true })
    writeFileSync(join(engineDir(p), 'sess.jsonl'), '{}')

    purgeProjectSessions(p)

    expect(existsSync(storePath(p))).toBe(false)
    expect(existsSync(indexPath(p))).toBe(false)
    expect(existsSync(bodiesDir(p))).toBe(false)
    expect(existsSync(engineDir(p))).toBe(false)
  })

  it('is a no-op (no throw) when nothing exists on disk', () => {
    expect(() => purgeProjectSessions(uniqueProject())).not.toThrow()
  })
})
