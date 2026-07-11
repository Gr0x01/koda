import { useRef } from 'react'

/**
 * A draggable divider used for every resizable split in the workspace (the sidebar, the Sessions ⇆
 * Files split, the conversation ⇆ artifact split, the 2-up artifact split) — everything except the
 * fixed activity rail. A wide invisible grab strip sits over the border so it's easy to hit; a thin
 * centered line tints on hover/drag (after a short delay, so a casual fly-over doesn't flash it).
 * Pointer-captured so the drag survives the cursor leaving the strip.
 *
 * Position it via `style` (the caller knows where the boundary is); the parent must be `relative`.
 * `onResize` receives the raw pointer coords — the caller maps them to a size against its own ref.
 */
export function ResizeHandle({
  orientation,
  style,
  onResize,
  onResizeEnd,
}: {
  orientation: 'horizontal' | 'vertical'
  style?: React.CSSProperties
  onResize: (clientX: number, clientY: number) => void
  /** Fired once when the drag ends — the place to persist the settled size (not on every move). */
  onResizeEnd?: () => void
}) {
  const dragging = useRef(false)
  const isV = orientation === 'vertical' // a vertical bar → resizes width (drag left/right)
  return (
    <div
      style={style}
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (dragging.current) onResize(e.clientX, e.clientY)
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return
        dragging.current = false
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        onResizeEnd?.()
      }}
      onLostPointerCapture={() => {
        if (dragging.current) {
          dragging.current = false
          onResizeEnd?.()
        }
      }}
      className={`group absolute z-10 flex touch-none items-center justify-center ${
        isV
          ? 'right-0 top-0 h-full w-2 translate-x-1/2 cursor-col-resize'
          : 'left-0 right-0 h-2 -translate-y-1/2 cursor-row-resize'
      }`}
    >
      <span
        className={`bg-transparent transition-colors delay-0 group-hover:bg-accent/30 group-hover:delay-700 ${
          isV ? 'h-full w-1' : 'h-1 w-full'
        }`}
      />
    </div>
  )
}
