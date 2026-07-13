import { useEffect, useRef } from 'react'
import type { EngineEvent } from '@shared/ipc'
import type { Entry } from '../transcript/Transcript'
import { setNotifyEnabled, setNotifyOk, useWorkspace, activeEditor, PREVIEW_SURFACE_ID } from './store'

/**
 * Wires the workspace store to the main process: engine-event demux, approval queue, persistence,
 * the dock badge, native-notification permission, and ⌘1–9 fast-switch. All the cross-cutting
 * side-effects the old App.tsx held inline — lifted out so the UI is just render. Call once, high in
 * the tree. Store actions have stable identities, so the []-deps effects never go stale.
 */
export function useEngineBridge(): void {
  const applyEngineEvent = useWorkspace((s) => s.applyEngineEvent)
  const applyAsideEvent = useWorkspace((s) => s.applyAsideEvent)
  const applyProviderStatus = useWorkspace((s) => s.applyProviderStatus)
  const addPending = useWorkspace((s) => s.addPending)
  const cancelPending = useWorkspace((s) => s.cancelPending)
  const resolvePending = useWorkspace((s) => s.resolvePending)
  const setDefaultApprovalMode = useWorkspace((s) => s.setDefaultApprovalMode)
  const setBilling = useWorkspace((s) => s.setBilling)
  const setSettingsOpen = useWorkspace((s) => s.setSettingsOpen)
  const hydrate = useWorkspace((s) => s.hydrate)
  const hydrateLayout = useWorkspace((s) => s.hydrateLayout)
  const selectSession = useWorkspace((s) => s.selectSession)
  const openPreview = useWorkspace((s) => s.openPreview)
  const rememberPreview = useWorkspace((s) => s.rememberPreview)
  const maybeOfferIntake = useWorkspace((s) => s.maybeOfferIntake)
  const adoptHeadless = useWorkspace((s) => s.adoptHeadless)
  const archiveSession = useWorkspace((s) => s.archiveSession)
  const renameSession = useWorkspace((s) => s.renameSession)
  const applyRemoteUserTurn = useWorkspace((s) => s.applyRemoteUserTurn)
  const openTerminalShelf = useWorkspace((s) => s.openTerminalShelf)

  // Engine event stream → store demux.
  useEffect(() => window.koda.onEngineEvent((e: EngineEvent) => applyEngineEvent(e)), [applyEngineEvent])

  // Side-question ("btw" / aside) answer stream → the matching session's aside overlay.
  useEffect(() => window.koda.onAsideEvent((e) => applyAsideEvent(e)), [applyAsideEvent])

  // Provider-outage pill: live pushes + a seed read so a window opened mid-outage still shows it.
  useEffect(() => {
    window.koda
      .getProviderStatus()
      .then((list) => list.forEach(applyProviderStatus))
      .catch(console.error)
    return window.koda.onProviderStatus(applyProviderStatus)
  }, [applyProviderStatus])

  // Approval gate ("Ask me"): queue requests; drop one when it's answered (on any head, so this window's
  // prompt clears even if the phone answered it); clear a session's whole queue when it ends.
  useEffect(() => {
    const offReq = window.koda.onApprovalRequest((req) => addPending(req))
    const offResolved = window.koda.onApprovalResolved((e) => resolvePending(e.requestId))
    const offCancel = window.koda.onApprovalCancelled((e) => cancelPending(e.sessionId))
    return () => {
      offReq()
      offResolved()
      offCancel()
    }
  }, [addPending, resolvePending, cancelPending])

  // Default approval posture (for new sessions) + the notification preference + native-notification
  // permission (best-effort). getApprovalMode + getSettings both read from main's settings file; the
  // former feeds the gate-seeded default, the latter the renderer-side notification gate.
  useEffect(() => {
    window.koda.getApprovalMode().then(setDefaultApprovalMode).catch(console.error)
    window.koda
      .getSettings()
      .then((s) => {
        setNotifyEnabled(s.notificationsEnabled)
        hydrateLayout(s.layout) // restore persisted pane sizes (boot only — not on cross-window changes)
      })
      .catch(console.error)
    // Billing mode + whether the API key is currently effective — drives the status chip + 'auto' fallback.
    window.koda.getBillingState().then((b) => setBilling(b.mode, b.apiActive)).catch(console.error)
    if ('Notification' in window) {
      if (Notification.permission === 'granted') setNotifyOk(true)
      else if (Notification.permission === 'default')
        Notification.requestPermission()
          .then((p) => setNotifyOk(p === 'granted'))
          .catch(() => {})
    }
  }, [setDefaultApprovalMode, setBilling, hydrateLayout])

  // App-menu "Settings…" / ⌘, → open the Settings pane in this window.
  useEffect(() => window.koda.onOpenSettings(() => setSettingsOpen(true)), [setSettingsOpen])

  // The agent started the managed dev server → open/point the preview surface at its URL. Agent-pushed,
  // so a pinned stage keeps what the user pinned (the preview still opens behind it, URL current).
  useEffect(
    () =>
      window.koda.onPreviewShow((url, sessionId, restart) => {
        openPreview(url, { respectPin: true, sessionId })
        rememberPreview(sessionId, restart)
      }),
    [openPreview, rememberPreview],
  )

  // The agent's open_terminal: pop the terminal shelf and, if it staged a command, hand it to the store
  // so the terminal view types it at the prompt (never runs it). The push already targets this window.
  useEffect(
    () => window.koda.onTerminalShow(({ command }) => openTerminalShelf(command)),
    [openTerminalShelf],
  )

  // The agent's view_preview: main asks for the preview iframe's on-screen rect, then capturePage's it.
  // Single responder (this hook is mounted once). If a preview exists but isn't showing, bring it to the
  // front so the agent can look even after the user switched tabs (Rung 3.1) — but fronting remounts +
  // reloads the iframe, so wait for its `load` before measuring or we'd capture a blank frame. No preview
  // surface at all → respond null (main turns that into a "open the Preview tab" hint).
  useEffect(() => {
    return window.koda.onPreviewCaptureRequest((correlationId) => {
      const dpr = window.devicePixelRatio
      const respond = (rect: { x: number; y: number; width: number; height: number } | null): void =>
        window.koda.respondPreviewCapture(correlationId, rect, dpr)
      const measure = (): void => {
        const el = document.querySelector('[data-preview-iframe]')
        const r = el?.getBoundingClientRect()
        respond(r && r.width >= 1 && r.height >= 1 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null)
      }

      const st = useWorkspace.getState()
      if (!activeEditor(st).surfaces.some((s) => s.kind === 'preview')) return respond(null)
      // "Front" = the dock is open AND the preview is on stage. If not, bring it there (remounts the
      // iframe → reloads), so the agent can look even if the user staged something else or collapsed
      // the dock. An explicit "look at it", so it overrides a pin.
      const front = st.dockOpen && activeEditor(st).activeSurfaceId === PREVIEW_SURFACE_ID
      if (!front) st.bringPreviewToStage()

      // Poll for the iframe (a just-fronted preview mounts async). Already front → its content is live,
      // measure on the next paint. Just fronted → wait for the reload to paint (load event, capped).
      let tries = 0
      const begin = (): void => {
        const el = document.querySelector('[data-preview-iframe]') as HTMLIFrameElement | null
        if (!el) {
          if (tries++ < 40) requestAnimationFrame(begin)
          else respond(null)
          return
        }
        if (front) return void requestAnimationFrame(() => requestAnimationFrame(measure))
        let done = false
        const ready = (): void => {
          if (done) return
          done = true
          requestAnimationFrame(() => requestAnimationFrame(measure))
        }
        el.addEventListener('load', ready, { once: true })
        setTimeout(ready, 1200) // fallback: the load may have already fired, or be slow (main caps at 3s)
      }
      requestAnimationFrame(begin)
    })
  }, [])

  // Settings changed in ANY window → re-sync this window's live gates (notification pref + the default
  // posture new sessions start at) so the app stays consistent across windows without a restart.
  useEffect(
    () =>
      window.koda.onSettingsChanged((s) => {
        setNotifyEnabled(s.notificationsEnabled)
        setDefaultApprovalMode(s.defaultApprovalMode)
        // billingMode rides settings; apiActive (fallback) doesn't — re-fetch the full billing state so
        // the chip reflects both after any save/remove/activate (each broadcasts uiSettingsChanged).
        window.koda.getBillingState().then((b) => setBilling(b.mode, b.apiActive)).catch(console.error)
      }),
    [setDefaultApprovalMode, setBilling],
  )

  // Restore persisted sessions on boot: tabs + history reappear immediately; each session's engine
  // reattaches lazily (claude --resume) on its next turn. `hydrate` flips the `hydrated` flag that
  // gates the save effect, so a slow load can't clobber the file with an empty list first.
  useEffect(() => {
    // Sessions (hot blob) + archived (cold file) load together — archived moved out of the hot blob so
    // its weight stops riding every debounced save (the 53MB-freeze bug); hydrate still sees one shape.
    // Archived is fail-soft AND optional-chained: an archived-load problem must never take sessions down,
    // and under `electron-vite dev` the renderer hot-reloads INSTANTLY while preload only updates on
    // restart — a renderer calling a just-added preload API crashes boot in that mixed-version window
    // (this exact gap once let the empty-hydrate catch below save over a real store and lose the archive).
    Promise.all([window.koda.loadSessions(), Promise.resolve(window.koda.loadArchived?.() ?? []).catch(() => [])])
      .then(([data, archived]) => {
        hydrate({
          version: 2,
          activeId: data?.activeId ?? null,
          sessions: (data?.sessions ?? []).map((s) => ({
            id: s.id,
            label: s.label,
            cwd: s.cwd,
            userNamed: s.userNamed, // preserve the manual-rename lock across restart
            approvalMode: s.approvalMode, // preserve per-session posture across restart
            model: s.model, // restore the chosen model (was dropped → "Default" after restart)
            effort: s.effort, // restore spawn-time reasoning effort for lazy reattach
            engineId: s.engineId, // preserve Claude vs Codex; hydrate falls back only for old blobs
            engineNativeId: s.engineNativeId, // preserve Codex's thread id for thread/resume
            context: s.context, // restore the fuel gauge (was dropped → blank meter after restart)
            spendUsd: s.spendUsd,
            byModel: s.byModel,
            lastPreview: s.lastPreview,
            items: s.items as Entry[],
          })),
          // Cold-file archived, plus any still inline in an old blob (pre-split, not yet migrated).
          archived: [...archived, ...(data?.archived ?? [])],
          rateLimits: data?.rateLimits, // restore the 5-hour/weekly footer (refreshed next turn)
        })
        // A project opened with no sessions + no guidelines yet → offer the one-time intake (common
        // case: an existing folder, not just New project). No-op otherwise (has sessions / skipped /
        // already has CLAUDE.md|AGENTS.md). New project pre-sets the flag, so this early-returns there.
        void maybeOfferIntake({ hasSessions: (data?.sessions ?? []).length > 0 })
        // Pull in any live sessions this project's already running headless (started from the phone) so
        // they show up alongside the restored ones. Runs after hydrate so it can skip already-open tabs.
        void adoptHeadless()
      })
      .catch((err) => {
        // Load FAILED (as opposed to loading an empty store, which resolves fine above). Deliberately do
        // NOT hydrate: hydrating un-gates the debounced save, and the very first save would then overwrite
        // the real on-disk store with this empty state — that's how a boot crash once destroyed the
        // archived list. Persistence stays read-only for this run; the store on disk survives untouched.
        console.error('session load failed — persistence disabled for this run', err)
      })
  }, [hydrate, maybeOfferIntake, adoptHeadless])

  // A phone just started/resumed a session in this window's project → adopt it live (appears in the
  // list + streams from here on). adoptHeadless is idempotent, so a redundant nudge is harmless.
  useEffect(() => window.koda.onHeadlessAppeared(() => void adoptHeadless()), [adoptHeadless])

  // The phone asked to archive a past session in this window's project — the renderer owns the session
  // store while the window is open, so main forwards the request here instead of writing the file.
  useEffect(
    () => window.koda.onArchiveRequested(({ sessionId }) => void archiveSession(sessionId)),
    [archiveSession],
  )

  // Same forwarding rule for a phone rename of a live session this window owns.
  useEffect(
    () => window.koda.onRenameRequested(({ sessionId, name }) => renameSession(sessionId, name)),
    [renameSession],
  )

  // A phone turn landed on a session this window already owns (adopted empty, before the turn). The
  // engine stream never echoes the human's prompt, so main forwards it here → append it + auto-title.
  useEffect(
    () => window.koda.onRemoteUserTurn(({ sessionId, text }) => applyRemoteUserTurn(sessionId, text)),
    [applyRemoteUserTurn],
  )

  // Persist the archived list to its cold file — only when it actually changes (archive / restore /
  // delete swap the array reference; streaming never touches it). Separate from the hot save below so
  // archives never ride the every-500ms blob again.
  useEffect(() => {
    let prev = useWorkspace.getState().archived
    return useWorkspace.subscribe((st) => {
      if (!st.hydrated || st.archived === prev) return
      prev = st.archived
      // Optional-chained for the dev-mode mixed-version window (renderer hot-reloads before preload).
      window.koda.saveArchived?.(st.archived)
    })
  }, [])

  // Persist open sessions + transcripts (debounced). Subscribes OUTSIDE React render so streaming
  // deltas don't thrash the disk: only durable fields are saved, an unchanged blob is skipped, and
  // the timer resets to the latest change. Gated until the boot-load settles.
  const saveTimer = useRef<number | null>(null)
  const lastSaved = useRef('')
  useEffect(() => {
    const persistNow = (): void => {
      const st = useWorkspace.getState()
      if (!st.hydrated) return
      const blob = st.persistBlob()
      const serialized = JSON.stringify(blob)
      if (serialized === lastSaved.current) return
      lastSaved.current = serialized
      window.koda.saveSessions(blob)
    }
    const schedule = (): void => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(persistNow, 500)
    }
    const unsub = useWorkspace.subscribe(schedule)
    // Pre-quit flush: main is about to app.exit() (no unload events fire) — save whatever the
    // debounce is still holding so a turn finished in the last 500ms survives the quit.
    const unsubFlush = window.koda.onFlushState(() => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      persistNow()
    })
    return () => {
      unsub()
      unsubFlush()
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [])

  // Dock badge = count of sessions needing attention. Subscribe outside render; only push on change.
  const lastBadge = useRef(0)
  useEffect(() => {
    const compute = (): void => {
      const { sessions } = useWorkspace.getState()
      const count = Object.values(sessions).filter((s) => s.attention).length
      if (count !== lastBadge.current) {
        lastBadge.current = count
        window.koda.setAttentionCount(count)
      }
    }
    return useWorkspace.subscribe(compute)
  }, [])

  // Swallow image drops that miss the composer — otherwise Electron navigates the window to the
  // dropped file:// and blows away the renderer (the composer's own onDrop handles real attaches).
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  // Window-level shortcuts: ⌘P / ⌘⇧F → Find overlay, ⌘/Ctrl + 1–9 → fast-switch sessions.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return
      // ⌘P (quick open) or ⌘⇧F (find in files) — summon the Find overlay. ⌘F stays Monaco's in-file
      // find; ⌘⇧F never collides with it (the shift distinguishes them).
      const isFindKey =
        (!e.shiftKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p')) ||
        (e.shiftKey && (e.code === 'KeyF' || e.key.toLowerCase() === 'f'))
      if (isFindKey) {
        e.preventDefault()
        useWorkspace.getState().setSearchOpen(true)
        return
      }
      // Browser-tab convention: ⌘T new session, ⌘W close the current one. (⌘W is free because the
      // File menu no longer claims it — see buildAppMenu.)
      if (!e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        void useWorkspace.getState().startSession()
        return
      }
      if (!e.shiftKey && e.code === 'KeyW') {
        const { activeId, archiveSession } = useWorkspace.getState()
        if (activeId) {
          e.preventDefault()
          void archiveSession(activeId)
        }
        return
      }
      // Dock: ⌘J toggles it; ⌘⇧[ / ⌘⇧] cycle what's on stage (⌘⇧F is caught above, so ⇧ is free here).
      if (!e.shiftKey && e.code === 'KeyJ') {
        e.preventDefault()
        useWorkspace.getState().toggleDock()
        return
      }
      if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        const s = useWorkspace.getState()
        const ed = activeEditor(s)
        if (ed.surfaces.length < 2) return
        const cur = Math.max(0, ed.surfaces.findIndex((su) => su.path === ed.activeSurfaceId))
        const delta = e.code === 'BracketRight' ? 1 : -1
        const next = ed.surfaces[(cur + delta + ed.surfaces.length) % ed.surfaces.length]
        s.selectSurface(next.path)
        return
      }
      if (e.key < '1' || e.key > '9') return
      const idx = Number(e.key) - 1
      const { order } = useWorkspace.getState()
      if (idx < order.length) {
        e.preventDefault()
        selectSession(order[idx])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectSession])
}
