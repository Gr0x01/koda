import { IMAGE_DETAIL_CAPS } from '@shared/ipc'

/** A composer attachment, staged in memory until send. Images are compressed and go inline to the
 *  engine as content blocks; document files (csv/pdf) keep their raw bytes + original `name` and reach
 *  the engine as a `.koda/scratch/` path instead (the engine reads files natively — inlining a PDF
 *  would burn tokens and die with the turn). */
export type StagedAttachment = { mediaType: string; dataBase64: string; name?: string }

export function isImageAttachment(a: { mediaType: string }): boolean {
  return a.mediaType.startsWith('image/')
}

// Document types the composer accepts alongside images. Detected by extension first — macOS browsers
// report inconsistent MIMEs for csv (`application/vnd.ms-excel`, sometimes empty) — MIME as fallback.
const DOC_EXT: Record<string, string> = { csv: 'text/csv', pdf: 'application/pdf' }
const DOC_MIME = new Set(Object.values(DOC_EXT))

/** The doc mediaType for a file the composer should accept as a document, or null. */
export function docMediaType(file: { name: string; type: string }): string | null {
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  return DOC_EXT[ext] ?? (DOC_MIME.has(file.type) ? file.type : null)
}

// Raster types worth re-encoding. Animated GIF (canvas keeps only the first frame) and SVG (canvas
// rasterizes the vector) are passed through untouched; everything else here decodes cleanly.
const COMPRESSIBLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])

/** Blob → bare base64 (strips the `data:…;base64,` prefix), preserving the blob's MIME as mediaType. */
function blobToStaged(blob: Blob): Promise<StagedAttachment | null> {
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
export async function compressImage(file: File, maxEdge: number): Promise<StagedAttachment | null> {
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

/** Read pasted/dragged/picked files → images downscaled + re-encoded, documents (csv/pdf) staged raw
 *  with their original name. Anything else is ignored. */
export async function stagingFromFiles(files: Iterable<File>): Promise<StagedAttachment[]> {
  const all = [...files]
  const imgs = all.filter((f) => f.type.startsWith('image/'))
  const docs = all
    .map((f) => ({ file: f, mediaType: docMediaType(f) }))
    .filter((d): d is { file: File; mediaType: string } => d.mediaType !== null)
  if (!imgs.length && !docs.length) return []
  let staged: (StagedAttachment | null)[] = []
  if (imgs.length) {
    const { imageDetail } = await window.koda.getSettings()
    const maxEdge = IMAGE_DETAIL_CAPS[imageDetail]
    staged = await Promise.all(imgs.map((f) => compressImage(f, maxEdge)))
  }
  const docStaged = await Promise.all(
    docs.map(async ({ file, mediaType }) => {
      const s = await blobToStaged(file)
      // The blob's own type can be blank/wrong for csv — trust the extension-derived mediaType.
      return s ? { ...s, mediaType, name: file.name } : null
    }),
  )
  return [...staged, ...docStaged].filter((r): r is StagedAttachment => r !== null)
}

/** The trailing path segment (filename) of an absolute path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}
