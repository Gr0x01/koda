/**
 * app-data-engine.mjs — the Mac (authority) half of a mini app's offline data layer.
 *
 * Copy this file VERBATIM into an offline app's `lib/` — do not edit it per app. It is the SAME engine
 * the phone runs over its replica (see create-mini-app/references/phone-face.md, "the offline data
 * contract"): one description in `sync/queries.json` drives both sides, so offline behavior can't drift
 * from online. The app declares its reads/writes once; this engine serves `/api` from them, assigns the
 * authoritative `change_seq` on every write, and exposes `GET /api/_changes?since=` for the phone to
 * catch up its replica. The app never hand-writes route handlers or write SQL.
 *
 * The app's tiny `server.mjs` supplies an open `node:sqlite` DatabaseSync and the parsed queries.json,
 * then forwards each `/api` request here. Everything else (static assets, listen) stays in server.mjs.
 *
 * Schema the engine assumes every write-mapped table carries (the app-data skill owns declaring these):
 *   - `id`         TEXT PRIMARY KEY   — client-generated stable id (never an autoincrement identity)
 *   - `deleted`    INTEGER NOT NULL DEFAULT 0   — tombstone flag (a delete sets 1; reads filter deleted=0)
 *   - `change_seq` INTEGER NOT NULL DEFAULT 0   — the engine stamps this on every write
 */

const META_TABLE = '_app_meta'
const SEQ_KEY = 'change_seq'

/** SQLite identifiers (table + column names) come from the app's own queries.json / rows, but guard them
 *  anyway so a malformed declaration or row can never smuggle SQL through a dynamic identifier. */
function ident(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`)
  return `"${name}"`
}

/** Match a `"<METHOD> <path>"` route key (with `:param` segments) against a request. Returns captured
 *  path params, or null when it doesn't match. Identical grammar to the phone dispatcher's matchRoute. */
export function matchRoute(routeKey, method, pathname) {
  const sp = routeKey.indexOf(' ')
  if (sp < 0) return null
  if (routeKey.slice(0, sp).toUpperCase() !== method.toUpperCase()) return null
  const r = routeKey.slice(sp + 1).split('/')
  const p = pathname.split('/')
  if (r.length !== p.length) return null
  const params = {}
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(':')) params[r[i].slice(1)] = decodeURIComponent(p[i])
    else if (r[i] !== p[i]) return null
  }
  return params
}

function findRoute(map, method, path) {
  for (const key of Object.keys(map)) {
    const params = matchRoute(key, method, path)
    if (params) return { key, spec: map[key], params }
  }
  return null
}

/** The named params (`:name`) a SQL string references — node:sqlite rejects params it wasn't given AND
 *  params it doesn't use, so bind exactly what the query asks for and nothing more. */
function referencedParams(sql) {
  const names = new Set()
  for (const m of sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1])
  return names
}

/** Build an upsert-by-id for a full row (the row must carry `id`). Mirrors the phone's upsertStatement so
 *  a write applied here matches the optimistic write the phone already applied to its replica. */
function upsertStatement(table, row) {
  const cols = Object.keys(row)
  if (!cols.includes('id')) throw new Error(`write for ${table} has no id`)
  const assign = cols.filter((c) => c !== 'id')
  const sql =
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) ` +
    `VALUES (${cols.map((c) => `:${c}`).join(', ')}) ` +
    (assign.length
      ? `ON CONFLICT(id) DO UPDATE SET ${assign.map((c) => `${ident(c)} = :${c}`).join(', ')}`
      : `ON CONFLICT(id) DO NOTHING`)
  return { sql, params: row }
}

/**
 * Create the engine over an open DatabaseSync (`db`) and the parsed `queries.json` (`{ reads, writes }`).
 * `db` must expose node:sqlite's `prepare(sql)` (→ `{ all(params), get(params), run(params) }`) and
 * `exec(sql)` for transaction control.
 */
