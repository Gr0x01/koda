import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PreviewRestart } from '@shared/ipc'
import { Caret } from '../Caret'
import { Menu } from '../motion'
import { resolvePreviewAddress } from './preview-address'

export type PreviewViewport = 'desktop' | 'tablet' | 'phone'

const PREVIEW_VIEWPORTS: Record<PreviewViewport, { label: string; iframeWidth?: number }> = {
  desktop: { label: 'Desktop' },
  tablet: { label: 'Tablet', iframeWidth: 768 },
  phone: { label: 'Phone', iframeWidth: 390 },
}

/**
 * The rendered-web preview surface (preview-surface.md). A sandboxed iframe pointing at the user's
 * own output — a `koda-preview://` static entry (Rung 1) or a `http://localhost:<port>` dev server
 * (Rung 2). It lives in the DOM (unlike a WebContentsView), so it tracks the artifact-zone rectangle
 * and Koda's overlays stack above it for free — the reason the whole VS Code lineage embeds previews
 * as iframes rather than native views.
 *
 * Isolation: the iframe loads a different origin than Koda's renderer, the preload bridge never runs
 * in subframes, and the `sandbox` attribute blocks top-navigation/escape. The agent's JS reaches its
 * own origin (so the previewed app can fetch its assets / use storage) but never Koda.
 */
