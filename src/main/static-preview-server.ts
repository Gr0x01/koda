/**
 * The phone's door to a STATIC preview. On the Mac a static page is served in-app over the privileged
 * `koda-preview://` scheme, which has no port — and the phone can only reach a preview through a port
 * (same-WiFi via lan-forward.ts, away via Connect). So when the phone asks for a static preview, this
 * opens a small per-session HTTP server on 127.0.0.1:<ephemeral> over the session window's project
 * root, answering through the same `serveAppPreviewFile` the scheme uses. The remote paths then expose
 * that port exactly as they expose a dev server's.
 *
 * Rules this server adds over the in-app scheme, because what it serves becomes reachable on the LAN
 * and over the tailnet rather than only inside Koda's own renderer:
 *  - GET/HEAD only.
 *  - No path component may start with a dot (`.env`, `.git/…`, `.koda/memory/…`), EXCEPT within the
 *    directory holding the page being previewed. Agents write mocks to `.koda/scratch/` on purpose, so
 *    a blanket deny would refuse the exact thing this exists to show; only that one directory is
 *    opened, and a dot-name inside it is still refused.
 *  - No path component may look like key material (`*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`,
 *    `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, any case) — anywhere, including
 *    the opened directory. This is judged on the REQUESTED name: a harmless-looking name that is a
 *    symlink to such a file inside the project still serves, as it does on the in-app scheme.
 *  - The Host must be `localhost` or an IP literal. A DNS-rebinding page names its own domain, so this
 *    keeps a hostile website in a Mac or phone browser from reading project files through the port.
 * Every refusal is the same 404 a missing file gets.
 *
 * No import from src/main/remote: this ships in the public build alongside lan-forward.ts.
 */
import http from 'node:http'
import { isIP } from 'node:net'
import { appPreviewNotFound, getSessionPreview, serveAppPreviewFile } from './preview'
import { contextForWindow } from './window-registry'
import { log } from './logger'

/** Structural, like lan-forward.ts's: the remote stack that mints the permit does not ship publicly. */
interface StaticPreviewActivationPermit {
  valid(): boolean
}

interface StaticServer {
  root: string
  winId: number
  /** Decoded project-relative directory of the page being previewed (`.koda/scratch/`), or ''. */
  entryDir: string
  server: http.Server
  port: Promise<number>
}

/** One server per session, created lazily when the phone opens a static preview. */
const servers = new Map<string, StaticServer>()

/** The project-relative directory of an entry pathname (`/.koda/scratch/mock.html` → `.koda/scratch/`). */
function entryDirOf(entryPath: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(entryPath)
  } catch {
    return ''
  }
  const rel = decoded.replace(/^\/+/, '')
  return rel.slice(0, rel.lastIndexOf('/') + 1)
}

/** Only a name no rebinding page can claim: `localhost` or an IP literal. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d*$/, '')
  return name.toLowerCase() === 'localhost' || isIP(name) !== 0
}

/** Names that are almost always credentials, refused because this server is reachable on the LAN. */
const KEY_MATERIAL = /(\.(pem|key|crt|p12|pfx|keystore|jks)$)|(^id_(rsa|ed25519|ecdsa))/i

