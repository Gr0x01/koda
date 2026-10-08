import { useEffect } from 'react'
import { AnimatePresence, Overlay } from '../motion'
import { useWorkspace } from '../workspace/store'
import { ZoomableImage } from './ZoomableImage'

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
    // The picture's pane fills the scrim so a zoomed image has the whole window to pan in. A click on
    // the space around it, or Esc, closes; a click on the picture itself zooms.
    <AnimatePresence>
      {img && (
        <Overlay
          onDismiss={() => setLightbox(null)}
          align="center"
          scrimClassName="bg-black/70"
          className="h-full w-full"
        >
          <ZoomableImage
            src={`data:${img.mediaType};base64,${img.dataBase64}`}
            alt="image preview"
            onBackdropClick={() => setLightbox(null)}
            className="h-full w-full"
            imgClassName="rounded-lg shadow-2xl"
          />
        </Overlay>
      )}
    </AnimatePresence>
  )
}
