import { useEffect, useRef, useState } from 'react'

/**
 * Find-in-transcript (⌘F when the conversation has focus; Monaco keeps its own ⌘F). A small bar over
 * the top-right of the message list that highlights matches with the CSS Custom Highlight API — no DOM
 * mutation of the rendered markdown, so it can't disturb streaming or layout. Enter / ⇧Enter cycle
 * matches, Esc closes. Matches are recomputed on query change; it's a snapshot, not a live index.
 */
const HL = 'koda-find'
const HL_ACTIVE = 'koda-find-active'

type HighlightCtor = new (...ranges: Range[]) => unknown
type HighlightRegistry = Map<string, unknown> & { set(k: string, v: unknown): void; delete(k: string): void }

function registry(): HighlightRegistry | null {
  const r = (CSS as unknown as { highlights?: HighlightRegistry }).highlights
  const ok = typeof (window as unknown as { Highlight?: unknown }).Highlight === 'function'
  return r && ok ? r : null
}

// Walk the container's text nodes and collect a Range per case-insensitive match.
function collectRanges(container: HTMLElement, query: string): Range[] {
  const out: Range[] = []
  const q = query.toLowerCase()
  if (!q) return out
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.nodeValue!.toLowerCase()
    let from = 0
    let idx = text.indexOf(q, from)
    while (idx !== -1) {
      const range = new Range()
      range.setStart(node, idx)
      range.setEnd(node, idx + q.length)
      out.push(range)
      from = idx + q.length
      idx = text.indexOf(q, from)
    }
  }
  return out
}

export function TranscriptFind({
  containerRef,
  onClose,
  placeholder = 'Find in conversation',
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Recompute matches whenever the query changes; paint them and jump to the first.
  useEffect(() => {
    const reg = registry()
    const container = containerRef.current
    if (!reg || !container) return
    const found = collectRanges(container, query)
    setMatches(found)
    setCurrent(0)
    const Ctor = (window as unknown as { Highlight: HighlightCtor }).Highlight
    if (found.length === 0) {
      reg.delete(HL)
      reg.delete(HL_ACTIVE)
      return
    }
    reg.set(HL, new Ctor(...found))
    reg.set(HL_ACTIVE, new Ctor(found[0]))
    found[0].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [query, containerRef])

  // Highlights live on the global registry — always clear them when the bar unmounts.
  useEffect(() => {
    return () => {
      const reg = registry()
      reg?.delete(HL)
      reg?.delete(HL_ACTIVE)
    }
  }, [])

  function go(delta: number): void {
    if (matches.length === 0) return
    const next = (current + delta + matches.length) % matches.length
    setCurrent(next)
    const reg = registry()
    if (reg) {
      const Ctor = (window as unknown as { Highlight: HighlightCtor }).Highlight
      reg.set(HL_ACTIVE, new Ctor(matches[next]))
    }
    matches[next].startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="absolute right-4 top-2 z-10 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-pop">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-44 bg-transparent text-xs text-text outline-none placeholder:text-text-muted"
      />
      <span className="min-w-[3.5rem] text-right text-[11px] tabular-nums text-text-muted">
        {query ? `${matches.length ? current + 1 : 0}/${matches.length}` : ''}
      </span>
      <FindBtn label="Previous match" disabled={matches.length === 0} onClick={() => go(-1)}>
        <path d="M18 15l-6-6-6 6" />
      </FindBtn>
      <FindBtn label="Next match" disabled={matches.length === 0} onClick={() => go(1)}>
        <path d="M6 9l6 6 6-6" />
      </FindBtn>
      <FindBtn label="Close find" onClick={onClose}>
        <path d="M18 6 6 18M6 6l12 12" />
      </FindBtn>
    </div>
  )
}

function FindBtn({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:text-text disabled:opacity-30"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  )
}
