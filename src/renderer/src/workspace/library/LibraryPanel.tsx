import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  DocKind,
  LibraryDoc,
  LibraryQueryRequest,
  LibraryQueryResult,
  SearchLineMatch,
} from '@shared/ipc'
import { Button, IconButton } from '../../ui'
import { DocProvenance } from '../DocProvenance'
import { StarGlyph } from '../KeptDocs'
import { LibraryAsk } from './LibraryAsk'
import {
  countLabel,
  docTitle,
  docTopic,
  excerptLine,
  KIND_ORDER,
  kindFilterLabel,
  kindLabel,
  libraryResultActionable,
  timeBucket,
  whenLabel,
} from './library-format'

/**
 * The Library, minus the overlay chrome — a surface over one read (`library:query`). It holds no store
 * state of its own: the query and selection are local, while `DocProvenance` and the ask's session
 * citations read only which chats exist.
 *
 * **An IDE shows you files; Koda shows you documents.** That is the whole bar, and it is why no path,
 * folder tree or file extension appears anywhere on this surface. A row is a document's *title*, the
 * sentence its author wrote about what it is for, what kind of thing it is, and when it was last
 * worked on. The reader finds something by recognizing it, never by knowing where it lives.
 *
 * Ranking, capping and exclusion are main's (`queryLibrary`): it reconciles the doc-list exclusion set
 * with the content walk so `CLAUDE.md`, vendored skill files and dependency READMEs are
 * *unrepresentable* here rather than filtered out afterwards. This file therefore never filters or
 * re-sorts what it is handed. Grouping is display only: browse rows keep main's recency order and get
 * time headings inserted at the boundaries, and a search partitions main's already-ranked list into
 * title hits (which main put first) and body hits, dropping nothing.
 */

const DEBOUNCE_MS = 110

/** Module scope so the default is referentially stable and the query effect can depend on it. */
const queryMain = (req: LibraryQueryRequest): Promise<LibraryQueryResult> => window.koda.libraryQuery(req)