export function PreviewSurfaceView({
  url,
  rev,
  className = '',
  recent = [],
  onShowRecent,
  onNavigate,
  onViewportChange,
}: {
  url?: string
  rev: number
  className?: string
  /** Everything this chat has previewed, most recent first — the toolbar's switcher once there is
   *  more than one. */
  recent?: PreviewRestart[]
  /** Bring an earlier preview back; rejects when it can't (file gone, server did not start). */
  onShowRecent?: (restart: PreviewRestart) => Promise<void>
  /** The address bar's Enter: point the surface at a URL the user typed (already admitted). */
  onNavigate?: (url: string) => void
  onViewportChange?: (viewport: PreviewViewport) => void
}) {
  // A manual reload bumps this; combined with `url` + `rev` (bumped when the surface is re-pointed) it
  // keys the iframe so it remounts on an explicit reload/re-point but stays mounted through dev-server
  // HMR. No need to reset on url change — url is itself part of the key.
  const [reloadNonce, setReloadNonce] = useState(0)
  const [viewport, setViewport] = useState<PreviewViewport>('desktop')
  const viewportWidth = PREVIEW_VIEWPORTS[viewport].iframeWidth
  const framed = viewport !== 'desktop'

  // The iframe is cross-origin (koda-preview:// or localhost:<port>), so we can neither read its
  // location nor call its history — every contentWindow access throws SecurityError. But clicking a
  // link inside it adds an entry to the shared session history, and the renderer itself uses no
  // History-based routing, so top-level history.back()/forward() traverse ONLY these preview
  // navigations, moving the frame without moving Koda's window. We track depth via the frame's `load`
  // event (the one signal we DO get) to know when Back/Forward are live and to never step past our own
  // entries into a stale/previous frame's history. `pos` is the current depth, `len` the reachable end.
  const frameKey = `${url}:${rev}:${reloadNonce}`
  const [nav, setNav] = useState({ pos: -1, len: 0 })
  const programmatic = useRef(false) // set while WE drive a back/forward so its load isn't a new nav
  useEffect(() => setNav({ pos: -1, len: 0 }), [frameKey]) // remount/re-point/reload starts fresh

  // Where the frame IS, as opposed to `url`, where it was SENT: a link click, Back, or Forward inside
  // the page moves the frame without touching `url`. Its location is unreadable cross-origin, so after
  // every load main is asked which project page it last served this window (`preview:location`). A dev
  // server serves its own pages, so on one of those the address stays at the entry URL.
  const [address, setAddress] = useState(url ?? '')
  useEffect(() => setAddress(url ?? ''), [frameKey, url])
  const loadSeq = useRef(0)
  const onFrameLoad = useCallback(() => {
    if (url?.startsWith('koda-preview:')) {
      const seq = ++loadSeq.current
      // Optional-chained: a dev HMR renderer can run against a preload that predates this call.
      void window.koda.previewLocation?.().then((location) => {
        // Only the newest load may answer, and only with a page on this frame's own origin.
        if (location && seq === loadSeq.current && sameHost(location, url)) setAddress(location)
      })
    }
    if (programmatic.current) {
      programmatic.current = false // our own back/forward landed — depth already updated
      return
    }
    setNav((n) => ({ pos: n.pos + 1, len: n.pos + 2 })) // a user link nav truncates any forward stack
  }, [url])
  const goBack = useCallback(() => {
    setNav((n) => {
      if (n.pos <= 0) return n
      programmatic.current = true
      window.history.back()
      return { ...n, pos: n.pos - 1 }
    })
  }, [])
  const goForward = useCallback(() => {
    setNav((n) => {
      if (n.pos >= n.len - 1) return n
      programmatic.current = true
      window.history.forward()
      return { ...n, pos: n.pos + 1 }
    })
  }, [])
  const canGoBack = nav.pos > 0
  const canGoForward = nav.pos < nav.len - 1

  function selectViewport(next: PreviewViewport): void {
    setViewport(next)
    onViewportChange?.(next)
  }

  if (!url) {
    return (
      <div className={`flex flex-col ${className}`}>
        <PreviewHeader
          url={url}
          address={address}
          viewport={viewport}
          canGoBack={false}
          canGoForward={false}
          recent={recent}
          onShowRecent={onShowRecent}
          onNavigate={onNavigate}
          onBack={goBack}
          onForward={goForward}
          onReload={() => setReloadNonce((n) => n + 1)}
          onViewportChange={selectViewport}
        />
        <div className="flex flex-1 items-center justify-center bg-bg px-6 text-center text-sm text-text-muted">
          Nothing to preview yet. The agent can start a live preview, or write an{' '}
          <code className="mx-1 font-mono text-xs">index.html</code> to render.
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col ${className}`}>
      <PreviewHeader
        url={url}
        address={address}
        viewport={viewport}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        recent={recent}
        onShowRecent={onShowRecent}
        onNavigate={onNavigate}
        onBack={goBack}
        onForward={goForward}
        onReload={() => setReloadNonce((n) => n + 1)}
        onViewportChange={selectViewport}
      />
      <div className={`min-h-0 flex-1 overflow-auto ${framed ? 'bg-surface/50 p-3' : 'bg-white'}`}>
        <div
          style={viewportWidth ? { width: viewportWidth } : undefined}
          className={
            framed
              ? 'mx-auto h-full min-h-[420px] max-w-full overflow-hidden rounded-md border border-border bg-white shadow-soft'
              : 'h-full w-full'
          }
        >
          <iframe
            // Tagged so the engine bridge can locate + measure it for the agent's view_preview capture.
            data-preview-iframe=""
            key={frameKey}
            src={url}
            onLoad={onFrameLoad}
            title="Live preview"
            className="h-full w-full border-0 bg-white"
            // Cross-origin to Koda's renderer + no preload in subframes, so this can't reach the bridge.
            // allow-same-origin lets the previewed app use its OWN origin (storage, fetch); top-navigation
            // is intentionally NOT granted so the frame can't drive Koda's window.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        </div>
      </div>
    </div>
  )
}

function PreviewHeader({
  url,
  address,
  viewport,
  canGoBack,
  canGoForward,
  recent,
  onShowRecent,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onViewportChange,
}: {
  url?: string
  address: string
  viewport: PreviewViewport
  canGoBack: boolean
  canGoForward: boolean
  recent: PreviewRestart[]
  onShowRecent?: (restart: PreviewRestart) => Promise<void>
  onNavigate?: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onViewportChange: (viewport: PreviewViewport) => void
}) {
  const navBtn =
    'grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted'
  return (
    <div className="flex h-9 items-center gap-1 border-b border-border px-2">
      <button
        onClick={onBack}
        disabled={!url || !canGoBack}
        title="Back"
        aria-label="Back"
        className={navBtn}
      >
        <Caret dir="left" size={15} />
      </button>
      <button
        onClick={onForward}
        disabled={!url || !canGoForward}
        title="Forward"
        aria-label="Forward"
        className={navBtn}
      >
        <Caret dir="right" size={15} />
      </button>
      <button
        onClick={onReload}
        disabled={!url}
        title="Reload preview"
        aria-label="Reload preview"
        className={`${navBtn} mr-1`}
      >
        <IconReload />
      </button>
      <div className="flex shrink-0 items-center gap-px rounded-lg bg-text/5 p-0.5">
        {(Object.keys(PREVIEW_VIEWPORTS) as PreviewViewport[]).map((v) => {
          const active = viewport === v
          return (
            <button
              key={v}
              onClick={() => onViewportChange(v)}
              title={PREVIEW_VIEWPORTS[v].label}
              aria-label={PREVIEW_VIEWPORTS[v].label}
              aria-pressed={active}
              className={`grid h-6 w-7 place-items-center rounded-md transition-colors ${
                active ? 'bg-surface text-text shadow-soft' : 'text-text-muted hover:text-text'
              }`}
            >
              <ViewportIcon viewport={v} />
            </button>
          )
        })}
      </div>
      <AddressBar url={url} address={address} onNavigate={onNavigate} />
      <RecentPreviews address={address} recent={recent} onShowRecent={onShowRecent} />
    </div>
  )
}

/** The page a preview URL points at, in the user's terms: a static file's project path, or the dev
 *  server's URL. The `koda-preview://` host is an unguessable window token that means nothing to a
 *  reader, so it is never shown; typed input is still resolved against the real URL. */
function previewPath(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'koda-preview:') return decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html'
  } catch {
    // Not a URL at all — show it as it came.
  }
  return url
}

/** What the address field reads: the project path plus any query or hash the page is on. */
function addressText(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'koda-preview:') return previewPath(url) + u.search + u.hash
  } catch {
    // Not a URL at all — show it as it came.
  }
  return url
}

