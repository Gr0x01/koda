import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, Menu, motion, useReducedMotion, duration, ease, spring } from '../motion'
import { FileSurfaceView } from './FileSurfaceView'
import { DocSurfaceView } from './DocSurfaceView'
import { DiffSurfaceView } from './DiffSurfaceView'
import { PreviewSurfaceView, type PreviewViewport } from './PreviewSurfaceView'
import { ChangesSurface } from './ChangesSurface'
import { AgentsSurface } from './AgentsSurface'
import { BranchGlyph } from './ChangesReview'
import { TerminalSurfaceView } from './TerminalSurfaceView'
import { useWorkspace, activeEditor, type FileSurface } from '../workspace/store'
import { isFleetEntry } from '../transcript/fleet'

const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
// A displayable image has only one meaningful view (the picture) — no File/Diff/Doc toggle.
const isImagePath = (path: string): boolean => /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(path)
const PREVIEW_PRESET_DOCK_WIDTH: Record<PreviewViewport, number> = {
  desktop: 1100,
  tablet: 820,
  phone: 430,
}

// ── The dock: the stage bar and the stage ──────────────────────────────────────────────────────────
// Everything that can take the stage — the running app, a file, the changes, the shell — is a TAB on
// the one stage. No shelf under it, no desk below it: one method, so learning any surface teaches all
// of them.
export function Dock() {
  return (
    <div className="flex h-full flex-col">
      <StageBar />
      <Stage />
    </div>
  )
}

/** The stage bar — co-open tabs and the stage's few controls. */
function StageBar() {
  const editor = useWorkspace(activeEditor)
  const setStagePinned = useWorkspace((s) => s.setStagePinned)
  const stageExpanded = useWorkspace((s) => s.stageExpanded)
  const setStageExpanded = useWorkspace((s) => s.setStageExpanded)
  const staged = stagedSurface(editor)
  const barBtn = 'grid h-[26px] w-[26px] place-items-center rounded-md transition-colors'
  const heldHint = staged ? `${staged.title} holds the view while the agent works. Click another tab to leave it.` : ''
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-1 pr-1.5">
      <StageTabs surfaces={editor.surfaces} staged={staged} />
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-1">
        {staged && !staged.kind && <ViewToggle surface={staged} />}
        {staged &&
          // The live surfaces hold the view by themselves (see stageHeld in the store): while one is
          // selected the agent's edits stop stealing the selection, so there's nothing to toggle — show
          // a quiet held indicator instead of a Hold view button that would look "off" while it holds.
          (staged.kind === 'preview' || staged.kind === 'terminal' ? (
            <div
              // Named as an image: a bare div is generic to assistive tech, so the one held state the
              // user can't toggle would otherwise announce as nothing at all.
              role="img"
              aria-label={heldHint}
              title={heldHint}
              className={`${barBtn} text-accent`}
            >
              <IconPin filled />
            </div>
          ) : (
            <button
              onClick={() => setStagePinned(!editor.pinned)}
              title={
                editor.pinned
                  ? 'Release the view. Let the agent’s work take the stage again.'
                  : 'Hold view. Keep this tab on stage while the agent works.'
              }
              aria-label="Hold view on this tab"
              aria-pressed={editor.pinned}
              className={`${barBtn} ${editor.pinned ? 'bg-text/5 text-accent' : 'text-text-muted hover:text-text'}`}
            >
              <IconPin filled={editor.pinned} />
            </button>
          ))}
        <button
          onClick={() => setStageExpanded(!stageExpanded)}
          title={stageExpanded ? 'Shrink back and show the session' : 'Expand to the full window'}
          aria-label={stageExpanded ? 'Shrink the stage' : 'Expand the stage'}
          aria-pressed={stageExpanded}
          className={`${barBtn} ${stageExpanded ? 'bg-text/5 text-text' : 'text-text-muted hover:text-text'}`}
        >
          {stageExpanded ? <IconCollapse /> : <IconExpand />}
        </button>
      </div>
    </div>
  )
}

/** Which surface is showing: the selected tab, or the newest one if the selection went stale. */
function stagedSurface(editor: { surfaces: FileSurface[]; activeSurfaceId: string | null }): FileSurface | null {
  return (
    editor.surfaces.find((s) => s.path === editor.activeSurfaceId) ??
    editor.surfaces[editor.surfaces.length - 1] ??
    null
  )
}

