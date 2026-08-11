import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScratchImage } from '@shared/ipc'
import { motion } from '../motion'
import { Caret } from '../Caret'
import { useWorkspace } from './store'
import { PanelHeader } from './PanelHeader'

const PAGE = 30

// Resting (collapsed) height: the h-9 (36px) header + a one-row peek (h-12 thumb + pt-2/pb-2 = 64px)
// + the 1px border-t. These are fixed-px Tailwind utilities — the text-size setting only scales the
// --prose-* vars, not the rem base — so this constant is stable. Used as a static flex-basis while
// expand/collapse animates flex-GROW (a unitless, valid-CSS number that reflows for real, so the
// thumbnails never scale-distort the way a transform-based `layout` animation made them).
const COLLAPSED_PX = 101

// A horizontal mask that dissolves whichever edge has more content scrolled past it. Undefined (no mask)
// when neither edge fades, so the expanded grid and a non-overflowing row render at full opacity.
const FADE = 24
function edgeMask({ left, right }: { left: boolean; right: boolean }): string | undefined {
  if (!left && !right) return undefined
  const from = left ? 'transparent' : 'black'
  const to = right ? 'transparent' : 'black'
  return `linear-gradient(to right, ${from}, black ${FADE}px, black calc(100% - ${FADE}px), ${to})`
}

/**
 * A strip of this project's recent scratch images — the durable copies of every screenshot you've handed
 * Claude (kept in `.koda/scratch/`, otherwise invisible). Click a thumb to view it full-size; the `+`
 * re-attaches it to the active session. Hidden when the project has none.
 *
 * Two heights via the title-bar chevron: **collapsed** = a one-row horizontal peek; **expanded** = a
 * vertical grid that grows into (scrunches) the Files section so you can review many at once. Either way
 * it **lazy-loads** a page at a time as the end sentinel scrolls into view — so a long retention can hold
 * "whatever amount" without the renderer ever holding every image in memory. Refetches on each new send.
 */
export function RecentImages() {
  const tick = useWorkspace((s) => s.scratchTick)
  const expanded = useWorkspace((s) => s.recentImagesExpanded)
  const toggleExpanded = useWorkspace((s) => s.toggleRecentImagesExpanded)
  const setLightbox = useWorkspace((s) => s.setLightbox)
  const addAttachments = useWorkspace((s) => s.addAttachments)
  const activeId = useWorkspace((s) => s.activeId)

  const [images, setImages] = useState<ScratchImage[]>([])
  const [total, setTotal] = useState(0)
  // Edge-fade state for the collapsed horizontal row: fade the right while more scrolls off-screen,
  // fade the left once you've scrolled away from the start. Both false in the expanded vertical grid.
  const [fade, setFade] = useState({ left: false, right: false })
  const loadingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Load one page. offset 0 replaces (a fresh refresh); >0 appends (lazy "load more").
  const loadPage = useCallback(async (offset: number) => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const r = await window.koda.listScratchImages({ offset, limit: PAGE })
      setTotal(r.total)
      setImages((prev) => (offset === 0 ? r.images : [...prev, ...r.images]))
    } catch {
      if (offset === 0) {
        setImages([])
        setTotal(0)
      }
    } finally {
      loadingRef.current = false
    }
  }, [])

  // Refresh from the top on mount and whenever a new image is sent.
  useEffect(() => {
    void loadPage(0)
  }, [tick, loadPage])

  // Recompute the edge fades from the scroll position. Only the collapsed row scrolls horizontally;
  // the expanded grid has no overflow-x, so scrollWidth === clientWidth and both fades stay off.
  const updateFade = useCallback(() => {
    const el = scrollRef.current
    if (!el) return setFade({ left: false, right: false })
    const max = el.scrollWidth - el.clientWidth
    setFade({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 })
  }, [])

  // Re-evaluate when content changes (new page, refresh, expand/collapse) and on container resize.
  useEffect(() => {
    updateFade()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateFade)
    ro.observe(el)
    return () => ro.disconnect()
  }, [images.length, expanded, updateFade])

  // Lazy-load the next page when the end sentinel scrolls into view — the scroll container is the
  // observer root, so the same sentinel works for the horizontal row and the vertical grid alike.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && images.length < total) void loadPage(images.length)
      },
      { root },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [images.length, total, loadPage])

  if (images.length === 0) return null
  const more = images.length < total
  return (
    // Animate flex-GROW 0⇄1 (collapsed peek ⇄ expanded fill). flex-grow is unitless, so each frame is
    // valid CSS and reflows the real flex column — the Files sibling (flex-1) yields/reclaims space on
    // its own, no transforms, no thumbnail distortion. flex-basis holds the one-row resting height.
    <motion.div
      className="flex min-h-0 flex-col border-t border-border"
      style={{ flexBasis: COLLAPSED_PX, flexShrink: 0 }}
      initial={false}
      animate={{ flexGrow: expanded ? 1 : 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      <PanelHeader label="Recent images">
        <button
          onClick={toggleExpanded}
          title={expanded ? 'Collapse' : 'Expand'}
          aria-label={expanded ? 'Collapse recent images' : 'Expand recent images'}
          aria-expanded={expanded}
          className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface hover:text-text"
        >
          <Caret dir={expanded ? 'up' : 'down'} />
        </button>
      </PanelHeader>
      <div
        ref={scrollRef}
        onScroll={updateFade}
        // pt-2/px-2: the `+` badge floats outside each thumb (-top-1 -right-1); a scroll container clips
        // both axes (overflow-x:auto forces overflow-y to clip too), so pad enough to keep it visible.
        className={
          expanded
            ? 'flex min-h-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto px-2 pb-2 pt-2'
            : 'flex gap-1.5 overflow-x-auto px-2 pb-2 pt-2'
        }
        style={{ WebkitMaskImage: edgeMask(fade), maskImage: edgeMask(fade) }}
      >
        {images.map((img) => (
          <div key={img.relPath} className="group relative shrink-0">
            <button
              type="button"
              onClick={() => setLightbox(img)}
              title={img.name}
              className="block h-12 w-12 overflow-hidden rounded-md border border-border bg-surface transition-opacity hover:opacity-90"
            >
              <img
                src={`data:${img.mediaType};base64,${img.dataBase64}`}
                alt={img.name}
                className="h-full w-full object-cover"
              />
            </button>
            {activeId && (
              <button
                type="button"
                onClick={() =>
                  addAttachments(activeId, [
                    {
                      mediaType: img.mediaType,
                      dataBase64: img.dataBase64,
                      scratchPath: img.relPath,
                    },
                  ])
                }
                title="Add to message"
                aria-label="Add to message"
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[11px] leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                +
              </button>
            )}
          </div>
        ))}
        {more && <div ref={sentinelRef} className="h-12 w-12 shrink-0" aria-hidden />}
      </div>
    </motion.div>
  )
}
