/**
 * WebP re-encoder for the docs replica — turns a screenshot/photo a document embeds into phone-sized
 * bytes WITHOUT the resolution loss plain downscaling causes. A 10 MB PNG screenshot lands around
 * 100-300 KB at quality ~0.8 and reads identically on a phone; PNG is lossless (huge for photos) and
 * JPEG rings around text, so webp is the right codec here.
 *
 * No native dependency: Chromium already encodes webp, so we drive an offscreen canvas in a hidden
 * BrowserWindow (the same engine the app is built on) rather than pulling in `sharp`/libvips.
 */
import { BrowserWindow } from 'electron'
import { log } from '../logger'

/** Longest-edge clamp — a doc image never needs more than a retina phone width; keeps the encode cheap. */
const MAX_EDGE = 1600
const QUALITY = 0.8
/** After webp, anything still this big isn't a page illustration — skip it rather than bloat the snapshot. */
const MAX_OUT_BYTES = 1024 * 1024

let win: BrowserWindow | null = null

/** Lazily hold one hidden window for the app's life — creating one per image would thrash. */
async function encoder(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await win.loadURL('about:blank')
  return win
}

/**
 * Re-encode image bytes (any format Chromium decodes) to webp, downscaled to MAX_EDGE. Returns null
 * when the source won't decode or the result is still too big — the caller then lists it as skipped
 * rather than shipping it. Runs entirely in the page context; only base64 crosses the boundary.
 */
export async function encodeWebp(input: Buffer): Promise<Buffer | null> {
  try {
    const w = await encoder()
    const srcB64 = input.toString('base64')
    const outB64 = (await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const bytes = Uint8Array.from(atob(${JSON.stringify(srcB64)}), (c) => c.charCodeAt(0))
          const bmp = await createImageBitmap(new Blob([bytes]))
          const scale = Math.min(1, ${MAX_EDGE} / Math.max(bmp.width, bmp.height))
          const w = Math.max(1, Math.round(bmp.width * scale))
          const h = Math.max(1, Math.round(bmp.height * scale))
          const canvas = new OffscreenCanvas(w, h)
          canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
          const blob = await canvas.convertToBlob({ type: 'image/webp', quality: ${QUALITY} })
          const buf = new Uint8Array(await blob.arrayBuffer())
          let bin = ''
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
          return btoa(bin)
        } catch { return null }
      })()`,
    )) as string | null
    if (!outB64) return null
    const out = Buffer.from(outB64, 'base64')
    return out.length > MAX_OUT_BYTES ? null : out
  } catch (err) {
    log.warn('backup', 'webp encode failed', err instanceof Error ? err.message : err)
    return null
  }
}