export function createEngine({ db, queries }) {
  const reads = queries.reads ?? {}
  const writes = queries.writes ?? {}
  // The synced tables: every table any write route maps to. This is the set `_changes` scans.
  const tables = [...new Set(Object.values(writes).map((w) => w.table))]

  // Seed the monotonic counter above any change_seq already present (a fresh snapshot may carry history),
  // so a restart never re-issues a sequence the phone has already seen.
  db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`)
  let maxExisting = 0
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT MAX(change_seq) AS m FROM ${ident(t)}`).get()
      if (row && Number.isFinite(row.m)) maxExisting = Math.max(maxExisting, row.m)
    } catch {
      /* table may not exist yet at first boot; its writes will create rows above 0 */
    }
  }
  db.prepare(`INSERT INTO ${META_TABLE} (k, v) VALUES (:k, :v) ON CONFLICT(k) DO UPDATE SET v = MAX(v, :v)`).run({
    k: SEQ_KEY,
    v: maxExisting,
  })

  function nextSeq() {
    db.prepare(`UPDATE ${META_TABLE} SET v = v + 1 WHERE k = :k`).run({ k: SEQ_KEY })
    return db.prepare(`SELECT v FROM ${META_TABLE} WHERE k = :k`).get({ k: SEQ_KEY }).v
  }

  /** The current change-sequence high-water mark. server.mjs stamps a snapshot with this as its
   *  `baseSeq`, so the phone's first `_changes?since=baseSeq` pull after loading the copy returns only
   *  what changed AFTER the snapshot was taken. */
  function currentSeq() {
    return db.prepare(`SELECT v FROM ${META_TABLE} WHERE k = :k`).get({ k: SEQ_KEY }).v
  }

  function runRead(spec, params) {
    const want = referencedParams(spec)
    const bound = {}
    for (const [k, v] of Object.entries(params)) if (want.has(k)) bound[k] = v
    return db.prepare(spec).all(bound)
  }

  function runWrite(spec, params, body) {
    const row = { ...(body ?? {}) }
    const id = row.id ?? params.id
    if (id == null) return { status: 400, body: { error: 'write has no id' } }
    row.id = id
    let toWrite
    if (spec.op === 'delete') {
      toWrite = { id, deleted: 1, change_seq: nextSeq() }
    } else {
      row.deleted = row.deleted ?? 0
      row.change_seq = nextSeq()
      toWrite = row
    }
    const { sql, params: p } = upsertStatement(spec.table, toWrite)
    db.exec('BEGIN')
    try {
      db.prepare(sql).run(p)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    const saved = db.prepare(`SELECT * FROM ${ident(spec.table)} WHERE id = :id`).get({ id })
    return { status: 200, body: { ok: true, row: saved } }
  }

  function changesSince(since) {
    const from = Number.isFinite(since) ? since : 0
    const changes = []
    let cursor = from
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM ${ident(t)} WHERE change_seq > :since`).all({ since: from })
      for (const row of rows) {
        changes.push({ table: t, id: row.id, row, deleted: row.deleted, change_seq: row.change_seq })
        if (row.change_seq > cursor) cursor = row.change_seq
      }
    }
    changes.sort((a, b) => a.change_seq - b.change_seq)
    return { changes, cursor }
  }

  /** Answer one `/api` request. `req` = `{ method, path, query, body }`; `path` is app-relative. */
  function handle(req) {
    const method = String(req.method || 'GET').toUpperCase()
    const path = req.path

    if (method === 'GET' && path === '/api/_changes') {
      const since = Number(req.query?.since ?? 0)
      return { status: 200, body: changesSince(since) }
    }

    const read = findRoute(reads, method, path)
    if (read) return { status: 200, body: runRead(read.spec, { ...(req.query ?? {}), ...read.params }) }

    const write = findRoute(writes, method, path)
    if (write) return runWrite(write.spec, write.params, req.body)

    return { status: 404, body: { error: `no route for ${method} ${path}` } }
  }

  return { handle, changesSince, currentSeq, tables }
}
