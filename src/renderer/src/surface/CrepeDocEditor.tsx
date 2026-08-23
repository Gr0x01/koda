import { useEffect, useMemo, useRef, useState } from 'react'
import { splitDocumentFrontmatter } from '@shared/document-contract'
import { useWorkspace } from '../workspace/store'
import { Collapse } from '../motion'
import { IconButton, reloadForModuleGraphError, noteModuleGraphRecovered } from '../ui'
import { useTableColumnResize } from './useTableColumnResize'
import { buildDocBlockMenu, docBlockPlugins } from './blocks'
import {
  artifactLinkRef,
  createArtifactCardPlugin,
  decodeArtifactRef,
  deriveInteractiveViewTitle,
  isRecognizedArtifactRef,
  repairArtifactTarget,
  resolveDocRelativePath,
  type ArtifactCardActions,
} from './artifact-card'
import { DocOutline, docHeadingEls, headingSlug } from './DocOutline'
import { DocPageChrome } from './DocPageChrome'
import { TranscriptFind } from './TranscriptFind'
import { Crepe, editorViewCtx, replaceAll } from './milkdown-runtime'
import './doc-theme.css'
import { windowHasOpenModal } from '../window-modal'
import { registerFileWriter } from '../workspace/file-writer-registry'

/** A frozen text selection inside the doc + where to join the Canvas controls beneath Crepe's toolbar. */
type CanvasSelection = { text: string; top: number; left: number }

const KODA_AI_ICON =
  '<svg viewBox="0 0 24 24"><path d="m12 3 1.1 3.4a6 6 0 0 0 3.8 3.8l3.4 1.1-3.4 1.1a6 6 0 0 0-3.8 3.8L12 19.6l-1.1-3.4a6 6 0 0 0-3.8-3.8l-3.4-1.1 3.4-1.1a6 6 0 0 0 3.8-3.8L12 3Z"/><path d="m19 3 .4 1.2a2 2 0 0 0 1.3 1.3l1.2.4-1.2.4a2 2 0 0 0-1.3 1.3L19 8.8l-.4-1.2a2 2 0 0 0-1.3-1.3l-1.2-.4 1.2-.4a2 2 0 0 0 1.3-1.3L19 3Z"/></svg>'

/**
 * Split a leading YAML frontmatter block off the raw file. Milkdown has no frontmatter node, so a bare
 * `---\n…\n---` round-trips to a `***` thematic break — silent metadata loss. We keep it out of the
 * editor entirely and re-attach it verbatim on save: the user only ever sees/edits the prose body, the
 * metadata survives byte-for-byte. The match captures its own trailing newline so `frontmatter + body`
 * reconstructs the original exactly.
 */
/** Project-relative POSIX path of an absolute path that lives under `root`, or null when it does not.
 *  Used to name the source document for the create-interactive command in the project's own terms. */
function relativeUnderProject(root: string, abs: string): string | null {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  if (abs === base || !abs.startsWith(base + '/')) return null
  return abs.slice(base.length + 1)
}

/** Join a project-relative POSIX path back onto its absolute root — the surface key form the Stage
 *  opens an artifact by. */
function joinProjectPath(root: string, rel: string): string {
  return `${root.endsWith('/') ? root.slice(0, -1) : root}/${rel}`
}

/**
 * The two "you can't type here" facts a document holds at once, deliberately kept apart.
 *
 * `readOnly` is about the FILE: today only a truncated read, where saving would destroy the part we
 * never loaded. Reading state is about the USER: they opened the doc and haven't asked to edit it.
 * Collapsing them (the obvious `readOnly={!editing}`) would also stop the agent's live rewrite, the
 * re-read after an engine edit, and the select-a-passage path — the three things a document being
 * READ has to keep doing.
 */
export function docEditorGuards({ readOnly, editing }: { readOnly: boolean; editing: boolean }): {
  /** ProseMirror's own `editable` flag: this gates the user's keystrokes and nothing else. */
  userEditable: boolean
  /** A programmatic `replaceAll` (agent edit, re-read) still lands while the doc is being read. */
  acceptsRefresh: boolean
  /** Selecting a passage to work on it with Koda is what reading state is FOR. */
  selectable: boolean
} {
  return { userEditable: !readOnly && editing, acceptsRefresh: !readOnly, selectable: !readOnly }
}

/** How long the doc sits still before a coalesced autosave lands. Long enough that ordinary typing
 *  doesn't put a file write and a safety-git checkpoint behind every word, short enough that "saved
 *  automatically" is already true by the time the user looks away. */
export const DOC_AUTOSAVE_IDLE_MS = 900

