/**
 * Preview-over-relay, Mac side (architecture/preview-over-relay.md): a thin remote-desktop of just
 * the preview surface. For a session the phone is watching, render its live preview URL (dev server
 * or koda-preview:// static) in an OFFSCREEN BrowserWindow — decoupled from any visible window, so it
 * works when the user is away from the Mac or the session is windowless — stream the rendered frames
 * to the phone, and replay the phone's taps/scroll/keys onto the real page.
 *
 * The offscreen page is the user's own project output: sandboxed exactly like the desktop preview
 * iframe (no Node, no preload, web-security on). sendInputEvent only ever targets THIS webContents,
 * never Koda chrome. Keystone-proven in spike/preview-relay.
 */
import { BrowserWindow } from 'electron'
import type { PreviewFrameChunk, PreviewInputEvent, PreviewViewport } from '@shared/preview'
import { log } from './logger'

/** Chunk cap: one encrypted relay broadcast tops out ~256KB; 96K base64 chars stays clear (matches the
 *  image blob path). Most frames are a single chunk. */
const CHUNK_CHARS = 96_000
/** Emit cadence — the fps cap. A paint between ticks just updates the pending buffer (drop-if-behind:
 *  only the newest frame survives), so a burst of repaints collapses to one send. */
const EMIT_INTERVAL_MS = 90
/** Bound the encoded frame's longest edge (physical px) — a retina offscreen paint is 2× the viewport,
 *  wasted over the wire. Keeps bandwidth predictable; the phone canvas scales to fit. */
const MAX_FRAME_EDGE = 1000
/** Sane viewport clamp (a malformed phone report can't ask for a 10k window). */
const MIN_DIM = 200
const MAX_DIM = 2000

interface Stream {
  win: BrowserWindow
  viewport: PreviewViewport
  onChunk: (chunk: PreviewFrameChunk) => void
  timer: NodeJS.Timeout
  latest: Electron.NativeImage | null
  dirty: boolean
  frameId: number
}

/** One stream per watched session. v1 in practice has a single phone watching a single session, but the
 *  map keeps it correct if that ever widens. */
const streams = new Map<string, Stream>()

const clampDim = (n: number): number => Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n) || MIN_DIM))

/**
 * Start (or re-point) the offscreen render+stream for a session. `url` is the session's current preview
 * URL (resolved by the caller from the per-session preview map). Returns false if there's nothing to
 * render. Re-calling with a new url/viewport re-points the existing window instead of leaking one.
 */
export function startPreviewStream(
  sessionId: string,
  url: string,
  viewport: PreviewViewport,
  onChunk: (chunk: PreviewFrameChunk) => void,
): boolean {
  if (!url) return false
  const w = clampDim(viewport.w)
  const h = clampDim(viewport.h)

  const stream = streams.get(sessionId)
  if (stream) {
    // Re-point: update viewport + reload the (possibly new) url, keep the window + timer.
    stream.viewport = { w, h }
    stream.onChunk = onChunk
    if (stream.win.getContentSize().join('x') !== `${w}x${h}`) stream.win.setContentSize(w, h)
    void stream.win.loadURL(url).catch((e) => log.warn('preview-stream', 'reload failed', String(e)))
    return true
  }

  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // The previewed page may pull third-party scripts; never let this invisible window pop a real,
  // visible one on the Mac via window.open (the main app windows have the same guard).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // A paint arrives per repaint (only on change). We keep the newest and let the interval emit it, so a
  // burst of repaints collapses to one send at the fps cap.
  win.webContents.setFrameRate(Math.round(1000 / EMIT_INTERVAL_MS))
  const created: Stream = {
    win,
    viewport: { w, h },
    onChunk,
    latest: null,
    dirty: false,
    frameId: 0,
    timer: setInterval(() => emit(sessionId), EMIT_INTERVAL_MS),
  }
  win.webContents.on('paint', (_e, _dirty, image) => {
    const s = streams.get(sessionId)
    if (!s) return
    s.latest = image
    s.dirty = true
  })
  // A runaway/untrusted project page can crash its own render process — reap the stream so its map entry
  // and interval don't linger (emit/input already no-op via isDestroyed, but the entry would leak).
  win.webContents.on('render-process-gone', () => stopPreviewStream(sessionId))
  streams.set(sessionId, created)
  void win.loadURL(url).catch((e) => log.warn('preview-stream', 'load failed', String(e)))
  log.info('preview-stream', 'started', { sessionId, url, w, h })
  return true
}

