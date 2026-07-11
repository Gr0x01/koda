import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchResult, SearchScope } from '@shared/ipc'
import { Overlay } from '../motion'
import { useWorkspace, activeEditor } from './store'

/**
 * The Find overlay (Spotlight-style, like Cursor's ⌘P palette) — project-wide find + replace, summoned
 * over the whole workspace and dismissed on Esc / click-out / opening a result. NOT a persistent rail
 * view: search is a thing you summon, do, and leave.
 *
 * - Empty query → quick-open: recent + currently-open files (jump straight to a file).
 * - Typed query → FILES (fuzzy filename matches, ranked) + IN FILES (substring content hits).
 * - Scope (All / Docs / Code) narrows by file type; Replace mode rewrites every match in one
 *   safety-git-checkpointed (undoable) step.
 *
 * Read/replace go through the contained, capped `fs:search` / `fs:replaceAll` IPC; the renderer never
 * names a path main hasn't vetted. Mounted only while open (Chassis gates it) → fresh state each open.
 */
const MIN_QUERY = 2
const DEBOUNCE_MS = 180

type Row =
  | { kind: 'file'; file: SearchResult['files'][number] }
  | { kind: 'line'; file: SearchResult['files'][number]; line: number; preview: string }
  | { kind: 'recent'; path: string; name: string; dir: string }

