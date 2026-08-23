import { basename, dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import { IpcChannels } from '@shared/channels'
import { disposeEngineSessions, getEngineSessions, registerIpcHandlers, runDreamNow } from './ipc'
import { probeEngine } from './engine/probe'
import { initUpdater } from './updater'
import { activateProvisionedRuntimes, activateToolsBinDir } from './runtime/provision'
import { ensureGlobalSkillsSeeded } from './engine/skills-catalog'
import { projectPathForWindow, registerWindow, unregisterWindow, windowForProject } from './window-registry'
import {
  backfillKnownProjects,
  loadAppState,
  migrateV1IfPresent,
  noteProjectClosed,
  noteProjectOpened,
  projectsHomeDir,
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
  forgetWindowDocuments,
  isDocumentFrameEscape,
} from './preview'
import { stopAllLanForwards } from './lan-forward'
import { bootStartMiniApps, disposeMiniApps } from './mini-apps'
import { voiceController } from './voice'
import { resumePlaywrightIfEnabled } from './playwright'
import { killTerminal, registerTerminalIpc } from './terminal'
import { track } from './telemetry'
import { startSuspensionWatchdog } from './suspension-watchdog'
import { startProbeGovernor } from './probe-governor'
import { startScratchRetentionSweep } from './scratch-retention'
import { closeAllNeuralViews, openNeuralView } from './neural-view'
import { appNameFor, runtimeProfile } from './runtime-profile'

// Pin the app name before any getPath() call (unpackaged Electron would otherwise name it
// "Electron"). Dev and E2E deliberately get distinct identities: dev can coexist with the installed
// app, while E2E must never write/prune either app's logs or contend for its single-instance lock.
const profile = runtimeProfile()
app.setName(appNameFor(profile))
if (profile === 'e2e') app.setAppLogsPath(join(app.getPath('userData'), 'logs'))

// Register the preview scheme as a privileged web origin — MUST run before app `ready` (Electron
// requirement), so it's a module-level call, not inside whenReady. The request handler is wired
// after ready (see whenReady).
registerPreviewScheme()

// E2E drives the built renderer and MUST keep the strict CSP; only electron-vite dev relaxes it.
const isDev = profile === 'dev'

// Set on before-quit so window-close teardown can tell "user closed this window" (drop it from the
// restore-on-boot set) from "the app is quitting" (keep the set so boot reopens these projects).
let quitting = false
let stopScratchRetentionSweep: (() => void) | null = null

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
            // koda-preview: lets the WYSIWYG doc surface show a doc's local images (served from the
            // contained project file server); the protocol handler realpath-contains every request.
            "img-src 'self' data: koda-preview:; font-src 'self'; connect-src 'self'; " +
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
function createWindow(projectPath: string, newProjectIntent = false): void {
  // Timed so a slow "opening an app / project" is diagnosable after the fact — the cold window+renderer
  // boot is the dominant cost of first-open (warm on retry) and otherwise leaves no trace in the log.
  const openStart = Date.now()
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

  registerWindow(win, projectPath, newProjectIntent)
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
    forgetWindowDocuments(win.id) // nor the paths its document origin was allowed to serve
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

  // Timing base: ready-to-show re-fires on every reload, and measuring all of them from the window's
  // ORIGINAL openStart poisoned the stall data — a 6-day-old window logged ms≈its uptime (the broken
  // instrumentation flagged 07-28). First paint measures the true cold open; each reload measures
  // from its own load start under a distinct label so cold-open reads stay clean.
  let paintStart = openStart
  let firstPaint = true
  win.webContents.on('did-start-loading', () => {
    if (!firstPaint) paintStart = Date.now()
  })
  win.on('ready-to-show', () => {
    log.info('window', firstPaint ? 'project window ready' : 'project window reloaded', {
      projectPath,
      ms: Date.now() - paintStart,
    })
    firstPaint = false
    win.show()
  })

  // A crashed renderer (OOM is the realistic case: Monaco + xterm + a long transcript) would
  // otherwise sit as a dead blank window while its engine sessions keep running invisibly.
  // Reload restores the UI; sessions re-hydrate from the persisted store.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.error('window', `renderer gone (${details.reason}) — reloading`)
    if (!win.isDestroyed()) win.webContents.reload()
  })

  // Native right-click menu for text. Electron ships none, so without this the spellchecker
  // underlines words but offers no fixes — and text fields have no cut/copy/paste menu at all.
  // Only pops on editable fields or a text selection; surfaces with their own custom menus
  // (file tree, sessions) aren't those, so the two never stack.
  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []
    for (const suggestion of params.dictionarySuggestions.slice(0, 5))
      template.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) })
    if (params.misspelledWord)
      template.push(
        {
          label: 'Add to Dictionary',
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: 'separator' }
      )
    if (params.isEditable) template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
    else if (params.selectionText.trim()) template.push({ role: 'copy' })
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win })
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

  // Defense in depth for the sandboxed document origin: `will-navigate` only fires for the MAIN frame,
  // so a document iframe navigating ITSELF slips past it. A hostile document could read its own host
  // and hop to the permissive app-preview origin to shed its no-network CSP. Deny any host/scheme
  // change of a frame that is currently on the document origin; reloading itself for live refresh and
  // same-origin paths are left untouched. (The independent document token already makes the app-preview
  // URL unconstructable — this keeps the CSP unsheddable even if another served origin is added later.)
  win.webContents.on('will-frame-navigate', (details) => {
    const frameUrl = details.frame?.url
    if (frameUrl && isDocumentFrameEscape(frameUrl, details.url)) details.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** A new window with no project yet — the renderer shows the folder picker. When `newProject` is set
 *  (the "New Project…" menu entry), it lands with the create-a-project modal already open. */
function createProjectHomeWindow(newProject = false): void {
  createWindow('', newProject)
}

/** Menu "Open…" (⌘O): pick a folder, then open it in its OWN window (focus it if already open).
 *  Starts in ~/Koda — where projects live — not wherever macOS last browsed. */
async function openFolderInNewWindow(): Promise<void> {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: projectsHomeDir() })
  if (res.canceled || !res.filePaths[0]) return
  const projectPath = realpathSync(res.filePaths[0])
  const existing = windowForProject(projectPath)
  if (existing) return existing.focus() // one window per project
  noteProjectOpened(projectPath)
  createWindow(projectPath)
  buildAppMenu()
}

