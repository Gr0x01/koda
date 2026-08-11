/**
 * The one accept-list for composer attachments. Every surface that decides whether a file can be
 * attached reads it from here: the drop/paste path in the renderer, the native file picker in main,
 * and the scratch store that names the saved copy.
 *
 * It lived in four places and had already drifted — `.avif` dropped in fine, was refused by the
 * picker, and saved with an `.img` extension because the scratch MIME→ext map never heard of it.
 *
 * The ceiling on this list is the ENGINE, not our own plumbing, and it is the INTERSECTION of the
 * engines: Claude's Messages API and the Codex driver both take jpeg/png/gif/webp and nothing else.
 * So this list is exactly that set — no format is accepted on the strength of being transcoded first.
 * That rule was earned: `bmp` used to sit here because attach.ts re-encodes it to WebP, but three
 * paths skip that re-encode (any decode failure falls back to the raw file, and Recent images
 * re-attaches from scratch with no compression pass at all), each one staging a `image/bmp` the API
 * rejects. `avif` and `svg` were never transcoded at all. Adding a format means checking BOTH engines
 * take it directly — a transcode elsewhere in the pipeline is not enough.
 *
 * Desktop-only: `src/mobile/` still carries its own copy of this rule (tracked as debt).
 */

/** Extension → media type for image attachments. Also the set the scratch store lists back as
 *  "Recent images", which is why docs are kept separate below. */
export const ATTACHABLE_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Extension → media type for document attachments. These reach the engine as a `.koda/scratch/`
 *  path rather than inline bytes. */
export const ATTACHABLE_DOC_MIME: Record<string, string> = {
  csv: 'text/csv',
  pdf: 'application/pdf',
}

export const ATTACHABLE_MIME: Record<string, string> = { ...ATTACHABLE_IMAGE_MIME, ...ATTACHABLE_DOC_MIME }

/** The extension list the native open dialog filters on. */
export const ATTACHABLE_EXTENSIONS = Object.keys(ATTACHABLE_MIME)

/** Media type → the extension to save it under. First listed extension wins, so `image/jpeg` saves
 *  as `.jpg`, not `.jpeg`. */
export const EXT_FOR_MEDIA_TYPE: Record<string, string> = Object.entries(ATTACHABLE_MIME).reduce<
  Record<string, string>
>((acc, [ext, mime]) => {
  if (!(mime in acc)) acc[mime] = ext
  return acc
}, {})

/** Lowercased extension of a filename, without the dot ('' when there is none). */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/**
 * The media type to stage a dropped/pasted/picked file as, or null when it isn't attachable.
 * Extension first — macOS browsers report inconsistent MIMEs for csv (`application/vnd.ms-excel`,
 * sometimes empty) — with the browser's own MIME as the fallback for extensionless files.
 */
export function attachableMediaType(file: { name: string; type: string }): string | null {
  return ATTACHABLE_MIME[extensionOf(file.name)] ?? (file.type in EXT_FOR_MEDIA_TYPE ? file.type : null)
}