/** The decoded project-relative file a request names, or null when this server refuses it. */
function requestRel(rawUrl: string | undefined, entryDir: string): string | null {
  if (!rawUrl?.startsWith('/')) return null
  let pathname: string
  try {
    // Parsed against a fixed origin so `..` is resolved the way a browser would, then decoded so an
    // encoded slash or dot is judged as the name it becomes on disk.
    pathname = decodeURIComponent(new URL(`http://h${rawUrl}`).pathname)
  } catch {
    return null
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const judged = entryDir && rel.startsWith(entryDir) ? rel.slice(entryDir.length) : rel
  if (judged.split('/').some((segment) => segment.startsWith('.'))) return null
  if (rel.split('/').some((segment) => KEY_MATERIAL.test(segment))) return null
  return rel
}

async function handle(s: StaticServer, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 })
    res.end()
    return
  }
  const rel = hostAllowed(req.headers.host) ? requestRel(req.url, s.entryDir) : null
  const answer = rel === null ? appPreviewNotFound() : await serveAppPreviewFile(s.root, rel)
  const body = Buffer.from(await answer.arrayBuffer())
  res.writeHead(answer.status, {
    ...Object.fromEntries(answer.headers),
    'Content-Length': body.length,
    // Reload on the phone must show the agent's latest draft, not a cached one.
    'Cache-Control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * Ensure the session's loopback static server over `root`, returning its port. Reused while the root
 * is unchanged (only the opened entry directory moves with the page); a different root replaces it.
 */
export function ensureStaticPreviewServer(
  sessionId: string,
  winId: number,
  root: string,
  entryPath: string,
  // Required, like ensureLanForward's: this listener exists only to be exposed to the phone, so it opens
  // under the same activation gate as the forward that exposes it, and never after a revoke.
  permit: StaticPreviewActivationPermit,
): Promise<number> {
  if (!permit.valid()) return Promise.reject(new Error('static-preview: remote access activation is blocked'))
  const entryDir = entryDirOf(entryPath)
  const existing = servers.get(sessionId)
  if (existing && existing.root === root) {
    existing.entryDir = entryDir
    existing.winId = winId
    return existing.port
  }
  if (existing) stopStaticPreviewServer(sessionId)

  const server = http.createServer((req, res) => {
    void handle(entry, req, res).catch(() => res.destroy())
  })
  const entry: StaticServer = { root, winId, entryDir, server, port: Promise.resolve(0) }
  entry.port = new Promise<number>((resolve, reject) => {
    // Kept for the server's whole life: an unlistened 'error' (an accept failure) would throw in main.
    server.on('error', (err) => {
      log.warn('static-preview', 'server error', { sessionId, message: err.message })
      reject(err)
    })
    // A stop before `listening` fires means that event never comes; settle here instead of hanging.
    server.once('close', () => reject(new Error('static preview server was stopped')))
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!permit.valid() || servers.get(sessionId) !== entry || typeof addr !== 'object' || !addr) {
        server.close()
        return reject(new Error('static preview server was stopped'))
      }
      log.info('static-preview', 'started', { sessionId, port: addr.port })
      resolve(addr.port)
    })
  })
  servers.set(sessionId, entry)
  entry.port.catch(() => {
    if (servers.get(sessionId) === entry) servers.delete(sessionId)
  })
  return entry.port
}

/** Close a session's static server (phone stopped Preview / session disposed). Idempotent. */
export function stopStaticPreviewServer(sessionId: string): void {
  const s = servers.get(sessionId)
  if (!s) return
  servers.delete(sessionId)
  s.server.close()
  s.server.closeAllConnections()
  log.info('static-preview', 'stopped', { sessionId })
}

/** Close every static server serving a window that is closing. */
export function stopStaticPreviewServersForWindow(winId: number): void {
  for (const [sessionId, s] of [...servers]) if (s.winId === winId) stopStaticPreviewServer(sessionId)
}

/** Close all of them (remote access revoked / app quit). */
export function stopAllStaticPreviewServers(): void {
  for (const sessionId of [...servers.keys()]) stopStaticPreviewServer(sessionId)
}

/** Where a session's preview lives on this Mac's loopback: the port to expose and the entry path the
 *  phone should open on it ('' for a dev server, whose root is the app). */
export interface PhonePreviewTarget {
  port: number
  path: string
}

/**
 * The one answer both remote routes (same-WiFi forward, Connect tunnel) expose. Null means the session
 * has no preview — the phone's "nothing to preview yet". A dev server is its own port; a static page
 * gets this module's loopback server and its pathname becomes the entry path. Throws if that server
 * cannot bind, which callers report as a failure rather than as "nothing to preview".
 */
export async function resolvePhonePreview(
  sessionId: string,
  permit: StaticPreviewActivationPermit,
): Promise<PhonePreviewTarget | null> {
  const preview = getSessionPreview(sessionId)
  if (!preview) return null
  if (preview.kind === 'dev') {
    const port = Number(new URL(preview.url).port) || 0
    return port ? { port, path: '' } : null
  }
  const root = contextForWindow(preview.winId)?.projectPath
  if (!root) return null
  const path = new URL(preview.url).pathname
  return { port: await ensureStaticPreviewServer(sessionId, preview.winId, root, path, permit), path }
}
