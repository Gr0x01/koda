/**
 * Docs replica — the phone's offline copy of what the user actually reads: `Documents/**` and
 * `.koda/memory/**`. Browse-only by design; it is NEVER a restore input (restore is bundle.ts's
 * job, with git history and its own guards — flat files must not grow a second door). Session
 * transcripts are a named follow-up slice, not in v1.
 *
 * Payload: gzipped JSON { files: [{rel, mtimeMs, bytes, b64}], skipped } sealed with the vault key
 * under its own AAD domain. One object per project, overwritten — the phone always reads the
 * latest. Text-sized by construction: readable documents (markdown/text) plus the images those
 * documents embed, re-encoded to phone-sized webp (webp.ts). A screenshot folder that no document
 * references never ships — the skipped list (INSIDE the sealed blob, since filenames are content)
 * keeps the phone honest about what was left out.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { log } from '../logger'
import { loadReplicaEnabled } from '../settings'
import { encryptBlob, replicaAad } from './crypto'
import { currentUserId, downloadManifest, projectHash, uploadReplica } from './storage'
import { ensureVaultKey } from './vault-key'
import { encodeWebp } from './webp'

/** The replica's roots, relative to the project. Order = display order on the phone. */
const REPLICA_ROOTS = ['Documents', '.koda/memory']

/** Readable-document extensions — the replica is "read your writing on the phone," so it ships text,
 *  not binaries. A font/screenshot/PDF that happens to live under Documents/ isn't a document to read
 *  (and an image referenced by a doc wouldn't resolve on the phone anyway); those are listed, not sent.
 *  Widen this list, never the roots, when a new readable format earns its place. */
const DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'csv', 'json', 'log'])
/** Extensions we treat as an embedded image worth re-encoding to webp for the phone. */
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'tif', 'tiff'])
/** Extensions whose text we scan for image references (markdown only — a .csv has no `![]()`). */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])
/** Per-file cap: even a text file this big is a data dump, not a page — list it, don't ship it. */
const FILE_CAP_BYTES = 2 * 1024 * 1024
/** Whole-snapshot guard (plaintext, pre-gzip) — fail-soft skip, mirrors backup's soft limit posture. */
const TOTAL_CAP_BYTES = 45 * 1024 * 1024

export interface ReplicaFile {
  rel: string
  mtimeMs: number
  bytes: number
  b64: string
}

export interface ReplicaSnapshot {
  schemaVersion: 1
  createdAt: number
  files: ReplicaFile[]
  /** What the per-file cap left out — sealed with everything else, so the phone can say so. */
  skipped: { rel: string; bytes: number }[]
}

export interface ReplicaStatus {
  state: 'idle' | 'uploading' | 'error' | 'too-large'
  replicaAt: number | null
  error?: string
}

interface LocalState extends ReplicaStatus {
  /** Same wedge guard as backup: a hung upload (dead Wi-Fi, sleep mid-send) becomes retryable. */
  uploadingSince?: number
}

const STUCK_MS = 10 * 60_000

const states = new Map<string, LocalState>()

function stateFor(projectDir: string): LocalState {
  let s = states.get(projectDir)
  if (!s) {
    s = { state: 'idle', replicaAt: null }
    states.set(projectDir, s)
  }
  return s
}

/** Walk one replica root, collecting files (hidden entries like .DS_Store excluded). */
async function collectRoot(projectDir: string, root: string, snap: ReplicaSnapshot): Promise<number> {
  const abs = join(projectDir, root)
  const entries = await readdir(abs, { withFileTypes: true, recursive: true }).catch(() => null)
  if (!entries) return 0
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = join(entry.parentPath, entry.name)
    const inside = filePath.slice(abs.length + 1)
    // No hidden files OR files under hidden dirs (.DS_Store, Documents/.obsidian/**) — checked on
    // every segment inside the root, since the recursive readdir flattens the tree.
    if (inside.split('/').some((seg) => seg.startsWith('.'))) continue
    const rel = join(root, inside)
    const st = await stat(filePath).catch(() => null)
    if (!st) continue
    // Not a readable document (font, image, PDF, …) or too big to be a page → record it so the phone
    // can be honest ("N other files aren't copied here"), but never ship the bytes.
    const ext = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
    if (!DOC_EXTS.has(ext) || st.size > FILE_CAP_BYTES) {
      snap.skipped.push({ rel, bytes: st.size })
      continue
    }
    const content = await readFile(filePath).catch(() => null)
    if (!content) continue
    snap.files.push({ rel, mtimeMs: st.mtimeMs, bytes: content.length, b64: content.toString('base64') })
    total += content.length
  }
  return total
}

/** Local image references a markdown doc embeds — `![alt](path)`. (Raw `<img>` HTML is deliberately
 *  ignored: the renderer runs without rehype-raw, so a raw tag never becomes an image on either the
 *  desktop or the phone.) Skips remote/data URLs and strips a `"title"` suffix + URL-encoding. Pure so
 *  the parsing is unit-tested without an Electron encoder. */
