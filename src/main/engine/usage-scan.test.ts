// The scanner's contract: transcripts on disk in the CLIs' real shapes become day×model×origin
// buckets, replayed history never double-counts, and an unchanged file is served from the cache.
// TZ is pinned before any Date use so local-day assertions hold on any machine.
process.env.TZ = 'America/Chicago'

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'koda-usage-scan-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
vi.mock('../logger', () => ({ log: { info: () => {}, warn: () => {} } }))

const { scanUsageTranscripts, recordKodaClaudeSession } = await import('./usage-scan')
type Roots = NonNullable<Parameters<typeof scanUsageTranscripts>[0]>

const claudeRoot = join(dir, 'claude-projects')
const codexOutsideRoot = join(dir, 'codex-sessions')
const codexKodaRoot = join(dir, 'codex-koda')

const roots: Roots = [
  { engine: 'claude', root: claudeRoot, kind: 'claude' },
  { engine: 'codex', root: codexOutsideRoot, kind: 'codex', origin: 'outside' },
  { engine: 'codex', root: codexKodaRoot, kind: 'codex', origin: 'koda' },
]

// 2026-08-20T04:30Z is 2026-08-19 23:30 in America/Chicago — the local-day assertion below is the
// whole point of pinning TZ.
const TS = '2026-08-20T04:30:00.000Z'
const LOCAL_DAY = '2026-08-19'

function claudeRecord(opts: {
  sessionId?: string
  messageId?: string
  requestId?: string
  model?: string
  input?: number
  cacheRead?: number
  cacheCreation?: number
  output?: number
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId ?? 'sess-a',
    requestId: opts.requestId,
    timestamp: opts.timestamp ?? TS,
    message: {
      id: opts.messageId,
      model: opts.model ?? 'claude-opus-5',
      usage: {
        input_tokens: opts.input ?? 10,
        cache_read_input_tokens: opts.cacheRead ?? 100,
        cache_creation_input_tokens: opts.cacheCreation ?? 5,
        output_tokens: opts.output ?? 20,
      },
    },
  })
}

function codexFile(model: string, usages: { input: number; cached: number; output: number; reasoning: number }[]): string {
  const lines = [
    JSON.stringify({ timestamp: TS, type: 'session_meta', payload: { session_id: 'c1' } }),
    JSON.stringify({ timestamp: TS, type: 'turn_context', payload: { model, cwd: '/x' } }),
    ...usages.map((u) =>
      JSON.stringify({
        timestamp: TS,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 999999, cached_input_tokens: 999990, output_tokens: 99999, reasoning_output_tokens: 9999 },
            last_token_usage: {
              input_tokens: u.input,
              cached_input_tokens: u.cached,
              output_tokens: u.output,
              reasoning_output_tokens: u.reasoning,
            },
          },
        },
      }),
    ),
  ]
  return lines.join('\n') + '\n'
}

beforeEach(() => {
  for (const root of [claudeRoot, codexOutsideRoot, codexKodaRoot]) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  }
  rmSync(join(dir, 'koda-usage-scan.json'), { force: true })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('claude transcripts', () => {
  it('buckets assistant usage by local day and model, skipping non-usage and synthetic rows', async () => {
    const project = join(claudeRoot, '-users-rb-proj')
    mkdirSync(project)
    writeFileSync(
      join(project, 'a.jsonl'),
      [
        claudeRecord({ messageId: 'm1', requestId: 'r1' }),
        JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user' } }),
        claudeRecord({ messageId: 'm2', requestId: 'r2', model: '<synthetic>' }),
        'not json at all',
        '',
      ].join('\n'),
    )
    const summary = await scanUsageTranscripts(roots)
    expect(summary.buckets).toHaveLength(1)
    const b = summary.buckets[0]
    expect(b).toMatchObject({
      day: LOCAL_DAY,
      engine: 'claude',
      model: 'claude-opus-5',
      origin: 'outside',
      uncachedInput: 10,
      cachedInput: 100,
      cacheCreation: 5,
      output: 20,
      records: 1,
    })
    const claudeSource = summary.sources.find((s) => s.root === claudeRoot)
    expect(claudeSource?.malformedRecords).toBe(1)
  })

  it('counts a record replayed into a second file once, and unkeyed records every time', async () => {
    const project = join(claudeRoot, '-users-rb-proj')
    mkdirSync(project)
    const replayed = claudeRecord({ messageId: 'm1', requestId: 'r1', output: 7 })
    writeFileSync(join(project, 'original.jsonl'), replayed + '\n' + claudeRecord({ output: 3 }))
    writeFileSync(join(project, 'fork.jsonl'), replayed + '\n')
    const summary = await scanUsageTranscripts(roots)
    const b = summary.buckets[0]
    // m1:r1 once (7) + the unkeyed record (3); the fork's copy of m1:r1 is dropped.
    expect(b.output).toBe(10)
    expect(b.records).toBe(2)
  })

  it('attributes registered Koda session ids to koda and everything else to outside', async () => {
    recordKodaClaudeSession('koda-sess')
    const project = join(claudeRoot, '-users-rb-proj')
    mkdirSync(project)
    writeFileSync(
      join(project, 'a.jsonl'),
      [
        claudeRecord({ sessionId: 'koda-sess', messageId: 'm1', requestId: 'r1' }),
        claudeRecord({ sessionId: 'terminal-sess', messageId: 'm2', requestId: 'r2' }),
      ].join('\n'),
    )
    const summary = await scanUsageTranscripts(roots)
    const origins = summary.buckets.map((b) => b.origin).sort()
    expect(origins).toEqual(['koda', 'outside'])

    // The registration must survive into the persisted registry, not just this process's memory.
    const again = await scanUsageTranscripts(roots)
    expect(again.buckets.map((b) => b.origin).sort()).toEqual(['koda', 'outside'])
  })
})

describe('codex rollouts', () => {
  it('collapses the repeated lifecycle copies of one delta into a single count', async () => {
    const day = join(codexOutsideRoot, '2026', '08', '19')
    mkdirSync(day, { recursive: true })
    // Older CLIs emit the same last_token_usage at two lifecycle points; only distinct consecutive
    // deltas may count (proven against real rollouts: collapsed sum == final total_token_usage).
    const one = { input: 1000, cached: 900, output: 50, reasoning: 10 }
    const two = { input: 200, cached: 0, output: 30, reasoning: 5 }
    writeFileSync(join(day, 'rollout-paired.jsonl'), codexFile('gpt-5.3-codex', [one, one, two, two]))
    const summary = await scanUsageTranscripts(roots)
    const b = summary.buckets.find((x) => x.engine === 'codex')
    expect(b).toMatchObject({ output: 80, records: 2 })
  })

  it('sums per-response deltas under the turn_context model, splitting cached from uncached input', async () => {
    const day = join(codexOutsideRoot, '2026', '08', '19')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, 'rollout-1.jsonl'),
      codexFile('gpt-5.3-codex', [
        { input: 1000, cached: 900, output: 50, reasoning: 10 },
        { input: 200, cached: 0, output: 30, reasoning: 5 },
      ]),
    )
    const kodaDay = join(codexKodaRoot, '2026', '08', '19')
    mkdirSync(kodaDay, { recursive: true })
    writeFileSync(join(kodaDay, 'rollout-2.jsonl'), codexFile('gpt-5.3-codex', [{ input: 10, cached: 0, output: 1, reasoning: 0 }]))

    const summary = await scanUsageTranscripts(roots)
    const outside = summary.buckets.find((b) => b.engine === 'codex' && b.origin === 'outside')
    expect(outside).toMatchObject({
      day: LOCAL_DAY,
      model: 'gpt-5.3-codex',
      uncachedInput: 300,
      cachedInput: 900,
      output: 80,
      reasoning: 15,
      records: 2,
    })
    const koda = summary.buckets.find((b) => b.engine === 'codex' && b.origin === 'koda')
    expect(koda?.records).toBe(1)
  })
})