export type SaveCoalescer = {
  /** The body changed: restart the idle timer. */
  schedule: () => void
  /** Write now, resolving once the write settles — leaving edit mode, ⌘S, an ask, or unmount. */
  flush: () => Promise<void>
  /** Drop a pending timer without writing (the editor is about to hold a different file). */
  cancel: () => void
}

/**
 * Coalesces the document's writes. Milkdown reports a change per keystroke, so saving on each one
 * would put a file write and a safety-git checkpoint behind every character. One trailing timer,
 * restarted by each change, is what "saved automatically" means here.
 *
 * Writes are also serialised: a flush arriving mid-write (the Stage tab switch that unmounts the
 * editor) queues one more pass instead of racing the first, so the last keystrokes can't lose to an
 * earlier write landing after them. The returned promise covers the queued pass too.
 */
export function createSaveCoalescer(save: () => Promise<void>, idleMs = DOC_AUTOSAVE_IDLE_MS): SaveCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let queued = false
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const run = (): Promise<void> => {
    if (inFlight) {
      queued = true
      return inFlight
    }
    inFlight = (async () => {
      try {
        await save()
      } finally {
        inFlight = null
        if (queued) {
          queued = false
          await run()
        }
      }
    })()
    return inFlight
  }
  return {
    schedule: () => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        void run()
      }, idleMs)
    },
    flush: () => {
      cancel()
      return run()
    },
    cancel,
  }
}

/**
 * The WYSIWYG document body — Crepe (Milkdown) over a markdown file. The file on disk stays canonical
 * markdown (the agent reads/writes it unchanged); this is purely a rich VIEW + write-back. Lazy-loaded
 * so Crepe stays out of the conversation-only bundle (loads only when a doc is opened).
 *
 * A doc opens in READING state and enters editing only when the user picks Edit; see `docEditorGuards`
 * for why that is not the `readOnly` prop. Editing saves itself: every write, autosaved or manual,
 * goes through the one `save()` below, so there is a single writer to reason about.
 *
 * Saves flow through `fs:writeFile`, where main checkpoints the pre-edit tree before writing — so a
 * user's doc edit is recoverable exactly like an engine tool write (dual-git thesis).
 *
 * Note (spike finding): Crepe re-serializes markdown into a normalised-but-equivalent form (bullet
 * char, table padding). We baseline against the FIRST serialized output, not the raw file, so opening
 * a doc never shows spurious "unsaved changes"; the first real save normalises the file once on disk
 * (idempotent thereafter).
 */