/** A static entry by its project path; a dev entry by its command, plus the folder when the agent ran
 *  it somewhere other than the project root (the same command in two folders is two apps). */
function restartName(r: PreviewRestart): string {
  if (r.kind === 'static') return r.relPath
  return r.cwd ? `${r.command} · ${r.cwd}` : r.command
}

function restartKey(r: PreviewRestart): string {
  return r.kind === 'static' ? `static:${r.relPath}` : `dev:${r.command}@${r.cwd ?? ''}`
}

const RECENT_MENU_WIDTH = 320
const NOTE_LINGER_MS = 5000

/**
 * The address bar, and it behaves like one: the text is where the frame is, editing it and pressing
 * Enter goes there, Escape puts it back. What it accepts is decided by `resolvePreviewAddress`; a refusal
 * is said in a sentence beside the field rather than left as a frame that silently failed to load.
 */
function AddressBar({
  url,
  address,
  onNavigate,
}: {
  url?: string
  address: string
  onNavigate?: (url: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_LINGER_MS)
    return () => clearTimeout(t)
  }, [note])
  const shown = addressText(address)
  const commit = (): void => {
    const result = resolvePreviewAddress(draft ?? shown, address)
    setDraft(null)
    inputRef.current?.blur()
    if (!result) return
    if ('refused' in result) setNote(result.refused)
    else onNavigate?.(result.url)
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={draft ?? shown}
        disabled={!url || !onNavigate}
        placeholder="Preview"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Preview address"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          // Enter and Escape belong to the field while it is being edited, not to the workspace.
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setDraft(null)
            inputRef.current?.blur()
          }
        }}
        className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-text-muted outline-none transition-colors placeholder:text-text-muted/60 hover:bg-surface focus:bg-surface focus:text-text disabled:hover:bg-transparent"
      />
      {note && <span className="max-w-[50%] truncate text-[11px] text-text-muted">{note}</span>}
    </div>
  )
}

