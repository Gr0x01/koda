import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { docMention, docMentionLabel } from '../../doc-mentions'

type DocEntry = { path: string; rel: string; name: string; mtimeMs: number }

/**
 * The composer's "@" file picker. Typing `@` opens a typeahead over the project's documents; picking
 * one drops an `@<relative-path>` reference into the message so the agent reads it — no hunting the file
 * down and opening it first. References only: the path rides in the text, the agent Reads it on demand.
 *
 * Design (mock approved 2026-07-13, `.koda/scratch/mention-picker-mock.html`): the panel floats on the
 * pop shadow; resting rows are one calm line (name · folder · edited-time); the SELECTED row opens into
 * a small document card showing the doc's first lines, so the user recognizes their document by content,
 * not filename. Ink-blue appears in exactly one place in the list: the letters the user typed.
 *
 * The menu's keyboard handling lives here but is driven by the textarea's own onKeyDown (the composer
 * owns focus): the composer calls `onKeyDown` first and bails out of its own Enter=send when we consumed
 * the key. Detection re-runs on every value/caret change via `sync`.
 */

const MAX_ROWS = 8

// Find an active @mention token ending at the caret. The `@` must start a token (preceded by
// start-of-text or whitespace) and the query after it may not contain whitespace — a space ends it.
function detectMention(value: string, caret: number): { start: number; query: string } | null {
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  const before = at === 0 ? '' : upto[at - 1]
  if (before && !/\s/.test(before)) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

/** "2h ago" / "yesterday" / "Jul 11" — the doc list is recency-sorted, so freshness is the useful cue. */
function formatWhen(ms: number): string {
  const diff = Date.now() - ms
  const hr = 3_600_000
  if (diff < hr) return `${Math.max(1, Math.round(diff / 60_000))}m ago`
  if (diff < 24 * hr) return `${Math.round(diff / hr)}h ago`
  if (diff < 48 * hr) return 'yesterday'
  const d = new Date(ms)
  const s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.getFullYear() === new Date().getFullYear() ? s : `${s}, ${d.getFullYear()}`
}

/** The doc's opening as a two-part excerpt: a lead (its first heading or sentence, shown in the text
 *  ink) and the following prose (muted). Light markdown stripping only — this is a recognition cue,
 *  not a render. */
type Excerpt = { lead: string; rest: string }
function excerptFrom(content: string): Excerpt {
  let body = content
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 4)
    if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1)
  }
  const clean = (line: string): string =>
    line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*>]\s+/, '')
      .replace(/[*_`]/g, '')
      .trim()
  const lines = body.split('\n').map(clean).filter(Boolean)
  const lead = lines[0] ?? ''
  const rest = lines.slice(1).join(' ').slice(0, 240)
  return { lead, rest }
}

/** The matched letters are the list's one use of ink — color + weight on the typed substring. */
function highlightMatch(name: string, query: string): React.ReactNode {
  if (!query) return name
  const i = name.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0) return name
  return (
    <>
      {name.slice(0, i)}
      <span className="font-semibold text-accent">{name.slice(i, i + query.length)}</span>
      {name.slice(i + query.length)}
    </>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 rounded bg-text/6 px-1 py-px font-mono text-[10px]">{children}</kbd>
  )
}

/** The composer's ink layer: renders the draft with `@` reference tokens in accent, everything else
 *  transparent. Painted in a div exactly overlaying the textarea, so the accent glyphs sit on top of
 *  the textarea's own — color only, never weight, or the glyph advance would drift out of register. */
export function inkTokens(text: string): React.ReactNode {
  const out: React.ReactNode[] = []
  const re = /(^|\s)(@"(?:\\.|[^"\\])*"|@\S+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    out.push(text.slice(last, start))
    out.push(
      <span key={start} className="text-accent">
        {m[2]}
      </span>,
    )
    last = start + m[2].length
  }
  out.push(text.slice(last))
  return out
}

export function useMentionPicker(opts: {
  activeId: string | null
  draft: string
  setDraft: (id: string, text: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const { activeId, draft, setDraft, textareaRef } = opts
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [index, setIndex] = useState(0)
  const [docs, setDocs] = useState<DocEntry[]>([])
  // The activeId whose doc list is loaded — refetch on session switch (a different project root).
  const loadedRef = useRef<string | null>(null)
  // The token start-offset the user dismissed with Escape — keep the menu closed for that same token so
  // a caret-move keyup doesn't reopen it. Cleared once the caret leaves the token (start changes / null).
  const dismissedStartRef = useRef<number | null>(null)
  // First-lines excerpts by doc path, fetched lazily for the selected row. `null` marks in-flight.
  const excerptsRef = useRef(new Map<string, Excerpt | null>())
  const [, setExcerptTick] = useState(0)

  // Reset when switching sessions: the doc list belongs to a project, so it can't carry over.
  useEffect(() => {
    loadedRef.current = null
    setDocs([])
    setMention(null)
    excerptsRef.current.clear()
  }, [activeId])

  // Load the doc list the first time a mention opens for this session. listDocs is cached in the main
  // process (~10s), so re-opening is cheap; a just-created doc shows up a beat late at worst.
  useEffect(() => {
    if (!mention || !activeId || loadedRef.current === activeId) return
    let cancelled = false
    window.koda
      .listDocs({})
      .then((res) => {
        if (cancelled) return
        loadedRef.current = activeId
        setDocs(res?.docs ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mention, activeId])

  // Matches for the current query. Empty query → most-recent docs (the list already arrives mtime-desc).
  const matches = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const hits = q
      ? docs.filter((d) => d.name.toLowerCase().includes(q) || d.rel.toLowerCase().includes(q))
      : docs
    return hits.slice(0, MAX_ROWS)
  }, [mention, docs])

  const open = mention !== null && matches.length > 0
  const selected = open ? matches[Math.min(index, matches.length - 1)] : null

  // Fetch the selected doc's first lines once per path (cached for the session). The excerpt is the
  // card's recognition cue; a fetch that hasn't landed just renders the row without one for a beat.
  useEffect(() => {
    if (!selected) return
    const cache = excerptsRef.current
    if (cache.has(selected.path)) return
    cache.set(selected.path, null)
    let stale = false
    window.koda
      .readFile({ path: selected.path })
      .then((res) => {
        cache.set(selected.path, res.binary ? { lead: '', rest: '' } : excerptFrom(res.content))
        if (!stale) setExcerptTick((t) => t + 1)
      })
      .catch(() => {
        cache.delete(selected.path)
      })
    return () => {
      stale = true
    }
  }, [selected])

  // Re-detect after any value/caret change — the composer calls this from onChange, key, and click.
  const sync = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const next = detectMention(el.value, el.selectionStart ?? el.value.length)
    // Leaving the dismissed token clears the dismissal; staying in it keeps the menu suppressed.
    if (!next || next.start !== dismissedStartRef.current) dismissedStartRef.current = null
    if (next && next.start === dismissedStartRef.current) {
      setMention(null)
      return
    }
    setMention((prev) => {
      // Same token → preserve the current selection (don't reset the highlighted row on a caret move).
      if (prev && next && prev.start === next.start && prev.query === next.query) return prev
      setIndex(0)
      return next
    })
  }, [textareaRef])

  const close = useCallback(() => setMention(null), [])

  const choose = useCallback(
    (doc: DocEntry) => {
      if (!activeId || !mention) return
      const el = textareaRef.current
      const value = el?.value ?? draft
      const caret = el?.selectionStart ?? value.length
      // Insert the pretty name (no folder, no extension), not the raw path — cleaner in the composer.
      // The full path is restored engine-side at send time (`expandDocMentions` in the store), so the
      // agent still gets an exact, readable location.
      const ref = `${docMention(docMentionLabel(doc.name))} `
      const next = value.slice(0, mention.start) + ref + value.slice(caret)
      setDraft(activeId, next)
      setMention(null)
      // Restore focus and drop the caret just after the inserted reference on the next frame (the
      // controlled value updates first).
      const pos = mention.start + ref.length
      requestAnimationFrame(() => {
        const t = textareaRef.current
        if (!t) return
        t.focus()
        t.setSelectionRange(pos, pos)
      })
    },
    [activeId, mention, draft, setDraft, textareaRef],
  )

  // Consume nav/select/dismiss keys while the menu is open. Returns true when the composer should NOT
  // run its own handler for this key (so Enter picks a file instead of sending the turn).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setIndex((i) => (i + 1) % matches.length)
          return true
        case 'ArrowUp':
          e.preventDefault()
          setIndex((i) => (i - 1 + matches.length) % matches.length)
          return true
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          choose(matches[Math.min(index, matches.length - 1)])
          return true
        case 'Escape':
          e.preventDefault()
          dismissedStartRef.current = mention?.start ?? null
          setMention(null)
          return true
        default:
          return false
      }
    },
    [open, matches, index, choose, mention],
  )

  const query = mention?.query ?? ''
  const excerpt = selected ? excerptsRef.current.get(selected.path) : null

  const menu = open ? (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-2xl bg-surface shadow-pop">
      <div className="flex items-baseline px-4 pb-0.5 pt-3">
        <span className="font-display text-[12px] font-semibold uppercase tracking-wider text-text-muted">
          Documents
        </span>
        <span className="ml-auto font-mono text-[11px] text-text-muted/70">
          {matches.length} of {docs.length}
        </span>
      </div>
      <ul className="max-h-80 overflow-y-auto px-2 pb-1 pt-1">
        {matches.map((doc, i) => {
          const sel = i === index
          return (
            <li key={doc.path}>
              <button
                type="button"
                // mousedown, not click: fire before the textarea's blur so the pick lands, and keep
                // the caret in the composer.
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(doc)
                }}
                onMouseEnter={() => setIndex(i)}
                className={
                  sel
                    ? 'my-0.5 block w-full rounded-xl bg-text/4 px-3 pb-2.5 pt-2 text-left'
                    : 'block w-full rounded-[10px] px-2.5 py-2 text-left'
                }
              >
                <span className="flex items-baseline gap-2.5">
                  <span
                    className={
                      sel
                        ? 'whitespace-nowrap font-display text-[14.5px] font-semibold text-text'
                        : 'whitespace-nowrap text-[13.5px] font-medium text-text'
                    }
                  >
                    {highlightMatch(docMentionLabel(doc.name), query)}
                  </span>
                  <span className="truncate font-mono text-[11px] text-text-muted/80">
                    {doc.rel.replace(/\/[^/]+$/, '')}
                  </span>
                  <span className="ml-auto flex-none text-[11px] text-text-muted/70">
                    {sel ? 'edited ' : ''}
                    {formatWhen(doc.mtimeMs)}
                  </span>
                </span>
                {sel && excerpt && (excerpt.lead || excerpt.rest) && (
                  <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-muted">
                    {excerpt.lead && <span className="font-medium text-text">{excerpt.lead} </span>}
                    {excerpt.rest}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-4 px-4 pb-2.5 pt-1.5 text-[11px] text-text-muted">
        <span>
          <Kbd>↑↓</Kbd>browse
        </span>
        <span>
          <Kbd>esc</Kbd>dismiss
        </span>
        <span className="ml-auto">
          <Kbd>↵</Kbd>reference it
        </span>
      </div>
    </div>
  ) : null

  return { menu, onKeyDown, sync, close, open }
}