export function SearchOverlay() {
  const openFile = useWorkspace((s) => s.openFile)
  const close = useWorkspace((s) => s.setSearchOpen)
  const recentFiles = useWorkspace((s) => s.recentFiles)
  const surfaces = useWorkspace((s) => activeEditor(s).surfaces)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(0)
  const [refreshTick, setRefreshTick] = useState(0)

  const [replaceMode, setReplaceMode] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0) // only the latest in-flight search may write state

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    const q = query.trim()
    // NB: don't clear replaceMsg here — this effect also re-runs on `refreshTick` (right after a
    // replace), which would wipe the success message instantly. It's cleared on query/scope change instead.
    if (q.length < MIN_QUERY) {
      setResult(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const id = ++reqId.current
    const t = setTimeout(() => {
      window.koda
        .search({ query: q, scope })
        .then((r) => {
          if (id !== reqId.current) return // a newer search superseded this one
          setResult(r)
          setSelected(0)
          setSearching(false)
        })
        .catch(() => {
          if (id !== reqId.current) return
          setResult({ query: q, truncated: false, files: [] })
          setSearching(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, scope, refreshTick])

  const q = query.trim()
  const quickOpen = q.length < MIN_QUERY

  // The flat, keyboard-navigable row list — quick-open files when the box is empty, else FILES (ranked
  // filename matches) then IN FILES (per-line content hits).
  const rows = useMemo<Row[]>(() => {
    if (quickOpen) {
      const open = surfaces.map((s) => s.path)
      const paths = [...recentFiles, ...open.filter((p) => !recentFiles.includes(p))]
      return paths.map((p) => ({ kind: 'recent', path: p, name: basename(p), dir: dirname(p) }))
    }
    if (!result) return []
    const fileRows: Row[] = result.files
      .filter((f) => f.nameMatch)
      .sort((a, b) => b.score - a.score)
      .map((f) => ({ kind: 'file', file: f }))
    const lineRows: Row[] = result.files.flatMap((f) =>
      f.matches.map((m) => ({ kind: 'line' as const, file: f, line: m.line, preview: m.preview })),
    )
    return [...fileRows, ...lineRows]
  }, [quickOpen, result, recentFiles, surfaces])

  const fileCount = useMemo(() => rows.filter((r) => r.kind === 'file').length, [rows])
  const totalMatches = result?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0

  // Keep the selected row scrolled into view as the arrows move.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  function openRow(r: Row): void {
    if (r.kind === 'line') openFile(r.file.path, r.line)
    else if (r.kind === 'file') openFile(r.file.path)
    else openFile(r.path)
    close(false)
  }

  async function runReplace(): Promise<void> {
    if (replacing || q.length < MIN_QUERY) return
    setReplacing(true)
    setReplaceMsg(null)
    try {
      const res = await window.koda.replaceAll({ query: q, replacement, scope })
      setReplaceMsg(
        res.replacements === 0
          ? 'Nothing to replace.'
          : `Replaced ${res.replacements} ${res.replacements === 1 ? 'occurrence' : 'occurrences'} in ${res.files} ${res.files === 1 ? 'file' : 'files'} · undo from the recovery timeline`,
      )
      setRefreshTick((n) => n + 1) // re-run the search so the list reflects the replacement
    } catch {
      setReplaceMsg("Couldn't complete the replacement.")
    } finally {
      setReplacing(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, Math.max(0, rows.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[selected]
      if (r) openRow(r)
    }
  }

  return (
    // Spotlight-style: scrim + soft card near the top; click outside the card to dismiss.
    // Enter/exit motion + interruptibility come from the Overlay preset (AnimatePresence in Chassis).
    <Overlay
      onDismiss={() => close(false)}
      align="start"
      className="flex max-h-[64vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-soft"
    >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <IconSearch />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setReplaceMsg(null)
            }}
            onKeyDown={onKeyDown}
            placeholder="Find in this project"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-muted/60"
          />
          {!quickOpen && result && (
            <span className="shrink-0 text-[11px] text-text-muted/70">
              {rows.length === 0
                ? 'No matches'
                : `${totalMatches || fileCount} ${(totalMatches || fileCount) === 1 ? 'result' : 'results'}`}
              {result.truncated && '+'}
            </span>
          )}
          <button
            onClick={() => setReplaceMode((v) => !v)}
            title="Replace"
            aria-label="Toggle replace"
            className={`shrink-0 rounded-md p-1 transition-colors ${
              replaceMode ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-surface hover:text-text'
            }`}
          >
            <IconReplace />
          </button>
        </div>

        {replaceMode && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="w-4 shrink-0" />
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  close(false)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  void runReplace()
                }
              }}
              placeholder="Replace with…"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-text outline-none placeholder:text-text-muted/60"
            />
            <button
              onClick={() => void runReplace()}
              disabled={replacing || q.length < MIN_QUERY || rows.length === 0}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {replacing ? 'Replacing…' : 'Replace all'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-1 border-b border-border px-4 py-1.5">
          {(['all', 'docs', 'code'] as const).map((s) => (
            <button
              key={s}
              onClick={() => {
                setScope(s)
                setReplaceMsg(null)
              }}
              className={`rounded-md px-2 py-0.5 text-[11px] capitalize transition-colors ${
                scope === s ? 'bg-surface text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              {s === 'all' ? 'All' : s}
            </button>
          ))}
          {replaceMsg && <span className="ml-auto truncate text-[11px] text-text-muted">{replaceMsg}</span>}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {quickOpen ? (
            rows.length === 0 ? (
              <p className="px-4 py-2 text-xs text-text-muted">
                Search file names and their contents across this project.
              </p>
            ) : (
              <Results
                rows={rows}
                quickOpen
                fileCount={fileCount}
                query={q}
                selected={selected}
                onHover={setSelected}
                onOpen={openRow}
              />
            )
          ) : searching && !result ? (
            <p className="px-4 py-2 text-xs text-text-muted">Searching…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-2 text-xs text-text-muted">No matches for “{q}”.</p>
          ) : (
            <Results
              rows={rows}
              quickOpen={false}
              fileCount={fileCount}
              query={q}
              selected={selected}
              onHover={setSelected}
              onOpen={openRow}
            />
          )}
        </div>
    </Overlay>
  )
}

function Results({
  rows,
  quickOpen,
  fileCount,
  query,
  selected,
  onHover,
  onOpen,
}: {
  rows: Row[]
  quickOpen: boolean
  fileCount: number
  query: string
  selected: number
  onHover: (i: number) => void
  onOpen: (r: Row) => void
}) {
  return (
    <>
      {quickOpen ? (
        <SectionLabel>Recent</SectionLabel>
      ) : (
        fileCount > 0 && <SectionLabel>Files</SectionLabel>
      )}
      {rows.map((r, i) => (
        <div key={i}>
          {/* The IN FILES heading sits at the boundary between filename rows and the first line row. */}
          {!quickOpen && i === fileCount && rows.length > fileCount && <SectionLabel>In files</SectionLabel>}
          <RowItem
            row={r}
            idx={i}
            query={query}
            active={i === selected}
            onHover={() => onHover(i)}
            onOpen={() => onOpen(r)}
          />
        </div>
      ))}
    </>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-4 pt-2 pb-1 font-display text-[10px] font-semibold uppercase tracking-wider text-text-muted/70">
      {children}
    </h3>
  )
}

function RowItem({
  row,
  idx,
  query,
  active,
  onHover,
  onOpen,
}: {
  row: Row
  idx: number
  query: string
  active: boolean
  onHover: () => void
  onOpen: () => void
}) {
  const name = row.kind === 'recent' ? row.name : row.file.name
  const title = row.kind === 'recent' ? row.path : row.file.rel
  const dir =
    row.kind === 'recent'
      ? row.dir
      : row.file.rel.includes('/')
        ? row.file.rel.slice(0, row.file.rel.lastIndexOf('/'))
        : ''
  return (
    <button
      data-idx={idx}
      onMouseMove={onHover}
      onClick={onOpen}
      title={title}
      className={`flex w-full items-baseline gap-2 px-4 py-1 text-left ${active ? 'bg-accent/10' : ''}`}
    >
      <span className={`shrink-0 truncate text-[13px] ${active ? 'text-accent' : 'text-text'}`}>{name}</span>
      {row.kind === 'line' ? (
        <>
          <span className="shrink-0 text-[10px] tabular-nums text-text-muted/50">{row.line}</span>
          <span className="truncate font-mono text-[11px] text-text-muted">{highlight(row.preview, query)}</span>
        </>
      ) : (
        dir && <span className="truncate text-[11px] text-text-muted/70">{dir}</span>
      )}
    </button>
  )
}

/** Wrap each case-insensitive occurrence of `query` in the preview with an accent mark. */
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

/** Last path segment. */
function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

/** The containing directory (display) — the path minus its last segment. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : ''
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-muted" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function IconReplace() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h11l-2.5-2.5M20 17H9l2.5 2.5" />
    </svg>
  )
}
