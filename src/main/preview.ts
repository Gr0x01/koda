/**
 * The preview surface's static backend (preview-surface.md, Rung 1). A privileged `koda-preview://`
 * scheme serves a window's project files to its sandboxed preview iframe, so a hand-written
 * `index.html` + relative assets/`fetch` resolve against a clean, project-scoped origin — with NO
 * `file://` filesystem-escape (the renderer never gets a raw file path, and every request is
 * realpath-contained to that window's project root, exactly like the Files-browser fs IPC).
 *
 * URL shape: `koda-preview://<token>/<relpath>`. The host is the window's unguessable preview token
 * (window-registry), NOT the integer window id — so a previewed app can't enumerate ids to read
 * another open project's files. `/` serves `index.html`.
 */
import { protocol, ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { IpcChannels } from '@shared/channels'
import { resolveDocFormat } from '@shared/document-contract'
import { PreviewRectSchema, type PreviewRect } from '@shared/ipc'
import { BROKER_TOKEN_ENV } from './broker/server'
import { containedReal } from './fs-browse'
import { readWholeContainedRegularFile } from './contained-read'
import { userPath } from './engine/user-path'
import { contextForPreviewToken, contextForWindow, previewTokenForWindow } from './window-registry'
import { log } from './logger'

export const PREVIEW_SCHEME = 'koda-preview'

/**
 * The current preview URL per session — the one fact phone preview needs that main didn't keep (the URL
 * was pushed to the renderer and forgotten). Written when a dev server confirms serving or a static file
 * is shown; read by remote-control.ts to expose that session's dev server to the phone (LAN forwarder or
 * Connect). `kind` distinguishes a live dev server from a static koda-preview:// file.
 */
const sessionPreviews = new Map<string, { url: string; kind: 'dev' | 'static'; winId: number }>()

/** The session's current preview URL (dev server or static), or undefined if it has none yet. */
export function getSessionPreview(sessionId: string): { url: string; kind: 'dev' | 'static' } | undefined {
  return sessionPreviews.get(sessionId)
}

/** Forget a session's preview (session ended / server torn down) so the phone doesn't render a dead URL. */
export function clearSessionPreview(sessionId: string): void {
  sessionPreviews.delete(sessionId)
}

/** Build the static entry URL for a window's preview. With `relPath` (a project-relative `.html`/`.htm`
 *  file — e.g. the file the user is looking at), point the entry there; otherwise default to the
 *  project-root `index.html`. Returns undefined if the window is unknown or has no project yet (a
 *  ProjectHome window). The protocol handler still realpath-contains every request, so a relPath that
 *  escapes the root just 404s. */
export function staticPreviewUrl(winId: number, relPath?: string): string | undefined {
  const token = previewTokenForWindow(winId)
  if (!token) return undefined
  const entry =
    relPath && /\.html?$/i.test(relPath)
      ? relPath.split('/').map(encodeURIComponent).join('/') // path-safe for spaces etc.
      : 'index.html'
  return `${PREVIEW_SCHEME}://${token}/${entry}`
}

// ── Document mode (typed-documents plan §4) ───────────────────────────────────────────────────────
// An HTML *document* is not an app preview. It reuses this file's containment and nothing else: its
// own origin, only the one file it names, no network at all, and no dev-server semantics. The mode is
// carried by the URL HOST rather than a query string, because a query is dropped the moment the page
// resolves a relative reference — a document that asked for `logo.png` would come back through the
// permissive app-preview branch and read another project file. Host `doc-<docToken>` is a distinct web
// origin, and `docToken` is minted INDEPENDENTLY of the window's app-preview `previewToken` — so a
// document that reads its own hostname learns nothing that lets it reconstruct the permissive
// app-preview URL, and the two modes cannot reach each other's storage or responses.

const DOCUMENT_HOST_PREFIX = 'doc-'

/**
 * A window's open HTML documents under an origin token unrelated to its app-preview `previewToken`.
 *
 * - `token` is minted fresh (`randomUUID`) the first time the window opens a document and shares
 *   nothing with the app-preview host. Severing that derivation is what closes the containment escape
 *   where a document stripped the `doc-` prefix off its own host to address the no-CSP app-preview
 *   branch and regain network egress.
 * - `paths` is the allowlist, not a filter: a document that navigates itself to any other path —
 *   including one it guessed — gets the same 404 as an escape. That is what makes "no reads of any file
 *   other than the document itself" a property of the server instead of a promise about the CSP.
 */
interface DocumentOrigin {
  token: string
  paths: Set<string>
}
const documentPreviews = new Map<number, DocumentOrigin>()

/** Reverse index docToken → winId. Document requests resolve through THIS map only, never through the
 *  app-preview `contextForPreviewToken` registry, so the two token spaces never meet. */
const documentTokenToWindow = new Map<string, number>()

/** Mint (once per window) or return this window's document origin. Undefined for an unknown/closed
 *  window, so nothing serves before the window and its project exist. */
function ensureDocumentOrigin(winId: number): DocumentOrigin | undefined {
  if (!contextForWindow(winId)) return undefined
  let origin = documentPreviews.get(winId)
  if (!origin) {
    origin = { token: randomUUID(), paths: new Set() }
    documentPreviews.set(winId, origin)
    documentTokenToWindow.set(origin.token, winId)
  }
  return origin
}

/**
 * The containment the document mode actually rests on, stated once as a response header so the
 * document cannot restate it: bytes on disk are never trusted to carry their own policy.
 *
 * - `default-src 'none'` withdraws every fetch destination it backstops, which is what makes the
 *   document offline: `fetch`, `XMLHttpRequest`, WebSocket, `sendBeacon`, external scripts, styles,
 *   fonts, media, frames and workers all have nowhere to go.
 * - `script-src` re-grants inline scripts only. Interaction is the point of this format, and the
 *   scripts are already confined to an opaque origin with no network and no privileged globals.
 *   `'unsafe-eval'` rides with it because a chart or template helper compiling a function is not a
 *   new capability once nothing can be reached.
 * - `img-src`/`font-src`/`media-src` allow `data:`/`blob:` so a genuinely self-contained document
 *   keeps its inlined art. A remote pixel — the cheapest exfiltration channel there is — is not a
 *   destination either of those schemes can name.
 * - `form-action` and `base-uri` are listed explicitly because neither falls back to `default-src`.
 * - `sandbox allow-scripts` repeats the iframe attribute from the side the renderer cannot edit, so
 *   the opaque origin (no storage, no cookies, no same-origin reads) survives a mistake in the DOM.
 *   `allow-modals` is deliberately absent: a document is not permitted to hold Koda's UI thread on an
 *   `alert()`. `frame-ancestors` is deliberately absent too — it does NOT fall back, and naming a
 *   value would refuse the `file://` renderer that has to frame this.
 */
export const DOCUMENT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ')

/**
 * Register `relPath` as this window's open HTML document and return the URL its sandboxed frame
 * loads. Registration is the authorization: nothing under the document origin serves until a surface
 * has asked for that exact path. Returns undefined for an unknown/project-less window or a path that
 * is not HTML — the format contract decides that, not a local regex.
 */
export function documentPreviewUrl(winId: number, relPath: string): string | undefined {
  const rel = relPath.replace(/^\/+/, '').trim()
  if (!rel || resolveDocFormat(rel) !== 'html') return undefined
  const origin = ensureDocumentOrigin(winId)
  if (!origin) return undefined
  origin.paths.add(rel)
  const entry = rel.split('/').map(encodeURIComponent).join('/')
  return `${PREVIEW_SCHEME}://${DOCUMENT_HOST_PREFIX}${origin.token}/${entry}`
}

/** Drop a closed window's document origin — both the winId→origin entry and the docToken→winId reverse
 *  index, so a stale host can never resolve back to a gone window's project. */
export function forgetWindowDocuments(winId: number): void {
  const origin = documentPreviews.get(winId)
  if (origin) documentTokenToWindow.delete(origin.token)
  documentPreviews.delete(winId)
}

/** Narrow state probe for the containment tests; production callers never need this. */
export function documentPreviewPathsForTest(winId: number): string[] {
  return [...(documentPreviews.get(winId)?.paths ?? [])]
}

/** The window's document-origin host token (independent of its app-preview token), or undefined before
 *  any document is opened. For the containment tests only. */
export function documentTokenForTest(winId: number): string | undefined {
  return documentPreviews.get(winId)?.token
}

/** Build a `koda-preview://` URL for any project-relative asset (not just `.html`) — used to make a
 *  doc's local images loadable in the WYSIWYG surface. The protocol handler realpath-contains every
 *  request, so an escaping relPath just 404s. Returns undefined for an unknown/project-less window. */
export function previewAssetUrl(winId: number, relPath: string): string | undefined {
  const token = previewTokenForWindow(winId)
  if (!token) return undefined
  const entry = relPath
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `${PREVIEW_SCHEME}://${token}/${entry}`
}

/**
 * Agent-facing static preview (preview-surface.md, Rung 1): point the window's preview at a specific
 * project-relative `.html` file the agent has produced (a mock, a generated report, a built page) and
 * push it so the user SEES it — the static-file sibling of `startDevServer`. The general primitive
 * behind the `preview_file` capability: nothing is special-cased to "mocks"; any contained `.html`
 * works. `containedReal` realpaths the target, so it throws on a path that escapes the root OR doesn't
 * exist — one check covers both, and never leaks which. Returns the served `koda-preview://` URL.
 */
export async function showStaticPreview(
  winId: number,
  projectPath: string,
  relPath: string,
  sessionId: string,
): Promise<{ url: string }> {
  const rel = relPath.replace(/^\/+/, '').trim()
  if (!/\.html?$/i.test(rel)) throw new Error('preview_file needs a path to an .html file')
  let file: string
  try {
    file = containedReal(projectPath, rel) // realpath: throws on escape OR missing
  } catch {
    throw new Error(`can't preview "${relPath}" — it's outside the project or doesn't exist`)
  }
  if (!(await stat(file)).isFile()) throw new Error(`"${relPath}" is not a file`)
  const url = staticPreviewUrl(winId, rel)
  if (!url) throw new Error('this window has no project to preview into')
  sessionPreviews.set(sessionId, { url, kind: 'static', winId })
  // Name the originating session: a window can host several sessions, and the push must land on the
  // one whose agent triggered it — NOT whichever session tab happens to be focused when it arrives.
  // `restart` lets the renderer re-show this file after the surface is closed (its token-bearing URL is
  // rebuilt fresh, so it works even across a restart when the window's preview token has rotated).
  BrowserWindow.fromId(winId)?.webContents.send(IpcChannels.previewShow, {
    url,
    sessionId,
    restart: { kind: 'static', relPath: rel },
  })
  return { url }
}

/**
 * Register the scheme as a standard, secure web origin BEFORE app `ready` (Electron requirement).
 * standard ⇒ proper origin + relative-URL resolution; secure ⇒ treated like https (so service
 * workers / secure-context APIs the previewed app may use work); supportFetchAPI ⇒ `fetch()` works.
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

/** Wire the request handler. Call once, after app `ready`. */
export function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, (req) => servePreviewRequest(req.url))
}