export function LibraryPanel({
  onOpenPath,
  onNewDocument,
  onClose,
  starredRels,
  onToggleStarred,
  askingSessionId,
  revision = 0,
}: {
  /** Routed to the store's `openFile` by the container, so the stage stays the one owner of what is open. */
  onOpenPath: (path: string, line?: number) => void
  /** Create in Documents/, open it on the Stage, then let the container dismiss the Library. */
  onNewDocument: () => Promise<void>
  onClose: () => void
  /** Project-relative paths starred in this project. */
  starredRels: string[]
  onToggleStarred: (rel: string) => void
  /** The chat in front when the modal opened, snapshotted by `Library`. */
  askingSessionId?: string | null
  /** `filesRev` — bumps when a document is written, renamed or deleted, so an open Library stays live. */
  revision?: number
}) {
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<DocKind[]>([])
  const [result, setResult] = useState<LibraryQueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState(0)
  const [asking, setAsking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(false)
  const now = Date.now()

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0) // only the newest in-flight query may write state
  const keepPath = useRef<string | null>(null)

  useEffect(() => {
    if (!asking) inputRef.current?.focus()
  }, [asking])

  // One read per keystroke is affordable (main serves the doc walk from a warm cache), but a short
  // debounce still collapses a burst of typing into a single content scan.
  useEffect(() => {
    const id = ++reqId.current
    setLoading(true)
    const t = setTimeout(
      () => {
        queryMain({ query: query.trim() || undefined, kinds: kinds.length ? kinds : undefined })
          .then((r) => {
            if (id !== reqId.current) return
            setResult(r)
            setFailed(false)
            setLoading(false)
          })
          .catch(() => {
            if (id !== reqId.current) return
            setResult(null)
            setFailed(true)
            setLoading(false)
          })
      },
      query.trim() ? DEBOUNCE_MS : 0,
    )
    return () => clearTimeout(t)
  }, [query, kinds, revision])

  const docs = useMemo(() => result?.docs ?? [], [result])
  const searching = query.trim().length > 0
  /** The rendered rows belong to the words in the box only once that exact query has settled. */
  const resultActionable = libraryResultActionable(loading, result?.query, query)

  // Keep the reader's place across a re-query (a filter flip, or the agent writing a file) when the
  // document they were looking at is still in the list.
  useEffect(() => {
    if (!result) return
    const at = result.docs.findIndex((d) => d.path === keepPath.current)
    setSelected(at >= 0 ? at : 0)
  }, [result])

  const active: LibraryDoc | undefined = docs[selected]
  useEffect(() => {
    keepPath.current = active?.path ?? null
  }, [active])

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Headings over main's order. `nameMatch` is main's own verdict, so partitioning on it preserves
  // the ranking exactly (main already sorted title hits first) and loses no row.
  const groups = useMemo(() => {
    const out: { header: string; from: number; docs: LibraryDoc[] }[] = []
    if (searching) {
      const titled = docs.filter((d) => d.nameMatch)
      const inside = docs.filter((d) => !d.nameMatch)
      if (titled.length) out.push({ header: 'Matching titles', from: 0, docs: titled })
      if (inside.length) out.push({ header: 'Found inside', from: titled.length, docs: inside })
      return out
    }
    for (const doc of docs) {
      const header = timeBucket(doc.mtimeMs, now)
      const last = out[out.length - 1]
      if (last && last.header === header) last.docs.push(doc)
      else out.push({ header, from: out.reduce((n, g) => n + g.docs.length, 0), docs: [doc] })
    }
    return out
  }, [docs, searching, now])

  function toggleKind(kind: DocKind): void {
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  }

  async function createDocument(): Promise<void> {
    if (creating) return
    setCreating(true)
    setCreateError(false)
    try {
      await onNewDocument()
    } catch {
      setCreateError(true)
      setCreating(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, Math.max(0, docs.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Keep rendering the last stable list during the debounce, but never ACT on it after the query
      // changed. Enter belongs to the words currently in the box, not a row from the previous search.
      if (resultActionable && active) onOpenPath(active.path)
    }
  }

  if (asking) {
    return (
      <LibraryAsk
        initialQuestion={query}
        askingSessionId={askingSessionId}
        onBack={() => setAsking(false)}
        onOpenDoc={onOpenPath}
        // Following a citation into a conversation leaves the Library the same way opening a document
        // does: the reader asked to go somewhere, so the overlay stops covering it.
        onFollowedSession={onClose}
      />
    )
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-4 pb-2.5 pt-3">
        <IconLibrary />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 id="library-heading" className="font-display text-[12px] font-semibold tracking-tight text-text">
              Library
            </h2>
            <span className="truncate text-[10.5px] text-text-muted/80">
              {createError
                ? 'Could not create a document'
                : failed
                ? 'Could not read this project'
                : loading && !result
                  ? 'Reading your documents'
                  : countLabel(docs.length, searching, result?.truncated ?? false)}
            </span>
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find by title, or by a phrase from inside"
            aria-label="Find a document"
            role="combobox"
            aria-expanded={docs.length > 0}
            aria-controls={docs.length > 0 ? 'library-results' : undefined}
            aria-activedescendant={active ? `library-row-${selected}` : undefined}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-[15px] text-text outline-none placeholder:text-text-muted/60"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={creating}
          onClick={() => void createDocument()}
          className="flex shrink-0 items-center gap-1.5"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {creating ? 'Creating…' : 'New document'}
        </Button>
        <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-text-muted/80">
          esc
        </kbd>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
        <FilterChip active={kinds.length === 0} onClick={() => setKinds([])}>
          Everything
        </FilterChip>
        {KIND_ORDER.map((kind) => (
          <FilterChip key={kind} active={kinds.includes(kind)} onClick={() => toggleKind(kind)}>
            {kindFilterLabel(kind)}
          </FilterChip>
        ))}
      </div>

      {/* Nothing to show takes the whole width: a two-pane split with an empty list beside an empty
          preview states the absence twice and reads like a broken layout rather than a clear answer. */}
      {docs.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {failed ? (
            <Empty title="Could not read this project" body="Reopen the project folder, then try again." />
          ) : !result ? (
            <p className="text-[12px] text-text-muted">Reading your documents…</p>
          ) : /* The query main answered, not the one still being typed: quoting the live box would
                 name a search that has not run yet, and would rewrite itself on every keystroke. */
          result.query.trim() ? (
            <Empty
              title={`Nothing matches “${result.query.trim()}”`}
              body="Try a phrase you remember from inside the document, or ask Koda to find it."
            />
          ) : kinds.length > 0 ? (
            <Empty
              title="No documents of that kind yet"
              body="Choose Everything to see the rest of this project."
            />
          ) : (
            <Empty
              title="No documents yet"
              body="Anything you or Koda writes down lands here, ready to find by name."
            />
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.85fr)_minmax(320px,1.15fr)]">
          <div
            ref={listRef}
            id="library-results"
            role="listbox"
            aria-label="Documents"
            className="min-h-0 overflow-y-auto p-2"
          >
            {groups.map((group) => (
              <div key={group.header} role="group" aria-label={group.header}>
                <h3 className="px-3 pb-1 pt-2.5 font-display text-[9.5px] font-semibold uppercase tracking-[0.09em] text-text-muted/70">
                  {group.header}
                </h3>
                {group.docs.map((doc, i) => {
                  const idx = group.from + i
                  return (
                    <ResultRow
                      key={doc.path}
                      doc={doc}
                      idx={idx}
                      query={query.trim()}
                      active={idx === selected}
                      now={now}
                      onSelect={() => setSelected(idx)}
                      onOpen={() => {
                        if (resultActionable) onOpenPath(doc.path)
                      }}
                    />
                  )
                })}
              </div>
            ))}
          </div>

          <div className="flex min-h-0 flex-col border-l border-border bg-surface">
            {active && (
              <Preview
                doc={active}
                query={query.trim()}
                now={now}
                onOpen={() => {
                  if (resultActionable) onOpenPath(active.path)
                }}
                starred={starredRels.includes(active.rel)}
                onToggleStarred={
                  resultActionable ? () => onToggleStarred(active.rel) : undefined
                }
              />
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-border px-4 py-2">
        {docs.length > 0 && (
          <span className="text-[11px] text-text-muted/80">
            <kbd className="font-mono">↑↓</kbd> to move, <kbd className="font-mono">↵</kbd> to open
          </span>
        )}
        <button
          onClick={() => setAsking(true)}
          className="ml-auto rounded-md px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/10"
        >
          Ask Koda
        </button>
      </div>
    </>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
        active ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}

function ResultRow({
  doc,
  idx,
  query,
  active,
  now,
  onSelect,
  onOpen,
}: {
  doc: LibraryDoc
  idx: number
  query: string
  active: boolean
  now: number
  onSelect: () => void
  onOpen: () => void
}) {
  const authored = doc.description?.trim()
  const subtitle = authored || excerptLine(doc.excerpt)
  const topic = docTopic(doc.rel, doc.resolvedKind)
  return (
    <div
      id={`library-row-${idx}`}
      data-idx={idx}
      role="option"
      aria-selected={active}
      onMouseMove={onSelect}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`cursor-default rounded-lg px-3 py-2 transition-colors ${
        active ? 'bg-accent/10' : 'hover:bg-surface'
      }`}
    >
      <div className="flex items-baseline gap-3">
        <span
          className={`min-w-0 flex-1 truncate font-display text-[13px] font-medium ${
            active ? 'text-accent' : 'text-text'
          }`}
        >
          {docTitle(doc)}
        </span>
        <span className="shrink-0 text-[10px] text-text-muted/70">{whenLabel(doc.mtimeMs, now)}</span>
      </div>
      {subtitle && (
        // An authored description reads at full strength; a scraped opening line is recessed, so the
        // column never pretends the two are the same thing.
        <p className={`mt-0.5 truncate text-[11.5px] ${authored ? 'text-text-muted' : 'text-text-muted/70'}`}>
          {subtitle}
        </p>
      )}
      <p className="mt-1 font-display text-[9.5px] uppercase tracking-[0.08em] text-text-muted/70">
        {kindLabel(doc.resolvedKind)}
        {topic && <span className="text-text-muted/50"> · {topic}</span>}
      </p>
      {doc.matches.slice(0, 2).map((m) => (
        <MatchLine key={m.line} match={m} query={query} />
      ))}
    </div>
  )
}

function MatchLine({ match, query }: { match: SearchLineMatch; query: string }) {
  return (
    <p className="mt-1 flex items-baseline gap-2 truncate font-mono text-[10.5px] text-text-muted/80">
      <span className="shrink-0 tabular-nums text-text-muted/50">{match.line}</span>
      <span className="truncate">{highlight(match.preview, query)}</span>
    </p>
  )
}

function Preview({
  doc,
  query,
  now,
  onOpen,
  starred,
  onToggleStarred,
}: {
  doc: LibraryDoc
  query: string
  now: number
  onOpen: () => void
  starred: boolean
  onToggleStarred?: () => void
}) {
  const topic = docTopic(doc.rel, doc.resolvedKind)
  const paperRef = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  // The fade means "there is more page below". Measured rather than assumed, because a short document
  // whose whole opening fits would otherwise dissolve its own last line for no reason.
  useLayoutEffect(() => {
    const el = paperRef.current
    setClipped(!!el && el.scrollHeight > el.clientHeight + 1)
  }, [doc.path, doc.excerpt])
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6 pt-6">
        <div className="flex flex-wrap items-center gap-1.5 font-display text-[9.5px] uppercase tracking-[0.08em] text-text-muted/80">
          <span>{kindLabel(doc.resolvedKind)}</span>
          {topic && (
            <>
              <span className="text-text-muted/40">·</span>
              <span>{topic}</span>
            </>
          )}
          <span className="text-text-muted/40">·</span>
          <span>{whenLabel(doc.mtimeMs, now)}</span>
        </div>

        <h3 className="mt-2.5 font-display text-[22px] leading-[1.2] tracking-[-0.02em] text-text">
          {docTitle(doc)}
        </h3>

        {doc.description?.trim() && (
          <p className="mt-3 max-w-prose text-[12.5px] leading-[1.6] text-text-muted">{doc.description.trim()}</p>
        )}

        {/* Where this came from. It sits with the title and the description because that is the block
            that says what the document IS, and provenance is the last line of that answer. `-ml-2.5`
            cancels the shared button's padding so "From" lands on the same left edge as the prose it
            annotates. Renders nothing for a document with no recorded source, which is most of them in
            a project that predates the convention. */}
        <DocProvenance source={doc.source} className="-ml-2.5 mt-2" />

        {doc.matches.length > 0 && (
          <div className="mt-5">
            <h4 className="font-display text-[9.5px] font-semibold uppercase tracking-[0.09em] text-text-muted/70">
              Where it matches
            </h4>
            <div className="mt-1.5 space-y-1">
              {doc.matches.slice(0, 6).map((m) => (
                <MatchLine key={m.line} match={m} query={query} />
              ))}
            </div>
          </div>
        )}

        {/* The document itself, set in the doc surface's own reading rhythm and faded out rather than
            cut off: the preview should read like the page it opens, which is the whole difference
            between a document library and a file listing. */}
        {doc.excerpt?.trim() && (
          <div
            ref={paperRef}
            className={`mt-5 max-h-64 overflow-hidden border-l-2 border-accent/20 pl-4 ${
              clipped ? '[mask-image:linear-gradient(to_bottom,#000_58%,transparent_100%)]' : ''
            }`}
          >
            <p className="whitespace-pre-wrap text-[length:var(--doc-fs)] leading-[var(--doc-lh)] text-text/75">
              {doc.excerpt.trim()}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-7 py-3">
        <Button size="sm" onClick={onOpen}>
          Open document
        </Button>
        {/* Starring is a decision, so it is stated where the reader is already deciding — looking at
            the document — and it is a quiet tertiary beside the open action, never a second CTA. */}
        {onToggleStarred && (
          <IconButton
            size="md"
            label={starred ? 'Unstar' : 'Star'}
            aria-pressed={starred}
            onClick={onToggleStarred}
          >
            <StarGlyph filled={starred} size={16} className={starred ? 'text-accent' : ''} />
          </IconButton>
        )}
      </div>
    </>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="font-display text-[13px] font-medium text-text">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[15rem] text-[11.5px] leading-relaxed text-text-muted">{body}</p>
    </div>
  )
}

/** Mark each case-insensitive occurrence of the query inside a matched line. */
function highlight(preview: string, query: string): React.ReactNode {
  if (!query) return preview
  const lower = preview.toLowerCase()
  const needle = query.toLowerCase()
  const out: React.ReactNode[] = []
  let i = 0
  let key = 0
  for (;;) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      out.push(preview.slice(i))
      break
    }
    if (at > i) out.push(preview.slice(i, at))
    out.push(
      <mark key={key++} className="rounded-sm bg-accent/20 text-text">
        {preview.slice(at, at + needle.length)}
      </mark>,
    )
    i = at + needle.length
  }
  return out
}

function IconLibrary() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 self-start text-text-muted/70"
      aria-hidden
    >
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M9 4h4.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H9" />
      <path d="m17.4 6.6 2.2 12.1" />
    </svg>
  )
}