/** Open a known folder (e.g. a worktree surfaced in Versions) in its OWN window — focus it if already
 *  open. The programmatic twin of openFolderInNewWindow (no dialog); a worktree is another workspace
 *  you want ALONGSIDE the current one, so it never swaps the calling window in place. */
export function openProjectInNewWindow(path: string): { projectPath: string; alreadyOpen: boolean } {
  const projectPath = realpathSync(path)
  const existing = windowForProject(projectPath)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
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

function focusedProject(): { win: BrowserWindow; path: string } | undefined {
  const win = BrowserWindow.getFocusedWindow()
  const path = win && projectPathForWindow(win.id)
  return win && path ? { win, path } : undefined
}

function sendFileCommand(command: import('@shared/ipc').FileMenuCommand): void {
  focusedProject()?.win.webContents.send(IpcChannels.uiFileCommand, command)
}

function openRecentProject(path: string): void {
  if (!existsSync(path)) return
  const opened = openProjectInNewWindow(path)
  if (opened.alreadyOpen) noteProjectOpened(opened.projectPath)
  buildAppMenu() // bumping a project to the front should immediately reorder Open Recent
}

/** App menu. On macOS the app submenu is built by hand (rather than `role: 'appMenu'`) so the
 *  conventional "Settings…" item (⌘,) sits in its standard place; the rest mirrors the default roles. */
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const focused = focusedProject()
  const hasProject = !!focused
  const hasNeuralProject = focused?.path === realpathSync(app.getAppPath())
  const recents = loadAppState().recentProjects.filter(existsSync).slice(0, 12)
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: appNameFor(profile),
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
        // Opens a ProjectHome window landing on the create-a-project modal (the start-a-new-project
        // flow). Always available — from a project window this is the only way back to it; the
        // project-scoped items below aren't.
        { label: 'New Project…', click: () => createProjectHomeWindow(true) },
        { type: 'separator' },
        { label: 'New Document', accelerator: 'CmdOrCtrl+N', enabled: hasProject, click: () => sendFileCommand('newDocument') },
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', enabled: hasProject, click: () => sendFileCommand('newFolder') },
        { type: 'separator' },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => void openFolderInNewWindow() },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? recents.map((path) => ({
                label: basename(path),
                sublabel: dirname(path),
                click: () => openRecentProject(path),
              }))
            : [{ label: 'No Recent Projects', enabled: false }],
        },
        {
          label: 'Import Files…',
          enabled: hasProject,
          click: () => sendFileCommand('importFiles'),
        },
        { type: 'separator' },
        // Sends the command to the focused window; the visible doc surface answers. Docs only —
        // "export what I'm reading" — so with no doc on the Stage it's a quiet no-op.
        { label: 'Export as PDF…', enabled: hasProject, click: () => sendFileCommand('exportPdf') },
        { type: 'separator' },
        {
          label: 'Reveal Project in Finder',
          enabled: hasProject,
          click: () => {
            const project = focusedProject()
            if (project) shell.showItemInFolder(project.path)
          },
        },
        {
          label: 'Copy Project Path',
          enabled: hasProject,
          click: () => {
            const project = focusedProject()
            if (project) clipboard.writeText(project.path)
          },
        },
        { type: 'separator' },
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => BrowserWindow.getFocusedWindow()?.close(),
        },
        // ⌘W stays renderer-owned for closing the active session.
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    ...(isDev
      ? [
          {
            label: 'Developer',
            submenu: [
              {
                label: 'Open Neural View',
                enabled: hasNeuralProject,
                click: () => {
                  const project = focusedProject()
                  if (project)
                    void openNeuralView(project.path).catch((err) =>
                      log.error('neural-view', 'open failed', err instanceof Error ? err.message : err),
                    )
                },
              },
              {
                label: 'Run Overnight Dream Now',
                click: () => runDreamNow(),
              },
            ],
          },
        ]
      : []),
    { role: 'windowMenu' as const },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Right-clicking the Dock icon lists recent projects — the Dock twin of File → Open Recent.
  // Rebuilt here so both stay in sync with the same recents list.
  if (isMac)
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        ...recents.map((path) => ({ label: basename(path), click: () => openRecentProject(path) })),
        ...(recents.length ? [{ type: 'separator' as const }] : []),
        { label: 'New Project…', click: () => createProjectHomeWindow(true) },
      ]),
    )
}

