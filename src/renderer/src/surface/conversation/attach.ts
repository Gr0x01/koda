import { attachableMediaType, extensionOf } from '@shared/attachments'
import { IMAGE_DETAIL_CAPS } from '@shared/ipc'

/** A composer attachment, staged in memory until send. Images are compressed and go inline to the
 *  engine as content blocks; document files (csv/pdf) keep their raw bytes + original `name` and reach
 *  the engine as a `.koda/scratch/` path instead (the engine reads files natively — inlining a PDF
 *  would burn tokens and die with the turn). */
export type StagedAttachment = { mediaType: string; dataBase64: string; name?: string }

export function isImageAttachment(a: { mediaType: string }): boolean {
  return a.mediaType.startsWith('image/')
}

// Raster types worth re-encoding — deliberately NOT the accept-list (@shared/attachments), a subset
// of it. Animated GIF passes through untouched (canvas would keep only the first frame); everything
// here decodes cleanly. This set is a token/payload optimization ONLY — never the thing that makes a
// format sendable. Every failure path below falls back to the raw file, so a format that is only
// valid after re-encoding would ship broken; the accept-list keeps that from being representable.
const COMPRESSIBLE = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Blob → bare base64 (strips the `data:…;base64,` prefix), tagged with `mediaType` (the blob's own
 *  MIME unless the caller resolved a better one from the extension). */
function blobToStaged(blob: Blob, mediaType = blob.type): Promise<StagedAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      resolve(comma >= 0 ? { mediaType, dataBase64: url.slice(comma + 1) } : null)
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
export async function compressImage(
  file: File,
  maxEdge: number,
  mediaType = file.type,
): Promise<StagedAttachment | null> {
  // Pass-through keeps the resolved mediaType, not the blob's — a drop can arrive with a blank type,
  // and main names the scratch copy from whatever we send (a blank one lands as `.img`).
  if (!COMPRESSIBLE.has(mediaType)) return blobToStaged(file, mediaType)
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
      return blobToStaged(file, mediaType)
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.82))
    // At native size a pre-optimized JPEG can re-encode larger — keep the smaller original then.
    if (!blob || blob.size >= file.size) return blobToStaged(file, mediaType)
    return blobToStaged(blob)
  } catch {
    return blobToStaged(file, mediaType)
  }
}

/** Read pasted/dragged/picked files → images downscaled + re-encoded, documents (csv/pdf) staged raw
 *  with their original name. Anything else is dropped here and reported by `refusedAttachmentMessage`. */
export async function stagingFromFiles(files: Iterable<File>): Promise<StagedAttachment[]> {
  const accepted = [...files]
    .map((f) => ({ file: f, mediaType: attachableMediaType(f) }))
    .filter((a): a is { file: File; mediaType: string } => a.mediaType !== null)
  const imgs = accepted.filter((a) => a.mediaType.startsWith('image/'))
  const docs = accepted.filter((a) => !a.mediaType.startsWith('image/'))
  if (!imgs.length && !docs.length) return []
  let staged: (StagedAttachment | null)[] = []
  if (imgs.length) {
    const { imageDetail } = await window.koda.getSettings()
    const maxEdge = IMAGE_DETAIL_CAPS[imageDetail]
    staged = await Promise.all(imgs.map(({ file, mediaType }) => compressImage(file, maxEdge, mediaType)))
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

// Reads as "a picture" for the sake of choosing WHICH sentence to show — never an accept decision
// (the one accept-list is @shared/attachments). A HEIC off an iPhone needs to hear about exporting;
// a dropped .zip needs to hear about pointing at it instead. Browsers report a blank type for plenty
// of files, so the extension carries the guess and the MIME is a second chance.
const IMAGE_LIKE_EXTENSIONS = new Set([
  'heic',
  'heif',
  'avif',
  'bmp',
  'svg',
  'tif',
  'tiff',
  'ico',
  'jfif',
  'dng',
  'raw',
  'psd',
])

/**
 * What to say about files a drop, paste or pick could not attach — null when everything was
 * attachable. A companion to `stagingFromFiles` rather than a second return value so the verdict
 * stays pure (no FileReader, no settings round-trip) and is testable on its own.
 *
 * The copy names the file and the next action, never the rule: the accept-list's ceiling is the
 * engine's and the user can do nothing with that fact. Silence here reads as a bug (RB, 2026-08-09).
 */
export function refusedAttachmentMessage(files: Iterable<{ name: string; type: string }>): string | null {
  const refused = [...files].filter((f) => attachableMediaType(f) === null)
  if (!refused.length) return null
  const exts = [...new Set(refused.map((f) => extensionOf(f.name)).filter(Boolean))].map((e) => `.${e}`)
  const what = refused.length === 1 ? refused[0].name : exts.length ? `${joinWords(exts)} files` : 'those files'
  const imageLike = refused.some(
    (f) => f.type.startsWith('image/') || IMAGE_LIKE_EXTENSIONS.has(extensionOf(f.name)),
  )
  const fix = imageLike
    ? 'Export as JPEG or PNG.'
    : refused.length === 1
      ? 'Point at it with the attach menu so the agent reads it in place.'
      : 'Point at them with the attach menu so the agent reads them in place.'
  return `Koda can't attach ${what}. ${fix}`
}

/** "a", "a and b", "a, b and c" — for naming a handful of things in one sentence. */
function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The trailing path segment (filename) of an absolute path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}