/** Same scheme and host: a location main reports is only trusted onto the address bar when it belongs
 *  to the origin this frame was sent to. */
function sameHost(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.protocol === ub.protocol && ua.host === ub.host
  } catch {
    return false
  }
}

/**
 * The switcher beside the address bar, present once the chat has shown more than one thing, so four
 * mocks shown in a row stay one click apart instead of the last one burying the rest. Portaled with
 * fixed coords like the stage's other menus (the dock clips its overflow). Picking an entry replays the
 * same restart the empty stage's button uses; main answers with a `preview:show` push that re-points
 * the frame, so nothing here guesses.
 */
function RecentPreviews({
  address,
  recent,
  onShowRecent,
}: {
  address: string
  recent: PreviewRestart[]
  onShowRecent?: (restart: PreviewRestart) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      // Right-aligned to the trigger: it sits at the toolbar's right edge.
      setPos({
        top: r.bottom + 6,
        left: Math.max(12, Math.min(r.right - RECENT_MENU_WIDTH, window.innerWidth - RECENT_MENU_WIDTH - 12)),
      })
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
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_LINGER_MS)
    return () => clearTimeout(t)
  }, [note])

  if (recent.length < 2 || !onShowRecent) return null

  // The frame can't be asked what it shows (cross-origin), so "current" is read off the address: a
  // static entry by its path, a dev entry by the server being what's loaded (the newest dev entry is the
  // one main last pushed).
  const name = previewPath(address)
  const currentDev = /^https?:/.test(address) ? recent.find((r) => r.kind === 'dev') : undefined
  const isCurrent = (r: PreviewRestart): boolean => (r.kind === 'static' ? r.relPath === name : r === currentDev)
  const show = (r: PreviewRestart): void => {
    setOpen(false)
    onShowRecent(r).catch(() =>
      setNote(r.kind === 'dev' ? 'That command did not start. Check the terminal.' : 'That file is no longer there.'),
    )
  }
  return (
    <>
      {note && <span className="max-w-[40%] truncate text-[11px] text-text-muted">{note}</span>}
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title="Everything this chat has previewed"
        aria-label="Recent previews"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <Caret size={15} />
      </button>
      {pos &&
        createPortal(
          <Menu
            open={open}
            origin="origin-top-right"
            onClose={() => setOpen(false)}
            className="fixed z-50 rounded-xl border border-border bg-surface shadow-pop"
            style={{ top: pos.top, left: pos.left, width: RECENT_MENU_WIDTH }}
          >
            {/* The padding sits on the ref'd element so a click in the menu's own margin is not read as
                a click outside it. */}
            <div ref={menuRef} role="menu" aria-label="Recent previews" className="flex flex-col p-1.5">
              {recent.map((r) => {
                const current = isCurrent(r)
                return (
                  <button
                    key={restartKey(r)}
                    role="menuitemradio"
                    aria-checked={current}
                    onClick={() => show(r)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-mono text-[11px] outline-none transition-colors hover:bg-bg focus-visible:bg-bg ${
                      current ? 'text-text' : 'text-text-muted'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${current ? 'bg-accent' : 'invisible'}`} />
                    <span className="truncate">{restartName(r)}</span>
                  </button>
                )
              })}
            </div>
          </Menu>,
          document.body,
        )}
    </>
  )
}

function IconReload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </svg>
  )
}

function ViewportIcon({ viewport }: { viewport: PreviewViewport }) {
  const p = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const
  if (viewport === 'desktop')
    return (
      <svg {...p}>
        <rect x="3" y="5" width="18" height="12" rx="1.8" />
        <path d="M8.5 21h7M12 17v4" />
      </svg>
    )
  if (viewport === 'tablet')
    return (
      <svg {...p}>
        <rect x="6" y="3" width="12" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
    )
  return (
    <svg {...p}>
      <rect x="8" y="3" width="8" height="18" rx="2" />
      <path d="M11.3 18h1.4" />
    </svg>
  )
}


