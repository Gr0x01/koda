/**
 * face-kit/Sheet.jsx — the bottom sheet. COPY VERBATIM (do not edit per app).
 *
 * On a touch screen a chooser or quick task is a sheet, never a popover beside a cursor — and the
 * sheet's FEEL is what this file owns: it springs up, tracks the finger dragging it away, snaps
 * back below the dismiss threshold, commits with a light haptic past it, pads itself above the
 * keyboard, and closes the keyboard that was open under it. Reduce Motion swaps the slide for a
 * fade. Appearance (surface, radius, borders, the handle's color) is the app's via classNames.
 *
 *   <Sheet open={open} onClose={() => setOpen(false)} title="How much?"
 *          className="rounded-t-[22px] bg-ground-2" footer={<Button…/>}>
 *     …content (scrolls internally; drag-down from the top of it dismisses)…
 *   </Sheet>
 *
 * The parent owns `open`; the sheet plays its exit and THEN calls onClose, so unmount is animated
 * without an AnimatePresence dependency.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { haptic } from './host'

const EXIT_MS = 260

export function Sheet({
  open,
  onClose,
  title,
  footer,
  children,
  className = '',
  veilClassName = '',
  handleClassName = '',
  titleClassName = '',
  contentClassName = '',
  footerClassName = '',
}) {
  const [shown, setShown] = useState(false)
  const panelRef = useRef(null)
  const contentRef = useRef(null)
  const drag = useRef(null)
  const closing = useRef(false)

  // Enter: mount hidden below, then flip the class next frame so the transition plays.
  // Also close the keyboard that was open under us — a sheet presents over a settled screen.
  useEffect(() => {
    if (!open) return
    closing.current = false
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur()
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
    return () => cancelAnimationFrame(raf)
  }, [open])

  function dismiss(fromDrag) {
    if (closing.current) return
    closing.current = true
    if (fromDrag) haptic('light')
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur()
    setShown(false)
    setTimeout(() => onClose?.(), EXIT_MS)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') dismiss(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-to-dismiss. Manual listeners (not React props) because tracking the finger needs
  // preventDefault, and React attaches touch handlers passively. The gesture engages from the
  // handle/header always, and from the content only when its scroll sits at the top — mid-list
  // drags keep scrolling the list.
  useEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return

    const onStart = (e) => {
      const t = e.touches[0]
      const inContent = contentRef.current?.contains(e.target)
      drag.current = {
        y0: t.clientY,
        t0: e.timeStamp,
        engaged: false,
        eligible: !inContent || (contentRef.current?.scrollTop ?? 0) <= 0,
      }
    }
    const onMove = (e) => {
      const d = drag.current
      if (!d || !d.eligible) return
      const dy = e.touches[0].clientY - d.y0
      if (!d.engaged) {
        if (dy < 6) return // not a downward pull yet
        d.engaged = true
        panel.classList.add('fk-dragging')
      }
      e.preventDefault()
      panel.style.transform = `translateY(${Math.max(0, dy)}px)`
    }
    const onEnd = (e) => {
      const d = drag.current
      drag.current = null
      if (!d?.engaged) return
      panel.classList.remove('fk-dragging')
      panel.style.transform = ''
      const dy = e.changedTouches[0].clientY - d.y0
      const velocity = dy / Math.max(1, e.timeStamp - d.t0) // px per ms
      if (dy > 120 || velocity > 0.5) dismiss(true)
      // else: clearing the inline transform snaps it back on the sheet's own spring curve
    }

    panel.addEventListener('touchstart', onStart, { passive: true })
    panel.addEventListener('touchmove', onMove, { passive: false })
    panel.addEventListener('touchend', onEnd, { passive: true })
    panel.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      panel.removeEventListener('touchstart', onStart)
      panel.removeEventListener('touchmove', onMove)
      panel.removeEventListener('touchend', onEnd)
      panel.removeEventListener('touchcancel', onEnd)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  return createPortal(
    <>
      <div
        className={`fk-veil ${shown ? 'fk-open' : ''} ${veilClassName}`}
        onClick={() => dismiss(false)}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={`fk-sheet ${shown ? 'fk-open' : ''} ${className}`}
      >
        <div className="fk-grab">
          <div className={`fk-handle ${handleClassName}`} />
        </div>
        {title != null && <div className={titleClassName}>{title}</div>}
        <div
          ref={contentRef}
          className={`fk-sheet-content ${contentClassName}`}
          onTouchMove={() => {
            // Same native feel as the shell: scrolling the sheet's list closes a keyboard its
            // search field opened.
            const el = document.activeElement
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur()
          }}
        >
          {children}
        </div>
        {footer ? <div className={footerClassName}>{footer}</div> : null}
      </div>
    </>,
    document.body,
  )
}
