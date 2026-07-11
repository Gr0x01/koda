import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { track, trackFirstTurn } from './telemetry'
import { checkForUpdatesNow, getUpdateStatus, getWhatsNew, quitAndInstallUpdate } from './updater'
import { submitFeedback } from './feedback'
import { z } from 'zod'
import { IpcChannels } from '@shared/channels'
import {
  AppInfoSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  FeedbackRequestSchema,
  EngineProbeSchema,
  StartSessionRequestSchema,
  StartSessionResponseSchema,
  SendTurnRequestSchema,
  SessionRefSchema,
  AskAsideRequestSchema,
  CancelAsideRequestSchema,
  CheckpointSchema,
  CheckpointListSchema,
  SafetyRestoreRequestSchema,
  SafetyChangesRequestSchema,
  SafetyChangesResultSchema,
  SafetyFileDiffRequestSchema,
  SafetyFileDiffResultSchema,
  PersistedSessionsSchema,
  ArchivedSessionSchema,
  AdoptedHeadlessListSchema,
  RendererLogSchema,
  AttentionCountSchema,
  ApprovalResolveSchema,
  SetApprovalModeSchema,
  SetModelEffortSchema,
  ApprovalModeSchema,
  AssistTitleRequestSchema,
  AssistTitleResponseSchema,
  ReadDirRequestSchema,
  ListDocsResultSchema,
  ReadDirResultSchema,
  ReadFileRequestSchema,
  ReadFileResultSchema,
  DiffFileRequestSchema,
  DiffFileResultSchema,
  WriteFileRequestSchema,
  WriteFileResultSchema,
  CreateFileRequestSchema,
  CreateFileResultSchema,
  ScratchSaveRequestSchema,
  ScratchSaveResultSchema,
  DocMetaGetRequestSchema,
  DocMetaSetRequestSchema,
  DocMetaSchema,
  ScratchListRequestSchema,
  ScratchListResultSchema,
  RenamePathRequestSchema,
  RenamePathResultSchema,
  DeletePathRequestSchema,
  CreateDirRequestSchema,
  CreateDirResultSchema,
  SearchRequestSchema,
  SearchResultSchema,
  ReplaceRequestSchema,
  ReplaceResultSchema,
  GitRepoInfoSchema,
  GitStatusResultSchema,
  GitGraphRequestSchema,
  GitCommitGraphResultSchema,
  GitInitResultSchema,
  GitCommitRequestSchema,
  GitCommitPathsRequestSchema,
  GitRenameHeadRequestSchema,
  GitRestoreRequestSchema,
  GitDiscardFileRequestSchema,
  GitDiscardResultSchema,
  GitCommitResultSchema,
  GitFileDiffRequestSchema,
  GitCommitChangesRequestSchema,
  GitBranchRequestSchema,
  GitBranchFileDiffRequestSchema,
  GitBranchOverviewSchema,
  GitSyncStateSchema,
  GitPushResultSchema,
  GitWorktreeListSchema,
  GitMergedStrayListSchema,
  GitTidyResultSchema,
  GitTidyStraysRequestSchema,
  WorktreeOpenRequestSchema,
  ProjectContextSchema,
  ChooseFolderResultSchema,
  GUIDELINES_FILES,
  ProjectCreateRequestSchema,
  ProjectHasGuidelinesResultSchema,
  ProjectOpenRequestSchema,
  ProjectOpenResultSchema,
  RecentProjectsSchema,
  AddRecentModelSchema,
  KodaSettingsSchema,
  KodaSettingsPatchSchema,
  GuardrailsLayerSchema,
  MemoryWeightSchema,
  GuardrailSaveRequestSchema,
  GuardrailSaveResultSchema,
  GuardrailSetEnabledRequestSchema,
  GuardrailItemRefSchema,
  SkillCatalogSchema,
  SkillSetActiveRequestSchema,
  GuardrailSaveItemBodyRequestSchema,
  GuardrailRuleOverrideRequestSchema,
  VoiceStartResponseSchema,
  PlaywrightStatusSchema,
  RuntimeIdSchema,
  RuntimeStatusSchema,
  RuntimeInstallResultSchema,
  AuthDetectResultSchema,
  AuthLoginStartResultSchema,
  AuthCodeSchema,
  BillingStateSchema,
  BillingSaveResultSchema,
  ApiKeySchema,
  ApiFallbackRequestSchema,
  PreviewRestartRequestSchema,
} from '@shared/ipc'
import { basename, isAbsolute, join, relative } from 'node:path'
import { projectMemoryWeight } from './engine/pack'
import { probeEngine } from './engine/probe'
import { EngineSessionManager } from './engine/sessions'
import { loadUsageHistory } from './engine/usage-history'
import { currentProviderStatus, setStatusWatchHooks } from './engine/status-watch'
import { assistTitle } from './assist'
import {
  browseDir,
  createProjectDir,
  createProjectFile,
  deleteProjectPath,
  diffProjectFile,
  listProjectDocs,
  readProjectFile,
  renameProjectPath,
  replaceInProject,
  searchProject,
  writeProjectFile,
  containedReal,
} from './fs-browse'
import { watchProjectFile, unwatchProjectFile } from './file-watch'
import { watchProjectDocs, unwatchProjectDocs } from './docs-watch'
import {
  branchFileDiff,
  commitAll,
  commitPaths,
  discardFile,
  renameHead,
  commitChanges,
  detectRepo,
  discardBranch,
  getBranchOverview,
  getCommitGraph,
  getMergedStrays,
  getStatus,
  getSyncState,
  getWorktrees,
  gitFileDiff,
  initRepo,
  pushToRemote,
  restoreVersion,
  tidyMergedStrays,
  UserGitError,
} from './user-git'
import { checkpointChanges, checkpointFileDiff } from './safety-git/changes'
import {
  projectPathForWindow,
  removeSessionFromWindow,
  setProjectPath,
  windowForProject,
} from './window-registry'
import { loadAppState, loadArchivedSessions, noteProjectOpened, saveArchivedSessions } from './session-store'
import {
  loadRecentModels,
  addRecentModel,
  loadSettings,
  updateSettings,
  resetSettings,
  loadScratchRetentionDays,
} from './settings'
import {
  initRemoteControl,
  registerRemoteIpcHandlers,
  remoteStatusWatchHooks,
  disposeRemoteControl,
} from './remote-control'
import { staticPreviewUrl, startDevServer, showStaticPreview } from './preview'
import { saveScratchImage, listScratchImages } from './scratch'
import { readDocMeta, writeDocMeta } from './docmeta'
import {
  listGuardrails,
  principleMemberKeys,
  removeGuardrailItem,
  saveGuardrail,
  saveItemBody,
  setRuleOverride,
} from './guardrails'
import { readOverrides, setGuardrailsDisabled } from './guardrails-config'
import { activateSkill, deactivateSkill, listSkillState } from './engine/skills-catalog'
import { voiceController } from './voice'
import { playwrightStatus, enablePlaywright } from './playwright'
import { getRuntimeStatus, installRuntime, isInstalling } from './runtime/provision'
import {
  detectAuthNow,
  startSubscriptionLogin,
  submitAuthCode,
  cancelSubscriptionLogin,
} from './auth'
import { startCodexLogin, cancelCodexLogin } from './engine/codex-auth'
import { hasApiKey, setApiKey, clearApiKey } from './api-key'
import { reconcileCodexAuth } from './engine/codex-home'
import { log } from './logger'

let engineSessions: EngineSessionManager | null = null

