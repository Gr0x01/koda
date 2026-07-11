import { IMAGE_DETAIL_CAPS } from '@shared/ipc'

export type StagedImage = { mediaType: string; dataBase64: string }

// Raster types worth re-encoding. Animated GIF (canvas keeps only the first frame) and SVG (canvas
// rasterizes the vector) are passed through untouched; everything else here decodes cleanly.
const COMPRESSIBLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])

/** Blob → bare base64 (strips the `data:…;base64,` prefix), preserving the blob's MIME as mediaType. */
function blobToStaged(blob: Blob): Promise<StagedImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      resolve(comma >= 0 ? { mediaType: blob.type, dataBase64: url.slice(comma + 1) } : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/**
 * Shrink an image before it's sent to the engine. Image *token* cost tracks pixel area, so the
 * downscale to `maxEdge` (longest side) is the real saving; the WebP re-encode then shrinks the
 * payload (and keeps it under the API's per-image size limit). Never upscales. Falls back to the raw
 * file on any failure — an unsupported type, a decode error, or a WebP that came out no smaller — so a
 * paste/drop is never silently dropped or degraded.
 */
export async function compressImage(file: File, maxEdge: number): Promise<StagedImage | null> {
  if (!COMPRESSIBLE.has(file.type)) return blobToStaged(file)
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return blobToStaged(file)
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.82))
    // At native size a pre-optimized JPEG can re-encode larger — keep the smaller original then.
    if (!blob || blob.size >= file.size) return blobToStaged(file)
    return blobToStaged(blob)
  } catch {
    return blobToStaged(file)
  }
}

/** Read image files (paste/drag) → downscale + re-encode → resolve to staged images. */
export async function stagingFromFiles(files: Iterable<File>): Promise<StagedImage[]> {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'))
  if (!imgs.length) return []
  const { imageDetail } = await window.koda.getSettings()
  const maxEdge = IMAGE_DETAIL_CAPS[imageDetail]
  const read = await Promise.all(imgs.map((f) => compressImage(f, maxEdge)))
  return read.filter((r): r is StagedImage => r !== null)
}

/** The trailing path segment (filename) of an absolute path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}