/**
 * The tab strip: everything co-open on this session's stage, in open order, plus the add control. A
 * tab selects on click and closes on ✕; the selected one is a raised white chip that slides between
 * tabs. The agent's auto-follow adds and selects tabs here, so the strip is the running record of what
 * it has touched this session.
 */
function StageTabs({ surfaces, staged }: { surfaces: FileSurface[]; staged: FileSurface | null }) {
  const selectSurface = useWorkspace((s) => s.selectSurface)
  const closeSurface = useWorkspace((s) => s.closeSurface)
  const stripRef = useRef<HTMLDivElement>(null)
  // Keep the selected tab in view when the agent adds or selects one off-screen.
  useEffect(() => {
    stripRef.current?.querySelector('[data-staged="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [staged?.path, surfaces.length])
  return (
    // The add control sits OUTSIDE the scrolling row: `overflow-x-auto` clips the other axis too, so a
    // menu anchored inside the row would be cut off at the bar's height.
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <div ref={stripRef} className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {surfaces.map((s) => {
          const active = s.path === staged?.path
          return (
            <div
              key={s.path}
              data-staged={active}
              onClick={() => selectSurface(s.path)}
              title={singletonKind(s) ? SINGLETON_HINT[singletonKind(s)!] : s.path}
              className={`group relative flex h-[26px] max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1 text-xs transition-colors ${
                active ? 'text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              {/* Shared layoutId → the selected chip SLIDES between tabs instead of flashing. */}
              {active && (
                <motion.span
                  layoutId="stage-tab-active"
                  className="absolute inset-0 rounded-md bg-surface shadow-soft"
                  transition={spring.snappy}
                />
              )}
              <span className="relative z-10 shrink-0">
                <SurfaceGlyph surface={s} />
              </span>
              <span
                className={`relative z-10 min-w-0 flex-1 truncate ${singletonKind(s) ? '' : 'font-mono text-[11.5px]'}`}
              >
                {s.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeSurface(s.path)
                }}
                title="Close this tab"
                aria-label={`Close ${s.title}`}
                className="relative z-10 grid h-4 w-4 shrink-0 place-items-center rounded text-[10px] text-text-muted opacity-0 transition-opacity hover:bg-text/5 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      <AddSurfaceButton />
    </div>
  )
}

const PICKER_WIDTH = 300

/** The add control at the end of the strip — the same surface picker the empty stage shows. The menu
 *  is PORTALED with fixed coords: the dock clips its overflow and the tab row scrolls, so an anchored
 *  menu would be cut off at the dock's edge (RemoteMenu solves the same problem the same way). */
function AddSurfaceButton() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      // Left-aligned to the button, then pulled back in when that would run past the window edge.
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - PICKER_WIDTH - 12) })
    }
    place()
    window.addEventListener('resize', place)
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])
  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title="Put something else on stage"
        aria-label="Put something else on stage"
        aria-expanded={open}
        className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-text/5 hover:text-text"
      >
        <IconPlus />
      </button>
      {pos &&
        createPortal(
          <Menu
            open={open}
            origin="origin-top-left"
            onClose={() => setOpen(false)}
            className="fixed z-50 rounded-xl border border-border bg-surface p-1.5 shadow-pop"
            style={{ top: pos.top, left: pos.left, width: PICKER_WIDTH }}
          >
            <div ref={menuRef}>
              <SurfacePicker onPicked={() => setOpen(false)} />
            </div>
          </Menu>,
          document.body,
        )}
    </>
  )
}

/** A surface's singleton kind, or null for an ordinary file tab (`kind` is optional on those). */
function singletonKind(s: FileSurface): 'preview' | 'terminal' | 'changes' | 'agents' | null {
  return s.kind && s.kind !== 'file' ? s.kind : null
}

/** What each singleton tab is, in one hover line. */
const SINGLETON_HINT: Record<'preview' | 'terminal' | 'changes' | 'agents', string> = {
  preview: 'Your app, running',
  terminal: 'A shell in this project folder',
  changes: 'Everything changed since your last version',
  agents: 'The agents this chat handed work to',
}

/** A tab's glyph. One 14px line-drawn mark per surface — the singletons read as siblings of the file
 *  tabs rather than as a different species (a bare status dot sat small and off-axis beside them). */
function SurfaceGlyph({ surface }: { surface: FileSurface }) {
  // Green means one thing here: something is answering on that URL right now. A preview whose dev
  // server died keeps its tab (the last paint is still worth reading) but loses the colour.
  if (surface.kind === 'preview') return <IconWindow className={surface.live ? 'text-emerald-500' : undefined} />
  if (surface.kind === 'terminal') return <IconTerminal />
  if (surface.kind === 'changes') return <BranchGlyph size={14} />
  if (surface.kind === 'agents') return <IconAgents />
  return <ViewIcon view={surface.view} md={isMarkdown(surface.path)} />
}

// ── The stage: the selected tab's surface ──────────────────────────────────────────────────────────
function Stage() {
  const editor = useWorkspace(activeEditor)
  const reduce = useReducedMotion()
  const staged = stagedSurface(editor)
  // The terminal is the one surface that can't be unmounted on a tab switch — disposing the xterm
  // throws away the scrollback while the pty keeps running. So it renders as its own always-mounted
  // layer, hidden by CSS unless it's the staged tab, and it stays mounted for as long as ANY session
  // in this window holds a terminal tab (switching chats must not clear the shell you were reading).
  const anyTerminal = useWorkspace((s) =>
    Object.values(s.editors).some((ed) => ed.surfaces.some((su) => su.kind === 'terminal')),
  )
  const termStaged = staged?.kind === 'terminal'
  return (
    <div className="relative min-h-0 flex-1">
      {/* Cross-fade between tabs (mode="wait" = no double Monaco/iframe mounting). */}
      <AnimatePresence mode="wait" initial={false}>
        {!termStaged && (
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
            ) : staged.kind === 'changes' ? (
              <ChangesSurface />
            ) : staged.kind === 'agents' ? (
              <AgentsSurface />
            ) : (
              <SurfacePane key={staged.path} surface={staged} className="h-full min-w-0" />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {anyTerminal && (
        // Hidden with `invisible` rather than unmounted: content keeps its size (xterm refits from a
        // real box) and drops out of hit-testing and the focus order, so a background shell can't
        // swallow keystrokes meant for the conversation.
        <div className={`absolute inset-0 ${termStaged ? '' : 'invisible'}`} aria-hidden={!termStaged}>
          <TerminalSurfaceView />
        </div>
      )}
    </div>
  )
}

/** The staged preview — the live app, with its navigation and viewport chrome. Expand now lives in the
 *  stage bar (it belongs to the stage, not to the preview), so this view no longer owns it. */
function StagePreview({ preview }: { preview: FileSurface }) {
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
      onViewportChange={applyViewportPreset}
    />
  )
}

/** The stage with no tabs open: a picker that names each surface and the job it does, so the panel
 *  teaches what can live here instead of resting as one blank line of copy. */
function StageEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <p className="mb-1 text-[13px] font-medium text-text-muted">Nothing on stage yet</p>
      <p className="mb-4 max-w-[320px] text-center text-xs leading-relaxed text-text-muted/70">
        The agent puts its work here as it goes. You can also open something yourself.
      </p>
      <div className="w-full max-w-[340px] rounded-xl border border-border bg-surface p-1.5 shadow-soft">
        <SurfacePicker />
      </div>
    </div>
  )
}

/**
 * The surface picker: one row per thing that can take the stage, each with the one sentence that says
 * what job it does. Shown two ways, same component — the empty stage, and the tab strip's add control.
 * It offers only the surfaces that already exist (preview, files, changes, terminal); it is a map of
 * the panel, not a place to invent new surface types.
 */
function SurfacePicker({ onPicked }: { onPicked?: () => void } = {}) {
  const openPreview = useWorkspace((s) => s.openPreview)
  const setSearchOpen = useWorkspace((s) => s.setSearchOpen)
  const openChanges = useWorkspace((s) => s.openChanges)
  const openTerminal = useWorkspace((s) => s.openTerminal)
  const openAgents = useWorkspace((s) => s.openAgents)
  const activeId = useWorkspace((s) => s.activeId)
  // Offered only once this chat has actually delegated something: an empty roster is a tab that
  // teaches nothing. The fan-out's own row is the usual way in; this is how you get it back.
  const hasAgents = useWorkspace((s) =>
    s.activeId ? (s.sessions[s.activeId]?.items.some(isFleetEntry) ?? false) : false,
  )
  const lastPreview = useWorkspace((s) => (s.activeId ? s.sessions[s.activeId]?.lastPreview : undefined))
  // Green here too, on the same terms: this session already has a preview and something is serving it.
  const livePreview = useWorkspace((s) => activeEditor(s).surfaces.some((x) => x.kind === 'preview' && x.live))
  const [staticUrl, setStaticUrl] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Probe once per active session: is there a static entry worth offering? Null and no remembered dev
  // server ⇒ say so honestly rather than opening the "nothing to preview" placeholder.
  useEffect(() => {
    let alive = true
    void window.koda.previewStaticUrl().then((u) => alive && setStaticUrl(u))
    return () => {
      alive = false
    }
  }, [activeId])

  // The dev server dies with the window, so bringing a session's preview back is a button, not a
  // conversation. Main answers the restart with a preview:show push, which reopens the surface.
  async function restartPreview(): Promise<void> {
    if (!activeId || !lastPreview) return
    setRestarting(true)
    setPreviewError(null)
    try {
      await window.koda.previewRestart(activeId, lastPreview)
      onPicked?.()
    } catch {
      setPreviewError(
        lastPreview.kind === 'dev'
          ? 'That command did not start. Check the terminal.'
          : 'That file is no longer there.',
      )
    } finally {
      setRestarting(false)
    }
  }

  const previewReady = !!lastPreview || !!staticUrl
  const pick = (run: () => void) => (): void => {
    run()
    onPicked?.()
  }

  return (
    <div className="flex flex-col">
      <PickerRow
        icon={<IconWindow className={livePreview ? 'text-emerald-500' : undefined} />}
        title={restarting ? 'Starting preview' : 'Preview'}
        hint={
          previewReady
            ? 'Your app running live, reloading as the agent changes it.'
            : 'Nothing is running yet. Ask the agent to start your app.'
        }
        disabled={!previewReady || restarting}
        onClick={() => {
          if (lastPreview) void restartPreview()
          else if (staticUrl) pick(() => openPreview(staticUrl))()
        }}
      />
      {previewError && <p className="px-2.5 pb-1.5 text-[11px] text-text-muted">{previewError}</p>}
      <PickerRow
        icon={<ViewIcon view="file" md={false} />}
        title="A file"
        hint="Any file in the project, as a document, as code, or as a diff."
        onClick={pick(() => setSearchOpen(true))}
      />
      <PickerRow
        icon={<BranchGlyph size={14} />}
        title="Changes"
        hint="Everything changed since your last version, ready to save."
        onClick={pick(() => openChanges())}
      />
      <PickerRow
        icon={<IconTerminal />}
        title="Terminal"
        hint="A shell in this project folder."
        onClick={pick(() => openTerminal())}
      />
      <PickerRow
        icon={<IconAgents />}
        title="Agents"
        hint={
          hasAgents
            ? 'The agents this chat handed work to, and what each one did.'
            : 'This chat has not handed work to any agents yet.'
        }
        disabled={!hasAgents}
        onClick={pick(() => openAgents())}
      />
    </div>
  )
}

/** One picker row: glyph, name, and the single sentence that says what the surface is for. */
function PickerRow({
  icon,
  title,
  hint,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode
  title: string
  hint: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-bg disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent"
    >
      {/* Fixed 14px slot: every row's glyph starts on the same vertical line, whatever its own size. */}
      <span className="mt-[3px] grid h-[14px] w-[14px] shrink-0 place-items-center text-text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-text">{title}</span>
        <span className="block text-[11.5px] leading-snug text-text-muted">{hint}</span>
      </span>
    </button>
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
  // An image renders as a picture with no alternate view — hide the toggle entirely.
  if (isImagePath(surface.path)) return null
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
// Preview glyph — a browser window (frame + title bar). It goes green when a server is actually
// answering on the URL, and only then: the old status dot was green even in the picker's
// nothing-is-running state, which is the one moment it was certain to be wrong.
function IconWindow({ className }: { className?: string } = {}) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01" />
    </svg>
  )
}
// Terminal glyph — a chevron prompt + a cursor line, the universal shell mark.
function IconTerminal() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  )
}
// Agents glyph — two small figures, one behind the other: work handed to more than one worker.
function IconAgents() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M18.5 19a5.6 5.6 0 0 0-2.2-4.4" />
    </svg>
  )
}
// Add glyph — the tab strip's "put something else on stage" control.
function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
// Expand/collapse glyphs — the stage taking the full window, and coming back.
function IconExpand() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
      <path d="M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6" />
    </svg>
  )
}
function IconCollapse() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
    </svg>
  )
}
// Hold view glyph — outline at rest, filled while the tab holds the view. The name keeps the store's
// `pinned` field readable from here; the word the user reads is "Hold view".
function IconPin({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17v5" />
      <path d="M7 4h10l-1.5 7.5 2.5 3H6l2.5-3z" />
    </svg>
  )
}