/**
 * Resolve the caller window's project root from the registry. Main owns this — the renderer never
 * names a cwd, so it can't read or write outside its own window's project (one-project-per-window).
 * Throws (rejecting the invoke) for a ProjectHome window with no project picked yet.
 */
function rootForSender(sender: WebContents): string {
  const win = BrowserWindow.fromWebContents(sender)
  const path = win ? projectPathForWindow(win.id) : undefined
  if (!path) throw new Error('no project open in this window')
  return path
}

/** The live session manager — created at IPC registration, drained on quit. */
export function getEngineSessions(): EngineSessionManager {
  if (!engineSessions) throw new Error('IPC handlers not registered')
  return engineSessions
}

/** Tear down all live sessions on shutdown; safe to call before registration. Also stops the remote
 *  LAN server + cloud relay (their connections must not outlive the app). */
export async function disposeEngineSessions(): Promise<void> {
  await disposeRemoteControl()
  await engineSessions?.disposeAll()
}

/**
 * Register the typed IPC handlers. Every payload is validated with Zod at this
 * boundary so the renderer can never push an unchecked shape into main, and the
 * main process can never return one the renderer didn't expect.
 */
export function registerIpcHandlers(): void {
  // resourcesPath is our bundled engine only when packaged; undefined in dev.
  engineSessions = new EngineSessionManager(app.isPackaged ? process.resourcesPath : undefined)

  // The phone-control tier (LAN server + cloud relay + pairing) — one seam, see remote-control.ts.
  initRemoteControl(engineSessions)

  // Provider-outage watch: pill broadcasts to every window; the remote legs (server-side watch, phone
  // push) come from the seam and are inert when phone control is absent or the cloud flag is off.
  setStatusWatchHooks({
    broadcast: (e) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.providerStatus, e)
    },
    ...remoteStatusWatchHooks(),
  })
  ipcMain.handle(IpcChannels.providerStatusGet, () => currentProviderStatus())

  ipcMain.handle(IpcChannels.getAppInfo, () =>
    AppInfoSchema.parse({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    }),
  )

  ipcMain.handle(IpcChannels.updateGetState, () => getUpdateStatus())
  ipcMain.handle(IpcChannels.updateCheckNow, () => checkForUpdatesNow())
  ipcMain.handle(IpcChannels.updateQuitAndInstall, () => quitAndInstallUpdate())
  ipcMain.handle(IpcChannels.updateWhatsNew, () => getWhatsNew())

  ipcMain.handle(IpcChannels.feedbackSubmit, (_event, rawArgs: unknown) =>
    submitFeedback(FeedbackRequestSchema.parse(rawArgs)),
  )

  ipcMain.handle(IpcChannels.echo, (_event, rawArgs: unknown) => {
    const { message } = EchoRequestSchema.parse(rawArgs)
    return EchoResponseSchema.parse({ reply: message })
  })

  ipcMain.handle(IpcChannels.probeEngine, async () =>
    // resourcesPath is our bundled engine only when packaged; undefined in dev.
    EngineProbeSchema.parse(await probeEngine(app.isPackaged ? process.resourcesPath : undefined)),
  )

  ipcMain.handle(IpcChannels.startSession, async (event, rawArgs: unknown) => {
    const args = StartSessionRequestSchema.parse(rawArgs)
    // Pass the owning window so start() registers ownership + resolves the project cwd BEFORE spawn
    // (so the first event routes correctly and a fresh session runs in this window's project).
    const ownerWindowId = BrowserWindow.fromWebContents(event.sender)?.id
    return StartSessionResponseSchema.parse(await getEngineSessions().start({ ...args, ownerWindowId }))
  })

  ipcMain.handle(IpcChannels.sendTurn, async (_event, rawArgs: unknown) => {
    const { sessionId, text, images } = SendTurnRequestSchema.parse(rawArgs)
    // Await: the turn-boundary safety checkpoint must land before the turn reaches the engine.
    await getEngineSessions().sendTurn(sessionId, text, images)
    trackFirstTurn()
  })

  ipcMain.handle(IpcChannels.interruptSession, (_event, rawArgs: unknown) => {
    const { sessionId } = SessionRefSchema.parse(rawArgs)
    getEngineSessions().interrupt(sessionId)
  })

  ipcMain.handle(IpcChannels.askAside, (_event, rawArgs: unknown) => {
    const { sessionId, asideId, question } = AskAsideRequestSchema.parse(rawArgs)
    getEngineSessions().askSideQuestion(sessionId, asideId, question)
  })

  ipcMain.handle(IpcChannels.cancelAside, (_event, rawArgs: unknown) => {
    const { sessionId, asideId } = CancelAsideRequestSchema.parse(rawArgs)
    getEngineSessions().cancelSideQuestion(sessionId, asideId)
  })

  ipcMain.handle(IpcChannels.disposeSession, async (_event, rawArgs: unknown) => {
    const { sessionId } = SessionRefSchema.parse(rawArgs)
    removeSessionFromWindow(sessionId)
    await getEngineSessions().dispose(sessionId)
  })

  // Per-project persistence: load on boot (invoke), save debounced (send, fire-and-forget). Both
  // resolve the project from the CALLING window — a ProjectHome window with no project loads nothing
  // and silently drops saves (rootForSender throws → caught here, persistence isn't a crash vector).
  ipcMain.handle(IpcChannels.sessionsLoad, (event) => {
    try {
      return getEngineSessions().loadSessionsForProject(rootForSender(event.sender))
    } catch {
      return null
    }
  })

  // Adopt this window's project's live headless (phone-started) sessions: claim them for this window
  // (future events route here) and return each one's replayable history. Fails soft — a ProjectHome
  // window with no project (rootForSender throws) or no headless sessions returns an empty list.
  ipcMain.handle(IpcChannels.sessionsAdoptHeadless, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return []
    try {
      return AdoptedHeadlessListSchema.parse(
        getEngineSessions().adoptHeadlessForWindow(win.id, rootForSender(event.sender)),
      )
    } catch {
      return []
    }
  })

  ipcMain.on(IpcChannels.sessionsSave, (event, rawArgs: unknown) => {
    const parsed = PersistedSessionsSchema.safeParse(rawArgs)
    if (!parsed.success) return // bad shape dropped, never thrown (persistence isn't a crash vector)
    try {
      getEngineSessions().persistProjectSessions(rootForSender(event.sender), parsed.data)
    } catch {
      /* no project for this window yet — nothing to persist */
    }
  })

  // Archived sessions: the cold per-project file (see session-store.ts) — read on boot, written only
  // when the archived list changes. Same fail-soft posture as the hot save above.
  ipcMain.handle(IpcChannels.archivedLoad, (event) => {
    try {
      return loadArchivedSessions(rootForSender(event.sender))
    } catch {
      return []
    }
  })

  ipcMain.on(IpcChannels.archivedSave, (event, rawArgs: unknown) => {
    const parsed = z.array(ArchivedSessionSchema).safeParse(rawArgs)
    if (!parsed.success) return
    try {
      saveArchivedSessions(rootForSender(event.sender), parsed.data)
    } catch {
      /* no project for this window yet */
    }
  })

  // Recovery is project-scoped (Settings → Recovery): root from the window, like the fs/git handlers.
  // The session-scoped checkpoint methods stay in the manager for the agent-driven (MCP) recovery.
  ipcMain.handle(IpcChannels.safetyList, async (event) =>
    CheckpointListSchema.parse(await getEngineSessions().getProjectCheckpoints(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.safetyRestore, async (event, rawArgs: unknown) => {
    const { checkpointId } = SafetyRestoreRequestSchema.parse(rawArgs)
    const restored = await getEngineSessions().restoreProjectCheckpoint(rootForSender(event.sender), checkpointId)
    return CheckpointSchema.parse(restored)
  })

  ipcMain.handle(IpcChannels.safetyChanges, async (event, rawArgs: unknown) => {
    const { checkpointId } = SafetyChangesRequestSchema.parse(rawArgs)
    return SafetyChangesResultSchema.parse(await checkpointChanges(rootForSender(event.sender), checkpointId))
  })

  ipcMain.handle(IpcChannels.safetyFileDiff, async (event, rawArgs: unknown) => {
    const { checkpointId, path } = SafetyFileDiffRequestSchema.parse(rawArgs)
    return SafetyFileDiffResultSchema.parse(
      await checkpointFileDiff(rootForSender(event.sender), checkpointId, path),
    )
  })

  // Approval gate: the "Ask me" answer + the mode setting.
  ipcMain.handle(IpcChannels.approvalResolve, (_event, rawArgs: unknown) => {
    const { requestId, decision } = ApprovalResolveSchema.parse(rawArgs)
    getEngineSessions().resolveApproval(requestId, decision)
  })

  ipcMain.handle(IpcChannels.approvalSetMode, (_event, rawArgs: unknown) => {
    const { sessionId, mode } = SetApprovalModeSchema.parse(rawArgs)
    getEngineSessions().setSessionApprovalMode(sessionId, mode)
  })

  ipcMain.handle(IpcChannels.approvalGetMode, () =>
    ApprovalModeSchema.parse(getEngineSessions().getApprovalMode()),
  )

  // Model/effort pick-time push — records intent + broadcasts ModelEffortChanged (no respawn; the
  // renderer reattaches lazily on its next turn). Mirrors approvalSetMode.
  ipcMain.handle(IpcChannels.modelEffortSet, (_event, rawArgs: unknown) => {
    const { sessionId, model, effort, engineId } = SetModelEffortSchema.parse(rawArgs)
    getEngineSessions().setSessionModelEffort(sessionId, { model, effort, engineId })
  })

  // Model picker — recently-used model ids (the substitute for an enumerable model list).
  ipcMain.handle(IpcChannels.modelsGetRecent, () => loadRecentModels())
  ipcMain.handle(IpcChannels.modelsAddRecent, (_event, rawArgs: unknown) => {
    const { model } = AddRecentModelSchema.parse(rawArgs)
    return addRecentModel(model)
  })
  ipcMain.handle(IpcChannels.codexModels, () => getEngineSessions().codexModels())
  ipcMain.handle(IpcChannels.codexAuthStatus, () => getEngineSessions().codexAuthStatus())
  ipcMain.handle(IpcChannels.codexLoginStart, () =>
    AuthLoginStartResultSchema.parse(startCodexLogin()),
  )
  ipcMain.handle(IpcChannels.codexLoginCancel, () => {
    cancelCodexLogin('cancelled')
  })

  // App preferences (the Settings pane). get returns the full settings; set merges a partial, persists
  // it, and — for a default-mode change — also updates the live gate so new sessions in already-open
  // windows start in the new posture without a restart. Returns the full, re-clamped settings.
  ipcMain.handle(IpcChannels.settingsGet, () => KodaSettingsSchema.parse(loadSettings()))
  ipcMain.handle(IpcChannels.settingsSet, (_event, rawArgs: unknown) => {
    const patch = KodaSettingsPatchSchema.parse(rawArgs)
    // Activation-funnel signal: fire once when onboarding finishes. Order matters — updateSettings
    // persists hasOnboarded:true first, so track()'s hasOnboarded send-gate is already open.
    const justOnboarded = patch.hasOnboarded === true && !loadSettings().hasOnboarded
    const next = updateSettings(patch)
    if (justOnboarded) track('onboarding_completed', {})
    if (patch.defaultApprovalMode !== undefined)
      getEngineSessions().setDefaultApprovalMode(next.defaultApprovalMode)
    if (patch.previewAutoStart !== undefined)
      getEngineSessions().setPreviewAutoStart(next.previewAutoStart)
    // Settings are app-global — fan the new values out to every window so per-window live gates (the
    // notification pref, each renderer's default posture) re-sync without a restart.
    const settings = KodaSettingsSchema.parse(next)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.uiSettingsChanged, settings)
    return settings
  })
  ipcMain.handle(IpcChannels.settingsReset, () => {
    const settings = KodaSettingsSchema.parse(resetSettings())
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.uiSettingsChanged, settings)
    return settings
  })

  // Preview surface: the calling window's static-preview entry URL (the manual "Preview" button opens
  // it). Null for a ProjectHome window with no project — OR when the target file doesn't exist, so the
  // button can hide itself instead of opening onto the blank "nothing to preview" placeholder (a static
  // index.html preview is meaningless for a framework project that has no served root index.html). The
  // dev-server (Rung 2) path pushes its URL via `preview:show` instead — started by a capability/restart.
  ipcMain.handle(IpcChannels.previewStaticUrl, (event, rawArgs?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    // Optional: an absolute file path (the active editor tab). Map it to a project-relative entry so
    // Preview shows what the user is looking at — not just the project-root index.html. Falls back to
    // index.html on a non-string, an out-of-project path, or a missing project root.
    let rel: string | undefined
    if (typeof rawArgs === 'string') {
      try {
        const r = relative(rootForSender(event.sender), rawArgs)
        if (r && !r.startsWith('..') && !isAbsolute(r)) rel = r
      } catch {
        /* no project root → fall back to index.html */
      }
    }
    const url = staticPreviewUrl(win.id, rel)
    if (!url) return null
    // Existence gate: only offer a static preview for a file that's actually there. containedReal
    // realpath-throws on an escape OR a missing file — the same resolution the protocol handler does,
    // so this returns null in exactly the cases the iframe would 404 to the blank placeholder.
    try {
      containedReal(rootForSender(event.sender), rel ?? 'index.html')
    } catch {
      return null
    }
    return url
  })

  // Re-run a session's last preview (the "Restart preview" button). Window-direct like previewStaticUrl,
  // NOT the agent's gated capability: the user is replaying a command the agent already ran in front of
  // them, on their own window's project. Resolves with the served URL (main also pushes preview:show so
  // the surface reopens); rejects if the dev server never comes up or the static file is gone.
  ipcMain.handle(IpcChannels.previewRestart, async (event, rawArgs: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('no window for this preview')
    const { sessionId, restart } = PreviewRestartRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return restart.kind === 'dev'
      ? startDevServer(win.id, root, restart.command, sessionId, restart.cwd)
      : showStaticPreview(win.id, root, restart.relPath, sessionId)
  })

  // Persist a pasted/dropped image to the window project's `.koda/scratch/` folder. Root is resolved in
  // main (renderer never names a cwd); retention is read live so a settings change applies next save.
  ipcMain.handle(IpcChannels.scratchSave, async (event, rawArgs: unknown) => {
    const { mediaType, dataBase64 } = ScratchSaveRequestSchema.parse(rawArgs)
    const path = await saveScratchImage(
      rootForSender(event.sender),
      mediaType,
      dataBase64,
      loadScratchRetentionDays(),
    )
    return ScratchSaveResultSchema.parse({ path })
  })

  // Page through the window project's recent scratch images (newest first) for the Recent images strip.
  // Root is resolved in main; a no-project window returns an empty page.
  ipcMain.handle(IpcChannels.scratchList, async (event, rawArgs: unknown) => {
    const { offset, limit } = ScratchListRequestSchema.parse(rawArgs)
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      return ScratchListResultSchema.parse({ images: [], total: 0 })
    }
    return ScratchListResultSchema.parse(await listScratchImages(root, offset, limit))
  })

  // Doc presentation sidecar (`.koda/docmeta/`) — table column widths and the like. The renderer sends
  // the doc's absolute path; we map it to a project-relative key (rejecting out-of-project) and store
  // beside the file. Both directions fail-soft: a no-project window, an out-of-project doc, or any read
  // error yields empty meta (the doc just opens auto-width); a write error is swallowed in writeDocMeta.
  const docMetaKey = (sender: WebContents, absPath: string): { root: string; rel: string } | null => {
    let root: string
    try {
      root = rootForSender(sender)
    } catch {
      return null // no project for this window
    }
    const rel = relative(root, absPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null // outside the project
    return { root, rel }
  }

  ipcMain.handle(IpcChannels.docmetaGet, async (event, rawArgs: unknown) => {
    const { path } = DocMetaGetRequestSchema.parse(rawArgs)
    const key = docMetaKey(event.sender, path)
    return DocMetaSchema.parse(key ? await readDocMeta(key.root, key.rel) : {})
  })

  ipcMain.handle(IpcChannels.docmetaSet, async (event, rawArgs: unknown) => {
    const { path, meta } = DocMetaSetRequestSchema.parse(rawArgs)
    const key = docMetaKey(event.sender, path)
    if (key) await writeDocMeta(key.root, key.rel, meta)
  })

  // How heavy this project's always-injected memory pair is (status-bar tidy pill + Settings →
  // Memory). A no-project window has no memory to weigh.
  ipcMain.handle(IpcChannels.memoryWeight, (event) => {
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      return MemoryWeightSchema.parse({ present: false, chars: 0, heavy: false })
    }
    return MemoryWeightSchema.parse(projectMemoryWeight(root))
  })

  // The behavior layer (Settings → Guardrails): the curated Koda pack + this project's own
  // rules/skills/subagents. Read-only. A no-project window (ProjectHome) still gets the pack.
  ipcMain.handle(IpcChannels.guardrailsList, (event) => {
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      root = ''
    }
    return GuardrailsLayerSchema.parse(
      listGuardrails(root, app.isPackaged ? process.resourcesPath : undefined),
    )
  })

  // Save a typed/pasted rule/skill/subagent straight to this project (no agent). saveGuardrail
  // validates FIRST, then runs the checkpoint thunk (so the new file is recoverable like an editor
  // save) right before writing — a rejected paste (no name, name clash) throws before any checkpoint.
  ipcMain.handle(IpcChannels.guardrailsSave, async (event, rawArgs: unknown) => {
    const req = GuardrailSaveRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    const res = await saveGuardrail(root, req, () =>
      getEngineSessions().checkpointProjectEdit(root, `add ${req.kind}`),
    )
    return GuardrailSaveResultSchema.parse(res)
  })

  // Switch a bundled Koda default off/on for this project. Persists to .koda/guardrails.json; the
  // engine reads the disabled set at the next session spawn. No checkpoint — a toggle is trivially
  // reversible (flip it back), and it's config, not the agent editing the user's content.
  ipcMain.handle(IpcChannels.guardrailsSetEnabled, (event, rawArgs: unknown) => {
    const { key, enabled } = GuardrailSetEnabledRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    // A pristine principle's toggle fans out to its member rule ids; a CUSTOMIZED principle (has an
    // override) toggles the override itself via its principle key; a skill/subagent key passes through.
    const overridden = key.startsWith('principle:') && key.slice('principle:'.length) in readOverrides(root)
    const keys = overridden ? [key] : principleMemberKeys(key, app.isPackaged ? process.resourcesPath : undefined)
    setGuardrailsDisabled(root, keys, !enabled)
  })

  // Save an edited skill/subagent body into this project (forks a Koda default; overwrites a project
  // item). Checkpointed before the write (like saveGuardrail). Returns the path.
  ipcMain.handle(IpcChannels.guardrailsSaveItemBody, async (event, rawArgs: unknown) => {
    const { kind, name, content } = GuardrailSaveItemBodyRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    const res = await saveItemBody(root, { kind, name }, content, () =>
      getEngineSessions().checkpointProjectEdit(root, `edit ${kind} ${name}`),
    )
    return GuardrailSaveResultSchema.parse(res)
  })

  // Remove a project skill/subagent; if it forked a Koda default, the default reappears. Checkpointed.
  ipcMain.handle(IpcChannels.guardrailsRemoveItem, async (event, rawArgs: unknown) => {
    const ref = GuardrailItemRefSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await removeGuardrailItem(root, ref, () =>
      getEngineSessions().checkpointProjectEdit(root, `remove ${ref.kind} ${ref.name}`),
    )
  })

  // Edit a Koda rule principle's wording for this project (or restore it with text:null). Checkpoint
  // first (recoverable), then fork the override + drop the bundled member rules. Applies next session.
  ipcMain.handle(IpcChannels.guardrailsSetRuleOverride, async (event, rawArgs: unknown) => {
    const { principleId, text } = GuardrailRuleOverrideRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await getEngineSessions().checkpointProjectEdit(root, `edit rule ${principleId}`)
    setRuleOverride(root, app.isPackaged ? process.resourcesPath : undefined, principleId, text)
  })

  // The skills gallery (Settings → Skills): the bundled Apache-2.0 catalog with each skill's active
  // scope(s). Read-only. A no-project window (ProjectHome) still gets the catalog + global state.
  ipcMain.handle(IpcChannels.skillsList, (event) => {
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      root = ''
    }
    return SkillCatalogSchema.parse(
      listSkillState({
        userData: app.getPath('userData'),
        projectRoot: root || undefined,
        resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      }),
    )
  })

  // Turn a catalog skill on/off at a scope. 'global' writes to the Koda-managed plugin dir (userData,
  // no project needed, no checkpoint — outside any project). 'project' copies into this project's
  // .claude/skills, checkpointed first (recoverable). Effective on the next session (read at spawn).
  ipcMain.handle(IpcChannels.skillsSetActive, async (event, rawArgs: unknown) => {
    const { id, scope, active } = SkillSetActiveRequestSchema.parse(rawArgs)
    const resourcesPath = app.isPackaged ? process.resourcesPath : undefined
    const userData = app.getPath('userData')
    if (scope === 'global') {
      const opts = { id, scope, userData, resourcesPath } as const
      await (active ? activateSkill(opts) : deactivateSkill(opts))
      return
    }
    const root = rootForSender(event.sender)
    const opts = {
      id,
      scope,
      userData,
      projectRoot: root,
      resourcesPath,
      beforeWrite: () =>
        getEngineSessions().checkpointProjectEdit(root, `${active ? 'add' : 'remove'} skill ${id}`),
    } as const
    await (active ? activateSkill(opts) : deactivateSkill(opts))
  })

  // Voice input (on-device dictation). start/stop resolve the sender's window; the controller is
  // fail-soft (never throws — a missing backend returns started:false). Transcript events stream back
  // over `voice:event` from the controller. Killed with the window in main/index.ts on close.
  ipcMain.handle(IpcChannels.voiceStart, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return VoiceStartResponseSchema.parse({ started: false, reason: 'unavailable' })
    return VoiceStartResponseSchema.parse(voiceController.startVoice(win))
  })

  ipcMain.handle(IpcChannels.voiceStop, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) voiceController.stopVoice(win)
  })

  // Optional Playwright browser-testing. status returns the current install state; enable kicks the
  // background Chromium download (does NOT block on it — progress streams over `playwright:progress`)
  // and returns the now-'installing' status. The toggle persists via settings:set; this just drives
  // the download. enablePlaywright() never rejects (fail-soft), so neither handler can throw.
  ipcMain.handle(IpcChannels.playwrightStatus, () => PlaywrightStatusSchema.parse(playwrightStatus()))
  ipcMain.handle(IpcChannels.playwrightEnable, () => {
    void enablePlaywright()
    return PlaywrightStatusSchema.parse(playwrightStatus())
  })

  // On-demand runtime provisioning (Node / Python), keyed by runtime id. status is a cheap sync read;
  // install is fire-and-forget (progress streams over `runtime:progress`), so the handler returns
  // immediately. Never throws.
  ipcMain.handle(IpcChannels.runtimeStatus, (_e, runtime) =>
    RuntimeStatusSchema.parse(getRuntimeStatus(RuntimeIdSchema.parse(runtime))),
  )

  ipcMain.handle(IpcChannels.runtimeInstall, (_e, runtime) => {
    const id = RuntimeIdSchema.parse(runtime)
    if (isInstalling(id)) return RuntimeInstallResultSchema.parse({ ok: false, reason: 'already installing' })
    void installRuntime(id) // self-contained: all outcomes (incl. errors) emit via runtime:progress
    return RuntimeInstallResultSchema.parse({ ok: true })
  })

  // Onboarding sign-in. detect is read-only (wrapped to {ok:false} so a missing binary surfaces in the
  // wizard, never an unhandled reject); loginStart/submitCode/cancel drive the state machine, which
  // streams every outcome over `auth:progress`, so these return immediately and never throw.
  ipcMain.handle(IpcChannels.authDetect, async () => {
    try {
      return AuthDetectResultSchema.parse({ ok: true, verdict: await detectAuthNow() })
    } catch (err) {
      return AuthDetectResultSchema.parse({
        ok: false,
        error: err instanceof Error ? err.message : 'Could not read sign-in status',
      })
    }
  })
  ipcMain.handle(IpcChannels.authLoginStart, () =>
    AuthLoginStartResultSchema.parse(startSubscriptionLogin()),
  )
  ipcMain.handle(IpcChannels.authSubmitCode, (_event, rawCode: unknown) => {
    submitAuthCode(AuthCodeSchema.parse(rawCode))
  })
  ipcMain.handle(IpcChannels.authLoginCancel, () => {
    cancelSubscriptionLogin('cancelled')
  })

  // Billing mode (Settings → Account). The pasted API key is stored encrypted (api-key.ts) and never
  // crosses back to the renderer — the UI only learns whether one EXISTS + the engine's mode-aware
  // verdict. `billingState()` is the shared shape both reads and writes return.
  // Fan the (possibly mode-changed) settings out to every window so the chassis status-bar chip flips
  // between the plan gauges and the API-spend chip live — same broadcast settingsSet uses. The billing
  // handlers persist via updateSettings directly (they return billing state, not settings), so they
  // must trigger this themselves.
  const broadcastSettings = (): void => {
    const settings = KodaSettingsSchema.parse(loadSettings())
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.uiSettingsChanged, settings)
  }

  const billingState = async () => {
    const mode = loadSettings().billingMode
    // The verdict reports the user's underlying SUBSCRIPTION sign-in (Keychain OAuth + any STRAY env key),
    // read clean — never inject the stored key. Injecting it would mask a real subscription login whenever
    // API mode is active, so the Subscription panel would falsely read "Sign in". Whether the API key is
    // what bills RIGHT NOW is a separate axis, carried by `apiActive`. Fail-soft to logged-out.
    let verdict
    try {
      verdict = await detectAuthNow({})
    } catch {
      verdict = { mode: 'logged-out' as const, apiKeyTrap: false, email: null, plan: null, detail: 'Could not read sign-in status.' }
    }
    return BillingStateSchema.parse({
      mode,
      hasKey: hasApiKey(),
      apiActive: getEngineSessions().apiActive(),
      verdict,
      hasCodexKey: hasApiKey('codex'),
      codexMode: loadSettings().codexBillingMode,
      codexApiActive: getEngineSessions().apiActive('codex'),
    })
  }

  ipcMain.handle(IpcChannels.billingGetState, () => billingState())

  ipcMain.handle(IpcChannels.usageGetHistory, () => loadUsageHistory())

  // 'auto' mode: the renderer confirmed continuing on the API key after a plan-limit rejection. Mark the
  // key effective until the window resets; the renderer drops live sessions so they reattach on API.
  ipcMain.handle(IpcChannels.billingActivateFallback, async (_event, rawArgs: unknown) => {
    const { until } = ApiFallbackRequestSchema.parse(rawArgs)
    // Cap how far out the fallback can run — this is the one value that prolongs real-money billing, so a
    // bogus far-future resetsAt can't keep the API key effective indefinitely (weekly windows are ≤7d).
    const capped = Math.min(until, Date.now() / 1000 + 8 * 86_400)
    getEngineSessions().activateApiFallback(capped)
    broadcastSettings() // chip re-evaluates apiActive
    return billingState()
  })

  ipcMain.handle(IpcChannels.billingSaveApiKey, async (_event, rawKey: unknown) => {
    const parsed = ApiKeySchema.safeParse(rawKey)
    if (!parsed.success) return BillingSaveResultSchema.parse({ ok: false, error: 'Enter your API key.' })
    const key = parsed.data
    if (!key.startsWith('sk-ant-'))
      return BillingSaveResultSchema.parse({ ok: false, error: 'That doesn’t look like an Anthropic API key (it should start with sk-ant-).' })
    // Smoke-check: does the engine pick the key up as its credential source? `auth status` reports the
    // source without spending a token, so a key the engine can't read fails here before we store it.
    // (It can't prove the key is VALID — that surfaces on the first turn — but it catches a dud paste.)
    try {
      const verdict = await detectAuthNow({ apiKey: key })
      if (verdict.mode !== 'api-key')
        return BillingSaveResultSchema.parse({ ok: false, error: 'The engine didn’t accept that key. Double-check it and try again.' })
    } catch {
      return BillingSaveResultSchema.parse({ ok: false, error: 'Couldn’t verify the key. Check your connection and try again.' })
    }
    if (!setApiKey('claude', key))
      return BillingSaveResultSchema.parse({ ok: false, error: 'Couldn’t store the key securely on this machine.' })
    // Default to the SAFE mode: subscription-first, fall back to the key only when the plan limit is hit
    // (after a confirm). The user can dial up to always-API in Settings. Saving a key shouldn't silently
    // start spending real money.
    updateSettings({ billingMode: 'auto' })
    broadcastSettings()
    return BillingSaveResultSchema.parse({ ok: true, state: await billingState() })
  })

  ipcMain.handle(IpcChannels.billingRemoveApiKey, async () => {
    clearApiKey()
    updateSettings({ billingMode: 'subscription' })
    broadcastSettings()
    return billingState()
  })

  // OpenAI/Codex BYO key. Unlike Claude (env-var credential), the key must be WRITTEN into Codex's isolated
  // home; reconcileCodexAuth does that here so the OpenAI sign-in status reflects it immediately, and every
  // future session reconciles too. Saving switches Codex to API billing (user-visible in Settings → OpenAI).
  const codexResourcesPath = (): string | undefined =>
    app.isPackaged ? process.resourcesPath : undefined
  ipcMain.handle(IpcChannels.billingSaveCodexApiKey, async (_event, rawKey: unknown) => {
    const parsed = ApiKeySchema.safeParse(rawKey)
    if (!parsed.success) return BillingSaveResultSchema.parse({ ok: false, error: 'Enter your API key.' })
    const key = parsed.data
    if (!key.startsWith('sk-'))
      return BillingSaveResultSchema.parse({ ok: false, error: 'That doesn’t look like an OpenAI API key (it should start with sk-).' })
    if (!setApiKey('codex', key))
      return BillingSaveResultSchema.parse({ ok: false, error: 'Couldn’t store the key securely on this machine.' })
    // Write the api-key login into the isolated home now (Codex ignores the env key). If that fails, roll the
    // stored key back so we don't leave the user in "API mode" with a key the engine never actually signed in
    // with (which would silently bill their plan instead). Only commit the mode switch once auth is in place.
    const ok = await reconcileCodexAuth({ resourcesPath: codexResourcesPath(), apiKey: key })
    if (!ok) {
      clearApiKey('codex')
      return BillingSaveResultSchema.parse({ ok: false, error: 'The engine couldn’t sign in with that key. Check it and try again.' })
    }
    updateSettings({ codexBillingMode: 'api' })
    broadcastSettings()
    return BillingSaveResultSchema.parse({ ok: true, state: await billingState() })
  })

  ipcMain.handle(IpcChannels.billingRemoveCodexApiKey, async () => {
    clearApiKey('codex')
    updateSettings({ codexBillingMode: 'subscription' })
    // Restore the ChatGPT login (backed up when we switched to the key).
    await reconcileCodexAuth({ resourcesPath: codexResourcesPath(), apiKey: null })
    broadcastSettings()
    return billingState()
  })

  // ── Remote Control + cloud relay (Settings → Remote) — handlers live with the seam ──
  registerRemoteIpcHandlers(broadcastSettings)

  // Local-assist: clean session title (on-device model, deterministic fallback). assistTitle()
  // never rejects — it always resolves to a usable string — so this handler can't throw.
  ipcMain.handle(IpcChannels.assistTitle, async (_event, rawArgs: unknown) => {
    const { text } = AssistTitleRequestSchema.parse(rawArgs)
    return AssistTitleResponseSchema.parse({ title: await assistTitle(text) })
  })

  // Project Files browser — read-only, contained to the project root in fs-browse. A bad/escaping
  // path rejects the invoke (the renderer surfaces it); main never reads outside the project.
  ipcMain.handle(IpcChannels.fsReadDir, async (event, rawArgs: unknown) => {
    const { path } = ReadDirRequestSchema.parse(rawArgs)
    return ReadDirResultSchema.parse(await browseDir(rootForSender(event.sender), path))
  })

  // The doc-first sidebar's flat Documents list. Read-only + contained.
  ipcMain.handle(IpcChannels.fsListDocs, async (event) => {
    const root = rootForSender(event.sender)
    const docs = await listProjectDocs(root)
    return ListDocsResultSchema.parse({ root, docs })
  })

  ipcMain.handle(IpcChannels.fsReadFile, async (event, rawArgs: unknown) => {
    const { path } = ReadFileRequestSchema.parse(rawArgs)
    return ReadFileResultSchema.parse(await readProjectFile(rootForSender(event.sender), path))
  })

  // Watch/unwatch an open file so its editor re-reads on an on-disk change (see file-watch.ts). send,
  // not invoke — fire-and-forget; a window with no project (rootForSender throws) simply watches nothing.
  ipcMain.on(IpcChannels.fsWatchFile, (event, rawArgs: unknown) => {
    try {
      const { path } = ReadFileRequestSchema.parse(rawArgs)
      watchProjectFile(event.sender, rootForSender(event.sender), path)
    } catch {
      /* no project / bad path — nothing to watch */
    }
  })
  ipcMain.on(IpcChannels.fsUnwatchFile, (event, rawArgs: unknown) => {
    try {
      const { path } = ReadFileRequestSchema.parse(rawArgs)
      unwatchProjectFile(event.sender, path)
    } catch {
      /* nothing was being watched */
    }
  })

  // Watch/unwatch the project's Documents/ folder so the doc-first sidebar refreshes when the agent (or
  // any external tool) adds/moves/removes docs, not just on UI-made changes (see docs-watch.ts). send,
  // fire-and-forget — a window with no project (rootForSender throws) simply watches nothing.
  ipcMain.on(IpcChannels.fsWatchDocs, (event) => {
    try {
      watchProjectDocs(event.sender, rootForSender(event.sender))
    } catch {
      /* no project — nothing to watch */
    }
  })
  ipcMain.on(IpcChannels.fsUnwatchDocs, (event) => {
    unwatchProjectDocs(event.sender)
  })

  // Live-edits diff: pinned pre-turn baseline vs current. Read-only, contained like the reads above.
  // The baseline SHA is resolved in main from the session (the renderer never names a git ref).
  ipcMain.handle(IpcChannels.fsDiffFile, async (event, rawArgs: unknown) => {
    const { path, sessionId } = DiffFileRequestSchema.parse(rawArgs)
    const sessions = getEngineSessions()
    // Resolve against the SESSION's cwd — its edits + diff baseline live there, which can differ from
    // the sender window's project root (a background session, or one launched in another folder). No
    // sessionId (manual File→Diff) falls back to the window root.
    const root = (sessionId ? sessions.getSessionCwd(sessionId) : undefined) ?? rootForSender(event.sender)
    const baseSha = sessionId ? sessions.getDiffBaseline(sessionId) : undefined
    return DiffFileResultSchema.parse(await diffProjectFile(root, path, baseSha))
  })

  // Editor save: checkpoint the pre-edit project tree FIRST (so the edit is recoverable like an
  // engine write), THEN write. The checkpoint is fail-soft inside the manager — a safety-git hiccup
  // is logged, never blocks the save. Root is resolved in main; the renderer never names the cwd.
  ipcMain.handle(IpcChannels.fsWriteFile, async (event, rawArgs: unknown) => {
    const { path, content } = WriteFileRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await getEngineSessions().checkpointProjectEdit(root, `edit to ${basename(path)}`)
    return WriteFileResultSchema.parse({ path: await writeProjectFile(root, path, content) })
  })

  // Create a new empty document at the project root and return its path (the renderer opens it).
  ipcMain.handle(IpcChannels.fsCreateFile, async (event, rawArgs: unknown) => {
    const { name } = CreateFileRequestSchema.parse(rawArgs)
    return CreateFileResultSchema.parse({ path: await createProjectFile(rootForSender(event.sender), name) })
  })

  // Rename/move a file/folder. Checkpoint the pre-move tree FIRST (so it's recoverable like an engine
  // edit), THEN rename. Returns the new path; the renderer rebases any open tab keyed by the old one.
  ipcMain.handle(IpcChannels.fsRenamePath, async (event, rawArgs: unknown) => {
    const { from, to } = RenamePathRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await getEngineSessions().checkpointProjectEdit(root, `rename ${basename(from)}`)
    return RenamePathResultSchema.parse({ path: await renameProjectPath(root, from, to) })
  })

  // Delete a file/folder. Checkpoint first so the delete is undoable from the recovery timeline.
  ipcMain.handle(IpcChannels.fsDeletePath, async (event, rawArgs: unknown) => {
    const { path } = DeletePathRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await getEngineSessions().checkpointProjectEdit(root, `delete ${basename(path)}`)
    await deleteProjectPath(root, path)
  })

  // Create a new folder (at the root, or inside `parent`) and return its path. No checkpoint.
  ipcMain.handle(IpcChannels.fsCreateDir, async (event, rawArgs: unknown) => {
    const { name, parent } = CreateDirRequestSchema.parse(rawArgs)
    return CreateDirResultSchema.parse({ path: await createProjectDir(rootForSender(event.sender), name, parent) })
  })

  // Project-wide find (the Find overlay): fuzzy filename + substring content matches, scope-filtered,
  // contained + capped in the service. Read-only; root resolved per-window like the other fs reads.
  ipcMain.handle(IpcChannels.fsSearch, async (event, rawArgs: unknown) => {
    const { query, scope } = SearchRequestSchema.parse(rawArgs)
    return SearchResultSchema.parse(await searchProject(rootForSender(event.sender), query, scope))
  })

  // Project-wide replace: checkpoint the whole tree via safety-git FIRST (so the entire replace is one
  // undoable step from the recovery timeline), THEN rewrite occurrences. Contained + scoped in the service.
  ipcMain.handle(IpcChannels.fsReplaceAll, async (event, rawArgs: unknown) => {
    const { query, replacement, scope } = ReplaceRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    // A bulk replace touches many files at once, so unlike a single edit it must NOT proceed without an
    // undo point — the overlay promises "undo from the recovery timeline". Abort if the checkpoint failed.
    const checkpointed = await getEngineSessions().checkpointProjectEdit(root, `replace “${query}”`)
    if (!checkpointed) throw new Error('Could not create an undo checkpoint — replace cancelled')
    return ReplaceResultSchema.parse(await replaceInProject(root, query, replacement, scope))
  })

  // ── Source Control (user-git — the real `.git`) ──────────────────────────────
  // Read-only detect/status/log + the only mutations init/commit. Root per-window; the renderer
  // never names a path. detect/status/log fail soft to "not a repo" inside the service.
  ipcMain.handle(IpcChannels.gitDetect, async (event) =>
    GitRepoInfoSchema.parse(await detectRepo(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.gitStatus, async (event) =>
    GitStatusResultSchema.parse(await getStatus(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.gitGraph, async (event, rawArgs: unknown) => {
    const { limit } = GitGraphRequestSchema.parse(rawArgs)
    return GitCommitGraphResultSchema.parse(await getCommitGraph(rootForSender(event.sender), limit))
  })

  ipcMain.handle(IpcChannels.gitInit, async (event) =>
    GitInitResultSchema.parse(await initRepo(rootForSender(event.sender))),
  )

  // Commit returns a TAGGED result — a UserGitError (no identity, nothing to commit, …) becomes
  // { ok:false, code } the renderer can branch on, instead of an Electron-wrapped reject string.
  ipcMain.handle(IpcChannels.gitCommit, async (event, rawArgs: unknown) => {
    const { message } = GitCommitRequestSchema.parse(rawArgs)
    try {
      const { sha } = await commitAll(rootForSender(event.sender), message)
      return GitCommitResultSchema.parse({ ok: true, sha })
    } catch (err) {
      if (err instanceof UserGitError) {
        return GitCommitResultSchema.parse({ ok: false, code: err.code, message: err.message })
      }
      throw err // a non-UserGitError (e.g. no project open) is a real fault — let it reject
    }
  })

  // Per-session save: commit only the named paths (leaving a sibling session's dirty files alone).
  // Same tagged-result contract as gitCommit.
  ipcMain.handle(IpcChannels.gitCommitPaths, async (event, rawArgs: unknown) => {
    const { message, paths } = GitCommitPathsRequestSchema.parse(rawArgs)
    try {
      const { sha } = await commitPaths(rootForSender(event.sender), paths, message)
      return GitCommitResultSchema.parse({ ok: true, sha })
    } catch (err) {
      if (err instanceof UserGitError) {
        return GitCommitResultSchema.parse({ ok: false, code: err.code, message: err.message })
      }
      throw err
    }
  })

  // Reword the just-saved version (amend HEAD). Same tagged-result contract; `not_head` means the
  // target is no longer the latest, so we won't rewrite history.
  ipcMain.handle(IpcChannels.gitRenameHead, async (event, rawArgs: unknown) => {
    const { sha, message } = GitRenameHeadRequestSchema.parse(rawArgs)
    try {
      const res = await renameHead(rootForSender(event.sender), sha, message)
      return GitCommitResultSchema.parse({ ok: true, sha: res.sha })
    } catch (err) {
      if (err instanceof UserGitError) {
        return GitCommitResultSchema.parse({ ok: false, code: err.code, message: err.message })
      }
      throw err
    }
  })

  // Restore a past version's files as a new version on top. Same tagged-result contract; not_clean
  // (unsaved changes) and nothing_to_commit (files already match) get specific renderer copy.
  ipcMain.handle(IpcChannels.gitRestoreVersion, async (event, rawArgs: unknown) => {
    const { sha } = GitRestoreRequestSchema.parse(rawArgs)
    try {
      const res = await restoreVersion(rootForSender(event.sender), sha)
      return GitCommitResultSchema.parse({ ok: true, sha: res.sha })
    } catch (err) {
      if (err instanceof UserGitError) {
        return GitCommitResultSchema.parse({ ok: false, code: err.code, message: err.message })
      }
      throw err
    }
  })

  // Discard one file's change. It removes a new file / reverts an edit — destructive on content, so we
  // checkpoint the whole tree FIRST (an untracked file isn't in user-git otherwise) and REFUSE if that
  // undo point fails, like the bulk replace. Tagged result → calm per-failure copy in the renderer.
  ipcMain.handle(IpcChannels.gitDiscardFile, async (event, rawArgs: unknown) => {
    const { path } = GitDiscardFileRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    const checkpointed = await getEngineSessions().checkpointProjectEdit(root, `discard ${basename(path)}`)
    if (!checkpointed) {
      return GitDiscardResultSchema.parse({
        ok: false,
        code: 'no_checkpoint',
        message: 'Could not create an undo point — nothing was removed.',
      })
    }
    try {
      await discardFile(root, path)
      return GitDiscardResultSchema.parse({ ok: true })
    } catch (err) {
      const code = err instanceof UserGitError && err.code === 'not_a_repo' ? 'not_a_repo' : 'git_failed'
      return GitDiscardResultSchema.parse({ ok: false, code, message: String(err) })
    }
  })

  ipcMain.handle(IpcChannels.gitFileDiff, async (event, rawArgs: unknown) => {
    const { path, ref } = GitFileDiffRequestSchema.parse(rawArgs)
    return DiffFileResultSchema.parse(await gitFileDiff(rootForSender(event.sender), path, ref))
  })

  ipcMain.handle(IpcChannels.gitCommitChanges, async (event, rawArgs: unknown) => {
    const { sha } = GitCommitChangesRequestSchema.parse(rawArgs)
    return GitStatusResultSchema.parse(await commitChanges(rootForSender(event.sender), sha))
  })

  // Branch Review (focus an unmerged branch) + the manual discard. Read-only overview/diff; discard is
  // the one user-confirmed destructive op (the renderer gates it behind a confirm with honest copy).
  ipcMain.handle(IpcChannels.gitBranchOverview, async (event, rawArgs: unknown) => {
    const { branch } = GitBranchRequestSchema.parse(rawArgs)
    return GitBranchOverviewSchema.parse(await getBranchOverview(rootForSender(event.sender), branch))
  })

  ipcMain.handle(IpcChannels.gitBranchFileDiff, async (event, rawArgs: unknown) => {
    const { branch, path } = GitBranchFileDiffRequestSchema.parse(rawArgs)
    return DiffFileResultSchema.parse(
      await branchFileDiff(rootForSender(event.sender), branch, path),
    )
  })

  ipcMain.handle(IpcChannels.gitDiscardBranch, async (event, rawArgs: unknown) => {
    const { branch } = GitBranchRequestSchema.parse(rawArgs)
    await discardBranch(rootForSender(event.sender), branch)
  })

  // Backup: sync-state is read-only + offline (never fetches); push is a plain fast-forward push of
  // the current branch with the same tagged-result contract as gitCommit (auth/rejected → specific
  // codes the renderer routes to the agent).
  ipcMain.handle(IpcChannels.gitSyncState, async (event) =>
    GitSyncStateSchema.parse(await getSyncState(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.gitPush, async (event) => {
    try {
      await pushToRemote(rootForSender(event.sender))
      return GitPushResultSchema.parse({ ok: true })
    } catch (err) {
      if (err instanceof UserGitError) {
        const code = ['no_remote', 'push_rejected', 'push_auth'].includes(err.code) ? err.code : 'git_failed'
        return GitPushResultSchema.parse({ ok: false, code, message: err.message })
      }
      throw err
    }
  })

  // The worktrees on disk (the checkouts a past session left behind, with their stranded dirty count).
  // Read-only; root per-window like the rest of user-git.
  ipcMain.handle(IpcChannels.gitWorktrees, async (event) =>
    GitWorktreeListSchema.parse(await getWorktrees(rootForSender(event.sender))),
  )

  // Leftovers from finished work (fully-merged branches + their clean checkouts) and the safe tidy.
  // Tidy recomputes the stray list in the main process — never trusts a renderer snapshot — and uses
  // only refusal-safe git (`branch -d` / plain `worktree remove`), so it can't lose unmerged work.
  ipcMain.handle(IpcChannels.gitMergedStrays, async (event) =>
    GitMergedStrayListSchema.parse(await getMergedStrays(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.gitTidyStrays, async (event, rawArgs: unknown) => {
    const { only } = GitTidyStraysRequestSchema.parse(rawArgs ?? {})
    return GitTidyResultSchema.parse(await tidyMergedStrays(rootForSender(event.sender), only))
  })

  // Open a worktree in its OWN window (focus if already open) — never swaps the calling window in
  // place. The path comes from getWorktrees (a real repo worktree), not free-form renderer input.
  // Dynamic import of ./index sidesteps the ipc↔index module cycle (index registers these handlers).
  ipcMain.handle(IpcChannels.worktreeOpen, async (_event, rawArgs: unknown) => {
    const { path } = WorktreeOpenRequestSchema.parse(rawArgs)
    const { openProjectInNewWindow } = await import('./index')
    return ProjectOpenResultSchema.parse(openProjectInNewWindow(path))
  })

  // ── One-project-per-window ────────────────────────────────────────────────
  // Which project is this window? '' ⇒ ProjectHome (renderer shows the folder picker).
  ipcMain.handle(IpcChannels.projectGetContext, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return ProjectContextSchema.parse({ projectPath: (win && projectPathForWindow(win.id)) || '' })
  })

  // Native open-directory dialog, parented to the calling window.
  ipcMain.handle(IpcChannels.projectChooseFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return ChooseFolderResultSchema.parse({ path: res.canceled ? null : (res.filePaths[0] ?? null) })
  })

  // Open a folder as THIS window's project, in place. If another window already shows it, focus that
  // one and leave this window unchanged (block-and-focus, VSCode-style — one window per project).
  ipcMain.handle(IpcChannels.projectOpen, (event, rawArgs: unknown) => {
    const { path } = ProjectOpenRequestSchema.parse(rawArgs)
    const projectPath = realpathSync(path) // resolve once so the registry + store key consistently
    const existing = windowForProject(projectPath)
    if (existing) {
      existing.focus()
      return ProjectOpenResultSchema.parse({ projectPath, alreadyOpen: true })
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      setProjectPath(win.id, projectPath)
      win.setTitle(basename(projectPath) || 'Koda') // distinguish windows in the switcher
    }
    noteProjectOpened(projectPath) // openProjects (restore-on-boot) + recents
    return ProjectOpenResultSchema.parse({ projectPath, alreadyOpen: false })
  })

  // Create a NEW project folder and open it as this window's project — the "New project" entry point
  // on ProjectHome. Validates the name as a single folder segment (no separators/traversal/dotfiles),
  // mkdirs it under parentDir (default ~/Koda), then opens it in place exactly like project:open. A
  // just-made folder can't be open in another window, so there's no block-and-focus branch.
  ipcMain.handle(IpcChannels.projectCreate, async (event, rawArgs: unknown) => {
    const { name, parentDir } = ProjectCreateRequestSchema.parse(rawArgs)
    const clean = name.trim()
    // A single folder name: reject path separators + leading dots, so join(parent, clean) can't escape
    // parent (no traversal) and we don't make a hidden folder.
    if (!clean || clean.length > 120 || /[/\\]/.test(clean) || clean.startsWith('.')) {
      throw new Error('Please enter a valid project name (no slashes).')
    }
    const rawParent = parentDir?.trim()
    const parent = rawParent
      ? rawParent.startsWith('~')
        ? join(homedir(), rawParent.slice(1))
        : rawParent
      : join(homedir(), 'Koda')
    if (!isAbsolute(parent)) throw new Error('The location must be a full folder path.')
    const target = join(parent, clean)
    if (existsSync(target)) throw new Error('A folder with that name already exists here.')
    await mkdir(target, { recursive: true })
    const projectPath = realpathSync(target) // resolve once so the registry + store key consistently
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      setProjectPath(win.id, projectPath)
      win.setTitle(basename(projectPath) || 'Koda')
    }
    noteProjectOpened(projectPath) // openProjects (restore-on-boot) + recents
    track('project_created', {})
    return ProjectOpenResultSchema.parse({ projectPath, alreadyOpen: false })
  })

  // Does this window's project already carry an agent-guidance file? Drives the one-time intake offer
  // (no guidelines ⇒ offer; present ⇒ leave them alone — never clobber a project's existing CLAUDE.md/
  // AGENTS.md). Filenames are constants joined to the contained project root → no traversal vector.
  ipcMain.handle(IpcChannels.projectHasGuidelines, (event) => {
    const root = rootForSender(event.sender)
    const hasGuidelines = GUIDELINES_FILES.some((f) => existsSync(join(root, f)))
    return ProjectHasGuidelinesResultSchema.parse({ hasGuidelines })
  })

  ipcMain.handle(IpcChannels.projectGetRecents, () =>
    RecentProjectsSchema.parse(loadAppState().recentProjects),
  )

  // Renderer log forwarding is fire-and-forget (send/on, no reply). safeParse so a
  // bad shape is dropped, never thrown — logging must not become a crash vector.
  ipcMain.on(IpcChannels.rendererLog, (_event, rawArgs: unknown) => {
    const parsed = RendererLogSchema.safeParse(rawArgs)
    if (!parsed.success) return
    log[parsed.data.level]('renderer', parsed.data.args.join(' '))
  })

  // Dock badge: number of sessions needing attention. safeParse-drop (fire-and-forget),
  // no-op on platforms without a dock.
  ipcMain.on(IpcChannels.setAttentionCount, (_event, rawArgs: unknown) => {
    const parsed = AttentionCountSchema.safeParse(rawArgs)
    if (!parsed.success) return
    app.setBadgeCount(parsed.data.count)
  })
}
