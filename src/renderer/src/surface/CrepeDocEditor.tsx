import { useEffect, useMemo, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import { replaceAll } from '@milkdown/kit/utils'
import { useWorkspace } from '../workspace/store'
import { useTableColumnResize } from './useTableColumnResize'
import { buildDocBlockMenu, docBlockPlugins } from './blocks'
import { DocPageChrome } from './DocPageChrome'
import './doc-theme.css'

/** A frozen text selection inside the doc + where to float the Canvas toolbar (wrapper-relative px). */
type CanvasSelection = { text: string; top: number; left: number }

/**
 * Split a leading YAML frontmatter block off the raw file. Milkdown has no frontmatter node, so a bare
 * `---\n…\n---` round-trips to a `***` thematic break — silent metadata loss. We keep it out of the
 * editor entirely and re-attach it verbatim on save: the user only ever sees/edits the prose body, the
 * metadata survives byte-for-byte. The match captures its own trailing newline so `frontmatter + body`
 * reconstructs the original exactly.
 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  return m ? { frontmatter: m[0], body: raw.slice(m[0].length) } : { frontmatter: '', body: raw }
}

/**
 * The WYSIWYG document body — Crepe (Milkdown) over a markdown file. The file on disk stays canonical
 * markdown (the agent reads/writes it unchanged); this is purely a rich VIEW + write-back. Lazy-loaded
 * so Crepe stays out of the conversation-only bundle (loads only when a doc is opened).
 *
 * Saves flow through `fs:writeFile`, where main checkpoints the pre-edit tree before writing — so a
 * user's doc edit is recoverable exactly like an engine tool write (dual-git thesis).
 *
 * Note (spike finding): Crepe re-serializes markdown into a normalised-but-equivalent form (bullet
 * char, table padding). We baseline against the FIRST serialized output, not the raw file, so opening
 * a doc never shows spurious "unsaved changes"; the first real save normalises the file once on disk
 * (idempotent thereafter).
 */
export function CrepeDocEditor({
  path,
  initialContent,
  readOnly = false,
  sessionId,
  className = '',
}: {
  path: string
  /** The file's current on-disk content. Re-passed (freshly read) when the engine edits the file;
   *  since the user's own edits live inside Crepe, a change here means the AGENT edited — we swap the
   *  editor body in place so the user watches the doc build without a remount. */
  initialContent: string
  readOnly?: boolean
  /** The session whose agent last edited this doc — used to detect a new turn (busy rising edge) so the
   *  Keep/Revert review re-baselines per turn instead of accumulating across turns. */
  sessionId?: string
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const crepeRootRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const sendCanvasEdit = useWorkspace((s) => s.sendCanvasEdit)
  // The live "point at a passage → ask the agent" affordance: a frozen selection + a floating toolbar.
  const [sel, setSel] = useState<CanvasSelection | null>(null)
  // Pending agent edit awaiting the user's Keep/Revert. Holds the doc body from BEFORE the edit (the
  // revert target); null = nothing to review. Stays stable across a multi-write turn until the user acts.
  const [review, setReview] = useState<string | null>(null)
  // Detect a NEW agent turn (the doc-session's busy rising edge) so the review re-baselines per turn
  // instead of accumulating — Revert then undoes only the latest turn, not every un-reviewed turn.
  const busy = useWorkspace((s) => (sessionId ? !!s.sessions[sessionId]?.busy : false))
  const newTurnRef = useRef(false)
  const prevBusyRef = useRef(busy)
  useEffect(() => {
    if (busy && !prevBusyRef.current) newTurnRef.current = true
    prevBusyRef.current = busy
  }, [busy])
  // Frontmatter is held aside (never enters the editor) and re-attached on save; the editor + dirty
  // baseline only ever deal with the prose body.
  const { frontmatter, body } = useMemo(() => splitFrontmatter(initialContent), [initialContent])
  const baselineRef = useRef(body)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Flips true once Crepe finishes mounting — also the re-trigger that lets the live-edit effect catch
  // up on any `body` that advanced during the (async) mount window.
  const [ready, setReady] = useState(false)

  // Notion-grade table column resizing — overlaid on Crepe's table NodeView; widths persist to the
  // doc's `.koda/docmeta/` sidecar (the markdown stays plain). Runs once Crepe has mounted.
  useTableColumnResize({ hostRef, path, ready, readOnly })

  // Mount Crepe once per open. `path` is the surface key (SurfacePane remounts on file switch), so a
  // single mount per file is correct — no need to react to content changes here.
  useEffect(() => {
    if (!crepeRootRef.current) return
    let disposed = false
    const crepe = new Crepe({
      // Crepe roots into its own child so the React-rendered page chrome can be a sibling above it,
      // both inside the scroll host (`hostRef`) — so the chrome scrolls with the doc, like Notion.
      root: crepeRootRef.current,
      defaultValue: body,
      // Everyday docs: keep the Notion feel (slash menu, tables, checklists, code, images, toolbar),
      // drop math — no everyday-doc need and it spares the KaTeX weight.
      features: { [Crepe.Feature.Latex]: false },
      // Koda's custom blocks (callout, …) appear in the slash / `+` insert menu.
      featureConfigs: { [Crepe.Feature.BlockEdit]: { buildMenu: buildDocBlockMenu } },
    })
    // Register Koda's block schemas + remark transformers before the editor is created.
    crepe.editor.use(docBlockPlugins)
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        if (!disposed) setDirty(markdown !== baselineRef.current)
      })
    })
    crepe
      .create()
      .then(() => {
        if (disposed) return
        crepe.setReadonly(readOnly)
        // Baseline against the normalised form so the doc doesn't open pre-dirtied.
        baselineRef.current = crepe.getMarkdown()
        crepeRef.current = crepe
        setReady(true)
      })
      .catch((e) => !disposed && setError(String(e)))
    return () => {
      disposed = true
      crepeRef.current = null
      void crepe.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // Live agent edits: `body` only changes when the engine rewrites the file on disk (the user's own
  // edits live in Crepe, not this prop), so a change means the agent edited — swap the editor content
  // in place. Re-baseline to the normalised post-swap form (mirrors the mount baseline) so the doc
  // doesn't show spurious "unsaved changes". `path` is constant per mount, so this only fires on edits.
  const syncedRef = useRef(body)
  useEffect(() => {
    if (body === syncedRef.current) return
    const crepe = crepeRef.current
    // Advance `synced` only once we actually apply — an early return here (still mounting, or read-only)
    // must NOT consume the revision, or an edit landing in the mount window (or before a readOnly→editable
    // flip) would be dropped and never re-applied.
    if (!crepe || readOnly) return
    // Preserve scroll: replaceAll rebuilds the whole doc, which otherwise yanks the view to the top when
    // the agent edits a part the user isn't looking at. (Caret-level preservation — a ProseMirror
    // region-diff transaction — is deferred; the scroll jump is the felt problem.)
    const host = hostRef.current
    const scroll = host?.scrollTop ?? 0
    // Open a review against the pre-edit content — but only on the FIRST edit of a streak, so the revert
    // target stays the content from before the agent's turn across a multi-write turn. Capture the
    // pre-swap baseline into a local NOW: the functional updater may run after we reassign baselineRef below.
    const preEdit = baselineRef.current
    if (newTurnRef.current) {
      newTurnRef.current = false
      setReview(preEdit) // new turn → revert target is the content from before THIS turn
    } else {
      setReview((r) => (r === null ? preEdit : r))
    }
    syncedRef.current = body
    crepe.editor.action(replaceAll(body))
    baselineRef.current = crepe.getMarkdown()
    setDirty(false)
    if (host) {
      host.scrollTop = scroll
      requestAnimationFrame(() => {
        host.scrollTop = scroll
      })
    }
  }, [body, readOnly, ready])

  // Revert a pending agent edit: write the pre-edit body back (checkpointed like any save) and swap the
  // editor to it. A user save doesn't bump `rev`, so this won't re-trigger the live-edit effect.
  async function revertReview(): Promise<void> {
    const target = review
    if (target == null) return
    setReview(null)
    const crepe = crepeRef.current
    if (!crepe) return
    syncedRef.current = target
    crepe.editor.action(replaceAll(target))
    baselineRef.current = crepe.getMarkdown()
    setDirty(false)
    try {
      await window.koda.writeFile({ path, content: frontmatter + target })
    } catch (e) {
      setError(String(e))
    }
  }

  // If the user starts editing on top of a pending agent edit, treat it as an implicit Keep — so Revert
  // can never silently discard the user's own unsaved edits. (Agent swaps leave `dirty` false; only the
  // user's own keystrokes set it true.)
  useEffect(() => {
    if (dirty && review !== null) setReview(null)
  }, [dirty, review])

  async function save(): Promise<void> {
    const crepe = crepeRef.current
    if (!crepe || readOnly || saving) return
    const markdown = crepe.getMarkdown()
    if (markdown === baselineRef.current) return
    setSaving(true)
    setError(null)
    try {
      await window.koda.writeFile({ path, content: frontmatter + markdown })
      baselineRef.current = markdown
      setDirty(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  // ⌘S anywhere in the doc saves (matches Monaco's binding).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    host.addEventListener('keydown', onKey)
    return () => host.removeEventListener('keydown', onKey)
  }, [])

  // Canvas affordance: detect a non-empty selection inside the doc → freeze its text + anchor the
  // toolbar above it. We capture on pointer/key release (not every selectionchange, to avoid thrash)
  // and dismiss on scroll (the toolbar is pinned to the wrapper, not the scrolling content) or collapse.
  useEffect(() => {
    const host = hostRef.current
    const wrap = wrapRef.current
    if (!host || !wrap || readOnly) return
    const capture = (): void => {
      const s = window.getSelection()
      const text = s && !s.isCollapsed && s.rangeCount > 0 ? s.toString().trim() : ''
      const anchor = s?.anchorNode ?? null
      if (!text || !anchor || !host.contains(anchor)) {
        setSel(null)
        return
      }
      const rect = s!.getRangeAt(0).getBoundingClientRect()
      const wr = wrap.getBoundingClientRect()
      setSel({ text, top: rect.top - wr.top, left: rect.left - wr.left + rect.width / 2 })
    }
    const dismiss = (): void => setSel(null)
    host.addEventListener('mouseup', capture)
    host.addEventListener('keyup', capture)
    host.addEventListener('scroll', dismiss)
    return () => {
      host.removeEventListener('mouseup', capture)
      host.removeEventListener('keyup', capture)
      host.removeEventListener('scroll', dismiss)
    }
  }, [readOnly, ready])

  // Hand the frozen selection + instruction to the active session's agent. Auto-save first so the file
  // on disk matches what the user sees (the agent locates the passage in the file) and a checkpoint exists.
  async function askCanvas(instruction: string): Promise<void> {
    if (!sel || !instruction.trim()) return
    const selection = sel.text
    setSel(null)
    await save()
    await sendCanvasEdit({ path, selection, instruction: instruction.trim() })
  }

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full overflow-auto bg-surface">
          <DocPageChrome path={path} readOnly={readOnly} />
          <div ref={crepeRootRef} />
        </div>
        {sel && !readOnly && (
          <CanvasToolbar
            top={sel.top}
            left={sel.left}
            onAsk={(instruction) => void askCanvas(instruction)}
            onClose={() => setSel(null)}
          />
        )}
      </div>
      {review !== null && !readOnly ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-1.5">
          <span className="text-[11px] text-text-muted">Claude edited this document</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void revertReview()}
              className="rounded-lg px-3 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg hover:text-text"
            >
              Revert
            </button>
            <button
              onClick={() => setReview(null)}
              className="rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Keep
            </button>
          </div>
        </div>
      ) : (dirty || error) && !readOnly ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-1.5">
          {error ? (
            <span className="truncate text-[11px] text-red-400">Couldn't save: {error}</span>
          ) : (
            <span className="text-[11px] text-text-muted">Unsaved changes</span>
          )}
          <button
            onClick={() => void save()}
            disabled={saving}
            className="shrink-0 rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Floats above a doc selection: quick verbs + a free-text instruction. Both hand the instruction up to
 *  `onAsk`. Quick-verb buttons preventDefault on mousedown so clicking them doesn't collapse the doc
 *  selection; the input deliberately takes focus (the selection is already frozen in state by then). */
function CanvasToolbar({
  top,
  left,
  onAsk,
  onClose,
}: {
  top: number
  left: number
  onAsk: (instruction: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const QUICK = ['Rewrite', 'Shorten', 'Expand', 'Fix grammar']
  return (
    <div
      className="absolute z-20 -translate-x-1/2 -translate-y-full"
      style={{ top: Math.max(30, top) - 8, left }}
    >
      <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-pop">
        {QUICK.map((q) => (
          <button
            key={q}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAsk(q)}
            className="rounded-lg px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg hover:text-text"
          >
            {q}
          </button>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault()
              onAsk(text.trim())
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder="Ask the agent to edit this…"
          className="w-52 rounded-lg bg-bg px-2 py-1 text-[12px] text-text outline-none placeholder:text-text-muted"
        />
      </div>
    </div>
  )
}

export default CrepeDocEditor
