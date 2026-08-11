/**
 * face-kit/pick.js — attach, the platform way. COPY VERBATIM (do not edit per app).
 *
 * One call to get files from the user. When the shell announced the power (`pick: true` in
 * koda:host — Koda's phone app), this presents the REAL native picker (PHPicker for photos, the
 * document picker for files) over the bridge. Everywhere else it falls back to a transient file
 * input — which on desktop Electron and plain Safari is the right native chooser anyway.
 *
 *   const files = await pick({ kind: 'photo' })                    // one photo
 *   const files = await pick({ kind: 'photo', multiple: true })    // several
 *   const files = await pick({ kind: 'file', types: ['csv','pdf'] })
 *
 * Resolves [{ name?, mediaType, dataB64 }] — empty on cancel, throws only on a real failure.
 * Photos are downscaled to ~1280px longest edge and re-encoded, per the offline data contract:
 * store the result as a data-URL IN the record's JSON body (never a Blob/FormData upload, which
 * the offline write path drops). `asDataUrl(file)` builds that string.
 */

import { hostCaps, requestPick } from './host'

const MAX_EDGE = 1280
const JPEG_QUALITY = 0.82

export async function pick({ kind = 'photo', multiple = false, types } = {}) {
  if (hostCaps().pick) return requestPick({ kind, multiple, types })
  return pickWeb({ kind, multiple, types })
}

export function asDataUrl(file) {
  return `data:${file.mediaType};base64,${file.dataB64}`
}

/** Downscale + re-encode one image blob; falls back to the original bytes on any failure so a
 *  pick is never silently dropped. */
async function shrinkImage(blob) {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY))
    return out && out.size < blob.size ? out : blob
  } catch {
    return blob
  }
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result
      const comma = url.indexOf(',')
      if (comma < 0) reject(new Error('unreadable file'))
      else resolve(url.slice(comma + 1))
    }
    reader.onerror = () => reject(new Error('unreadable file'))
    reader.readAsDataURL(blob)
  })
}

function pickWeb({ kind, multiple, types }) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = kind === 'photo' ? 'image/*' : (types || []).map((t) => `.${t}`).join(',') || '*/*'
    input.multiple = multiple
    // iOS Safari silently ignores .click() on a DETACHED input — it must be in the DOM (hidden).
    input.style.display = 'none'
    document.body.appendChild(input)
    let done = false
    const finish = async (files) => {
      if (done) return
      done = true
      input.remove()
      try {
        const out = []
        for (const f of files.slice(0, multiple ? 8 : 1)) {
          const isImage = f.type.startsWith('image/')
          const blob = isImage ? await shrinkImage(f) : f
          out.push({
            name: f.name || undefined,
            mediaType: blob.type || f.type || 'application/octet-stream',
            dataB64: await blobToB64(blob),
          })
        }
        resolve(out)
      } catch (e) {
        reject(e)
      }
    }
    input.onchange = () => void finish(Array.from(input.files ?? []))
    // A cancelled picker never fires onchange in some browsers; oncancel covers the rest.
    input.oncancel = () => void finish([])
    input.click()
  })
}
