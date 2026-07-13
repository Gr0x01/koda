import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import { IpcChannels } from '@shared/channels'
import { disposeEngineSessions, getEngineSessions, registerIpcHandlers } from './ipc'
import { probeEngine } from './engine/probe'
import { initUpdater } from './updater'
import { activateProvisionedRuntimes, activateToolsBinDir } from './runtime/provision'
import { ensureGlobalSkillsSeeded } from './engine/skills-catalog'
import { registerWindow, unregisterWindow, windowForProject } from './window-registry'
import {
  loadAppState,
  migrateV1IfPresent,
  noteProjectClosed,
  noteProjectOpened,
  pruneGhostSessions,
  saveWindowBounds,
} from './session-store'
import type { WindowBounds } from './session-store'
import { initLogger, log } from './logger'
import {
  registerPreviewScheme,
  registerPreviewProtocol,
  registerPreviewCaptureResponder,
  killDevServer,
} from './preview'
import { stopAllLanForwards } from './lan-forward'
import { voiceController } from './voice'
import { resumePlaywrightIfEnabled } from './playwright'
import { killTerminal, registerTerminalIpc } from './terminal'
import { track } from './telemetry'

// Pin the app name before any getPath() call (unpackaged Electron would otherwise name it
// "Electron"). In dev we deliberately use a DISTINCT name so a `npm run dev` instance and the
// installed .app can run side by side: it drives the dock label + menu-bar name (so you can tell
// them apart at a glance) AND forks userData/Logs to `Koda Dev`, so the two live processes never
// stomp each other's session stores or safety-git checkpoints.
app.setName(process.env.ELECTRON_RENDERER_URL ? 'Koda Dev' : 'Koda')

// Register the preview scheme as a privileged web origin — MUST run before app `ready` (Electron
// requirement), so it's a module-level call, not inside whenReady. The request handler is wired
// after ready (see whenReady).
registerPreviewScheme()

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Set on before-quit so window-close teardown can tell "user closed this window" (drop it from the
// restore-on-boot set) from "the app is quitting" (keep the set so boot reopens these projects).
let quitting = false

/**
 * Strict CSP for packaged builds (local content only). Dev is left relaxed so
 * the Vite dev server and React Fast Refresh's inline preamble keep working.
 * style-src needs 'unsafe-inline' for Tailwind v4 + inline styles; base-uri and
 * object-src are set explicitly since default-src doesn't backstop them.
 * NOTE: must run before the window is created and uses the default session —
 * a custom partition or later reorder would silently drop this.
 */
function applyContentSecurityPolicy(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only Koda's own chrome (the file:// renderer bundle) gets the strict policy. The preview
    // surface's content — the user's project over koda-preview:// or a localhost dev server —
    // must keep ITS own (or no) CSP: stamping ours onto it would block e.g. the inline <script>
    // in an agent-built HTML mock, a break that only shows up in packaged builds (dev skips this).
    if (!details.url.startsWith('file://')) return callback({})
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
            // The preview surface embeds the user's own web output in a sandboxed iframe: its static
            // origin (koda-preview:) and a managed dev server (localhost). Those origins are isolated
            // from Koda's renderer; this only permits FRAMING them, nothing more.
            "object-src 'none'; base-uri 'self'; " +
            'frame-src koda-preview: http://localhost:* http://127.0.0.1:*',
        ],
      },
    })
  })
}

const MIN_SIZE = { width: 960, height: 640 }

/**
 * First-launch (or off-screen-fallback) size: a roomy window that still fits the screen. The fixed
 * 1280×800 of old looked cramped with the rail + sessions + conversation + editor all open and was a
 * weak first impression. Scale to the primary display (cap so it doesn't fill a huge monitor), and
 * `center` so the OS places it nicely.
 */
function defaultWindowBounds(): { width: number; height: number; center: true } {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    width: Math.max(MIN_SIZE.width, Math.min(1480, Math.round(wa.width * 0.86))),
    height: Math.max(MIN_SIZE.height, Math.min(960, Math.round(wa.height * 0.88))),
    center: true,
  }
}

/**
 * Pick the size/position a new window opens at: the user's last-saved bounds if they're still on a
 * connected display, otherwise the default. Clamps to the target display's work area so a smaller — or
 * disconnected — monitor can't strand the window off-screen or oversized.
 */
function restoreWindowBounds():
  | { width: number; height: number; x: number; y: number }
  | { width: number; height: number; center: true } {
  const saved = loadAppState().windowBounds
  if (!saved) return defaultWindowBounds()
  const wa = screen.getDisplayMatching(saved).workArea
  // Require a meaningful overlap with that display (≥40px each axis) — else the saved spot is off-screen.
  const onScreen =
    saved.x + saved.width > wa.x + 40 &&
    saved.x < wa.x + wa.width - 40 &&
    saved.y + saved.height > wa.y + 40 &&
    saved.y < wa.y + wa.height - 40
  if (!onScreen) return defaultWindowBounds()
  return {
    x: saved.x,
    y: saved.y,
    width: Math.max(MIN_SIZE.width, Math.min(saved.width, wa.width)),
    height: Math.max(MIN_SIZE.height, Math.min(saved.height, wa.height)),
  }
}

