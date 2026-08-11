/**
 * The Mac (authority) half of the offline app-data contract, tested against a REAL in-memory node:sqlite
 * so the SQL and the change_seq bookkeeping are genuinely exercised — not a fake. The engine source is the
 * canonical file the recipe copies verbatim into every offline mini app; this is its guard.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
// The ship location: the same bytes get vendored into each generated app's lib/.
// @ts-expect-error — plain .mjs, no types
import { createEngine, matchRoute } from '../../../resources/pack-staging/skills/create-mini-app/references/app-data-engine.mjs'

const QUERIES = {
  reads: {
    'GET /api/sets': 'SELECT * FROM sets WHERE deleted=0 ORDER BY change_seq ASC',
    'GET /api/sets/:day': 'SELECT * FROM sets WHERE day=:day AND deleted=0 ORDER BY change_seq ASC',
  },
  writes: {
    'POST /api/sets': { table: 'sets' },
    'DELETE /api/sets/:id': { table: 'sets', op: 'delete' },
  },
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE sets (
    id TEXT PRIMARY KEY,
    day TEXT,
    exercise TEXT,
    reps INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    change_seq INTEGER NOT NULL DEFAULT 0
  )`)
  return db
}

describe('app-data mac engine', () => {
  let db: DatabaseSync
  let engine: ReturnType<typeof createEngine>


  beforeEach(() => {
    db = freshDb()
    engine = createEngine({ db, queries: QUERIES })
  })

  it('creates a row, assigns a climbing change_seq, and reads it back', () => {
    const a = engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', day: 'mon', exercise: 'squat', reps: 5 } })
    expect(a.status).toBe(200)
    expect(a.body.row.change_seq).toBe(1)

    const b = engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's2', day: 'mon', exercise: 'bench', reps: 8 } })
    expect(b.body.row.change_seq).toBe(2)

    const list = engine.handle({ method: 'GET', path: '/api/sets' })
    expect(list.body.map((r: any) => r.id)).toEqual(['s1', 's2'])
  })

  it('binds path params for a read and filters extra query params', () => {
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', day: 'mon', reps: 5 } })
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's2', day: 'tue', reps: 8 } })
    // extra `limit` in the query must not break node:sqlite (it rejects unused named params)
    const r = engine.handle({ method: 'GET', path: '/api/sets/mon', query: { day: 'IGNORED', limit: '10' } })
    expect(r.status).toBe(200)
    expect(r.body.map((x: any) => x.id)).toEqual(['s1'])
  })

  it('upsert-by-id is last-writer-wins, not a duplicate insert', () => {
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', reps: 5 } })
    const upd = engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', reps: 9 } })
    expect(upd.body.row.reps).toBe(9)
    expect(upd.body.row.change_seq).toBe(2)
    const all = engine.handle({ method: 'GET', path: '/api/sets' })
    expect(all.body).toHaveLength(1)
  })

  it('delete tombstones the row and hides it from reads but keeps it in _changes', () => {
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', reps: 5 } })
    const del = engine.handle({ method: 'DELETE', path: '/api/sets/s1' })
    expect(del.status).toBe(200)
    expect(del.body.row.deleted).toBe(1)

    expect(engine.handle({ method: 'GET', path: '/api/sets' }).body).toHaveLength(0)

    const changes = engine.handle({ method: 'GET', path: '/api/_changes', query: { since: 0 } })
    const s1 = changes.body.changes.find((c: any) => c.id === 's1')
    expect(s1.deleted).toBe(1)
  })

  it('_changes returns rows above the cursor in change_seq order, with a fresh cursor', () => {
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', reps: 5 } }) // seq 1
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's2', reps: 8 } }) // seq 2
    const first = engine.handle({ method: 'GET', path: '/api/_changes', query: { since: 0 } }).body
    expect(first.changes.map((c: any) => c.change_seq)).toEqual([1, 2])
    expect(first.cursor).toBe(2)

    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's3', reps: 3 } }) // seq 3
    const next = engine.handle({ method: 'GET', path: '/api/_changes', query: { since: first.cursor } }).body
    expect(next.changes.map((c: any) => c.id)).toEqual(['s3'])
    expect(next.cursor).toBe(3)
  })

  it('a replayed write (phone-generated id) upserts idempotently — no double row', () => {
    // The phone replays the literal request twice (retry after a missing ack); id is stable.
    const op = { method: 'POST', path: '/api/sets', body: { id: 'phone-uuid', reps: 12 } }
    engine.handle(op)
    engine.handle(op)
    expect(engine.handle({ method: 'GET', path: '/api/sets' }).body).toHaveLength(1)
  })

  it('seeds the counter above a snapshot that already carries history', () => {
    db.exec(`INSERT INTO sets (id, reps, change_seq) VALUES ('old', 1, 42)`)
    const e2 = createEngine({ db, queries: QUERIES })
    const w = e2.handle({ method: 'POST', path: '/api/sets', body: { id: 'new', reps: 1 } })
    expect(w.body.row.change_seq).toBe(43)
  })

  it('currentSeq tracks the high-water mark for stamping a snapshot', () => {
    expect(engine.currentSeq()).toBe(0)
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's1', reps: 5 } })
    engine.handle({ method: 'POST', path: '/api/sets', body: { id: 's2', reps: 8 } })
    expect(engine.currentSeq()).toBe(2)
  })

  it('unknown route → 404', () => {
    expect(engine.handle({ method: 'GET', path: '/api/nope' }).status).toBe(404)
  })

  it('matchRoute grammar matches the phone dispatcher', () => {
    expect(matchRoute('GET /api/sets/:day', 'GET', '/api/sets/mon')).toEqual({ day: 'mon' })
    expect(matchRoute('GET /api/sets/:day', 'POST', '/api/sets/mon')).toBeNull()
    expect(matchRoute('GET /api/sets', 'GET', '/api/sets/mon')).toBeNull()
  })
})
