import { useWorkspace } from '../workspace/store'

/** The user's turn — the instruction that opens a turn. Rendered inside the pinned card (see
 *  PinnedUserMessage), so this is just the content: image thumbnails above the text.
 *
 *  Photos render as the same 56px upload tiles as the composer's attachment row (not a large,
 *  height-cropped preview) — so a photo-only turn reads as a labeled anchor, and expanding a turn
 *  just shows the tiles at the size they were attached. Click a tile to view it full-size. */
export function UserMessage({
  text,
  images,
}: {
  text: string
  images?: { mediaType: string; dataBase64: string }[]
}) {
  const setLightbox = useWorkspace((s) => s.setLightbox)
  const hasImages = images && images.length > 0
  return (
    <div className="flex flex-col items-start gap-1.5">
      {hasImages && (
        <div className="flex flex-wrap items-center gap-2">
          {images.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setLightbox(img)}
              title="Click to view"
              className="block h-14 w-14 overflow-hidden rounded-lg border border-border bg-bg transition-opacity hover:opacity-90"
            >
              <img
                src={`data:${img.mediaType};base64,${img.dataBase64}`}
                alt="attachment"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
          {!text && (
            <span className="text-xs text-text-muted">
              {images.length > 1 ? `${images.length} images` : 'Image'}
            </span>
          )}
        </div>
      )}
      {text && (
        <div className="whitespace-pre-wrap text-[length:var(--prose-fs)] leading-relaxed text-text">
          {text}
        </div>
      )}
    </div>
  )
}