/**
 * Create a window for a project (one-project-per-window). `projectPath` '' opens a ProjectHome
 * window (the renderer shows a folder picker); a real path opens straight into that project's
 * workspace. The renderer asks which it is via `project:getContext`.
 */
function createWindow(projectPath: string): void {
  const win = new BrowserWindow({
    ...restoreWindowBounds(),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    backgroundColor: '#0b0b0f',
    // Frameless-but-native: hide the OS title bar, keep the traffic lights, and pin them so they
    // center in our custom 36px drag bar (see TitleBar in Chassis.tsx). The window stays resizable
    // from its edges natively; the drag bar is what lets the user move it.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Locked sandbox posture (overview.md §6): renderer never gets raw Node.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  registerWindow(win, projectPath)
  // Title the window by project so multiple windows are distinguishable in the macOS window switcher.
  if (projectPath) win.setTitle(projectPath.split('/').filter(Boolean).pop() || 'Koda')

  // Remember size/position across launches. Debounced because resize/move fire continuously while
  // dragging; `getNormalBounds` returns the restored (un-maximized/un-fullscreen) rect. A final flush
  // on `close` captures a change made in the last debounce window before quitting.
  let boundsTimer: NodeJS.Timeout | undefined
  const persistBounds = (): void => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (!win.isDestroyed()) saveWindowBounds(win.getNormalBounds() as WindowBounds)
    }, 400)
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('close', () => {
    clearTimeout(boundsTimer)
    saveWindowBounds(win.getNormalBounds() as WindowBounds)
  })
  // On close, tear down the engine sessions this window owned so no headless `claude` child outlives
  // its window, free the registry slot, and — unless we're quitting — drop the project from the
  // restore-on-boot set (a user closing a window means "don't reopen it"; quitting preserves the set).
  win.on('closed', () => {
    killDevServer(win.id) // a managed preview dev server must not outlive its window
    killTerminal(win.id) // nor the window's interactive shell
    voiceController.killForWindow(win.id) // nor a live dictation helper holding the mic
    const ctx = unregisterWindow(win.id)
    if (ctx) {
      for (const sid of ctx.sessionIds)
        getEngineSessions()
          .disposeForWindow(sid)
          .catch((err) => log.error('engine', 'window-close teardown failed', err instanceof Error ? err.message : err))
      if (!quitting && ctx.projectPath) noteProjectClosed(ctx.projectPath)
    }
  })

  win.on('ready-to-show', () => win.show())

  // A crashed renderer (OOM is the realistic case: Monaco + xterm + a long transcript) would
  // otherwise sit as a dead blank window while its engine sessions keep running invisibly.
  // Reload restores the UI; sessions re-hydrate from the persisted store.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.error('window', `renderer gone (${details.reason}) — reloading`)
    if (!win.isDestroyed()) win.webContents.reload()
  })

  // External links open in the user's browser, never inside the app shell — and
  // only http(s). Markdown rendered from engine output is untrusted-ish; never
  // hand file://, custom-protocol, or other schemes to shell.openExternal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-page navigation away from our own content (e.g. a stray
  // location.href or <a href> the renderer should never be able to follow).
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** A new window with no project yet — the renderer shows the folder picker. */
function createProjectHomeWindow(): void {
  createWindow('')
}

/** Menu "Open…" (⌘O): pick a folder, then open it in its OWN window (focus it if already open). */
async function openFolderInNewWindow(): Promise<void> {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled || !res.filePaths[0]) return
  const projectPath = realpathSync(res.filePaths[0])
  const existing = windowForProject(projectPath)
  if (existing) return existing.focus() // one window per project
  noteProjectOpened(projectPath)
  createWindow(projectPath)
}

/** Open a known folder (e.g. a worktree surfaced in Versions) in its OWN window — focus it if already
 *  open. The programmatic twin of openFolderInNewWindow (no dialog); a worktree is another workspace
 *  you want ALONGSIDE the current one, so it never swaps the calling window in place. */
export function openProjectInNewWindow(path: string): { projectPath: string; alreadyOpen: boolean } {
  const projectPath = realpathSync(path)
  const existing = windowForProject(projectPath)
  if (existing) {
    existing.focus()
    return { projectPath, alreadyOpen: true }
  }
  noteProjectOpened(projectPath)
  createWindow(projectPath)
  return { projectPath, alreadyOpen: false }
}

