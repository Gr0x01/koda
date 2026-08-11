import { useEffect, useRef, useState } from 'react'
import { Menu } from '../motion'

/**
 * The doc's outline — Notion's right-edge affordance, two states:
 *   collapsed: a vertical rail of dashes, one per heading, indented by level, current section inked;
 *   hover:     the rail swaps for a floating panel of heading titles; click jumps (smooth scroll).
 *
 * Headings are read from the LIVE ProseMirror DOM (not the markdown) so the outline tracks agent edits
 * for free via a debounced MutationObserver — the same pattern the image resolver and table overlay use.
 * Element handles are never held in state: rows re-query by index at click time, so ProseMirror
 * re-renders can't leave the outline pointing at detached nodes.
 */

/** GitHub-style heading slug — the anchor vocabulary `[text](#section)` links use. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/** The doc's headings in document order (h1–h3 — outline depth; deeper levels are body detail). */
export function docHeadingEls(host: HTMLElement): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3'),
  )
}

type Heading = { text: string; level: number }

/** How far below the pane top a heading counts as "the current section" (past-the-title reading line). */
const ACTIVE_LINE_PX = 96
const DASH_WIDTH = [18, 11, 6] // px per level — h1 longest, like Notion's rail

export function DocOutline({
  hostRef,
  ready,
}: {
  /** The doc's scroll host (the element the headings live in and the user scrolls). */
  hostRef: React.RefObject<HTMLDivElement | null>
  ready: boolean
}): React.JSX.Element | null {
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)

  // Collect headings; recollect (debounced) as the user types or the agent rewrites the doc.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ready) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const collect = (): void => {
      const next = docHeadingEls(host).map((el) => ({
        text: el.textContent?.trim() ?? '',
        level: Number(el.tagName[1]),
      }))
      // Referential stability: only swap state when the outline actually changed, so observer churn
      // (every keystroke in the body) doesn't re-render the rail.
      setHeadings((prev) =>
        prev.length === next.length && prev.every((h, i) => h.text === next[i].text && h.level === next[i].level)
          ? prev
          : next,
      )
    }
    collect()
    const obs = new MutationObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(collect, 300)
    })
    obs.observe(host.querySelector('.milkdown') ?? host, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => {
      if (timer) clearTimeout(timer)
      obs.disconnect()
    }
  }, [hostRef, ready])

  // Current section from scroll position — the last heading above the reading line (rAF-throttled).
  const rafRef = useRef(0)
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ready) return
    const update = (): void => {
      rafRef.current = 0
      const els = docHeadingEls(host)
      const hostTop = host.getBoundingClientRect().top
      let idx = 0
      for (let i = 0; i < els.length; i++) {
        if (els[i].getBoundingClientRect().top - hostTop <= ACTIVE_LINE_PX) idx = i
      }
      setActive(idx)
    }
    const onScroll = (): void => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(update)
    }
    update()
    host.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      host.removeEventListener('scroll', onScroll)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [hostRef, ready, headings])

  // One heading is a title, not a structure — the outline earns its pixels at two.
  if (headings.length < 2) return null

  const jump = (i: number): void => {
    const host = hostRef.current
    if (!host) return
    docHeadingEls(host)[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(i)
  }

  return (
    <div
      className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {/* Collapsed rail — kept in layout while the panel is open so the hover region never collapses. */}
      <div
        aria-hidden
        className={`flex max-h-[60vh] flex-col items-end gap-[7px] overflow-hidden px-2 py-2 transition-opacity ${
          open ? 'opacity-0' : ''
        }`}
      >
        {headings.map((h, i) => (
          <span
            key={i}
            className={`h-[2px] rounded-full ${i === active ? 'bg-text' : 'bg-text-muted/40'}`}
            style={{ width: DASH_WIDTH[h.level - 1] ?? DASH_WIDTH[2] }}
          />
        ))}
      </div>
      <Menu
        open={open}
        origin="origin-right"
        className="absolute right-0 top-1/2 max-h-[60vh] w-60 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface py-1.5 shadow-pop"
      >
        {headings.map((h, i) => (
          <button
            key={i}
            onClick={() => jump(i)}
            className={`block w-full truncate px-3 py-1 text-left text-[12px] transition-colors hover:bg-text/5 ${
              i === active ? 'font-medium text-text' : 'text-text-muted'
            }`}
            style={{ paddingLeft: 12 + (h.level - 1) * 12 }}
          >
            {h.text || 'Untitled'}
          </button>
        ))}
      </Menu>
    </div>
  )
}
