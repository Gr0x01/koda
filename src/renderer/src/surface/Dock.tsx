import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, Menu, motion, useReducedMotion, duration, ease, spring } from '../motion'
import { FileSurfaceView } from './FileSurfaceView'
import { DocSurfaceView } from './DocSurfaceView'
import { DiffSurfaceView } from './DiffSurfaceView'
import { PreviewSurfaceView, type PreviewViewport } from './PreviewSurfaceView'
import { StageDesk } from './ChangesSurface'
import { TerminalSurfaceView } from './TerminalSurfaceView'
import { Caret } from '../Caret'
import { useWorkspace, activeEditor, type FileSurface } from '../workspace/store'

const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
const PREVIEW_PRESET_DOCK_WIDTH: Record<PreviewViewport, number> = {
  desktop: 1100,
  tablet: 820,
  phone: 430,
}

// ── The dock: the stage bar, the stage, the terminal shelf, the desk ───────────────────────────────
export function Dock() {
  return (
    <div className="flex h-full flex-col">
      <StageBar />
      <Stage />
      <TerminalShelf />
      <StageDesk />
    </div>
  )
}

/**
 * The stage bar — what's showing, and the stage's few controls. Left: the switcher (the staged
 * surface's name + a menu of everything else on this session's workbench — the old Editor tab row,
 * demoted to a dropdown). Right: the view toggle for a staged file, the pin, the terminal.
 */
function StageBar() {
  const editor = useWorkspace(activeEditor)
  const setStagePinned = useWorkspace((s) => s.setStagePinned)
  const termOpen = useWorkspace((s) => s.termOpen)
  const setTermOpen = useWorkspace((s) => s.setTermOpen)
  const staged =
    editor.surfaces.find((s) => s.path === editor.activeSurfaceId) ??
    editor.surfaces[editor.surfaces.length - 1] ??
    null
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
      <StageSwitcher surfaces={editor.surfaces} staged={staged} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {staged && staged.kind !== 'preview' && <ViewToggle surface={staged} />}
        {staged &&
          // The preview soft-pins itself (see stageHeld in the store): while it's on stage the agent's
          // edits stop stealing focus, so there's nothing to toggle — show a quiet held indicator instead
          // of a pin button that would look "off" while it's actually holding.
          (staged.kind === 'preview' ? (
            <div
              title="Preview stays on stage while the agent works — pick a file to leave it"
              className="grid h-[26px] w-[26px] place-items-center rounded-md text-accent"
            >
              <IconPin filled />
            </div>
          ) : (
            <button
              onClick={() => setStagePinned(!editor.pinned)}
              title={editor.pinned ? 'Unpin — let the agent’s work take the stage' : 'Pin — keep this on stage while the agent works'}
              aria-pressed={editor.pinned}
              className={`grid h-[26px] w-[26px] place-items-center rounded-md transition-colors ${
                editor.pinned ? 'bg-text/5 text-accent' : 'text-text-muted hover:text-text'
              }`}
            >
              <IconPin filled={editor.pinned} />
            </button>
          ))}
        <button
          onClick={() => setTermOpen(!termOpen)}
          title={termOpen ? 'Hide terminal' : 'Terminal'}
          aria-pressed={termOpen}
          className={`grid h-[26px] w-[26px] place-items-center rounded-md transition-colors ${
            termOpen ? 'bg-text/5 text-text' : 'text-text-muted hover:text-text'
          }`}
        >
          <IconTerminal />
        </button>
      </div>
    </div>
  )
}

/** The stage switcher — the staged surface's identity as a quiet pill; click for the workbench menu
 *  (preview + open files), where each row stages on click and closes on ✕. */