/**
 * Answer one `koda-preview://` request. Exported so the containment tests exercise the shipped
 * handler rather than a re-implementation of its rules.
 */
export async function servePreviewRequest(rawUrl: string): Promise<Response> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return blankPreviewResponse(400)
  }

  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  rel = rel.replace(/^\/+/, '') // strip leading '/' → project-relative

  // The document origin is a SEPARATE token space: its host resolves through documentTokenToWindow,
  // never contextForPreviewToken, so a document host reveals nothing about — and cannot be turned into
  // — the permissive app-preview host.
  if (url.hostname.startsWith(DOCUMENT_HOST_PREFIX)) {
    return serveDocumentRequest(url.hostname.slice(DOCUMENT_HOST_PREFIX.length), rel)
  }

  const ctx = contextForPreviewToken(url.hostname)
  if (!ctx || !ctx.projectPath) return blankPreviewResponse(404)
  try {
    // Validation and bytes come from one opened descriptor. A path-only realpath check followed by
    // `readFile(path)` left a swap window where a project asset could become an outside symlink.
    const { bytes, path } = await readWholeContainedRegularFile(ctx.projectPath, rel)
    return new Response(bytes, { headers: { 'Content-Type': contentType(path) } })
  } catch (err) {
    // Escapes, missing files and read failures are deliberately indistinguishable to the preview.
    log.warn('preview', 'read failed', err instanceof Error ? err.message : err)
    return blankPreviewResponse(404)
  }
}

