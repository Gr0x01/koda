import { useCallback, useEffect, useRef, useState } from 'react'
import { Caret } from '../Caret'

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
  onViewportChange,
}: {
  url?: string
  rev: number
  className?: string
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

  const onFrameLoad = useCallback(() => {
    if (programmatic.current) {
      programmatic.current = false // our own back/forward landed — depth already updated
      return
    }
    setNav((n) => ({ pos: n.pos + 1, len: n.pos + 2 })) // a user link nav truncates any forward stack
  }, [])
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
          viewport={viewport}
          canGoBack={false}
          canGoForward={false}
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
        viewport={viewport}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
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
  viewport,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onReload,
  onViewportChange,
}: {
  url?: string
  viewport: PreviewViewport
  canGoBack: boolean
  canGoForward: boolean
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
      <span className="truncate font-mono text-[11px] text-text-muted">{url ?? 'Preview'}</span>
    </div>
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