function StageSwitcher({ surfaces, staged }: { surfaces: FileSurface[]; staged: FileSurface | null }) {
  const selectSurface = useWorkspace((s) => s.selectSurface)
  const closeSurface = useWorkspace((s) => s.closeSurface)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  // Preview first (it's "the app"), then files in open order — same order the menu shows.
  const ordered = [...surfaces].sort((a, b) => (a.kind === 'preview' ? -1 : 0) - (b.kind === 'preview' ? -1 : 0))
  if (!staged) {
    return <span className="px-2 text-xs text-text-muted/70">Nothing on stage</span>
  }
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Switch what's on stage"
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-text/5"
      >
        {staged.kind === 'preview' ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_5px] shadow-emerald-500/60" aria-hidden />
        ) : (
          <span className="shrink-0 text-text-muted">
            <SurfaceGlyph surface={staged} />
          </span>
        )}
        <span className={`truncate ${staged.kind === 'preview' ? '' : 'font-mono text-[11.5px] font-normal'}`}>
          {staged.title}
        </span>
        {ordered.length > 1 && <Caret size={12} className="text-text-muted" />}
      </button>
      <div className="absolute left-0 top-full z-10 mt-1">
        <Menu
          open={open && ordered.length > 1}
          origin="origin-top-left"
          className="w-max min-w-[200px] max-w-[300px] rounded-xl border border-border bg-surface p-1 shadow-pop"
        >
          {ordered.map((s) => (
            <div
              key={s.path}
              onClick={() => {
                selectSurface(s.path)
                setOpen(false)
              }}
              title={s.kind === 'preview' ? 'The running preview' : s.path}
              className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                s.path === staged.path ? 'bg-bg text-text' : 'text-text-muted hover:bg-bg hover:text-text'
              }`}
            >
              {s.kind === 'preview' ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              ) : (
                <SurfaceGlyph surface={s} />
              )}
              <span className={`min-w-0 flex-1 truncate ${s.kind === 'preview' ? '' : 'font-mono text-[11.5px]'}`}>
                {s.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeSurface(s.path)
                }}
                title="Remove from the workbench"
                className="shrink-0 opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
        </Menu>
      </div>
    </div>
  )
}

/** A tiny kind-glyph for switcher rows: rendered doc, diff, or code file. */
function SurfaceGlyph({ surface }: { surface: FileSurface }) {
  return <ViewIcon view={surface.view} md={isMarkdown(surface.path)} />
}

// ── The stage: the one surface that matters right now ──────────────────────────────────────────────
function Stage() {
  const editor = useWorkspace(activeEditor)
  const reduce = useReducedMotion()
  const staged =
    editor.surfaces.find((s) => s.path === editor.activeSurfaceId) ??
    editor.surfaces[editor.surfaces.length - 1] ??
    null
  return (
    <div className="relative min-h-0 flex-1">
      {/* Cross-fade between staged surfaces (mode="wait" = no double Monaco/iframe mounting). */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={staged?.path ?? 'empty'}
          className="h-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: duration.fast, ease: ease.out }}
        >
          {!staged ? (
            <StageEmpty />
          ) : staged.kind === 'preview' ? (
            <StagePreview preview={staged} />
          ) : (
            <SurfacePane key={staged.path} surface={staged} className="h-full min-w-0" />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/** The staged preview — the live app, with the expand/viewport chrome it always had. */
function StagePreview({ preview }: { preview: FileSurface }) {
  const expanded = useWorkspace((s) => s.previewExpanded)
  const setExpanded = useWorkspace((s) => s.setPreviewExpanded)
  const setDockWidth = useWorkspace((s) => s.setConversationWidth)
  const persistLayout = useWorkspace((s) => s.persistLayout)
  function applyViewportPreset(viewport: PreviewViewport): void {
    setDockWidth(PREVIEW_PRESET_DOCK_WIDTH[viewport])
    persistLayout()
  }
  return (
    <PreviewSurfaceView
      url={preview.previewUrl}
      rev={preview.rev}
      className="h-full"
      expanded={expanded}
      onExpandedChange={setExpanded}
      onViewportChange={applyViewportPreset}
    />
  )
}

/** The stage at rest — nothing running, nothing staged. One state instead of the old per-tab three.
 *  Its action adapts to the session: if this session previewed before, one click brings that preview
 *  back (the dev server's killed on window close, but re-running it is a button, not a conversation);
 *  otherwise a raw static preview — but only when the project actually has a servable index.html
 *  (a framework project has none, and the old always-on button just opened a blank placeholder). */
function StageEmpty() {
  const openPreview = useWorkspace((s) => s.openPreview)
  const activeId = useWorkspace((s) => s.activeId)
  const lastPreview = useWorkspace((s) => (s.activeId ? s.sessions[s.activeId]?.lastPreview : undefined))
  const [staticUrl, setStaticUrl] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [failed, setFailed] = useState(false)

  // Probe once per active session: is there a static file worth offering? Null ⇒ hide the button
  // rather than open the "nothing to preview" placeholder.
  useEffect(() => {
    let alive = true
    void window.koda.previewStaticUrl().then((u) => alive && setStaticUrl(u))
    return () => {
      alive = false
    }
  }, [activeId])

  async function restart(): Promise<void> {
    if (!activeId || !lastPreview) return
    setRestarting(true)
    setFailed(false)
    try {
      await window.koda.previewRestart(activeId, lastPreview) // main pushes preview:show → surface reopens
    } catch {
      setFailed(true)
    } finally {
      setRestarting(false)
    }
  }

  const btn = 'rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface disabled:opacity-50'
  const action = lastPreview ? (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={() => void restart()}
        disabled={restarting}
        title={lastPreview.kind === 'dev' ? lastPreview.command : lastPreview.relPath}
        className={btn}
      >
        {restarting ? 'Starting preview…' : 'Restart preview'}
      </button>
      {failed && (
        <span className="text-[11px] text-text-muted">
          {lastPreview.kind === 'dev' ? "Couldn't start it — check the terminal." : 'That file is no longer there.'}
        </span>
      )}
    </div>
  ) : staticUrl ? (
    <button onClick={() => openPreview(staticUrl)} className={btn}>
      Preview index.html
    </button>
  ) : undefined

  return (
    <DockEmpty
      title="Nothing on stage yet"
      hint="As the agent works, its work shows up here: your app running, a document taking shape, a change landing."
      action={action}
    />
  )
}

// ── The terminal shelf: summoned under the stage; the xterm stays mounted so the pty + scrollback
//    survive (the shelf only animates height — never unmounts once spawned). ───────────────────────
const TERM_SHELF_HEIGHT = 280
function TerminalShelf() {
  const termOpen = useWorkspace((s) => s.termOpen)
  const reduce = useReducedMotion()
  const [spawned, setSpawned] = useState(false)
  // Height-clipping alone leaves the collapsed xterm in the focus order (its textarea could still
  // steal keystrokes). So once the collapse animation settles, flip to visibility:hidden — content
  // stays visible DURING the collapse, then drops out of hit-testing/focus for real.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (termOpen) {
      setSpawned(true)
      setSettled(false) // un-hide before the expand animates
    }
  }, [termOpen])
  if (!spawned) return null
  return (
    <motion.div
      animate={{ height: termOpen ? TERM_SHELF_HEIGHT : 0 }}
      transition={reduce ? { duration: 0 } : { duration: duration.slow, ease: ease.out }}
      onAnimationComplete={() => {
        if (!useWorkspace.getState().termOpen) setSettled(true)
      }}
      aria-hidden={!termOpen}
      className={`shrink-0 overflow-hidden ${termOpen ? 'border-t border-border' : ''} ${
        !termOpen && settled ? 'invisible' : ''
      }`}
    >
      {/* Fixed inner height so xterm keeps its size while the shelf animates. */}
      <div style={{ height: TERM_SHELF_HEIGHT }}>
        <TerminalSurfaceView />
      </div>
    </motion.div>
  )
}

/**
 * The dock tools' shared empty state — a ghosted glyph, a short title, a one-line hint, and an
 * optional action. One quiet structure across Editor / Preview / Changes so an empty tab reads as
 * "at rest", not broken or unfinished.
 */
export function DockEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode
  title: string
  hint?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
      {icon && <span className="mb-1 text-text-muted/40">{icon}</span>}
      <p className="text-[13px] font-medium text-text-muted">{title}</p>
      {hint && <p className="max-w-[300px] text-xs leading-relaxed text-text-muted/70">{hint}</p>}
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  )
}

/**
 * The Doc/Markdown/Diff (or File/Diff) view selector for a surface. Lives in the Editor chrome — the
 * single-file header bar, the multi-tab row's right edge, or a split pane's own header.
 */
function ViewToggle({ surface }: { surface: FileSurface }) {
  const setSurfaceView = useWorkspace((s) => s.setSurfaceView)
  const md = isMarkdown(surface.path)
  // Markdown gets the rich Doc default + a "Markdown" escape hatch to the raw editor (the advanced
  // "show real markdown" path). Other files keep the plain File/Diff toggle.
  const views = md ? (['doc', 'file', 'diff'] as const) : (['file', 'diff'] as const)
  const label = (v: 'doc' | 'file' | 'diff'): string =>
    v === 'doc' ? 'Doc' : v === 'diff' ? 'Diff' : md ? 'Markdown' : 'File'
  // Icon-only segmented control. The optimal view is already shown on open, so this is the advanced
  // escape hatch — glyphs + tooltips keep it compact (no "Markdown" word eating the row); it's
  // non-destructive, so learning it by clicking is fine.
  return (
    <div className="flex shrink-0 items-center gap-px rounded-lg bg-text/5 p-0.5">
      {views.map((v) => {
        const active = surface.view === v
        return (
          <button
            key={v}
            onClick={() => setSurfaceView(surface.path, v)}
            title={label(v)}
            aria-label={label(v)}
            aria-pressed={active}
            className={`relative grid h-[22px] w-[26px] place-items-center rounded-md transition-colors ${
              active ? 'text-text' : 'text-text-muted hover:text-text'
            }`}
          >
            {/* Shared layoutId (per surface, so split panes don't slide into each other) → the white
                highlight SLIDES between cells like the Editor/Preview underline, instead of flashing. */}
            {active && (
              <motion.span
                layoutId={`view-toggle-${surface.path}`}
                className="absolute inset-0 rounded-md bg-surface shadow-soft"
                transition={spring.snappy}
              />
            )}
            <span className="relative z-10">
              <ViewIcon view={v} md={md} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ViewIcon({ view, md }: { view: 'doc' | 'file' | 'diff'; md: boolean }) {
  const p = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const
  // Doc = rendered prose (justified text lines), distinct from the file-document glyph on the tab.
  if (view === 'doc')
    return (
      <svg {...p}>
        <path d="M4 7h16M4 12h16M4 17h9" />
      </svg>
    )
  // Diff = changes (a + over a −).
  if (view === 'diff')
    return (
      <svg {...p}>
        <path d="M5 7h6M8 4v6" />
        <path d="M13 17h6" />
      </svg>
    )
  // 'file' = raw source: the markdown mark for .md, code brackets for everything else.
  return md ? (
    <svg {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 14.5v-5l2.5 3 2.5-3v5" />
      <path d="M15.5 9.5v4M15.5 13.5l-1.5-1.7M15.5 13.5l1.5-1.7" />
    </svg>
  ) : (
    <svg {...p}>
      <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
    </svg>
  )
}

/**
 * The staged file pane: the body (read-only live diff, rich Doc, or editable file per the surface's
 * `view`) — headerless; identity + the view toggle live in the stage bar. The diff re-fetches on
 * `rev` (bumped by each engine edit), so it tracks the agent's changes live.
 */
function SurfacePane({ surface, className = '' }: { surface: FileSurface; className?: string }) {
  return (
    <div className={`flex flex-col ${className}`}>
      <div className="min-h-0 flex-1">
        {surface.view === 'diff' ? (
          <DiffSurfaceView path={surface.path} rev={surface.rev} sessionId={surface.sessionId} className="h-full" />
        ) : surface.view === 'doc' ? (
          <DocSurfaceView path={surface.path} rev={surface.rev} sessionId={surface.sessionId} className="h-full" />
        ) : (
          <FileSurfaceView path={surface.path} gotoLine={surface.gotoLine} gotoNonce={surface.gotoNonce} className="h-full" />
        )}
      </div>
    </div>
  )
}

// ── Stage icons (inline strokes, currentColor — no icon dep) ───────────────────────────────────────
// Terminal glyph — a chevron prompt + a cursor line, the universal shell mark.
function IconTerminal() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  )
}
// Pin glyph — outline at rest, filled when the stage is pinned.
function IconPin({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17v5" />
      <path d="M7 4h10l-1.5 7.5 2.5 3H6l2.5-3z" />
    </svg>
  )
}