/** Tell the focused window to open its Settings pane (app-menu "Settings…" / ⌘,). No-op if no window
 *  is focused (e.g. all minimized) — the menu item simply does nothing, which is the expected macOS feel. */
function openSettingsInFocusedWindow(): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(IpcChannels.uiOpenSettings)
}

/** App menu. On macOS the app submenu is built by hand (rather than `role: 'appMenu'`) so the
 *  conventional "Settings…" item (⌘,) sits in its standard place; the rest mirrors the default roles. */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettingsInFocusedWindow },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createProjectHomeWindow() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void openFolderInNewWindow() },
        // ⌘W is intentionally left unbound here so the renderer can use it to close the active session
        // (browser-tab convention); the window still closes via the red button or ⌘Q.
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  initLogger() // open the run's log file + crash traps before anything can fail
  migrateV1IfPresent() // one-shot: split the legacy global session blob into per-project files
  pruneGhostSessions() // drop recorded sessions the engine never wrote (start failed / nothing said)
  applyContentSecurityPolicy()
  registerPreviewProtocol() // serve koda-preview:// (scheme was registered pre-ready, above)
  registerPreviewCaptureResponder() // renderer→main iframe-rect replies for the agent's view_preview
  registerIpcHandlers()
  registerTerminalIpc() // the Dock's interactive shell (per-window pty)
  activateProvisionedRuntimes() // re-activate on-demand Node/Python installs from a previous session
  activateToolsBinDir() // pre-register the CLI tools bin dir on PATH so mid-session installs are usable
  // Seed the default-active gallery skills once each into the Koda-managed global plugin dir (fail-soft).
  try {
    ensureGlobalSkillsSeeded(app.getPath('userData'), app.isPackaged ? process.resourcesPath : undefined)
  } catch (err) {
    log.error('skills', 'seed failed', err instanceof Error ? err.message : err)
  }
  buildAppMenu()
  initUpdater() // app self-update: check-on-launch + interval, background download (packaged-only)
  track('app_opened', {}) // no-op unless the user opted in (telemetry.ts)

  // Reopen the projects that were open at last quit, one window each (sequential — avoids any race on
  // shared init). Drop any whose folder has since been deleted/moved (a stale path would wedge the
  // window with no resolvable fs root). First run / nothing alive → a ProjectHome window to pick.
  const alive: string[] = []
  for (const path of loadAppState().openProjects) {
    try {
      realpathSync(path)
      alive.push(path)
    } catch {
      noteProjectClosed(path) // gone — stop trying to reopen it
    }
  }
  if (alive.length) for (const path of alive) createWindow(path)
  else createProjectHomeWindow()

  // Finish a Chromium download the user enabled but didn't see complete (quit mid-install). No-op
  // when the capability is off or already installed. Fail-soft (never throws).
  resumePlaywrightIfEnabled()

  // Boot-time engine check — fail soft (surface it, don't crash the shell).
  // resourcesPath only means our bundled engine when packaged; in dev it's Electron's own.
  try {
    const probe = await probeEngine(app.isPackaged ? process.resourcesPath : undefined)
    log.info('engine', `${probe.version} (${probe.source}) at ${probe.path}`)
  } catch (err) {
    log.error('engine', 'probe failed', err instanceof Error ? err.message : err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createProjectHomeWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** Ask every window to fire its pending debounced state save and wait for the acks (see
 *  uiFlushState in channels.ts) — bounded, because quit must never wedge on a hung renderer. */
function flushRendererState(): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let remaining = wins.length
    const onDone = (): void => {
      remaining -= 1
      if (remaining <= 0) finish()
    }
    const finish = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener(IpcChannels.uiFlushStateDone, onDone)
      resolve()
    }
    const timer = setTimeout(finish, 1000)
    ipcMain.on(IpcChannels.uiFlushStateDone, onDone)
    for (const w of wins) w.webContents.send(IpcChannels.uiFlushState)
  })
}

// Tear down live engine processes before the app exits so no orphaned `claude`
// child outlives the shell. app.exit() bypasses before-quit, so no re-entry loop.
// (`quitting` is declared up top so window-close teardown can read it.)
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  // Backstop: never let a child that ignores signals wedge the quit.
  const backstop = setTimeout(() => app.exit(0), 5000)
  // app.exit() never fires window close/closed, so the per-window teardown must run HERE too —
  // dev servers especially: an orphaned one keeps its port + CPU running long after Koda is gone.
  for (const win of BrowserWindow.getAllWindows()) {
    killDevServer(win.id)
    killTerminal(win.id)
    voiceController.killForWindow(win.id)
  }
  stopAllLanForwards()
  // Flush the renderers' pending saves in parallel with engine teardown — both are bounded.
  Promise.allSettled([flushRendererState(), disposeEngineSessions()]).then(() => {
    clearTimeout(backstop)
    app.exit(0)
  })
})