function emit(sessionId: string): void {
  const s = streams.get(sessionId)
  if (!s || !s.dirty || !s.latest || s.win.isDestroyed()) return
  s.dirty = false
  let image = s.latest
  const size = image.getSize()
  const longest = Math.max(size.width, size.height)
  if (longest > MAX_FRAME_EDGE) {
    const scale = MAX_FRAME_EDGE / longest
    image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
  }
  const { width, height } = image.getSize()
  const b64 = image.toJPEG(70).toString('base64')
  const n = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS))
  const frameId = ++s.frameId
  for (let i = 0; i < n; i++) {
    s.onChunk({
      frameId,
      i,
      n,
      w: width,
      h: height,
      mime: 'image/jpeg',
      data: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
    })
  }
}

/** Replay one phone gesture onto the real page. Coords are normalized 0..1 → scaled to the viewport
 *  (which is the offscreen content size in DIP, so this is 1:1 with what sendInputEvent expects). */
export function previewInput(sessionId: string, ev: PreviewInputEvent): void {
  const s = streams.get(sessionId)
  if (!s || s.win.isDestroyed()) return
  const wc = s.win.webContents
  const px = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * s.viewport.w)
  const py = (y: number): number => Math.round(Math.max(0, Math.min(1, y)) * s.viewport.h)
  switch (ev.t) {
    case 'down':
      wc.sendInputEvent({ type: 'mouseDown', x: px(ev.x), y: py(ev.y), button: 'left', clickCount: 1 })
      break
    case 'move':
      wc.sendInputEvent({ type: 'mouseMove', x: px(ev.x), y: py(ev.y) })
      break
    case 'up':
      wc.sendInputEvent({ type: 'mouseUp', x: px(ev.x), y: py(ev.y), button: 'left', clickCount: 1 })
      break
    case 'wheel':
      // Electron scrolls the page by the NEGATIVE of deltaY (natural), matching a browser wheel.
      wc.sendInputEvent({ type: 'mouseWheel', x: px(ev.x), y: py(ev.y), deltaX: ev.dx, deltaY: ev.dy, canScroll: true })
      break
    case 'key': {
      const named = ev.key.length > 1 // "Enter", "Backspace", … vs a single character
      wc.sendInputEvent({ type: 'keyDown', keyCode: ev.key })
      if (!named) wc.sendInputEvent({ type: 'char', keyCode: ev.key })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ev.key })
      break
    }
  }
}

/** Reload the offscreen page (the phone's Reload button). */
export function previewReload(sessionId: string): void {
  const s = streams.get(sessionId)
  if (s && !s.win.isDestroyed()) s.win.webContents.reload()
}

/** Stop + tear down a session's stream (phone closed Preview / detached / backgrounded). */
export function stopPreviewStream(sessionId: string): void {
  const s = streams.get(sessionId)
  if (!s) return
  streams.delete(sessionId)
  clearInterval(s.timer)
  if (!s.win.isDestroyed()) s.win.destroy()
  log.info('preview-stream', 'stopped', { sessionId })
}

/** Tear down every stream (remote tier off / app quit). */
export function stopAllPreviewStreams(): void {
  for (const id of [...streams.keys()]) stopPreviewStream(id)
}

// ── Boundary validation (untrusted phone payloads) ──────────────────────────────────────────────
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Coerce an untrusted `{w,h}` into a viewport, falling back to a phone default. */
export function coerceViewport(raw: unknown): PreviewViewport {
  const o = (raw ?? {}) as Record<string, unknown>
  return { w: num(o.w) ?? 390, h: num(o.h) ?? 844 }
}

/** Parse an untrusted input event, returning null if it doesn't match a known shape. */
export function coercePreviewInput(raw: unknown): PreviewInputEvent | null {
  const o = raw as Record<string, unknown>
  if (!o || typeof o.t !== 'string') return null
  const x = num(o.x)
  const y = num(o.y)
  switch (o.t) {
    case 'down':
    case 'move':
    case 'up':
      return x == null || y == null ? null : { t: o.t, x, y }
    case 'wheel': {
      const dx = num(o.dx)
      const dy = num(o.dy)
      return x == null || y == null || dx == null || dy == null ? null : { t: 'wheel', x, y, dx, dy }
    }
    case 'key':
      return typeof o.key === 'string' && o.key.length > 0 && o.key.length <= 20 ? { t: 'key', key: o.key } : null
    default:
      return null
  }
}
