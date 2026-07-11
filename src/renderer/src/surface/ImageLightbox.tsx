import { useEffect } from 'react'
import { AnimatePresence, Overlay } from '../motion'
import { useWorkspace } from '../workspace/store'

/**
 * The single full-screen image preview for the whole app. One instance is mounted at the Chassis root;
 * any image site (composer staged thumbs, sent images in the transcript, the Recent images strip) opens
 * it by calling `setLightbox(img)`. Click-out or Esc closes. Nothing renders when closed.
 */
export function ImageLightbox() {
  const img = useWorkspace((s) => s.lightbox)
  const setLightbox = useWorkspace((s) => s.setLightbox)

  useEffect(() => {
    if (!img) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [img, setLightbox])

  return (
    // Centered scrim + scale-in image; click the scrim (or the image) or Esc to close.
    <AnimatePresence>
      {img && (
        <Overlay
          onDismiss={() => setLightbox(null)}
          align="center"
          scrimClassName="bg-black/70 p-10"
          className="flex max-h-full max-w-full items-center justify-center"
        >
          <img
            src={`data:${img.mediaType};base64,${img.dataBase64}`}
            alt="image preview"
            onClick={() => setLightbox(null)}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        </Overlay>
      )}
    </AnimatePresence>
  )
}