function CrepeDocEditor({
  path,
  surfacePath,
  initialContent,
  readOnly = false,
  sessionId,
  className = '',
}: {
  /** Main's resolved path: the one identity used for writes and destructive-boundary matching. */
  path: string
  /** The lexical path that keys this open Stage surface. */
  surfacePath: string
  /** The file's current on-disk content. Re-passed (freshly read) when the engine edits the file;
   *  since the user's own edits live inside Crepe, a change here means the AGENT edited — we swap the
   *  editor body in place so the user watches the doc build without a remount. */
  initialContent: string
  /** The FILE can't be written back (a truncated read). Not "not editing yet" — see `docEditorGuards`. */
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
  // The card plugin is registered once per mount but must act on the latest resolver, so it calls
  // through this ref rather than closing over a stale render's functions.
  const artifactActionsRef = useRef<ArtifactCardActions>({ onOpen: () => {}, onReveal: () => {} })
  const sendCanvasEdit = useWorkspace((s) => s.sendCanvasEdit)
  const openFile = useWorkspace((s) => s.openFile)
  const projectPath = useWorkspace((s) => s.projectPath)
  // Koda-driven artifact renames/deletes this session — read at click time so a smart card opens the
  // artifact's current home even though the source link text still spells the old one. A ref keeps the
  // card plugin (created once per mount) reading the latest map without re-registering.
  const docRefRepairs = useWorkspace((s) => s.docRefRepairs)
  const repairsRef = useRef(docRefRepairs)
  repairsRef.current = docRefRepairs
  // The live "point at a passage → ask the agent" affordance: a frozen selection + a floating toolbar.
  const [sel, setSel] = useState<CanvasSelection | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  // A refusal from Create interactive view (an empty selection, a source that moved) is a sentence in
  // the status line, never a thrown exception the surface has to survive.
  const [actionError, setActionError] = useState<string | null>(null)
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
  const { frontmatter, body } = useMemo(() => splitDocumentFrontmatter(initialContent), [initialContent])
  const baselineRef = useRef(body)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // `save` reports failures in the pane instead of rejecting every fire-and-forget autosave. The
  // writer registry still needs a hard failure signal so a confirmed delete can stop before main.
  const lastSaveErrorRef = useRef<unknown>(null)
  // Reading vs. direct editing. A doc always opens in reading state; Edit is the one way in.
  const [editing, setEditing] = useState(false)
  const guards = docEditorGuards({ readOnly, editing })
  const editingRef = useRef(editing)
  editingRef.current = editing
  // The body as the editor was torn down. Milkdown's markdown listener is debounced (200ms) and is
  // CANCELLED when the view is destroyed, so the last keystrokes before a tab switch exist nowhere but
  // the editor itself — this is where they are caught on the way out, for the flush that follows.
  const finalBodyRef = useRef<string | null>(null)
  // Autosave. `saveRef` is filled in below (the save closure wants this render's frontmatter and path);
  // the coalescer only calls it when a write is actually due, which is what keeps one writer.
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const autosaveRef = useRef<SaveCoalescer | null>(null)
  if (!autosaveRef.current) autosaveRef.current = createSaveCoalescer(() => saveRef.current())
  const autosave = autosaveRef.current

  // ── Smart artifact references ──────────────────────────────────────────────
  // A recognized relative link to a project-local artifact resolves against the doc's folder, then
  // through this session's Koda-driven renames/deletes, so the card opens the artifact's CURRENT home.
  function resolveArtifact(href: string): { path: string; deleted: boolean } | null {
    const resolved = resolveDocRelativePath(path, decodeArtifactRef(href))
    if (!resolved) return null
    return repairArtifactTarget(resolved, repairsRef.current)
  }
  function openArtifact(href: string): void {
    const target = resolveArtifact(href)
    if (!target || target.deleted) return
    openFile(target.path)
  }
  function revealArtifact(href: string): void {
    const target = resolveArtifact(href)
    if (!target || target.deleted) return
    window.koda.revealPath?.({ path: target.path })
  }
  artifactActionsRef.current = { onOpen: openArtifact, onReveal: revealArtifact }

  /** Insert an ordinary relative markdown link as its own paragraph after the current selection. The
   *  ProseMirror model gains a plain link node, so `getMarkdown()` still emits portable `[t](ref)` — no
   *  new syntax reaches the file. */
  function insertArtifactLink(title: string, ref: string): boolean {
    const crepe = crepeRef.current
    if (!crepe) return false
    try {
      const view = crepe.editor.ctx.get(editorViewCtx)
      const { state } = view
      const linkType = state.schema.marks.link
      const paragraphType = state.schema.nodes.paragraph
      if (!linkType || !paragraphType) return false
      const text = state.schema.text(title, [linkType.create({ href: ref })])
      const paragraph = paragraphType.createAndFill(null, text)
      if (!paragraph) return false
      const $to = state.selection.$to
      const insertAt = $to.depth >= 1 ? $to.after(1) : state.doc.content.size
      view.dispatch(state.tr.insert(insertAt, paragraph))
      return true
    } catch (e) {
      window.koda.logFromRenderer({ level: 'error', args: [`Insert artifact link failed: ${String(e)}`] })
      return false
    }
  }

  /** Create interactive view: carve the selected passage into a sibling HTML artifact, drop a portable
   *  relative link back into the source, and open the artifact beside it on the Stage. The create
   *  command writes exactly one file and touches nothing in the source — inserting the link is this
   *  side's job, so a half-done write can never leave a link pointing at a file that was not created. */
  async function createInteractiveView(): Promise<void> {
    const selection = sel?.text
    setSel(null)
    setAiOpen(false)
    setActionError(null)
    if (!selection) return
    if (!projectPath) {
      setActionError("Couldn't locate this document inside the project.")
      return
    }
    const sourceRel = relativeUnderProject(projectPath, surfacePath)
    if (!sourceRel) {
      setActionError("Couldn't locate this document inside the project.")
      return
    }
    // The source has to match disk: the passage is the seed, and the link lands in the file the command
    // reads. A checkpoint from the flush also covers the edit that inserts the link.
    await autosave.flush()
    const title = deriveInteractiveViewTitle(selection)
    let result: Awaited<ReturnType<typeof window.koda.createInteractiveDocument>>
    try {
      result = await window.koda.createInteractiveDocument({ sourcePath: sourceRel, selection, title })
    } catch (e) {
      setActionError(String(e))
      return
    }
    if (!result.ok) {
      setActionError(result.reason)
      return
    }
    if (insertArtifactLink(title, artifactLinkRef(sourceRel, result.htmlPath))) await autosave.flush()
    openFile(joinProjectPath(projectPath, result.htmlPath))
  }
  // The last save landed but main couldn't take a recovery point for it. Silence would leave the user
  // believing this edit is undoable when it isn't. Cleared by the next save that does get one.
  const [noUndo, setNoUndo] = useState(false)
  // Flips true once Crepe finishes mounting — also the re-trigger that lets the live-edit effect catch
  // up on any `body` that advanced during the (async) mount window.
  const [ready, setReady] = useState(false)

  // Per-doc full width (docmeta sidecar): the page spans the pane instead of the reading column.
  const [fullWidth, setFullWidth] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.koda.getDocMeta({ path }).then((m) => {
      if (!cancelled) setFullWidth(!!m.fullWidth)
    })
    return () => {
      cancelled = true
    }
  }, [path])
  function toggleFullWidth(): void {
    const next = !fullWidth
    setFullWidth(next)
    void window.koda.setDocMeta({ path, meta: { fullWidth: next } })
  }

  // Notion-grade table column resizing — overlaid on Crepe's table NodeView; widths persist to the
  // doc's `.koda/docmeta/` sidecar (the markdown stays plain). Runs once Crepe has mounted.
  // Drag handles are a user mutation, so they follow the human-editing state, not the file's.
  useTableColumnResize({ hostRef, path, ready, readOnly: !guards.userEditable, fullWidth })

  // ⌘F finds inside THIS doc when the user is working in it (focus inside the editor); the
  // conversation's own ⌘F handler stands down for that case (it skips [data-doc-editor], the same
  // way it skips Monaco). The bar reuses TranscriptFind over the doc's scroll host.
  const [findOpen, setFindOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (windowHasOpenModal()) return
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== 'KeyF') return
      const wrap = wrapRef.current
      if (!wrap || !wrap.contains(document.activeElement)) return
      e.preventDefault()
      // One find bar at a time — see ConversationSurface's twin (shared global highlight registry).
      window.dispatchEvent(new CustomEvent('koda:find-open'))
      setFindOpen(true)
    }
    function onOtherFind(): void {
      setFindOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('koda:find-open', onOtherFind)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('koda:find-open', onOtherFind)
    }
  }, [])

  // Links are LIVE (Notion behavior): a click navigates instead of dying in the editor. http(s) → the
  // user's browser (main's window-open handler enforces the scheme), `#anchor` → smooth-scroll to the
  // matching heading (GitHub-slug vocabulary), a relative path → that file opens in the workspace
  // (markdown lands back here as a doc). Any other scheme stays inert — main would refuse it anyway.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onClick = (e: MouseEvent): void => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!a || !host.contains(a)) return
      const href = a.getAttribute('href') ?? ''
      if (!href) return
      e.preventDefault()
      if (/^https?:\/\//i.test(href)) {
        window.open(href)
        return
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return
      const [target, fragment] = href.split('#')
      if (!target) {
        const want = decodeURIComponent(fragment ?? '').toLowerCase()
        const el = docHeadingEls(host).find((h) => headingSlug(h.textContent ?? '') === want)
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      // A recognized artifact link (the card's own title) opens through the rename-repair resolver, so a
      // click lands on the artifact's current home rather than the stale path the source still spells.
      if (isRecognizedArtifactRef(href)) {
        artifactActionsRef.current.onOpen(href)
        return
      }
      const resolved = resolveDocRelativePath(path, decodeURIComponent(target))
      if (resolved) openFile(resolved)
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [path, openFile])

  // File → Export as PDF…: the VISIBLE doc editor answers (panes for other files stay mounted but
  // display:none — offsetParent is null there). Sends the rendered ProseMirror HTML; main owns the
  // print page, save dialog, and opening the result.
  useEffect(() => {
    function onExport(): void {
      const root = crepeRootRef.current
      if (!root || root.offsetParent === null) return
      const html = root.querySelector('.ProseMirror')?.innerHTML
      if (!html) return
      const name = path.split('/').pop() ?? 'Document'
      const title = name.replace(/\.[^.]+$/, '')
      window.koda.exportPdf?.({ title, html }).catch((e: unknown) => {
        window.koda.logFromRenderer({ level: 'error', args: [`PDF export failed: ${String(e)}`] })
      })
    }
    window.addEventListener('koda:export-pdf', onExport)
    return () => window.removeEventListener('koda:export-pdf', onExport)
  }, [path])

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
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: { buildMenu: buildDocBlockMenu },
        [Crepe.Feature.Toolbar]: {
          buildToolbar: (builder) => {
            builder.addGroup('koda', 'Koda').addItem('ask-koda', {
              icon: KODA_AI_ICON,
              active: () => false,
              onRun: () => setAiOpen(true),
            })
          },
        },
      },
    })
    // Register Koda's block schemas + remark transformers before the editor is created.
    crepe.editor.use(docBlockPlugins)
    // Render recognized relative artifact links as smart cards. A decoration, not a node, so the
    // markdown on disk stays the portable link — the card never enters the document model.
    crepe.editor.use(
      createArtifactCardPlugin({
        onOpen: (href) => artifactActionsRef.current.onOpen(href),
        onReveal: (href) => artifactActionsRef.current.onReveal(href),
      }),
    )
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        if (disposed) return
        const changed = markdown !== baselineRef.current
        setDirty(changed)
        // Only the user's own typing arms the autosave. An agent swap also lands here, and its content
        // is already the file on disk — re-baselined a line later, so a queued write would be a no-op
        // anyway, but arming on it would mean reading a doc could write it.
        if (changed && editingRef.current) autosave.schedule()
      })
    })
    crepe
      .create()
      .then(() => {
        if (disposed) return
        // Reading state is the resting state, so a doc is born non-editable; the effect below follows
        // the Edit action from here on.
        crepe.setReadonly(!docEditorGuards({ readOnly, editing: editingRef.current }).userEditable)
        // Baseline against the normalised form so the doc doesn't open pre-dirtied.
        baselineRef.current = crepe.getMarkdown()
        crepeRef.current = crepe
        setInitError(null)
        setReady(true)
        // A clean mount means Vite's graph settled — release the shared reload budget so a later,
        // unrelated churn recovers with a full budget instead of one this open already spent.
        noteModuleGraphRecovered()
      })
      .catch(async (e) => {
        if (disposed) return
        // A dependency pre-bundle replacement can leave Crepe and Koda's custom plugins on opposite
        // sides of Vite's module graph. One guarded full reload is the same recovery used for a stale
        // lazy chunk; the runtime seam above prevents the graph from splitting again after it reloads.
        if (await reloadForModuleGraphError(e)) return
        if (disposed) return
        setInitError(String(e))
        window.koda.logFromRenderer({ level: 'error', args: [`Document editor failed (${path}): ${String(e)}`] })
      })
    return () => {
      disposed = true
      // Hand the body to the unmount flush while the editor still exists. This must stay ahead of
      // `destroy()`, and this effect must stay ahead of the flush effect below, because React runs
      // cleanups in the order their effects were declared.
      if (crepeRef.current === crepe) finalBodyRef.current = crepe.getMarkdown()
      crepeRef.current = null
      void crepe.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // A new file in this instance is a new document: it opens in reading state, carries none of the
  // previous doc's per-file flags, and must not inherit a pending write — a queued autosave firing
  // after the swap would put the old body under the new path.
  useEffect(() => {
    setEditing(false)
    setNoUndo(false)
    setReady(false)
    setInitError(null)
    setSaveError(null)
    finalBodyRef.current = null
    autosave.cancel()
  }, [path, autosave])

  // The Edit action reaches ProseMirror here. Also re-asserted on `ready` so a doc that finished
  // mounting after the user pressed Edit still lands editable.
  useEffect(() => {
    crepeRef.current?.setReadonly(!guards.userEditable)
  }, [guards.userEditable, ready])

  // Local images: a doc's markdown keeps plain relative refs (`assets/pic.png`), but the renderer's
  // origin can't load them. Rewrite each `<img>`'s src in place to a `koda-preview://` URL that serves
  // the contained project file — display only; the ProseMirror model + on-disk markdown stay untouched
  // (so the doc never dirties). A MutationObserver re-resolves images the agent inserts or PM re-renders.
  useEffect(() => {
    const rootEl = crepeRootRef.current
    if (!rootEl || !ready) return
    let cancelled = false
    const cache = new Map<string, string>()
    // Skip anything already loadable: a scheme (data:/http:/blob:/koda-preview:) or a protocol-relative URL.
    const hasScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')
    const resolveImg = async (img: HTMLImageElement): Promise<void> => {
      const ref = img.getAttribute('src') ?? ''
      if (!ref || hasScheme(ref)) return
      let url = cache.get(ref)
      if (!url) {
        const r = await window.koda.docAssetUrl(path, ref)
        if (!r || cancelled) return
        cache.set(ref, r)
        url = r
      }
      if (img.getAttribute('src') === ref) img.src = url // guard against a concurrent PM re-render
    }
    const scan = (el: ParentNode): void =>
      el.querySelectorAll?.('img').forEach((i) => void resolveImg(i as HTMLImageElement))
    scan(rootEl)
    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'attributes' && rec.target instanceof HTMLImageElement) {
          void resolveImg(rec.target)
        } else {
          rec.addedNodes.forEach((n) => {
            if (n instanceof HTMLImageElement) void resolveImg(n)
            else if (n instanceof Element) scan(n)
          })
        }
      }
    })
    obs.observe(rootEl, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    })
    return () => {
      cancelled = true
      obs.disconnect()
    }
  }, [ready, path])

  // Live agent edits: `body` only changes when the engine rewrites the file on disk (the user's own
  // edits live in Crepe, not this prop), so a change means the agent edited — swap the editor content
  // in place. Re-baseline to the normalised post-swap form (mirrors the mount baseline) so the doc
  // doesn't show spurious "unsaved changes". `path` is constant per mount, so this only fires on edits.
  const syncedRef = useRef(body)
  useEffect(() => {
    if (body === syncedRef.current) return
    const crepe = crepeRef.current
    // Advance `synced` only once we actually apply — an early return here (still mounting, or a file we
    // can't write back) must NOT consume the revision, or an edit landing in the mount window would be
    // dropped and never re-applied. Reading state deliberately does NOT gate this: a doc the user is
    // only reading still has to show the agent's work land.
    if (!crepe || !guards.acceptsRefresh) return
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
  }, [body, guards.acceptsRefresh, ready])

  // Revert a pending agent edit: write the pre-edit body back (checkpointed like any save) and swap the
  // editor to it. A user save doesn't bump `rev`, so this won't re-trigger the live-edit effect.
  async function revertReview(): Promise<void> {
    const target = review
    if (target == null) return
    setReview(null)
    // A pending autosave holds the pre-revert body; letting it fire afterwards would undo the revert.
    autosave.cancel()
    const crepe = crepeRef.current
    if (!crepe) return
    syncedRef.current = target
    crepe.editor.action(replaceAll(target))
    setDirty(true)
    // Revert is a write too. Sending it through the same serial coalescer means a sidebar delete can
    // await it, and a failed revert leaves the old on-disk baseline intact for Retry to write again.
    await autosave.flush()
  }

  // If the user starts editing on top of a pending agent edit, treat it as an implicit Keep — so Revert
  // can never silently discard the user's own unsaved edits. (Agent swaps leave `dirty` false; only the
  // user's own keystrokes set it true.)
  useEffect(() => {
    if (dirty && review !== null) setReview(null)
  }, [dirty, review])

  // The document's ONE writer: autosave, ⌘S, the retry button, an ask, and the unmount flush all land
  // here, so there is a single place where a doc reaches disk and a single place a checkpoint comes
  // from. Serialisation across overlapping calls belongs to the coalescer, not to a `saving` guard —
  // a dropped call would be a lost keystroke.
  async function save(): Promise<void> {
    if (readOnly) return
    // Ask the editor, not the debounced change listener: a save can land within 200ms of a keystroke
    // (leaving edit mode, ⌘S) and the listener would still be holding it. `finalBodyRef` covers the
    // one case the editor can't: the flush that runs after this pane has been torn down.
    const markdown = crepeRef.current?.getMarkdown() ?? finalBodyRef.current
    if (markdown === null) return
    if (markdown === baselineRef.current) {
      lastSaveErrorRef.current = null
      setSaveError(null)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await window.koda.writeFile({ path, content: frontmatter + markdown })
      baselineRef.current = markdown
      setDirty(false)
      setNoUndo(res.checkpointed === false)
      lastSaveErrorRef.current = null
    } catch (e) {
      lastSaveErrorRef.current = e
      setSaveError(String(e))
      // The error line can only be read while this pane is mounted, and the flush that matters most
      // runs as it unmounts — so a failed save leaves a trace the user can be pointed at later.
      window.koda.logFromRenderer({ level: 'error', args: [`Document save failed (${path}): ${String(e)}`] })
    } finally {
      setSaving(false)
    }
  }
  saveRef.current = save

  // The store cannot see an editor's live buffer, so expose one path-scoped drain for destructive
  // mutations. Keep the registration until the unmount flush settles: a delete requested just after
  // a tab switch must still wait for the write already leaving this editor. This effect stays after
  // Crepe's mount effect so its cleanup receives the finalBodyRef snapshot made before destroy().
  useEffect(() => {
    const unregister = registerFileWriter(path, surfacePath, async () => {
      await autosave.flush()
      if (lastSaveErrorRef.current) throw lastSaveErrorRef.current
    })
    return () => {
      void autosave.flush().catch(() => {}).finally(unregister)
    }
  }, [path, surfacePath, autosave])

  // ⌘S anywhere in the doc saves (matches Monaco's binding). It flushes rather than saving directly so
  // it can't race a coalesced write already on its way.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void autosave.flush()
      }
    }
    host.addEventListener('keydown', onKey)
    return () => host.removeEventListener('keydown', onKey)
  }, [autosave])

  // Leaving edit mode is a promise that what was typed is on disk, so it flushes before the door shuts.
  function stopEditing(): void {
    setEditing(false)
    void autosave.flush()
  }

  // Canvas affordance: detect a non-empty selection and remember Crepe's own bubble geometry. The
  // formatting toolbar includes one Koda action; choosing it transforms that same popover position
  // into the agent controls instead of showing a competing second bubble.
  useEffect(() => {
    const host = hostRef.current
    const wrap = wrapRef.current
    // Reading state keeps this: pointing at a passage and asking Koda about it is the whole reason a
    // document that can't be typed into is still live.
    if (!host || !wrap || !guards.selectable) return
    let positionTimer: number | null = null
    const capture = (event: MouseEvent | KeyboardEvent): void => {
      // Crepe runs toolbar commands on pointerdown. Don't let that same interaction's mouseup bubble
      // into this selection observer and immediately reset the Koda mode it just opened.
      if (event.target instanceof Element && event.target.closest('.milkdown-toolbar')) return
      const s = window.getSelection()
      const text = s && !s.isCollapsed && s.rangeCount > 0 ? s.toString().trim() : ''
      const anchor = s?.anchorNode ?? null
      if (!text || !anchor || !host.contains(anchor)) {
        setSel(null)
        setAiOpen(false)
        return
      }
      setAiOpen(false)
      if (positionTimer !== null) window.clearTimeout(positionTimer)
      positionTimer = window.setTimeout(() => {
        const toolbar = crepeRootRef.current?.querySelector<HTMLElement>('.milkdown-toolbar[data-show="true"]')
        if (!toolbar) return
        const tr = toolbar.getBoundingClientRect()
        const wr = wrap.getBoundingClientRect()
        setSel({ text, top: tr.top - wr.top, left: tr.left - wr.left + tr.width / 2 })
      }, 30)
    }
    const dismiss = (): void => {
      setSel(null)
      setAiOpen(false)
    }
    host.addEventListener('mouseup', capture)
    host.addEventListener('keyup', capture)
    host.addEventListener('scroll', dismiss)
    return () => {
      if (positionTimer !== null) window.clearTimeout(positionTimer)
      host.removeEventListener('mouseup', capture)
      host.removeEventListener('keyup', capture)
      host.removeEventListener('scroll', dismiss)
    }
  }, [guards.selectable, ready])

  // Focus leaving the document drops the frozen passage. Without this there are two live inputs at
  // once: the user types in the composer while the Canvas bubble still holds a passage, and the next
  // ⏎ is ambiguous about which one it belongs to. One staged input at a time.
  useEffect(() => {
    if (!sel) return
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as Node | null
      if (!target || wrapRef.current?.contains(target)) return
      setSel(null)
      setAiOpen(false)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [sel])

  // Hand the frozen selection + instruction to the active session's agent. Auto-save first so the file
  // on disk matches what the user sees (the agent locates the passage in the file) and a checkpoint exists.
  async function askCanvas(instruction: string): Promise<void> {
    if (!sel || !instruction.trim()) return
    const selection = sel.text
    setSel(null)
    await autosave.flush()
    await sendCanvasEdit({ path, selection, instruction: instruction.trim() })
  }

  function backToFormatting(): void {
    setAiOpen(false)
    // The AI input can own DOM focus while the ProseMirror selection remains intact. Restore editor
    // focus and issue a no-op transaction so Crepe's tooltip recalculates and reopens at that selection.
    requestAnimationFrame(() => {
      const view = crepeRef.current?.editor.ctx.get(editorViewCtx)
      if (!view) return
      view.focus()
      view.dispatch(view.state.tr)
    })
  }

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      <div ref={wrapRef} data-doc-editor className={`relative min-h-0 flex-1 ${aiOpen ? 'koda-ai-toolbar-open' : ''}`}>
        <div
          ref={hostRef}
          data-doc-fullwidth={fullWidth ? 'true' : undefined}
          data-doc-editing={guards.userEditable ? 'true' : undefined}
          className="h-full overflow-auto bg-surface"
        >
          {/* The title renames the file, so it follows the same human-editing state as the body. */}
          <DocPageChrome path={path} readOnly={!guards.userEditable} fullWidth={fullWidth} />
          <div ref={crepeRootRef} />
        </div>
        {/* The editable region's edge, so "this page takes typing now" is visible in the page and not
            only in the footer label. An overlay rather than a ring on the scroll host: Milkdown paints
            its own background over an ancestor's inset ring, leaving the edge drawn only above the
            title. Inert and inset, so it changes no layout and eats no clicks. */}
        {guards.userEditable && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 ring-1 ring-inset ring-accent/30" />
        )}
        {/* Quiet page-layout control — reading column ⇄ full width, persisted per doc. */}
        <IconButton
          label={fullWidth ? 'Reading column' : 'Full width'}
          size="sm"
          onClick={toggleFullWidth}
          className="absolute right-2 top-2 z-10"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {fullWidth ? (
              <>
                <path d="m5 8 4 4-4 4" />
                <path d="m19 8-4 4 4 4" />
              </>
            ) : (
              <>
                <path d="M8 8 4 12l4 4" />
                <path d="m16 8 4 4-4 4" />
                <path d="M4 12h16" />
              </>
            )}
          </svg>
        </IconButton>
        <DocOutline hostRef={hostRef} ready={ready} />
        {findOpen && (
          <TranscriptFind containerRef={hostRef} placeholder="Find in document" onClose={() => setFindOpen(false)} />
        )}
        {sel && aiOpen && guards.selectable && (
          <CanvasToolbar
            top={sel.top}
            left={sel.left}
            onAsk={(instruction) => void askCanvas(instruction)}
            onCreateView={() => void createInteractiveView()}
            onBack={backToFormatting}
            onClose={() => {
              setSel(null)
              setAiOpen(false)
            }}
          />
        )}
      </div>
      {/* The live region is mounted for the life of the pane, not with the bar: a screen reader only
          reliably announces into a region that was already there. The bar names Koda, never an engine —
          the same document surface runs behind Claude and Codex. */}
      <div role="status">
        <Collapse open={review !== null && !readOnly}>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-1.5">
            <span className="text-[11px] text-text-muted">Koda changed 1 passage</span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void revertReview()}
                className="rounded-lg px-3 py-1 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg hover:text-text"
              >
                Revert
              </button>
              {/* The change is already in the file — this dismisses the revert window, it applies nothing. */}
              <button
                onClick={() => setReview(null)}
                className="rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Accept edit
              </button>
            </div>
          </div>
        </Collapse>
      </div>
      {!readOnly && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-1.5">
          {initError ? (
            <span role="status" className="truncate text-[11px] text-red-400">
              Couldn't open editor: {initError}
            </span>
          ) : saveError ? (
            <span role="status" className="truncate text-[11px] text-red-400">
              Couldn't save: {saveError}
            </span>
          ) : actionError ? (
            <span role="status" className="truncate text-[11px] text-red-400">
              {actionError}
            </span>
          ) : noUndo ? (
            <span role="status" className="truncate text-[11px] text-amber-600 dark:text-amber-400">
              Saved, but Koda couldn't add this to the recovery timeline.
            </span>
          ) : (
            <span className="truncate text-[11px] text-text-muted">
              {editing ? 'Type directly, or select a passage to ask Koda' : 'Select any passage to work on it with Koda.'}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {initError ? (
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Reload
              </button>
            ) : saveError ? (
              <button
                onClick={() => void autosave.flush()}
                disabled={saving}
                className="rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Retry'}
              </button>
            ) : null}
            {/* A failed save drops the "saved automatically" half of the label: the error beside it is
                the truth, and two claims that contradict each other are worse than either alone. */}
            {!initError && (
              <button
                onClick={() => (editing ? stopEditing() : setEditing(true))}
                aria-pressed={editing}
                className={`rounded-lg px-3 py-1 text-[11px] font-medium transition-colors ${
                  editing ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg hover:text-text'
                }`}
              >
                {!editing ? 'Edit' : saveError ? 'Editing' : 'Editing · saved automatically'}
              </button>
            )}
          </div>
        </div>
      )}
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
  onCreateView,
  onBack,
  onClose,
}: {
  top: number
  left: number
  onAsk: (instruction: string) => void
  onCreateView: () => void
  onBack: () => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const QUICK = ['Rewrite', 'Shorten', 'Expand', 'Fix grammar']
  return (
    <div
      className="absolute z-20 -translate-x-1/2"
      style={{ top, left }}
    >
      <div className="flex h-11 items-center gap-1 rounded-lg bg-surface px-1 shadow-pop">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBack}
          title="Back to formatting"
          aria-label="Back to formatting"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-bg hover:text-text"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span className="mx-1 h-6 w-px bg-border" />
        {QUICK.map((q) => (
          <button
            key={q}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAsk(q)}
            className="rounded-lg px-2 py-1 text-[11px] font-medium text-text transition-colors hover:bg-bg"
          >
            {q}
          </button>
        ))}
        {/* Not an AI edit: this carves the passage into its own interactive artifact and links back. */}
        <span className="mx-1 h-6 w-px bg-border" />
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCreateView}
          title="Create an interactive view from this passage"
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text transition-colors hover:bg-bg"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          Interactive view
        </button>
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
          className="w-52 rounded-lg bg-bg px-2 py-1 text-[12px] text-text outline-none placeholder:text-text-muted/80"
        />
      </div>
    </div>
  )
}

export default CrepeDocEditor
