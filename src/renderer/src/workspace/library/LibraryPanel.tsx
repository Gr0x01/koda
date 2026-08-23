import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  undoPointRefusal,
  type DocKind,
  type LibraryDoc,
  type LibraryQueryRequest,
  type LibraryQueryResult,
  type ReadFileResult,
  type SearchFileResult,
  type SearchLineMatch,
  type SearchRequest,
  type SearchResult,
} from '@shared/ipc'
import { Button, IconButton } from '../../ui'
import { DocProvenance } from '../DocProvenance'
import { StarGlyph } from '../KeptDocs'
import { LibraryAsk } from './LibraryAsk'
import {
  docTitle,
  docTopic,
  excerptLine,
  fileContext,
  KIND_ORDER,
  kindFilterLabel,
  kindLabel,
  librarySubtitle,
  libraryResultActionable,
  timeBucket,
  whenLabel,
} from './library-format'

/**
 * The Library, minus the overlay chrome — the one search door in Koda, over two reads: `library:query`
 * (the user's documents) and `fs:search` (every file in the project). It holds no store state of its
 * own: the query and selection are local, while `DocProvenance` and the ask's session citations read
 * only which chats exist.
 *
 * **Documents are the surface; files are the honest floor beneath them.** Browsing is unchanged — a row
 * is a document's *title*, the sentence its author wrote, its kind, and when it was last worked on, and
 * no file appears until the user types. Once they do, a second **Project files** section opens *below*
 * the documents, never interleaved, because a filename the user typed reading as "nothing here" is the
 * exact failure this merge exists to end.
 *
 * Two exclusion universes meet here without touching each other. Documents ranking, capping and
 * exclusion stay main's (`queryLibrary`): `CLAUDE.md`, vendored skill files and dependency READMEs are
 * *unrepresentable* in the Documents section rather than filtered out afterwards. The files section is
 * the honest `searchProject` universe (only `.git`/`node_modules`/`.koda` pruned) and is deliberately
 * not narrowed down — hiding a real file is the same lie in reverse. This file never re-sorts either
 * list; grouping is display only. Documents-above-files is a section guarantee, not a score.
 */

const DEBOUNCE_MS = 110
/** Files only join the search once the query is worth a whole-tree walk. Documents still answer from
 *  the first character (their walk is a warm 10s cache); the file walk is not, and a one-letter query
 *  would scan the project to rank noise. Two characters is the old Find overlay's threshold too. */
const FILE_MIN_QUERY = 2
/** Lines shown in a file preview, and how many to keep above the first match when one exists. */
const PREVIEW_LINES = 16
const PREVIEW_LEAD = 3

/** A row in the merged list — a document (from `queryLibrary`) or a project file (from `fs:search`). */
type Row = { kind: 'doc'; doc: LibraryDoc } | { kind: 'file'; file: SearchFileResult }
const rowKey = (r: Row): string => (r.kind === 'doc' ? `doc:${r.doc.path}` : `file:${r.file.rel}`)

/** Module scope so the defaults are referentially stable and the query effect can depend on them. */
const queryMain = (req: LibraryQueryRequest): Promise<LibraryQueryResult> => window.koda.libraryQuery(req)
const searchMain = (req: SearchRequest): Promise<SearchResult> => window.koda.search(req)

