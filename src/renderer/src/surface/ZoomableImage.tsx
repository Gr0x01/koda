import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const MAX_ZOOM = 8

// object-contain can letterbox the fitted box, so the true scale is the tighter of the two axes.
function renderedScale(img: HTMLImageElement): number {
  const r = img.getBoundingClientRect()
  return Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
}

/**
 * A picture you can look at closely: it opens fitted to its pane, a click jumps to actual size (and
 * back), and pinch or ⌘-scroll zooms continuously around the cursor. Once it is bigger than the pane
 * it pans by ordinary scrolling. Shared by the Stage's image tab and the lightbox so the two never
 * grow different zoom rules.
 */
export function ZoomableImage({
  src,
  alt,
  onBackdropClick,
  className = '',
  imgClassName = '',
}: {
  src: string
  alt: string
  /** A click on the empty space around the picture (the lightbox closes on it). */
  onBackdropClick?: () => void
  className?: string
  imgClassName?: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // null = fitted to the pane; a number = CSS px per image px.
  const [zoom, setZoom] = useState<number | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // The fitted scale, measured as we leave it. Zooming back out past it snaps to fit, so the picture
  // can never end up smaller than the view it started in.
  const fitRef = useRef(1)
  // The image point under the cursor, restored after the resize so a zoom grows around the cursor
  // instead of around the top-left corner.
  const anchorRef = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)

  useEffect(() => setZoom(null), [src])

  const zoomAt = useCallback((next: number | null, x: number, y: number): void => {
    const img = imgRef.current
    if (!img) return
    const r = img.getBoundingClientRect()
    anchorRef.current =
      next === null ? null : { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, x, y }
    setZoom(next)
  }, [])

  useLayoutEffect(() => {
    const a = anchorRef.current
    const img = imgRef.current
    const box = boxRef.current
    anchorRef.current = null
    if (!a || !img || !box) return
    const r = img.getBoundingClientRect()
    box.scrollLeft += r.left + a.fx * r.width - a.x
    box.scrollTop += r.top + a.fy * r.height - a.y
  }, [zoom])

  // Native listener: React's onWheel is passive, and the pinch has to be cancelled or it scrolls the
  // pane while it zooms. A trackpad pinch arrives as a wheel event with ctrlKey set.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const img = imgRef.current
      if (!img?.naturalWidth) return
      const current = renderedScale(img)
      if (zoomRef.current === null) fitRef.current = current
      const next = Math.min(MAX_ZOOM, current * Math.exp(-e.deltaY * 0.01))
      zoomAt(next <= fitRef.current ? null : next, e.clientX, e.clientY)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const toggle = (e: React.MouseEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    if (!img.naturalWidth) return
    if (zoom !== null) return zoomAt(null, e.clientX, e.clientY)
    fitRef.current = renderedScale(img)
    // A picture that already fits at actual size has nothing to reveal at 100%, so it doubles.
    zoomAt(fitRef.current < 0.95 ? 1 : 2, e.clientX, e.clientY)
  }

  return (
    <div className={`relative ${className}`}>
      <div
        ref={boxRef}
        className="h-full w-full overflow-auto"
        onClick={(e) => {
          if (e.target !== imgRef.current) onBackdropClick?.()
        }}
      >
        <div
          className={`flex p-6 ${zoom === null ? 'h-full w-full' : 'h-max min-h-full w-max min-w-full'}`}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            onClick={toggle}
            style={zoom === null ? undefined : { width: (imgRef.current?.naturalWidth ?? 0) * zoom }}
            className={`m-auto ${
              zoom === null
                ? 'max-h-full min-h-0 max-w-full min-w-0 cursor-zoom-in object-contain'
                : 'max-w-none shrink-0 cursor-zoom-out'
            } ${imgClassName}`}
          />
        </div>
      </div>
      {zoom !== null && (
        <button
          type="button"
          onClick={() => setZoom(null)}
          aria-label="Fit image to window"
          className="absolute bottom-3 right-3 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-text-muted shadow-pop transition-colors hover:text-text"
        >
          {Math.round(zoom * 100)}% · Fit
        </button>
      )}
    </div>
  )
}