describe('cache and coverage', () => {
  it('serves an unchanged file from cache and re-parses it when it grows', async () => {
    const project = join(claudeRoot, '-users-rb-proj')
    mkdirSync(project)
    const file = join(project, 'a.jsonl')
    writeFileSync(file, claudeRecord({ messageId: 'm1', requestId: 'r1', output: 7 }) + '\n')
    // Pin the mtime to a millisecond value first: the filesystem stores nanoseconds but utimes can
    // only restore milliseconds, and the cache compares exact mtimeMs.
    const pinned = new Date('2026-08-19T12:00:00.000Z')
    utimesSync(file, pinned, pinned)
    const first = await scanUsageTranscripts(roots)
    expect(first.buckets[0].output).toBe(7)

    // Same byte length + same mtime = the cache must not re-read; the poisoned content proves it.
    const st = statSync(file)
    const poisoned = claudeRecord({ messageId: 'm1', requestId: 'r1', output: 9 })
    writeFileSync(file, poisoned.padEnd(st.size - 1) + '\n')
    utimesSync(file, pinned, pinned)
    const second = await scanUsageTranscripts(roots)
    expect(second.buckets[0].output).toBe(7)

    writeFileSync(file, claudeRecord({ messageId: 'm1', requestId: 'r1', output: 7 }) + '\n' + claudeRecord({ output: 3 }) + '\n')
    const third = await scanUsageTranscripts(roots)
    expect(third.buckets[0].output).toBe(10)
  })

  it('treats an older cache version as stale and rebuilds it, keeping the cache writable', async () => {
    // A v1 file (pre-hourly rows) parses fine; treating it as corrupt would flip writable off and
    // disable the cache forever. It must be discarded, rebuilt, and OVERWRITTEN on the first scan.
    writeFileSync(
      join(dir, 'koda-usage-scan.json'),
      JSON.stringify({ version: 1, knownClaudeSessions: {}, files: { '/old/file.jsonl': { mtimeMs: 1, size: 1, malformed: 0, rows: [] } } }),
    )
    const project = join(claudeRoot, '-users-rb-proj')
    mkdirSync(project)
    writeFileSync(join(project, 'a.jsonl'), claudeRecord({ messageId: 'm1', requestId: 'r1' }) + '\n')
    const summary = await scanUsageTranscripts(roots)
    expect(summary.buckets).toHaveLength(1)
    const rewritten = JSON.parse(readFileSync(join(dir, 'koda-usage-scan.json'), 'utf8'))
    expect(rewritten.version).toBe(2)
    expect(rewritten.files['/old/file.jsonl']).toBeUndefined()
  })

  it('reports an absent root as missing instead of failing the scan', async () => {
    rmSync(codexOutsideRoot, { recursive: true, force: true })
    const summary = await scanUsageTranscripts(roots)
    expect(summary.sources.find((s) => s.root === codexOutsideRoot)?.status).toBe('missing')
    expect(summary.buckets).toEqual([])
  })
})