export function LibraryPanel({
  onOpenPath,
  onNewDocument,
  onClose,
  starredRels,
  onToggleStarred,
  askingSessionId,
  revision = 0,
}: {
  /** Routed to the store's `openFile` by the container, so the stage stays the one owner of what is
   *  open. `asCode` forces the raw Monaco view (the file preview's "Open as code"); omitted, a document
   *  format opens rendered and everything else as its editable source. */
  onOpenPath: (path: string, line?: number, asCode?: boolean) => void
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
  const [fileResult, setFileResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [filesLoading, setFilesLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState(0)
  const [asking, setAsking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(false)
  // Bumped by a completed replace so both reads re-run and the list reflects the rewrite.
  const [refreshTick, setRefreshTick] = useState(0)
  const now = Date.now()

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0) // only the newest in-flight fan-out (both reads) may write state
  const keepKey = useRef<string | null>(null)

  const trimmed = query.trim()
  const searching = trimmed.length > 0
  const filesApplicable = trimmed.length >= FILE_MIN_QUERY && kinds.length === 0

  useEffect(() => {
    if (!asking) inputRef.current?.focus()
  }, [asking])

  // One keystroke now fans to two reads. A single request id guards BOTH, so a slow files response for
  // a query the user already moved past can never write over the newer one. Documents answer from the
  // first character (a warm 10s cache); files join only once the query is worth a whole-tree walk, and
  // never while a kind filter is narrowing to a document shelf they have no part in.
  useEffect(() => {
    const id = ++reqId.current
    setLoading(true)
    if (filesApplicable) setFilesLoading(true)
    else {
      // Not a file query (browsing, a one-letter query, or a kind filter): drop any prior file rows now
      // rather than leave a stale section under the documents.
      setFileResult(null)
      setFilesLoading(false)
    }
    const t = setTimeout(
      () => {
        queryMain({ query: trimmed || undefined, kinds: kinds.length ? kinds : undefined })
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
        if (filesApplicable)
          searchMain({ query: trimmed, scope: 'all' })
            .then((r) => {
              if (id !== reqId.current) return
              setFileResult(r)
              setFilesLoading(false)
            })
            .catch(() => {
              if (id !== reqId.current) return
              setFileResult({ query: trimmed, truncated: false, files: [] })
              setFilesLoading(false)
            })
      },
      trimmed ? DEBOUNCE_MS : 0,
    )
    return () => clearTimeout(t)
  }, [trimmed, kinds, filesApplicable, revision, refreshTick])

  const docs = useMemo(() => result?.docs ?? [], [result])

  // The files section ranks like the old Find overlay: name matches first (best fuzzy score wins), then
  // files found only by their contents, in the tree order main returned. Documents outranking files is
  // guaranteed by the section split below, not by any score, so nothing here touches the doc list.
  const fileRows = useMemo<SearchFileResult[]>(() => {
    if (!fileResult) return []
    const named = fileResult.files.filter((f) => f.nameMatch).sort((a, b) => b.score - a.score)
    const inside = fileResult.files.filter((f) => !f.nameMatch)
    return [...named, ...inside]
  }, [fileResult])

  // The one flat, keyboard-navigable list: documents, then (only while searching) project files. Every
  // row's selection index is its position here; the sections below are a display grouping over it.
  const rows = useMemo<Row[]>(() => {
    const docRows: Row[] = docs.map((doc) => ({ kind: 'doc', doc }))
    if (!searching) return docRows
    return [...docRows, ...fileRows.map((file): Row => ({ kind: 'file', file }))]
  }, [docs, fileRows, searching])

  /** A row may be ACTED on only once the read behind it belongs to the words currently in the box. The
   *  two reads settle independently, so each kind of row is gated by its own read. */
  const docsActionable = libraryResultActionable(loading, result?.query, query)
  const filesActionable = !filesLoading && (fileResult?.query.trim() ?? '') === trimmed

  // Keep the reader's place across a re-query (a filter flip, a replace, the agent writing a file) when
  // the row they were on is still present. Keyed by identity, not index, because the two sections shift
  // independently as their reads land.
  useEffect(() => {
    const at = rows.findIndex((r) => rowKey(r) === keepKey.current)
    setSelected(at >= 0 ? at : 0)
  }, [rows])

  const active: Row | undefined = rows[selected]
  useEffect(() => {
    keepKey.current = active ? rowKey(active) : null
  }, [active])

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  /** Hover-select, but only for a hand that actually moved. The two reads settle in waves, and each
   *  wave shifts rows under a parked cursor; Chromium replays mousemove at the same coordinates when
   *  the element under the pointer changes, which would hand selection to whatever row drifted in. */
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  function hoverSelect(idx: number, e: React.MouseEvent): void {
    const last = lastPointer.current
    lastPointer.current = { x: e.clientX, y: e.clientY }
    if (last && last.x === e.clientX && last.y === e.clientY) return
    setSelected(idx)
  }

  // Display grouping over `rows`. Browsing inserts time headings at the recency boundaries main already
  // sorted by; searching states exactly two sections, Documents then Project files, never interleaved.
  const sections = useMemo(() => {
    const out: { header: string; items: { row: Row; idx: number }[] }[] = []
    if (!searching) {
      rows.forEach((row, idx) => {
        if (row.kind !== 'doc') return
        const header = timeBucket(row.doc.mtimeMs, now)
        const last = out[out.length - 1]
        if (last && last.header === header) last.items.push({ row, idx })
        else out.push({ header, items: [{ row, idx }] })
      })
      return out
    }
    const docItems = rows.map((row, idx) => ({ row, idx })).filter((x) => x.row.kind === 'doc')
    const fileItems = rows.map((row, idx) => ({ row, idx })).filter((x) => x.row.kind === 'file')
    if (docItems.length) out.push({ header: 'Documents', items: docItems })
    if (fileItems.length) out.push({ header: 'Project files', items: fileItems })
    return out
  }, [rows, searching, now])

  function openRow(row: Row, asCode = false): void {
    if (row.kind === 'doc') {
      if (docsActionable) onOpenPath(row.doc.path)
    } else if (filesActionable) {
      onOpenPath(row.file.path, row.file.matches[0]?.line, asCode)
    }
  }

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
      setSelected((i) => Math.min(i + 1, Math.max(0, rows.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Keep rendering the last stable list during the debounce, but never ACT on it after the query
      // changed. Enter belongs to the words currently in the box, not a row from the previous search.
      if (active) openRow(active)
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

  const fileCountLabel = searching && !filesApplicable ? null : filesLoading ? null : searching ? fileRows.length : null

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
                  : librarySubtitle(
                      searching,
                      docs.length,
                      result?.truncated ?? false,
                      fileCountLabel,
                      fileResult?.truncated ?? false,
                    )}
            </span>
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a document, or any file, by name or a phrase from inside"
            aria-label="Find a document or a file"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={rows.length > 0 ? 'library-results' : undefined}
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
      {rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {failed ? (
            <Empty title="Could not read this project" body="Reopen the project folder, then try again." />
          ) : !result ? (
            <p className="text-[12px] text-text-muted">Reading your documents…</p>
          ) : loading || filesLoading ? (
            // The documents came back empty but a read is still in flight (the file walk, or a slower
            // replacement scan): "Searching…" rather than a premature "nothing here".
            <p className="text-[12px] text-text-muted">Searching…</p>
          ) : /* The query main answered, not the one still being typed: quoting the live box would
                 name a search that has not run yet, and would rewrite itself on every keystroke. */
          result.query.trim() ? (
            <Empty
              title={`Nothing matches “${result.query.trim()}”`}
              body="Try a phrase you remember from inside the document or file, or ask Koda to find it."
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
            aria-label={searching ? 'Documents and files' : 'Documents'}
            className="min-h-0 overflow-y-auto p-2"
          >
            {sections.map((section) => (
              <div key={section.header} role="group" aria-label={section.header}>
                <h3 className="px-3 pb-1 pt-2.5 font-display text-[9.5px] font-semibold uppercase tracking-[0.09em] text-text-muted/70">
                  {section.header}
                </h3>
                {section.items.map(({ row, idx }) =>
                  row.kind === 'doc' ? (
                    <ResultRow
                      key={rowKey(row)}
                      doc={row.doc}
                      idx={idx}
                      query={trimmed}
                      active={idx === selected}
                      now={now}
                      onSelect={() => setSelected(idx)}
                      onHover={(e) => hoverSelect(idx, e)}
                      onOpen={() => openRow(row)}
                    />
                  ) : (
                    <FileRow
                      key={rowKey(row)}
                      file={row.file}
                      idx={idx}
                      query={trimmed}
                      active={idx === selected}
                      onSelect={() => setSelected(idx)}
                      onHover={(e) => hoverSelect(idx, e)}
                      onOpen={() => openRow(row)}
                    />
                  ),
                )}
              </div>
            ))}
          </div>

          <div className="flex min-h-0 flex-col border-l border-border bg-surface">
            {active?.kind === 'doc' && (
              <Preview
                doc={active.doc}
                query={trimmed}
                now={now}
                onOpen={() => openRow(active)}
                starred={starredRels.includes(active.doc.rel)}
                onToggleStarred={docsActionable ? () => onToggleStarred(active.doc.rel) : undefined}
              />
            )}
            {active?.kind === 'file' && (
              <FilePreview
                file={active.file}
                query={trimmed}
                replaceReady={filesActionable}
                onOpen={() => openRow(active)}
                onOpenAsCode={() => openRow(active, true)}
                onReplaced={() => setRefreshTick((n) => n + 1)}
              />
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-border px-4 py-2">
        {rows.length > 0 && (
          <span className="text-[11px] text-text-muted/80">
            <kbd className="font-mono">↑↓</kbd> to move, <kbd className="font-mono">↵</kbd> to open
          </span>
        )}
        {/* The whole point of the merge: the shortcut that used to open a separate Find box now lands
            here too, so a reader learns the one door once. */}
        <span className="text-[11px] text-text-muted/70">⌘P opens this too</span>
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
  onHover,
  onOpen,
}: {
  doc: LibraryDoc
  idx: number
  query: string
  active: boolean
  now: number
  onSelect: () => void
  onHover: (e: React.MouseEvent) => void
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
      onMouseMove={onHover}
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

/**
 * One project-file row. The filename is mono because a file IS known by its exact name (a document is
 * known by its title), and its location is stated as a phrase so the section never reads as `ls`
 * output. Line hits sit below, exactly like a document's, so the two sections scan the same way.
 */
function FileRow({
  file,
  idx,
  query,
  active,
  onSelect,
  onHover,
  onOpen,
}: {
  file: SearchFileResult
  idx: number
  query: string
  active: boolean
  onSelect: () => void
  onHover: (e: React.MouseEvent) => void
  onOpen: () => void
}) {
  return (
    <div
      id={`library-row-${idx}`}
      data-idx={idx}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`cursor-default rounded-lg px-3 py-2 transition-colors ${
        active ? 'bg-accent/10' : 'hover:bg-surface'
      }`}
    >
      <div className="flex items-baseline gap-3">
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${active ? 'text-accent' : 'text-text'}`}
        >
          {file.nameMatch ? highlight(file.name, query) : file.name}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[11.5px] text-text-muted/70">{fileContext(file.rel)}</p>
      {file.matches.slice(0, 2).map((m) => (
        <MatchLine key={m.line} match={m} query={query} />
      ))}
    </div>
  )
}

/** A window of numbered lines for the file preview: centred on the first match when there is one, else
 *  the head of the file. Built from one contained, size-capped `fs:readFile` — the same read that
 *  opening the file would do, so selecting a row costs no more than opening it. */
function buildFilePreview(
  read: ReadFileResult,
  anchor: number | undefined,
): { lines: { n: number; text: string }[]; binary: boolean } {
  if (read.binary) return { lines: [], binary: true }
  const all = read.content.split('\n')
  const start = anchor ? Math.max(1, anchor - PREVIEW_LEAD) : 1
  const lines = all.slice(start - 1, start - 1 + PREVIEW_LINES).map((text, i) => ({
    n: start + i,
    // A very long line is trimmed for the fixed-width block; the match highlight still lands within it.
    text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
  }))
  return { lines, binary: false }
}

/**
 * The file preview pane. It mirrors the document preview's shape (kicker, title, body, actions) so the
 * two feel like one surface, and it is where find-and-replace now lives — off the first-glance chrome,
 * reachable once a file is in front of you rather than as a mode toggle on the whole search.
 */
function FilePreview({
  file,
  query,
  replaceReady,
  onOpen,
  onOpenAsCode,
  onReplaced,
}: {
  file: SearchFileResult
  query: string
  /** The file rows on screen belong to the words in the box. A replace may only fire against a query
   *  whose results the user is actually looking at, never a fresher query with staler rows. */
  replaceReady: boolean
  onOpen: () => void
  onOpenAsCode: () => void
  onReplaced: () => void
}) {
  const [preview, setPreview] = useState<{ lines: { n: number; text: string }[]; binary: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const reqId = useRef(0)
  const anchor = file.matches[0]?.line

  useEffect(() => {
    const id = ++reqId.current
    setLoading(true)
    setPreview(null)
    window.koda
      .readFile({ path: file.path })
      .then((r) => {
        if (id !== reqId.current) return
        setPreview(buildFilePreview(r, anchor))
        setLoading(false)
      })
      .catch(() => {
        if (id !== reqId.current) return
        setPreview(null)
        setLoading(false)
      })
  }, [file.path, anchor])

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 pb-4 pt-5">
        <span className="font-display text-[9.5px] uppercase tracking-[0.08em] text-text-muted/80">
          File · {fileContext(file.rel)}
        </span>
        <span className="font-mono text-[14.5px] font-medium text-text">{file.name}</span>

        {loading ? (
          <p className="text-[12px] text-text-muted">Reading this file…</p>
        ) : !preview || preview.binary ? (
          <p className="text-[12px] text-text-muted">This file has no text preview.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-bg px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.75] text-text-muted">
            {preview.lines.map((l) => (
              <div key={l.n} className="whitespace-pre">
                <span className="inline-block w-6 select-none text-text-muted/45">{l.n}</span>
                {highlight(l.text, query)}
              </div>
            ))}
          </div>
        )}

        <ReplacePanel query={query} ready={replaceReady} onReplaced={onReplaced} />
      </div>

      <div className="flex items-center gap-2 border-t border-border px-6 py-3">
        <Button size="sm" onClick={onOpen}>
          Open
        </Button>
        {/* Raw source only makes sense for text — an image or other binary has no code view. */}
        {preview && !preview.binary && (
          <Button variant="ghost" size="sm" onClick={onOpenAsCode}>
            Open as code
          </Button>
        )}
      </div>
    </>
  )
}

/**
 * Find and replace, relocated. The old Find overlay carried it as a mode toggle across the whole
 * search; here it is a quiet control in the file pane, so it is reached deliberately. The IPC and its
 * copy are unchanged: main checkpoints the whole tree first, and a refused undo point is reported in
 * its own words rather than as a generic failure a user would retry forever.
 */
function ReplacePanel({ query, ready, onReplaced }: { query: string; ready: boolean; onReplaced: () => void }) {
  const [open, setOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function run(): Promise<void> {
    if (busy || !query || !ready) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.koda.replaceAll({ query, replacement, scope: 'all' })
      setMessage(
        res.replacements === 0
          ? 'Nothing to replace.'
          : `Replaced ${res.replacements} ${res.replacements === 1 ? 'occurrence' : 'occurrences'} in ${res.files} ${res.files === 1 ? 'file' : 'files'} · undo from the recovery timeline`,
      )
      onReplaced() // re-run the search so the list reflects the rewrite
    } catch (e) {
      // Main refuses the replace when it can't first take an undo point. Saying only "couldn't
      // complete" would send the user back to retry forever against a broken recovery store.
      setMessage(undoPointRefusal(e) ?? "Couldn't complete the replacement.")
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-1 self-start rounded-md px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:text-text"
      >
        Find and replace
      </button>
    )

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
          autoFocus
          placeholder={`Replace “${query}” with…`}
          aria-label={`Replace “${query}” across the project`}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none placeholder:text-text-muted/60"
        />
        <Button size="sm" onClick={() => void run()} disabled={busy || !ready}>
          {busy ? 'Replacing…' : 'Replace all'}
        </Button>
      </div>
      {message && <p className="mt-1.5 text-[11px] text-text-muted">{message}</p>}
    </div>
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