// One Koda per userData dir. Two instances silently share app-lifetime state — worst known cost: both
// auto-refresh the same single-use cloud token, Supabase's reuse detection revokes the whole family,
// and phone access dies for the day (2026-08-02). The second launch just fronts the one already running.
// Dev and packaged builds have different userData dirs, so they still coexist.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return // quitting — don't boot services underneath the running instance
  initLogger() // open the run's log file + crash traps before anything can fail
  startSuspensionWatchdog() // so a socket-drop diagnosis can say "the process was stopped", not guess
  // Power/focus signals for the non-essential background probes. Must be after ready (powerMonitor is
  // unusable before it) and before anything that registers a probe, so the first tick is already governed.
  startProbeGovernor()
  migrateV1IfPresent() // one-shot: split the legacy global session blob into per-project files
  pruneGhostSessions() // drop recorded sessions the engine never wrote (start failed / nothing said)
  backfillKnownProjects() // seed the phone's full project list from the on-disk stores (past the 20-recents cap)
  applyContentSecurityPolicy()
  registerPreviewProtocol() // serve koda-preview:// (scheme was registered pre-ready, above)
  registerPreviewCaptureResponder() // renderer→main iframe-rect replies for the agent's view_preview
  registerIpcHandlers()
  stopScratchRetentionSweep = startScratchRetentionSweep()
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
  app.on('browser-window-focus', buildAppMenu)
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

  // Restart the mini apps that were running at last quit ("restart when Koda relaunches"). No-op with
  // the mini-apps flag off; fire-and-forget per app — a failure just leaves it stopped (app_status).
  bootStartMiniApps()

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
  closeAllNeuralViews()
  stopScratchRetentionSweep?.()
  stopScratchRetentionSweep = null
  // Flush the renderers' pending saves in parallel with engine + mini-app teardown — all bounded.
  // Mini apps get SIGTERM → short-grace SIGKILL (a port held by a half-dead child would break the
  // next launch's boot-restart); their desired-running state survives, so they come back next launch.
  Promise.allSettled([flushRendererState(), disposeEngineSessions(), disposeMiniApps()]).then(() => {
    clearTimeout(backstop)
    app.exit(0)
  })
})
