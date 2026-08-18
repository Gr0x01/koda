import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScratchImage } from '@shared/ipc'
import { HoverCard } from '../ui'
import { RailFootLine } from './RailFoot'
import { useWorkspace } from './store'

const PAGE = 30

/**
 * **Recent images** — this project's scratch images, the durable copies of every screenshot handed to
 * the agent (kept in `.koda/scratch/`, otherwise invisible). One line at the rail's foot; the grid
 * lives in its hover card. Click a thumb to view it full-size, `+` to re-attach it to the active
 * session. Renders nothing when the project has none.
 *
 * It used to be an always-visible strip with a collapsed peek and an expanded grid. A thumbnail strip
 * answers *what exists*, so it does not earn permanent rail height; the expanded grid is the shape
 * that survived, and the card is where it lives.
 *
 * Still **lazy-loads** a page at a time as the end sentinel scrolls into view, so a long retention
 * never puts every image in the renderer at once. The scroll container and sentinel are held as state
 * via callback refs rather than `useRef`, because they only exist while the card is open — a plain ref
 * would still be null on the render that wires the observer, and paging would never start.
 */
export function RecentImages() {
  const tick = useWorkspace((s) => s.scratchTick)
  const setLightbox = useWorkspace((s) => s.setLightbox)
  const addAttachments = useWorkspace((s) => s.addAttachments)
  const activeId = useWorkspace((s) => s.activeId)

  const [images, setImages] = useState<ScratchImage[]>([])
  const [total, setTotal] = useState(0)
  const loadingRef = useRef(false)
  const refreshQueuedRef = useRef(false)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null)

  // Load one page. offset 0 replaces (a fresh refresh); >0 appends (lazy "load more").
  const loadPage = useCallback(async (offset: number) => {
    // Retention can change while the initial page is still in flight. A fresh refresh is authoritative,
    // so queue offset 0 instead of dropping it behind that older request. Lazy-page overlaps may still
    // collapse into one request; the sentinel will ask again if more remains.
    if (loadingRef.current) {
      if (offset === 0) refreshQueuedRef.current = true
      return
    }
    loadingRef.current = true
    let nextOffset = offset
    try {
      while (true) {
        const requestOffset = nextOffset
        if (requestOffset === 0) refreshQueuedRef.current = false
        try {
          const r = await window.koda.listScratchImages({ offset: requestOffset, limit: PAGE })
          setTotal(r.total)
          setImages((prev) => (requestOffset === 0 ? r.images : [...prev, ...r.images]))
        } catch {
          if (requestOffset === 0) {
            setImages([])
            setTotal(0)
          }
        }
        if (!refreshQueuedRef.current) break
        nextOffset = 0
      }
    } finally {
      loadingRef.current = false
    }
  }, [])

  // Refresh from the top on mount and whenever a new image is sent. The first page loads even while
  // the card is shut, because the line itself has to show a count.
  useEffect(() => {
    void loadPage(0)
  }, [tick, loadPage])

  // Lazy-load the next page when the end sentinel scrolls into view; the card's scroll box is the
  // observer root, so nothing fires until the card is actually open.
  useEffect(() => {
    if (!sentinelEl || !scrollEl) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && images.length < total) void loadPage(images.length)
      },
      { root: scrollEl },
    )
    io.observe(sentinelEl)
    return () => io.disconnect()
  }, [sentinelEl, scrollEl, images.length, total, loadPage])

  if (total === 0) return null
  const more = images.length < total

  return (
    <HoverCard
      interactive
      heading="Recent images"
      ariaLabel="Recent images"
      width={272}
      trigger={
        <RailFootLine
          icon={<IconImage />}
          label="Recent images"
          count={total}
          aria-label={`Recent images (${total})`}
        />
      }
    >
      <div
        ref={setScrollEl}
        // p-1 rather than none: the `+` badge floats outside each thumb (-top-1 -right-1) and a scroll
        // box clips it, so the grid needs a hair of room on every edge.
        className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto p-1"
      >
        {images.map((img) => (
          <div key={img.relPath} className="group relative">
            <button
              type="button"
              onClick={() => setLightbox(img)}
              aria-label={`View ${img.name}`}
              className="block aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-bg outline-none transition-opacity hover:opacity-90 focus-visible:border-accent"
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
                aria-label={`Add ${img.name} to your message`}
                onClick={() =>
                  addAttachments(activeId, [
                    {
                      mediaType: img.mediaType,
                      dataBase64: img.dataBase64,
                      scratchPath: img.relPath,
                    },
                  ])
                }
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[11px] leading-none text-white opacity-0 outline-none transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                +
              </button>
            )}
          </div>
        ))}
        {more && <div ref={setSentinelEl} className="aspect-[4/3] w-full" aria-hidden />}
      </div>
      <p className="mt-2 border-t border-border pt-2 text-[11px] text-text-muted">
        Click one to view it, or <span className="text-text">+</span> to add it to your message.
      </p>
    </HoverCard>
  )
}

function IconImage() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  )
}