/**
 * Answer a document-origin request. `docToken` is the host with the `doc-` prefix already stripped; it
 * resolves through the document token registry ONLY — the app-preview token space is unreachable from
 * here. The allowlist is authorization, the realpath read is containment: a subresource, a guessed
 * sibling, and a self-navigation to another path all land here and are refused before a descriptor is
 * opened.
 */
async function serveDocumentRequest(docToken: string, rel: string): Promise<Response> {
  const winId = documentTokenToWindow.get(docToken)
  const origin = winId !== undefined ? documentPreviews.get(winId) : undefined
  const ctx = winId !== undefined ? contextForWindow(winId) : undefined
  if (!ctx || !ctx.projectPath || !origin || !origin.paths.has(rel)) return refusedDocumentResponse()
  try {
    const { bytes } = await readWholeContainedRegularFile(ctx.projectPath, rel)
    return new Response(bytes, {
      headers: {
        // Forced, never sniffed: the allowlist already decided this is the open HTML document.
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': DOCUMENT_PREVIEW_CSP,
        'X-Content-Type-Options': 'nosniff',
        // The surface refreshes by reloading this exact URL when the file changes on disk, so a cached
        // copy would quietly show the agent's previous draft.
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    log.warn('preview', 'read failed', err instanceof Error ? err.message : err)
    return refusedDocumentResponse()
  }
}

/**
 * Defense in depth for the document origin (typed-documents plan §4). A frame currently showing a
 * sandboxed HTML document may reload itself (live refresh) and follow same-origin paths, but it must
 * never navigate to a different host or scheme — that hop is how the document's no-network CSP would be
 * shed by moving to the app-preview origin (or any origin added to this scheme later). Returns true
 * when the navigation to `targetUrl` must be denied. Only frames CURRENTLY on the document origin are
 * policed; the app-preview origin and the file:// renderer keep their existing, separate guards.
 */
export function isDocumentFrameEscape(currentUrl: string, targetUrl: string): boolean {
  let current: URL
  try {
    current = new URL(currentUrl)
  } catch {
    return false
  }
  const onDocumentOrigin =
    current.protocol === `${PREVIEW_SCHEME}:` && current.hostname.startsWith(DOCUMENT_HOST_PREFIX)
  if (!onDocumentOrigin) return false
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return true // an unparseable destination is not somewhere a document frame may go
  }
  return target.protocol !== current.protocol || target.hostname !== current.hostname
}

/** A document-origin refusal. Plain text, and still policed: a refusal that carried no policy would be
 *  the one response in this origin a hostile document could use as a scriptable page. */
function refusedDocumentResponse(): Response {
  return new Response('Not available.', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': DOCUMENT_PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  })
}

/** A calm, on-brand placeholder shown in the preview iframe when there's nothing to render yet —
 *  no project entry, a file that doesn't exist, or a bad request. Adapts to light/dark via
 *  `prefers-color-scheme` (the iframe can't read Koda's theme, so we let the OS decide). */
function blankPreviewResponse(status: number): Response {
  return new Response(BLANK_PREVIEW_HTML, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

const BLANK_PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preview</title>
<style>
  :root { --bg: #f7f8fa; --muted: #7a8194; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1420; --muted: #8891a5; } }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--muted);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    font-size: 13px;
  }
</style>
</head>
<body>
  <p>Nothing to preview yet.</p>
</body>
</html>`

// ── Dev-server lifecycle (Rung 2) ────────────────────────────────────────────────────────────────
// A Koda-OWNED dev server per window (preview-surface.md): the agent invokes the `preview` capability
// (broker → gate), Koda spawns the process, reads the port from ITS OWN child's stdout (no port
// sniffing/guessing), points the preview iframe at it, and kills it on window close. One owner,
// deterministic teardown. The agent only STARTS it — it never sees the rendered pixels.

interface DevServer {
  child: ChildProcess
  url?: string
}

/** Live dev servers keyed by window id (one per window — starting a new one replaces the old). */
const devServers = new Map<number, DevServer>()

/** Tell the window a dev-server URL has stopped serving, so its preview tab drops the live mark. Only
 *  worth sending for a URL that actually served: before that the renderer was never pointed at it. The
 *  iframe keeps its last paint either way, which is exactly why the mark has to be told the truth. */
function notePreviewStopped(winId: number, url?: string): void {
  if (!url) return
  const win = BrowserWindow.fromId(winId)
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.previewStopped, { url })
}

// eslint-disable-next-line no-control-regex -- stripping ANSI color codes means matching the raw ESC byte
const ANSI = /\x1b\[[0-9;]*m/g
// Match a local dev-server URL and capture the port. Covers the JS dev servers (localhost/127.0.0.1)
// AND Python's http.server / anything bound to all interfaces (0.0.0.0, [::], [::1]) — whatever host
// the child prints, we always navigate the iframe to localhost:<port> (a browser can't load 0.0.0.0).
const LOCAL_URL = /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-fA-F:]+\]):(\d+)/i
/** How long to wait for the child to announce a local URL AND for that URL to actually start serving,
 *  before giving up. Covers both phases — printing the port is instant; accepting a connection can lag
 *  a beat behind while the server binds. */
const PORT_TIMEOUT_MS = 30_000
/** Health-check cadence: how often we re-probe the announced URL until it accepts a connection. */
const PROBE_INTERVAL_MS = 250
/** Per-probe budget. A localhost socket connects instantly; if the request is still open after this,
 *  the server has accepted the connection and is merely slow to respond (e.g. first-hit compile) —
 *  which already proves it's up, so we treat a per-probe timeout as "serving". */
const PROBE_TIMEOUT_MS = 2_000

/**
 * Probe `url` once: resolve true if the dev server accepts the connection (any HTTP response, OR the
 * socket connected but is slow to reply), false if it's not up yet (connection refused/reset). This is
 * the real "serving" signal — a printed `localhost:<port>` line is NOT: dev servers log it before the
 * port binds, and a compile-crash can kill the process a beat later. We only care that SOMETHING is
 * listening and speaking HTTP, not what it returns (a 500 error overlay still means the server is up
 * and the user will SEE it in the preview).
 */
function probeServing(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const settle = (v: boolean): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const lib = url.startsWith('https') ? https : http
    // Self-signed certs are the norm for a local https dev server — we're only pinging, not trusting it.
    const req = lib.get(url, { timeout: PROBE_TIMEOUT_MS, rejectUnauthorized: false }, (res) => {
      res.destroy() // response headers are enough; we don't read the body
      settle(true)
    })
    req.on('timeout', () => {
      req.destroy()
      settle(true) // connected but slow to answer ⇒ the server is up (busy compiling the first request)
    })
    req.on('error', () => settle(false)) // ECONNREFUSED / reset ⇒ nothing listening yet
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Start (or restart) the window's dev server with `command`, resolving once the child prints a
 * `http://localhost:<port>` URL. On success the preview iframe is pointed at it (push to the window)
 * and the URL is returned to the agent. Rejects on spawn error, early exit, or timeout.
 */
export function startDevServer(
  winId: number,
  projectPath: string,
  command: string,
  sessionId: string,
  cwd?: string,
): Promise<{ url: string }> {
  killDevServer(winId) // one per window
  // Don't hand the dev server Koda's broker bearer token — it has no business with it.
  const env = { ...process.env }
  delete env[BROKER_TOKEN_ENV]
  // Same PATH starvation as the engine: a Finder-launched .app can't find the user's node/npm
  // without their login-shell PATH, so `npm run dev` (etc.) would fail with "command not found".
  env.PATH = userPath()
  const child = spawn(command, {
    cwd: cwd || projectPath,
    shell: true, // let the user's command be a normal shell line ("npm run dev")
    env,
    // Own process group, so killDevServer can signal the WHOLE tree — killing just the shell
    // wrapper leaves a grandchild server (e.g. "cd app && npm run dev") alive holding the port.
    detached: true,
  })
  const entry: DevServer = { child }
  devServers.set(winId, entry)

  return new Promise((resolve, reject) => {
    let settled = false
    let announced: string | undefined // the URL the child printed (before we've confirmed it serves)
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    // Only this promise's OWN child may be torn down on failure — a later startDevServer may have
    // already replaced it (killing this one + installing a new child under the same winId).
    const killIfCurrent = (): void => {
      if (devServers.get(winId)?.child === child) killDevServer(winId)
    }
    const isCurrent = (): boolean => devServers.get(winId)?.child === child
    const timer = setTimeout(() => {
      finish(() => {
        killIfCurrent() // don't leave a server that never came up holding a port
        reject(
          new Error(
            announced
              ? `preview server printed ${announced} but wasn't serving within ${PORT_TIMEOUT_MS / 1000}s`
              : `preview server didn't report a local URL within ${PORT_TIMEOUT_MS / 1000}s`,
          ),
        )
      })
    }, PORT_TIMEOUT_MS)

    // Poll the announced URL until it actually accepts a connection, THEN resolve — so the agent hears
    // "ready" only when the page truly loads, not when the child merely logged its port. The master
    // `timer` bounds the wait; a crash mid-poll trips the `exit` handler and stops us.
    const confirmServing = async (url: string): Promise<void> => {
      while (!settled && isCurrent()) {
        if (await probeServing(url)) {
          if (settled || !isCurrent()) return
          entry.url = url
          sessionPreviews.set(sessionId, { url, kind: 'dev', winId })
          // `restart` carries the command (+ cwd) so the user can bring this dev server back with one
          // click after it's killed on window close — the process can't survive, but re-running it can.
          BrowserWindow.fromId(winId)?.webContents.send(IpcChannels.previewShow, {
            url,
            sessionId,
            restart: { kind: 'dev', command, cwd },
          })
          finish(() => resolve({ url }))
          return
        }
        await delay(PROBE_INTERVAL_MS)
      }
    }

    const scan = (buf: Buffer): void => {
      // Only the CURRENT child for this window may resolve (a racing kill/restart invalidates an old one).
      if (settled || announced || !isCurrent()) return
      const m = LOCAL_URL.exec(buf.toString().replace(ANSI, ''))
      if (!m) return
      // Normalize 0.0.0.0/[::]/127.0.0.1 → localhost (a browser can't load 0.0.0.0), keep the scheme.
      announced = `${m[1].toLowerCase()}://localhost:${m[2]}`
      void confirmServing(announced)
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan) // many dev servers print the URL to stderr
    child.on('error', (err) =>
      finish(() => {
        killIfCurrent() // spawn failed (e.g. command not found) — drop the dead entry
        reject(err)
      }),
    )
    child.on('exit', (code) => {
      if (isCurrent()) devServers.delete(winId)
      // A server that had come up and then died: the renderer is pointed at a URL nothing answers now.
      notePreviewStopped(winId, entry.url)
      finish(() =>
        reject(
          new Error(
            announced
              ? `preview server exited (code ${code ?? 'null'}) before it started serving`
              : `preview server exited (code ${code ?? 'null'}) before reporting a URL`,
          ),
        ),
      )
    })
  })
}

/** Kill the window's dev server, if any (window close / restart). Detaches listeners first so the
 *  exit handler can't fire a stale rejection. */
export function killDevServer(winId: number): void {
  // The dev-server URL for this window is now dead — forget it so a later preview stream doesn't render
  // a stale localhost that would just show a blank/error frame (static previews for the window stay).
  for (const [sid, p] of sessionPreviews) if (p.kind === 'dev' && p.winId === winId) sessionPreviews.delete(sid)
  const entry = devServers.get(winId)
  if (!entry) return
  devServers.delete(winId)
  // Listeners come off next, so the exit handler will never fire — say it here instead.
  notePreviewStopped(winId, entry.url)
  entry.child.removeAllListeners()
  entry.child.stdout?.removeAllListeners()
  entry.child.stderr?.removeAllListeners()
  try {
    // Negative pid = the child's whole process group (it's a group leader via detached: true).
    if (entry.child.pid) process.kill(-entry.child.pid, 'SIGTERM')
    else entry.child.kill()
  } catch (err) {
    try {
      entry.child.kill() // group already gone or not a leader — fall back to the wrapper alone
    } catch {
      log.warn('preview', 'failed to kill dev server', err instanceof Error ? err.message : err)
    }
  }
}

// ── Agent-sees-preview (preview-surface.md, Rung 3) ────────────────────────────────────────────────
// The agent's `view_preview` capability (broker → manager → here). We can't read the cross-origin
// preview iframe from the renderer (drawing it to a canvas taints), so we capture main-side at the
// compositor: ask the window's renderer for the iframe's on-screen rect, then capturePage(rect). The
// pixels are downscaled (image token cost tracks area) + JPEG-encoded and returned to the agent.

interface CaptureReply {
  rect: PreviewRect | null
  dpr: number
}
interface PendingCapture {
  resolve: (reply: CaptureReply) => void
  timer: NodeJS.Timeout
  senderId: number
}
const pendingCaptures = new Map<string, PendingCapture>()
/** How long to wait for the renderer to report the iframe rect before giving up (→ "no preview"). */
const CAPTURE_RECT_TIMEOUT_MS = 3_000

/** Wire the renderer's rect replies. Call once after app `ready` (index.ts), beside registerPreviewProtocol. */
export function registerPreviewCaptureResponder(): void {
  ipcMain.on(IpcChannels.previewCaptureResponse, (event, raw: unknown) => {
    const payload = raw as { correlationId?: unknown; rect?: unknown; dpr?: unknown }
    if (typeof payload?.correlationId !== 'string') return
    const pending = pendingCaptures.get(payload.correlationId)
    if (!pending || pending.senderId !== event.sender.id) return // ignore unknown id / wrong window
    pendingCaptures.delete(payload.correlationId)
    clearTimeout(pending.timer)
    const parsed = PreviewRectSchema.safeParse(payload.rect)
    const dpr = typeof payload.dpr === 'number' && payload.dpr >= 1 ? payload.dpr : 1
    pending.resolve({ rect: parsed.success ? parsed.data : null, dpr })
  })
}

/**
 * Capture the window's currently-visible preview as a downscaled JPEG (base64) for the agent's
 * view_preview. Rejects when no preview is showing/visible (the renderer reports a null/empty rect)
 * so the tool returns a clear hint rather than a blank frame. `maxEdge` caps the longest side in
 * PHYSICAL pixels — the real token lever (the manager passes the imageDetail cap).
 */
export async function captureWindowPreview(
  win: BrowserWindow,
  maxEdge: number,
): Promise<{ data: string; mimeType: string }> {
  if (win.isDestroyed()) throw new Error('the preview window is gone')

  const correlationId = randomUUID()
  const { rect, dpr } = await new Promise<CaptureReply>((resolve) => {
    const timer = setTimeout(() => {
      pendingCaptures.delete(correlationId)
      resolve({ rect: null, dpr: 1 })
    }, CAPTURE_RECT_TIMEOUT_MS)
    pendingCaptures.set(correlationId, { resolve, timer, senderId: win.webContents.id })
    win.webContents.send(IpcChannels.previewCaptureRequest, { correlationId })
  })
  if (!rect || rect.width < 1 || rect.height < 1) {
    // Either nothing is running or the Preview tab isn't the visible surface (only the foreground
    // pane is mounted). Don't say "start one" — that risks the agent redundantly relaunching a server.
    throw new Error("couldn't see the preview — make sure the Preview tab is open and visible, then try again")
  }

  // Clamp the rect into the window's content bounds (a partial scroll could report a negative or
  // overflowing rect; capturePage outside the page would grab Koda's chrome or fail).
  const [cw, ch] = win.getContentSize()
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const width = Math.min(Math.round(rect.width), cw - x)
  const height = Math.min(Math.round(rect.height), ch - y)
  if (width < 1 || height < 1) {
    throw new Error("couldn't see the preview — make sure the Preview tab is open and visible, then try again")
  }

  let image = await win.webContents.capturePage({ x, y, width, height })
  if (image.isEmpty()) {
    throw new Error('the preview capture came back empty — the preview may be hidden behind another panel')
  }

  // getSize() is logical (DIP); the encoded JPEG is physical (DIP × dpr) — that physical area is what
  // the vision tokens cost. Cap the longest PHYSICAL edge, then JPEG-encode (smaller than PNG, and it
  // blunts the tool-result base64 overhead). resize() yields an image at exactly the given pixel dims.
  const size = image.getSize()
  const physLongest = Math.max(size.width, size.height) * dpr
  if (physLongest > maxEdge) {
    const scale = maxEdge / physLongest
    image = image.resize({
      width: Math.round(size.width * dpr * scale),
      height: Math.round(size.height * dpr * scale),
    })
  }
  return { data: image.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' }
}

/** Minimal extension → MIME map. Unknown ⇒ octet-stream (the browser won't execute it, which is the
 *  safe default for anything we didn't explicitly recognize). */
function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff2':
      return 'font/woff2'
    case '.woff':
      return 'font/woff'
    case '.ttf':
      return 'font/ttf'
    case '.wasm':
      return 'application/wasm'
    case '.map':
    case '.txt':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