export function docImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    let u = m[1].trim().split(/\s+/)[0] // drop a trailing `"title"`
    if (!u || /^(https?:|data:|#|mailto:)/i.test(u)) continue
    try {
      u = decodeURIComponent(u)
    } catch {
      /* keep the raw ref if it isn't valid percent-encoding */
    }
    refs.add(u)
  }
  return [...refs]
}

/** Second pass: for every image a shipped markdown doc references, re-encode it to phone-sized webp
 *  and add it under its project-relative path (the same path the phone recomputes from the doc). An
 *  image no document references never ships. Refs escaping the project, or that fail to encode, are
 *  recorded as skipped. Returns bytes added to the snapshot. */
async function collectDocImages(projectDir: string, snap: ReplicaSnapshot): Promise<number> {
  const projectReal = await realpath(projectDir).catch(() => projectDir)
  const have = new Set(snap.files.map((f) => f.rel))
  const wanted = new Map<string, string>() // project-relative rel → absolute path
  for (const f of snap.files) {
    if (!MARKDOWN_EXTS.has(f.rel.slice(f.rel.lastIndexOf('.') + 1).toLowerCase())) continue
    const docDir = dirname(f.rel)
    for (const ref of docImageRefs(Buffer.from(f.b64, 'base64').toString('utf8'))) {
      if (!IMG_EXTS.has(ref.slice(ref.lastIndexOf('.') + 1).toLowerCase())) continue
      const rel = join(docDir, ref)
      if (have.has(rel) || wanted.has(rel)) continue
      const abs = resolve(projectDir, rel)
      // Containment: the resolved path must stay inside the project (a doc can't exfiltrate ../../secret).
      const realAbs = await realpath(abs).catch(() => abs)
      if (realAbs !== projectReal && !realAbs.startsWith(projectReal + '/')) continue
      wanted.set(rel, abs)
    }
  }

  let added = 0
  for (const [rel, abs] of wanted) {
    const st = await stat(abs).catch(() => null)
    if (!st || !st.isFile()) continue
    if (st.size > FILE_CAP_BYTES) {
      snap.skipped.push({ rel, bytes: st.size })
      continue
    }
    const raw = await readFile(abs).catch(() => null)
    if (!raw) continue
    const webp = await encodeWebp(raw)
    if (!webp) {
      snap.skipped.push({ rel, bytes: st.size })
      continue
    }
    snap.files.push({ rel, mtimeMs: st.mtimeMs, bytes: webp.length, b64: webp.toString('base64') })
    added += webp.length
  }
  return added
}

/** Null = nothing to replicate (no Documents/ and no memory — a brand-new or non-doc project). */
export async function buildDocsSnapshot(projectDir: string): Promise<ReplicaSnapshot | null> {
  const snap: ReplicaSnapshot = { schemaVersion: 1, createdAt: Date.now(), files: [], skipped: [] }
  let total = 0
  for (const root of REPLICA_ROOTS) total += await collectRoot(projectDir, root, snap)
  if (snap.files.length === 0 && snap.skipped.length === 0) return null
  total += await collectDocImages(projectDir, snap)
  if (total > TOTAL_CAP_BYTES) throw new Error('docs snapshot too large')
  return snap
}

/** Build → gzip → seal → upload. Same fail-soft contract as backupNow: never blocks a turn. */
export async function replicaNow(projectDir: string): Promise<ReplicaStatus> {
  const s = stateFor(projectDir)
  if (!loadReplicaEnabled()) return s
  if (s.state === 'uploading' && Date.now() - (s.uploadingSince ?? 0) < STUCK_MS) return s

  s.state = 'uploading'
  s.uploadingSince = Date.now()
  s.error = undefined
  try {
    const userId = await currentUserId()
    if (!userId) throw new Error('not signed in')
    const key = ensureVaultKey()
    if (!key) throw new Error('could not create or read the vault key')

    const hash = await projectHash(projectDir)
    let snap = await buildDocsSnapshot(projectDir)
    if (!snap) {
      // No prior cloud copy means there is nothing to publish. But if this project USED to have docs,
      // upload an encrypted empty snapshot so deleting the last page also clears the phone instead of
      // leaving a stale copy forever.
      const prior = await downloadManifest(userId, hash)
      if (prior?.replicaAt === undefined) {
        s.state = 'idle'
        return s
      }
      snap = { schemaVersion: 1, createdAt: Date.now(), files: [], skipped: [] }
    }
    const sealed = encryptBlob(gzipSync(Buffer.from(JSON.stringify(snap))), replicaAad(hash), key)
    const manifest = await uploadReplica(userId, hash, projectDir, sealed, snap.files.length)
    s.state = 'idle'
    s.replicaAt = manifest.replicaAt ?? Date.now()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'docs snapshot too large') {
      s.state = 'too-large'
    } else {
      s.state = 'error'
      s.error = msg
      log.warn('backup', 'replica upload failed', msg)
    }
  }
  return s
}
