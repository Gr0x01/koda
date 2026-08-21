import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { track, trackFirstTurn } from './telemetry'
import { checkForUpdatesNow, getUpdateStatus, getWhatsNew, quitAndInstallUpdate } from './updater'
import { submitFeedback } from './feedback'
import { z } from 'zod'
import { IpcChannels } from '@shared/channels'
import { ATTACHABLE_EXTENSIONS, ATTACHABLE_MIME, extensionOf } from '@shared/attachments'
import {
  AppInfoSchema,
  FeedbackRequestSchema,
  EngineProbeSchema,
  ProviderModelCatalogsSchema,
  StartSessionRequestSchema,
  StartSessionResponseSchema,
  SendTurnRequestSchema,
  SessionRefSchema,
  StopSubagentRequestSchema,
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
  type SessionsLoadResult,
  type ArchivedLoadResult,
  ArchivedSessionMetaSchema,
  AdoptedHeadlessListSchema,
  RendererLogSchema,
  AttentionCountSchema,
  ApprovalResolveSchema,
  SetApprovalModeSchema,
  SetModelEffortSchema,
  ApprovalModeSchema,
  ApprovalRequestsSchema,
  TaskCompletionStatesSchema,
  StageReceiptsSchema,
  ResolveStageLinkRequestSchema,
  StageLinkTargetSchema,
  SessionNameRequestSchema,
  SessionNameResponseSchema,
  ReadDirRequestSchema,
  ListDocsResultSchema,
  LibraryResolveRequestSchema,
  LibraryResolveResultSchema,
  LibraryQueryRequestSchema,
  LibraryQueryResultSchema,
  LibraryAskRequestSchema,
  LibraryAskResultSchema,
  ReadDirResultSchema,
  ReadFileRequestSchema,
  ReadFileResultSchema,
  DiffFileRequestSchema,
  DiffFileResultSchema,
  WriteFileRequestSchema,
  WriteFileResultSchema,
  NO_UNDO_POINT,
  CreateFileRequestSchema,
  CreateFileResultSchema,
  PickFilesResultSchema,
  PickPathResultSchema,
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
  DuplicatePathRequestSchema,
  DuplicatePathResultSchema,
  ImportFilesRequestSchema,
  ImportFilesResultSchema,
  RevealPathRequestSchema,
  OpenPathRequestSchema,
  StartDragRequestSchema,
  ExportPdfRequestSchema,
  ExportPdfResultSchema,
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
  GitProposeMessageRequestSchema,
  GitProposeMessageResultSchema,
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
  ProjectDeleteRequestSchema,
  ProjectDeleteResultSchema,
  DataIntegritySchema,
  RecentProjectsSchema,
  MiniAppListSchema,
  MiniAppStartRequestSchema,
  MiniAppFrontRequestSchema,
  MiniAppStartResultSchema,
  MiniAppBridgeListSchema,
  MiniAppBridgeConsentRequestSchema,
  AddRecentModelSchema,
  KodaSettingsSchema,
  KodaSettingsPatchSchema,
  GuardrailsLayerSchema,
  MemoryWeightSchema,
  BackupStatusSchema,
  BackupManifestSchema,
  BackupRestoreRequestSchema,
  BackupRestoreResultSchema,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { projectMemoryWeight } from './engine/pack'
import { backupNow, getBackupStatus, listCloudBackups, restoreCloudBackup, revealRecoveryCode } from './backup'
import { probeEngine } from './engine/probe'
import { EngineSessionManager } from './engine/sessions'
import { DreamScheduler } from './engine/dream'
import { loadUsageHistory } from './engine/usage-history'
import { currentProviderStatus, refreshProviderStatus, setStatusWatchHooks } from './engine/status-watch'
import {
  browseDir,
  createProjectDir,
  createProjectFile,
  deleteProjectDocument,
  deleteProjectPath,
  duplicateProjectPath,
  importFilesIntoProject,
  diffProjectFile,
  listProjectDocs,
  resolveProjectDocs,
  queryLibrary,
  readProjectFile,
  prepareProjectDocumentDelete,
  renameProjectPath,
  replaceInProject,
  searchProject,
  writeProjectFile,
  containedReal,
  isDisplayableImage,
  type ProjectDocumentDeleteTarget,
} from './fs-browse'
import { askLibrary } from './library-ask'
import { watchProjectFile, unwatchProjectFile } from './file-watch'
import { notifyProjectDocsMutation, watchProjectDocs, unwatchProjectDocs } from './docs-watch'
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
  getChangeEvidence,
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
  contextForSession,
  projectPathForWindow,
  removeSessionFromWindow,
  setProjectPath,
  takeNewProjectIntent,
  windowForProject,
} from './window-registry'
import { resolveStageLink as resolveWorkspaceStageLink } from './stage-presentation'
import {
  appStateHealth,
  deleteArchivedBody,
  loadAppState,
  loadArchivedBody,
  loadArchivedMeta,
  noteProjectDeleted,
  projectsHomeDir,
  purgeProjectSessions,
  noteProjectOpened,
  saveArchivedMeta,
  writeArchivedBody,
  StoreReadError,
  type StoreReadReport,
} from './session-store'
import {
  loadRecentModels,
  addRecentModel,
  loadLastPosture,
  saveLastPosture,
  loadSettings,
  settingsHealth,
  updateSettings,
  resetSettings,
  loadMiniAppsEnabled,
} from './settings'
import { deleteProjectApps, listMiniApps, startRegisteredMiniApp, onMiniAppsChanged } from './mini-apps'
import { bridgeAppState, setBridgeConsent, setBridgeSpendListener } from './app-bridge'
import {
  initRemoteControl,
  registerRemoteIpcHandlers,
  remoteStatusWatchHooks,
  disposeRemoteControl,
} from './remote-control'
import { staticPreviewUrl, previewAssetUrl, startDevServer, showStaticPreview } from './preview'
import { listScratchImages } from './scratch'
import {
  applyScratchRetentionSetting,
  pruneProjectScratch,
  saveScratchWithRetention,
} from './scratch-retention'
import { healGuidelinesPair } from './guidelines'
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
import {
  HERMETIC_E2E_BLOCK_REASON,
  isHermeticE2EProfile,
  requireRealAccountAccess,
} from './runtime-profile'

let engineSessions: EngineSessionManager | null = null
let dreamScheduler: DreamScheduler | null = null
const libraryAskControllers = new Map<string, AbortController>()

function libraryAskKey(sender: WebContents, requestId: string): string {
  return `${sender.id}:${requestId}`
}

/** Dev-menu live-fire of the whole dream, including separately gated REM. */
export function runDreamNow(): void {
  dreamScheduler?.dreamNow()
}

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

/** A successful Koda-owned filesystem mutation invalidates main's Library cache and wakes every open
 * Library on this project before the IPC result is handed back. */
async function withProjectDocsRefresh<T>(root: string, mutate: () => Promise<T>): Promise<T> {
  const result = await mutate()
  notifyProjectDocsMutation(root)
  return result
}

/**
 * Checkpoint before a CONTENT-DESTROYING edit, and refuse the edit outright when no recovery point
 * could be taken. The project mutation boundary stays held through `mutate`, so a new agent turn
 * cannot establish its ownership baseline between the checkpoint and the user's actual write.
 *
 * Only destroying actions route through here — the user loses nothing by the refusal (their content is
 * untouched) and everything by proceeding blind. Additive actions (create, duplicate, import, add a
 * guardrail) still checkpoint fail-soft: nothing existing is destroyed, so the worst case is a new
 * file that isn't in the timeline, which the user can simply delete. A SAVE is also excluded — see
 * NO_UNDO_POINT.
 *
 * `refusal` completes the sentence: what did NOT happen, in the user's terms.
 */
async function withRequiredCheckpoint<T>(
  root: string,
  label: string,
  refusal: string,
  mutate: () => T | Promise<T>,
  checkpointFile?: ProjectDocumentDeleteTarget,
): Promise<T> {
  return getEngineSessions().withExternalProjectMutation(
    root,
    { checkpointLabel: label, checkpointFile },
    (checkpointed) => {
      if (!checkpointed) throw new Error(`${NO_UNDO_POINT}, so ${refusal}`)
      return mutate()
    },
  )
}

/** The Settings words for a guardrail item. `subagent` is our word, not the user's — that screen
 *  calls them specialist helpers, so a refusal has to as well. */
function guardrailItemNoun(kind: 'skill' | 'subagent'): string {
  return kind === 'subagent' ? 'specialist helper' : 'skill'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The PDF export's page style: a clean black-on-white print layout, independent of the app theme.
 *  The body is the doc surface's ProseMirror HTML, so selectors target plain markdown-ish tags. */
const PDF_CSS = `
  * { box-sizing: border-box; }
  body { font: 12pt/1.6 -apple-system, 'Helvetica Neue', sans-serif; color: #111; margin: 0.9in 1in; }
  .koda-pdf-title { font-size: 22pt; line-height: 1.2; margin: 0 0 0.6em; }
  h1 { font-size: 17pt; } h2 { font-size: 14pt; } h3, h4 { font-size: 12pt; }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.2em 0 0.4em; break-after: avoid; }
  p, ul, ol { margin: 0.5em 0; }
  li { margin: 0.15em 0; }
  li p { margin: 0; }
  input[type='checkbox'] { margin-right: 0.4em; }
  a { color: #1a4fd6; text-decoration: none; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 0.6em 0; padding: 0.1em 1em; border-left: 3px solid #bbb; color: #444; }
  code { font: 10pt/1.5 ui-monospace, Menlo, monospace; background: #f2f2f2; padding: 0.1em 0.3em; border-radius: 3px; }
  pre { background: #f6f6f6; border: 1px solid #e2e2e2; border-radius: 6px; padding: 0.7em 0.9em; overflow: hidden; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 0.7em 0; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.3em 0.6em; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.2em 0; }
  /* Crepe's in-editor affordances ride along in the rendered HTML (image toolbars, caption inputs,
     drag handles). Markdown itself never produces these, so hiding them wholesale is safe. */
  button, input:not([type='checkbox']), .milkdown-toolbar, .ProseMirror-gapcursor { display: none !important; }
`

/** The live session manager — created at IPC registration, drained on quit. */
export function getEngineSessions(): EngineSessionManager {
  if (!engineSessions) throw new Error('IPC handlers not registered')
  return engineSessions
}

/** Tear down all live sessions on shutdown; safe to call before registration. Also stops the remote
 *  LAN server + cloud relay (their connections must not outlive the app). */
export async function disposeEngineSessions(): Promise<void> {
  for (const controller of libraryAskControllers.values()) controller.abort()
  libraryAskControllers.clear()
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

  // Overnight dream consolidation (dream-plan.md) — inert unless the dreamEnabled flag is on.
  const dream = new DreamScheduler(engineSessions)
  dreamScheduler = dream
  engineSessions.setEngineActivityListener((cwd) => dream.noteActivity(cwd))

  // The phone-control tier (LAN server + cloud relay + pairing) — one seam, see remote-control.ts.
  initRemoteControl(engineSessions)

  // Provider-health watch: health broadcasts to every window (the engine chips); the remote legs
  // (server-side watch, phone push) come from the seam and are inert when phone control is absent or off.
  setStatusWatchHooks({
    broadcast: (e) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.providerStatus, e)
    },
    ...remoteStatusWatchHooks(),
  })
  ipcMain.handle(IpcChannels.providerStatusGet, () => currentProviderStatus())
  ipcMain.handle(IpcChannels.providerStatusRefresh, (_e, engines: string[]) =>
    refreshProviderStatus(Array.isArray(engines) ? engines : []),
  )

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

  ipcMain.handle(IpcChannels.probeEngine, async () =>
    // resourcesPath is our bundled engine only when packaged; undefined in dev.
    EngineProbeSchema.parse(await probeEngine(app.isPackaged ? process.resourcesPath : undefined)),
  )

  ipcMain.handle(IpcChannels.startSession, async (event, rawArgs: unknown) => {
    const args = StartSessionRequestSchema.parse(rawArgs)
    const rawRecord = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
    const hasFreshPostureOverride = ['engineId', 'model', 'effort'].some((key) =>
      Object.prototype.hasOwnProperty.call(rawRecord, key),
    )
    // Pass the owning window so start() registers ownership + resolves the project cwd BEFORE spawn
    // (so the first event routes correctly and a fresh session runs in this window's project).
    const ownerWindowId = BrowserWindow.fromWebContents(event.sender)?.id
    if (args.sessionId) {
      return StartSessionResponseSchema.parse(
        await getEngineSessions().start({ ...args, ownerWindowId }),
      )
    }

    // Main owns the app-wide next-chat posture. A plain fresh start hydrates it here, which makes a
    // phone pick survive even when no renderer was open. Callers such as handoff may deliberately pass
    // all three fields (including explicit undefined to clear a field) as a one-start override.
    const remembered = hasFreshPostureOverride ? {} : loadLastPosture()
    const posture = {
      engineId: args.engineId ?? remembered.engineId ?? ('claude' as const),
      model: hasFreshPostureOverride ? args.model : remembered.model,
      effort: hasFreshPostureOverride ? args.effort : remembered.effort,
    }
    const started = await getEngineSessions().start({ ...args, ...posture, ownerWindowId })
    if (hasFreshPostureOverride) saveLastPosture(posture)
    return StartSessionResponseSchema.parse({ ...started, ...posture })
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

  ipcMain.handle(IpcChannels.stopSubagent, (_event, rawArgs: unknown) => {
    const { sessionId, taskId } = StopSubagentRequestSchema.parse(rawArgs)
    getEngineSessions().stopSubagent(sessionId, taskId)
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
    try {
      await getEngineSessions().dispose(sessionId)
    } finally {
      // The tab is truly gone (not a respawn) — forget its approval posture so a resumed conversation
      // on this id never comes back UNATTENDED-locked (see ApprovalGate.forgetSession). In a finally:
      // a throwing dispose must not skip this (W5) — it's the same route into the dream critical fix.
      getEngineSessions().forgetSession(sessionId)
    }
  })

  // Per-project persistence: load on boot (invoke), save debounced (send, fire-and-forget). Both
  // resolve the project from the CALLING window — a ProjectHome window with no project loads nothing
  // and silently drops saves (rootForSender throws → caught here, persistence isn't a crash vector).
  //
  // "No project in this window" is a legitimate nothing-to-load (`ok` with no data); a load FAILURE
  // comes back as `ok: false`, so the renderer skips hydrate and leaves its debounced save gated.
  // Collapsing the two is what let an unreadable store be rewritten to empty.
  //
  // The result carries what only main can know: whether the copy the banner promises actually landed
  // (`backupKept`), and how many rows a read that otherwise succeeded had to set aside. The drop case is
  // the one where saving stays ON, so an unreported drop means the shortened list IS written back.
  ipcMain.handle(IpcChannels.sessionsLoad, (event): SessionsLoadResult => {
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      return { ok: true, data: null, droppedSessions: 0, unreadableArchiveBodyIds: [] }
    }
    const report: StoreReadReport = { dropped: 0 }
    try {
      const data = getEngineSessions().loadSessionsForProject(root, report)
      return {
        ok: true,
        data,
        droppedSessions: report.dropped,
        unreadableArchiveBodyIds: report.unreadableArchiveBodyIds ?? [],
      }
    } catch (err) {
      log.warn('ipc', 'session store load failed', err instanceof Error ? err.message : err)
      return { ok: false, backupKept: err instanceof StoreReadError ? err.backupKept : null }
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

  ipcMain.handle(IpcChannels.sessionsSave, (event, rawArgs: unknown): boolean => {
    const parsed = PersistedSessionsSchema.safeParse(rawArgs)
    if (!parsed.success) return false // bad shape dropped, never thrown (persistence isn't a crash vector)
    try {
      return getEngineSessions().persistProjectSessions(rootForSender(event.sender), parsed.data)
    } catch {
      /* no project for this window yet — nothing to persist */
      return false
    }
  })

  // Archived sessions: the cold per-project store (see session-store.ts). The metadata index is read on
  // boot and written when the list changes; transcript bodies live in per-session files, fetched only on
  // restore. Same fail-soft posture as the hot save above — and the same split: no project = an empty
  // list, but a failed READ comes back `ok: false` so the renderer disables the archive save instead of
  // writing `[]` over a real index.
  ipcMain.handle(IpcChannels.archivedLoad, (event): ArchivedLoadResult => {
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      return { ok: true, archived: [], droppedArchives: 0 }
    }
    const report: StoreReadReport = { dropped: 0 }
    try {
      return { ok: true, archived: loadArchivedMeta(root, report), droppedArchives: report.dropped }
    } catch (err) {
      log.warn('ipc', 'archive index load failed', err instanceof Error ? err.message : err)
      return { ok: false, backupKept: err instanceof StoreReadError ? err.backupKept : null }
    }
  })

  // Answers with whether the index is now on disk holding exactly this list. Unlike the hot save above,
  // this one is not allowed to fail quietly: the renderer only completes an archive/restore/delete after
  // it hears `true`, so every `false` here is a move the hot store declines to make either. The
  // validation branch is the one that used to drop the entire save over a single unparseable row while
  // the hot save (validated separately) went through — one writer succeeding and the other not.
  ipcMain.handle(IpcChannels.archivedSave, (event, rawArgs: unknown): boolean => {
    const parsed = z.array(ArchivedSessionMetaSchema).safeParse(rawArgs)
    if (!parsed.success) {
      log.warn('ipc', 'archive index save refused — the list failed validation', parsed.error.issues[0]?.message)
      return false
    }
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      return false // no project for this window — nothing was written, and claiming otherwise would lie
    }
    return saveArchivedMeta(root, parsed.data)
  })

  ipcMain.handle(IpcChannels.archivedLoadBody, (event, rawArgs: unknown) => {
    const id = z.string().safeParse(rawArgs)
    if (!id.success) return null
    try {
      return loadArchivedBody(rootForSender(event.sender), id.data)
    } catch {
      return null // read failure → caller (restore) keeps the archive rather than destroying it
    }
  })

  ipcMain.handle(IpcChannels.archivedWriteBody, (event, rawArgs: unknown) => {
    const parsed = z.object({ id: z.string(), items: z.array(z.unknown()) }).safeParse(rawArgs)
    if (!parsed.success) return false
    try {
      return writeArchivedBody(rootForSender(event.sender), parsed.data.id, parsed.data.items)
    } catch {
      return false // no project for this window yet, or the body write failed
    }
  })

  ipcMain.handle(IpcChannels.archivedDeleteBody, (event, rawArgs: unknown) => {
    const id = z.string().safeParse(rawArgs)
    if (!id.success) return
    try {
      deleteArchivedBody(rootForSender(event.sender), id.data)
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
    const { checkpointId, path, sessionId } = SafetyFileDiffRequestSchema.parse(rawArgs)
    let root = rootForSender(event.sender)
    if (sessionId) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const owner = contextForSession(sessionId)
      const sessionRoot = getEngineSessions().getSessionCwd(sessionId)
      if (!win || owner?.win.id !== win.id || !sessionRoot)
        throw new Error('that session does not belong to this window')
      root = sessionRoot
    }
    return SafetyFileDiffResultSchema.parse(
      await checkpointFileDiff(root, checkpointId, path),
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

  ipcMain.handle(IpcChannels.approvalPending, (event) =>
    ApprovalRequestsSchema.parse(getEngineSessions().pendingRequestsForProject(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.completionList, async (event) =>
    TaskCompletionStatesSchema.parse(
      await getEngineSessions().completionStatesForProject(rootForSender(event.sender)),
    ),
  )

  ipcMain.handle(IpcChannels.stageReceiptList, (event) =>
    StageReceiptsSchema.parse(getEngineSessions().stageReceiptsForProject(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.stageResolveLink, (event, rawArgs: unknown) => {
    const { sessionId, href } = ResolveStageLinkRequestSchema.parse(rawArgs)
    if (!sessionId)
      return StageLinkTargetSchema.parse(resolveWorkspaceStageLink(rootForSender(event.sender), href))
    const win = BrowserWindow.fromWebContents(event.sender)
    const owner = contextForSession(sessionId)
    if (!win || owner?.win.id !== win.id)
      return StageLinkTargetSchema.parse({ kind: 'declined', reason: 'That session belongs to another window.' })
    return StageLinkTargetSchema.parse(getEngineSessions().resolveStageLink(sessionId, href))
  })

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
  ipcMain.handle(IpcChannels.modelsGetProviderCatalogs, async () =>
    ProviderModelCatalogsSchema.parse(await getEngineSessions().modelProviderCatalogs()),
  )
  ipcMain.handle(IpcChannels.codexModels, () => getEngineSessions().codexModels())
  ipcMain.handle(IpcChannels.codexAuthStatus, () => getEngineSessions().codexAuthStatus())
  ipcMain.handle(IpcChannels.codexLoginStart, () =>
    AuthLoginStartResultSchema.parse(
      isHermeticE2EProfile()
        ? { ok: false, reason: HERMETIC_E2E_BLOCK_REASON }
        : startCodexLogin(),
    ),
  )
  ipcMain.handle(IpcChannels.codexLoginCancel, () => {
    cancelCodexLogin('cancelled')
  })

  // App preferences (the Settings pane). get returns the full settings; set merges a partial, persists
  // it, and — for a default-mode change — also updates the live gate so new sessions in already-open
  // windows start in the new posture without a restart. Returns the full, re-clamped settings.
  ipcMain.handle(IpcChannels.settingsGet, () => KodaSettingsSchema.parse(loadSettings()))
  ipcMain.handle(IpcChannels.settingsSet, async (_event, rawArgs: unknown) => {
    const patch = KodaSettingsPatchSchema.parse(rawArgs)
    // Activation-funnel signal: fire once when onboarding finishes. Order matters — updateSettings
    // persists hasOnboarded:true first, so track()'s hasOnboarded send-gate is already open.
    const justOnboarded = patch.hasOnboarded === true && !loadSettings().hasOnboarded
    // Every production prune shares the retention lane. Put persistence inside it so an older,
    // shorter policy cannot keep deleting after a longer/Forever preference has been saved.
    const next =
      patch.scratchRetentionDays !== undefined
        ? await applyScratchRetentionSetting(() => updateSettings(patch))
        : updateSettings(patch)
    if (justOnboarded) track('onboarding_completed', {})
    if (patch.defaultApprovalMode !== undefined)
      getEngineSessions().setDefaultApprovalMode(next.defaultApprovalMode)
    if (patch.previewAutoStart !== undefined)
      getEngineSessions().setPreviewAutoStart(next.previewAutoStart)
    if (patch.dreamEnabled !== undefined) dream.recheck() // toggled on late-evening should still dream tonight
    // A retention change was persisted and pruned above; closed projects take the same lane when
    // Recent images loads on their next open.
    // Settings are app-global — fan the new values out to every window so per-window live gates (the
    // notification pref, each renderer's default posture) re-sync without a restart.
    const settings = KodaSettingsSchema.parse(next)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcChannels.uiSettingsChanged, settings)
    }
    return settings
  })
  ipcMain.handle(IpcChannels.settingsReset, async () => {
    // DEV reset also changes retention back to its default, so it must share the policy lane too.
    const settings = KodaSettingsSchema.parse(
      await applyScratchRetentionSetting(() => resetSettings()),
    )
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

  // Resolve a doc's relative image reference to a loadable koda-preview:// URL so local images render
  // in the WYSIWYG doc surface (the file on disk keeps its plain `assets/pic.png` markdown). Only bare
  // relative refs reach here; absolute URLs / data: URIs are handled in the renderer. Contained to the
  // project root — an escaping or missing ref returns null and the renderer leaves the src untouched.
  ipcMain.handle(IpcChannels.docAssetUrl, (event, rawArgs: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    if (
      typeof rawArgs !== 'object' ||
      rawArgs === null ||
      typeof (rawArgs as { docPath?: unknown }).docPath !== 'string' ||
      typeof (rawArgs as { ref?: unknown }).ref !== 'string'
    )
      return null
    const { docPath, ref } = rawArgs as { docPath: string; ref: string }
    const root = rootForSender(event.sender)
    // Resolve the ref against the doc's own folder (markdown image paths are doc-relative), then map to
    // a project-relative key and containment-check it exactly as the protocol handler will.
    const abs = resolve(dirname(docPath), ref)
    const rel = relative(root, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    try {
      containedReal(root, rel) // realpath: throws on escape OR missing file
    } catch {
      return null
    }
    return previewAssetUrl(win.id, rel) ?? null
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
    const { mediaType, dataBase64, fileName } = ScratchSaveRequestSchema.parse(rawArgs)
    const path = await saveScratchWithRetention(rootForSender(event.sender), mediaType, dataBase64, fileName)
    return ScratchSaveResultSchema.parse({ path })
  })

  // Composer attach menu: native open dialog → the picked files' bytes. Main does the read (the
  // renderer has no fs); the renderer stages the result exactly like a drop, compressing images there.
  ipcMain.handle(IpcChannels.composerPickFiles, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [{ name: 'Attachable files', extensions: ATTACHABLE_EXTENSIONS }],
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled) return PickFilesResultSchema.parse({ files: [] })
    const files = await Promise.all(
      res.filePaths.map(async (p) => {
        const name = basename(p)
        const mediaType = ATTACHABLE_MIME[extensionOf(name)]
        if (!mediaType) return null
        try {
          return { name, mediaType, dataBase64: (await readFile(p)).toString('base64') }
        } catch {
          return null // unreadable (vanished, permissions) — skip, never block the pick
        }
      }),
    )
    return PickFilesResultSchema.parse({ files: files.filter((f) => f !== null) })
  })

  // "Point at files or folders" — returns the chosen absolute paths; nothing is copied.
  ipcMain.handle(IpcChannels.composerPickPath, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      properties: ['openFile', 'openDirectory', 'multiSelections'] as (
        | 'openFile'
        | 'openDirectory'
        | 'multiSelections'
      )[],
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return PickPathResultSchema.parse({ paths: res.canceled ? [] : res.filePaths })
  })

  // Page through the window project's recent scratch images (newest first) for the Recent images strip.
  // The first page enforces retention before counting, so opening a quiet project cleans it even when
  // no newer attachment was ever sent. Later pages do not prune: deleting the tail between offsets
  // would shift pagination. Root is resolved in main; a no-project window returns an empty page.
  ipcMain.handle(IpcChannels.scratchList, async (event, rawArgs: unknown) => {
    const { offset, limit } = ScratchListRequestSchema.parse(rawArgs)
    let root: string
    try {
      root = rootForSender(event.sender)
    } catch {
      return ScratchListResultSchema.parse({ images: [], total: 0 })
    }
    if (offset === 0) await pruneProjectScratch(root)
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

  // How heavy this project's memory navigation pair is (status-bar tidy pill + Settings →
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

  // Encrypted cloud backup (Settings → Backup; dogfood-flagged in main/backup). Status/now are
  // project-scoped; a no-project window reads as a disabled surface rather than an error.
  ipcMain.handle(IpcChannels.backupStatus, async (event) => {
    try {
      return BackupStatusSchema.parse(await getBackupStatus(rootForSender(event.sender)))
    } catch {
      return BackupStatusSchema.parse({
        enabled: false,
        signedIn: false,
        state: 'idle',
        lastBackupAt: null,
        sizeBytes: null,
      })
    }
  })
  ipcMain.handle(IpcChannels.backupNow, async (event) => {
    return BackupStatusSchema.parse(await backupNow(rootForSender(event.sender)))
  })
  ipcMain.handle(IpcChannels.backupRecoveryCode, () => revealRecoveryCode())
  ipcMain.handle(IpcChannels.backupList, async () => {
    return z.array(BackupManifestSchema).parse(await listCloudBackups())
  })
  ipcMain.handle(IpcChannels.backupRestore, async (_event, rawArgs: unknown) => {
    const args = BackupRestoreRequestSchema.parse(rawArgs)
    return BackupRestoreResultSchema.parse(await restoreCloudBackup(args))
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
    const res = await saveGuardrail(root, req, (write) =>
      getEngineSessions().withExternalProjectMutation(
        root,
        { checkpointLabel: `add ${req.kind}` },
        () => write(),
      ),
    )
    return GuardrailSaveResultSchema.parse(res)
  })

  // Switch a bundled Koda default off/on for this project. Persists to .koda/guardrails.json; the
  // engine reads the disabled set at the next session spawn. No checkpoint — a toggle is trivially
  // reversible (flip it back), and it's config, not the agent editing the user's content.
  ipcMain.handle(IpcChannels.guardrailsSetEnabled, async (event, rawArgs: unknown) => {
    const { key, enabled } = GuardrailSetEnabledRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    // A pristine principle's toggle fans out to its member rule ids; a CUSTOMIZED principle (has an
    // override) toggles the override itself via its principle key; a skill/subagent key passes through.
    const overridden = key.startsWith('principle:') && key.slice('principle:'.length) in readOverrides(root)
    const keys = overridden ? [key] : principleMemberKeys(key, app.isPackaged ? process.resourcesPath : undefined)
    await getEngineSessions().withExternalProjectMutation(root, {}, () =>
      setGuardrailsDisabled(root, keys, !enabled),
    )
  })

  // Save an edited skill/subagent body into this project (forks a Koda default; overwrites a project
  // item). The overwrite loses the previous body, so the checkpoint thunk REFUSES rather than returns
  // — saveItemBody awaits it before touching disk, so a refusal leaves the old body intact.
  ipcMain.handle(IpcChannels.guardrailsSaveItemBody, async (event, rawArgs: unknown) => {
    const { kind, name, content } = GuardrailSaveItemBodyRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    const res = await saveItemBody(root, { kind, name }, content, (write) =>
      withRequiredCheckpoint(
        root,
        `edit ${kind} ${name}`,
        `your ${guardrailItemNoun(kind)} was left as it was.`,
        write,
      ),
    )
    return GuardrailSaveResultSchema.parse(res)
  })

  // Remove a project skill/subagent; if it forked a Koda default, the default reappears. A hand-written
  // one has nothing to fall back to, so refuse the delete when it can't be made undoable.
  ipcMain.handle(IpcChannels.guardrailsRemoveItem, async (event, rawArgs: unknown) => {
    const ref = GuardrailItemRefSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await removeGuardrailItem(root, ref, (write) =>
      withRequiredCheckpoint(root, `remove ${ref.kind} ${ref.name}`, 'nothing was removed.', write),
    )
  })

  // Edit a Koda rule principle's wording for this project (or restore it with text:null). Refuse
  // without an undo point (it overwrites the user's own edited wording), then fork the override + drop
  // the bundled member rules. Applies next session.
  ipcMain.handle(IpcChannels.guardrailsSetRuleOverride, async (event, rawArgs: unknown) => {
    const { principleId, text } = GuardrailRuleOverrideRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    await withRequiredCheckpoint(root, `edit rule ${principleId}`, 'the rule was left as it was.', () =>
      setRuleOverride(root, app.isPackaged ? process.resourcesPath : undefined, principleId, text),
    )
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
      writeBoundary: <T>(write: () => T | Promise<T>): Promise<T> =>
        getEngineSessions().withExternalProjectMutation(
          root,
          { checkpointLabel: `${active ? 'add' : 'remove'} skill ${id}` },
          () => write(),
        ),
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
    requireRealAccountAccess()
    const { until } = ApiFallbackRequestSchema.parse(rawArgs)
    // Cap how far out the fallback can run — this is the one value that prolongs real-money billing, so a
    // bogus far-future resetsAt can't keep the API key effective indefinitely (weekly windows are ≤7d).
    const capped = Math.min(until, Date.now() / 1000 + 8 * 86_400)
    getEngineSessions().activateApiFallback(capped)
    broadcastSettings() // chip re-evaluates apiActive
    return billingState()
  })

  ipcMain.handle(IpcChannels.billingSaveApiKey, async (_event, rawKey: unknown) => {
    requireRealAccountAccess()
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
    requireRealAccountAccess()
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
    requireRealAccountAccess()
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
    requireRealAccountAccess()
    clearApiKey('codex')
    updateSettings({ codexBillingMode: 'subscription' })
    // Restore the ChatGPT login (backed up when we switched to the key).
    await reconcileCodexAuth({ resourcesPath: codexResourcesPath(), apiKey: null })
    broadcastSettings()
    return billingState()
  })

  // ── Remote Control + cloud relay (Settings → Remote) — handlers live with the seam ──
  registerRemoteIpcHandlers(broadcastSettings)

  // Name a session through the app-global writer. The request carries evidence, never an execution
  // directory; model children run from the neutral one-shot cwd. Every miss resolves to the floor.
  ipcMain.handle(IpcChannels.sessionName, async (_event, rawArgs: unknown) => {
    const args = SessionNameRequestSchema.parse(rawArgs)
    return SessionNameResponseSchema.parse(await getEngineSessions().nameSession(args))
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

  // Refresh remembered shortcuts by their exact project-relative identities. Unlike fs:listDocs,
  // this does not walk or inherit the 300-row discovery cap; main still owns the identical Library
  // eligibility and metadata rules, and silently omits paths that have gone stale.
  ipcMain.handle(IpcChannels.libraryResolve, async (event, rawArgs: unknown) => {
    const { rels } = LibraryResolveRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return LibraryResolveResultSchema.parse({ root, docs: await resolveProjectDocs(root, rels) })
  })

  ipcMain.handle(IpcChannels.fsReadFile, async (event, rawArgs: unknown) => {
    const { path } = ReadFileRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    // A displayable image renders as a picture, not text. Skip reading its bytes into the renderer
    // (they'd just be a NUL-laden "binary" string) — resolve it to a contained koda-preview:// URL and
    // let the surface's <img> load it directly over the protocol.
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && isDisplayableImage(path)) {
      const file = containedReal(root, path) // realpath: throws on escape OR missing
      const rel = relative(root, file).split(sep).join('/')
      const imageUrl = previewAssetUrl(win.id, rel)
      if (imageUrl) {
        return ReadFileResultSchema.parse({ path: file, content: '', truncated: false, binary: true, imageUrl })
      }
    }
    return ReadFileResultSchema.parse(await readProjectFile(root, path))
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
  // engine write), THEN write. Alone among the edit paths a failed checkpoint does NOT refuse the
  // save — that would strand the user's typed work in the editor with nowhere to put it. It writes
  // and REPORTS instead, so the editor can say this one change has no undo behind it. Root is
  // resolved in main; the renderer never names the cwd.
  ipcMain.handle(IpcChannels.fsWriteFile, async (event, rawArgs: unknown) => {
    const { path, content } = WriteFileRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return getEngineSessions().withExternalProjectMutation(
      root,
      { checkpointLabel: `edit to ${basename(path)}` },
      async (checkpointed) =>
        withProjectDocsRefresh(root, async () =>
          WriteFileResultSchema.parse({ path: await writeProjectFile(root, path, content), checkpointed }),
        ),
    )
  })

  // Create a new empty document in Documents/ or a selected contained folder, then return its path.
  // `source` is the session the user made it from — it lands in the file's own `source:` frontmatter
  // rather than the docmeta sidecar, because the sidecar is keyed by a hash of the relative path and
  // so dies on the rename or move that is exactly when "where did this come from" is worth the most.
  ipcMain.handle(IpcChannels.fsCreateFile, async (event, rawArgs: unknown) => {
    const { name, parent, source } = CreateFileRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return getEngineSessions().withExternalProjectMutation(root, {}, async () =>
      withProjectDocsRefresh(root, async () =>
        CreateFileResultSchema.parse({ path: await createProjectFile(root, name, parent, source) }),
      ),
    )
  })

  // Rename/move a file/folder. Checkpoint the pre-move tree FIRST (so it's recoverable like an engine
  // edit), THEN rename. Returns the new path; the renderer rebases any open tab keyed by the old one.
  // Fail-soft on purpose (unlike the delete below): renameProjectPath refuses to clobber an existing
  // target, so no content is destroyed and the move undoes by moving it back.
  ipcMain.handle(IpcChannels.fsRenamePath, async (event, rawArgs: unknown) => {
    const { from, to } = RenamePathRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return getEngineSessions().withExternalProjectMutation(
      root,
      { checkpointLabel: `rename ${basename(from)}` },
      async () =>
        withProjectDocsRefresh(root, async () =>
          RenamePathResultSchema.parse({ path: await renameProjectPath(root, from, to) }),
        ),
    )
  })

  // Delete a file/folder. Checkpoint first so the delete is undoable from the recovery timeline — and
  // REFUSE if that undo point can't be taken, like the bulk replace. A delete with no checkpoint
  // behind it is unrecoverable, and the tree's own copy promises it can be undone.
  ipcMain.handle(IpcChannels.fsDeletePath, async (event, rawArgs: unknown) => {
    const { path, document } = DeletePathRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    if (document) {
      const prepared = await prepareProjectDocumentDelete(root, path)
      await withRequiredCheckpoint(
        root,
        `delete ${basename(prepared.path)}`,
        'nothing was deleted.',
        () => withProjectDocsRefresh(root, () => deleteProjectDocument(root, prepared)),
        prepared,
      )
      return
    }
    await withRequiredCheckpoint(root, `delete ${basename(path)}`, 'nothing was deleted.', () =>
      withProjectDocsRefresh(root, () => deleteProjectPath(root, path)),
    )
  })

  // Duplicate a file/folder as "<name> copy". Checkpoint first so the copy is undoable. Returns the
  // new path so the renderer can nudge its tree/docs list to re-read. Fail-soft like the import below:
  // both only ADD deduped new names (import writes with 'wx'), so a missing checkpoint costs nothing —
  // undoing an addition is deleting it, which the user can do by hand.
  ipcMain.handle(IpcChannels.fsDuplicatePath, async (event, rawArgs: unknown) => {
    const { path } = DuplicatePathRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return getEngineSessions().withExternalProjectMutation(
      root,
      { checkpointLabel: `duplicate ${basename(path)}` },
      async () =>
        withProjectDocsRefresh(root, async () =>
          DuplicatePathResultSchema.parse({ path: await duplicateProjectPath(root, path) }),
        ),
    )
  })

  // Import Finder-dragged files into a folder (or Documents/). Checkpoint first so the import is
  // undoable. Bytes ride over IPC; no external path is ever followed. Returns the new paths.
  ipcMain.handle(IpcChannels.fsImportFiles, async (event, rawArgs: unknown) => {
    const { destDir, files } = ImportFilesRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return getEngineSessions().withExternalProjectMutation(
      root,
      { checkpointLabel: `import ${files.length} file(s)` },
      async () =>
        withProjectDocsRefresh(root, async () =>
          ImportFilesResultSchema.parse({ paths: await importFilesIntoProject(root, destDir, files) }),
        ),
    )
  })

  // The native File-menu importer starts as a main→renderer command so an open modal can decline it.
  // Only after the renderer accepts does it invoke this picker; Electron menu accelerators bypass DOM
  // keydown/inert, so opening the dialog directly in the menu click would mutate behind the Library.
  ipcMain.handle(IpcChannels.fsImportFilesFromMenu, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const root = rootForSender(event.sender)
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    if (res.canceled || !res.filePaths.length) return null
    const files = await Promise.all(
      res.filePaths.map(async (path) => ({
        name: basename(path),
        data: new Uint8Array(await readFile(path)),
      })),
    )
    return getEngineSessions().withExternalProjectMutation(
      root,
      { checkpointLabel: `import ${files.length} file(s)` },
      async () =>
        withProjectDocsRefresh(root, async () =>
          ImportFilesResultSchema.parse({ paths: await importFilesIntoProject(root, undefined, files) }),
        ),
    )
  })

  // Reveal a file/folder in Finder. containedReal refuses any path outside the project root (and
  // resolves the symlinked root), so the renderer can only surface its own project's files.
  ipcMain.handle(IpcChannels.fsRevealPath, async (event, rawArgs: unknown) => {
    const { path } = RevealPathRequestSchema.parse(rawArgs)
    shell.showItemInFolder(containedReal(rootForSender(event.sender), path))
  })

  // Open a file/folder in the OS default app. Contained like reveal; shell.openPath returns a
  // non-empty string on failure (e.g. no handler) — surface it as an error the renderer can show.
  ipcMain.handle(IpcChannels.fsOpenPath, async (event, rawArgs: unknown) => {
    const { path } = OpenPathRequestSchema.parse(rawArgs)
    const err = await shell.openPath(containedReal(rootForSender(event.sender), path))
    if (err) throw new Error(err)
  })

  // Start a native OS drag of a project file/folder — the renderer preventDefaults its HTML5
  // dragstart and hands the gesture to us, so the file can land in Finder/Mail/a browser. Contained
  // like reveal/open. Resolving the invoke tells the renderer the native drag is underway (its
  // drag-state cleanup listeners only attach after that, so they can't fire mid-gesture).
  ipcMain.handle(IpcChannels.fsStartDrag, async (event, rawArgs: unknown) => {
    const { path } = StartDragRequestSchema.parse(rawArgs)
    const file = containedReal(rootForSender(event.sender), path)
    event.sender.startDrag({ file, icon: await app.getFileIcon(file) })
  })

  // Export the open doc as a PDF: lay the doc surface's rendered HTML on a clean print page in a
  // hidden window, printToPDF it, save where the user picks, then open the result. The doc's images
  // are koda-preview:// URLs, which the hidden window resolves through the same global protocol.
  ipcMain.handle(IpcChannels.docExportPdf, async (event, rawArgs: unknown) => {
    const { title, html } = ExportPdfRequestSchema.parse(rawArgs)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const safeName = (title.replace(/[/:]/g, '-').trim() || 'Document') + '.pdf'
    const picked = parent
      ? await dialog.showSaveDialog(parent, { defaultPath: join(app.getPath('downloads'), safeName) })
      : await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), safeName) })
    if (picked.canceled || !picked.filePath) return ExportPdfResultSchema.parse({ path: null })

    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PDF_CSS}</style></head><body><h1 class="koda-pdf-title">${escapeHtml(title)}</h1>${html}</body></html>`
    // Via a temp file, not a data: URL — a doc with a few images overflows Chromium's data-URL cap.
    const tmp = join(app.getPath('temp'), `koda-export-${Date.now()}.html`)
    await writeFile(tmp, page, 'utf8')
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    try {
      await win.loadFile(tmp)
      const pdf = await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: true })
      await writeFile(picked.filePath, pdf)
    } finally {
      win.destroy()
      await unlink(tmp).catch(() => {})
    }
    void shell.openPath(picked.filePath)
    return ExportPdfResultSchema.parse({ path: picked.filePath })
  })

  // Create a new folder (at the root, or inside `parent`) and return its path. No checkpoint.
  ipcMain.handle(IpcChannels.fsCreateDir, async (event, rawArgs: unknown) => {
    const { name, parent, home } = CreateDirRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    return getEngineSessions().withExternalProjectMutation(root, {}, async () =>
      withProjectDocsRefresh(root, async () =>
        CreateDirResultSchema.parse({ path: await createProjectDir(root, name, parent, home) }),
      ),
    )
  })

  // The Library's ONE read: documents narrowed by kind and by a query over titles, filenames and file
  // contents. Not `fs:search` with a filter on top — main reconciles the two exclusion sets once, in
  // `queryLibrary`, so no caller can produce a Library listing `CLAUDE.md`, a vendored skill file or a
  // dependency README. Read-only, contained + capped in the service like the other fs reads.
  ipcMain.handle(IpcChannels.libraryQuery, async (event, rawArgs: unknown) => {
    const req = LibraryQueryRequestSchema.parse(rawArgs)
    return LibraryQueryResultSchema.parse(await queryLibrary(rootForSender(event.sender), req))
  })

  // The Library's second door: a question answered across the project's documents AND the conversations
  // that produced them. Main does the retrieval (deterministic term matching over both corpora, no model
  // and no index) and the ENGINE writes the answer, through the same `buildEngineEnv()` chokepoint every
  // other engine spawn uses — Koda never calls a model itself, and never bills a path the user did not
  // choose. The ask runs on the engine of the CHAT it was launched from, so any capability refusal
  // names that engine and main reads it off the session itself; a renderer naming an engine would be
  // this surface picking a billing path on
  // the user's behalf. No chat behind the ask (the Library opened with none in front) falls back to the
  // engine the user last explicitly ran on.
  // A rejection here is a real failure and renders as one; it never renders as "found nothing".
  ipcMain.handle(IpcChannels.libraryAsk, async (event, rawArgs: unknown) => {
    const req = LibraryAskRequestSchema.parse(rawArgs)
    const sessions = getEngineSessions()
    const root = rootForSender(event.sender)
    const engineId = req.sessionId ? sessions.sessionEngine(root, req.sessionId) : undefined
    // A snapshotted owner that has since disappeared is not "no owner": falling through to the last
    // posture would silently move both the engine and billing path underneath the question.
    if (req.sessionId && !engineId) throw new Error('the chat this question was asked from is no longer open')

    const controller = new AbortController()
    const key = req.requestId ? libraryAskKey(event.sender, req.requestId) : undefined
    if (key) {
      libraryAskControllers.get(key)?.abort()
      libraryAskControllers.set(key, controller)
    }
    const onDestroyed = (): void => controller.abort()
    event.sender.once('destroyed', onDestroyed)
    try {
      return LibraryAskResultSchema.parse(
        await askLibrary(root, req, sessions.libraryAskRunner(engineId), controller.signal, {
          // Re-check after documents are walked, immediately before the session scan. A turn that
          // completes during retrieval makes the acknowledged renderer snapshot stale and the answer
          // partial; it can never silently disappear from a supposedly complete corpus.
          hotSessionsComplete: () => sessions.hotSessionSnapshotComplete(root, req.hotStoreSavedAt),
        }),
      )
    } finally {
      event.sender.removeListener('destroyed', onDestroyed)
      if (key && libraryAskControllers.get(key) === controller) libraryAskControllers.delete(key)
    }
  })

  ipcMain.on(IpcChannels.libraryAskCancel, (event, rawRequestId: unknown) => {
    if (typeof rawRequestId !== 'string' || !rawRequestId || rawRequestId.length > 128) return
    libraryAskControllers.get(libraryAskKey(event.sender, rawRequestId))?.abort()
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
    return withRequiredCheckpoint(root, `replace “${query}”`, 'nothing was replaced.', async () =>
      withProjectDocsRefresh(root, async () =>
        ReplaceResultSchema.parse(await replaceInProject(root, query, replacement, scope)),
      ),
    )
  })

  // ── Source Control (user-git — the real `.git`) ──────────────────────────────
  // Read-only detect/status/log + the only mutations init/commit. Root per-window; the renderer
  // never names a path. detect/status/log fail soft to "not a repo" inside the service.
  ipcMain.handle(IpcChannels.gitDetect, async (event) =>
    GitRepoInfoSchema.parse(await detectRepo(rootForSender(event.sender))),
  )

  ipcMain.handle(IpcChannels.gitStatus, async (event) => {
    const root = rootForSender(event.sender)
    const status = await getStatus(root)
    await getEngineSessions().refreshCompletionStatesForProject(root)
    return GitStatusResultSchema.parse(status)
  })

  ipcMain.handle(IpcChannels.gitGraph, async (event, rawArgs: unknown) => {
    const { limit } = GitGraphRequestSchema.parse(rawArgs)
    return GitCommitGraphResultSchema.parse(await getCommitGraph(rootForSender(event.sender), limit))
  })

  ipcMain.handle(IpcChannels.gitInit, async (event) => {
    const root = rootForSender(event.sender)
    const result = await initRepo(root)
    await getEngineSessions().refreshCompletionStatesForProject(root)
    return GitInitResultSchema.parse(result)
  })

  // Commit returns a TAGGED result — a UserGitError (no identity, nothing to commit, …) becomes
  // { ok:false, code } the renderer can branch on, instead of an Electron-wrapped reject string.
  ipcMain.handle(IpcChannels.gitCommit, async (event, rawArgs: unknown) => {
    const { message } = GitCommitRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    try {
      const { sha } = await commitAll(root, message)
      await getEngineSessions().refreshCompletionStatesForProject(root)
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
    const root = rootForSender(event.sender)
    try {
      const { sha } = await commitPaths(root, paths, message)
      await getEngineSessions().refreshCompletionStatesForProject(root)
      return GitCommitResultSchema.parse({ ok: true, sha })
    } catch (err) {
      if (err instanceof UserGitError) {
        return GitCommitResultSchema.parse({ ok: false, code: err.code, message: err.message })
      }
      throw err
    }
  })

  // Describe the save the user is about to make. Read-only (status + diff + recent subjects), then
  // the selected generated-text writer, with the deterministic floor for every miss.
  // Never rejects: a description that could fail would be a description that can block a save.
  ipcMain.handle(IpcChannels.gitProposeMessage, async (event, rawArgs: unknown) => {
    GitProposeMessageRequestSchema.parse(rawArgs)
    const root = rootForSender(event.sender)
    // Status first (cheap, and all the floor needs); the diff is read only if a turn will actually
    // run, so a save that takes the floor never pays for a whole `git diff` it cannot use.
    const status = await getStatus(root)
    return GitProposeMessageResultSchema.parse(
      await getEngineSessions().proposeVersionMessage({
        cwd: root,
        status,
        readEvidence: () => getChangeEvidence(root, status),
      }),
    )
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
    const root = rootForSender(event.sender)
    try {
      const res = await getEngineSessions().withExternalProjectMutation(root, {}, () =>
        restoreVersion(root, sha),
      )
      await getEngineSessions().refreshCompletionStatesForProject(root)
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
    try {
      const discarded = await getEngineSessions().withExternalProjectMutation(
        root,
        { checkpointLabel: `discard ${basename(path)}` },
        async (checkpointed) => {
          if (!checkpointed) return false
          await discardFile(root, path)
          return true
        },
      )
      if (!discarded) {
        return GitDiscardResultSchema.parse({
          ok: false,
          code: 'no_checkpoint',
          message: 'Could not create an undo point — nothing was removed.',
        })
      }
      await getEngineSessions().refreshCompletionStatesForProject(root)
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
    return ProjectContextSchema.parse({
      projectPath: (win && projectPathForWindow(win.id)) || '',
      // Read-and-clear: a ProjectHome window opened by "New Project…" lands on the create modal once.
      newProjectIntent: win ? takeNewProjectIntent(win.id) : false,
    })
  })

  // Native open-directory dialog, parented to the calling window. Starts in ~/Koda so opening a
  // project defaults to where Koda creates them, not wherever macOS last browsed.
  ipcMain.handle(IpcChannels.projectChooseFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = { properties: ['openDirectory'] as 'openDirectory'[], defaultPath: projectsHomeDir() }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return ChooseFolderResultSchema.parse({ path: res.canceled ? null : (res.filePaths[0] ?? null) })
  })

  // Open a folder as THIS window's project, in place. If another window already shows it, focus that
  // one and leave this window unchanged (block-and-focus, VSCode-style — one window per project).
  ipcMain.handle(IpcChannels.projectOpen, async (event, rawArgs: unknown) => {
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
    const { buildAppMenu } = await import('./index')
    buildAppMenu()
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
    const { buildAppMenu } = await import('./index')
    buildAppMenu()
    track('project_created', {})
    return ProjectOpenResultSchema.parse({ projectPath, alreadyOpen: false })
  })

  // Does this window's project already carry an agent-guidance file? Drives the one-time intake offer
  // (no guidelines ⇒ offer; present ⇒ leave them alone — never clobber a project's existing CLAUDE.md/
  // AGENTS.md). Filenames are constants joined to the contained project root → no traversal vector.
  // Asked once per project mount, which makes it the natural moment to heal a one-file project into
  // the shared-guide pair (healGuidelinesPair — a no-op everywhere else).
  ipcMain.handle(IpcChannels.projectHasGuidelines, (event) => {
    const root = rootForSender(event.sender)
    healGuidelinesPair(root)
    const hasGuidelines = GUIDELINES_FILES.some((f) => existsSync(join(root, f)))
    return ProjectHasGuidelinesResultSchema.parse({ hasGuidelines })
  })

  // Serve-time existence filter: a project folder deleted outside Koda (Finder, the agent) must not
  // linger as a dead launcher tile. The state file keeps the path — it ages out via the recents cap —
  // so a folder restored from the Trash reappears without ceremony.
  ipcMain.handle(IpcChannels.projectGetRecents, () =>
    RecentProjectsSchema.parse(loadAppState().recentProjects.filter((p) => existsSync(p))),
  )

  // The empty list above can mean two opposite things, and only main knows which. Asked by ProjectHome
  // (which would otherwise render a first-launch screen over a project list that exists and couldn't be
  // read) and by the data-integrity banner (billing). Read fresh per call — both facts un-latch when the
  // underlying file reads cleanly again, so a stale answer would outlive the problem.
  ipcMain.handle(IpcChannels.appDataIntegrity, () => {
    const state = appStateHealth()
    return DataIntegritySchema.parse({
      projectListUnreadable: state.unreadable,
      projectListBackupKept: state.backupKept,
      billingModeReset: settingsHealth().billingModeReset,
    })
  })

  // Delete a project: stop + deregister its mini apps, then move the folder (and its orphaned agent
  // worktrees, if any) to the Trash — recoverable, never rm. The path must come from the recents/apps
  // lists (same posture as miniApps:start: a compromised renderer can't trash arbitrary folders), and
  // the project can't be open in a window — closing it stays the user's explicit step, never something
  // main does out from under a live session.
  ipcMain.handle(IpcChannels.projectDelete, async (_event, rawArgs: unknown) => {
    const { path } = ProjectDeleteRequestSchema.parse(rawArgs)
    const known =
      loadAppState().recentProjects.includes(path) ||
      (await listMiniApps()).some((a) => a.projectPath === path)
    if (!known) throw new Error('that folder is not a Koda project')
    for (const win of BrowserWindow.getAllWindows()) {
      if (projectPathForWindow(win.id) === path) {
        throw new Error('this project is open in a window — close that window first')
      }
    }
    await deleteProjectApps(path)
    // Purge the project's session stores BEFORE trashing the folder — the engine's store slug depends on
    // the path's realpath, which stops resolving once the folder is gone. Otherwise a same-name project
    // recreated at this path re-adopts the old sessions.
    purgeProjectSessions(path)
    if (existsSync(path)) await shell.trashItem(path)
    const worktrees = join(dirname(path), '.worktrees', basename(path))
    if (existsSync(worktrees)) await shell.trashItem(worktrees)
    noteProjectDeleted(path)
    return ProjectDeleteResultSchema.parse({})
  })

  // Mini apps (the face — seam ③). List doubles as the renderer's feature gate: flag off ⇒ [] ⇒ no
  // launcher rail, no App/Workshop toggle — one flag, read live, same posture as the broker verbs.
  ipcMain.handle(IpcChannels.miniAppsList, async () =>
    MiniAppListSchema.parse(loadMiniAppsEnabled() ? await listMiniApps() : []),
  )

  // Registry/run-state changes push to every window (a project window opened BEFORE the agent built
  // its app must still learn the face exists — the graduation moment happens mid-session). Flag off ⇒
  // never fires (nothing can register), and the re-fetch would return [] anyway.
  onMiniAppsChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.miniAppsChanged)
  })

  // Start is registry-validated in mini-apps.ts — the renderer can only start apps the agent installed,
  // never run an arbitrary folder's entry command.
  ipcMain.handle(IpcChannels.miniAppsStart, async (_event, rawArgs: unknown) => {
    if (!loadMiniAppsEnabled()) throw new Error('mini apps are not enabled')
    const { dir } = MiniAppStartRequestSchema.parse(rawArgs)
    const { url } = await startRegisteredMiniApp(dir)
    return MiniAppStartResultSchema.parse({ url })
  })

  // Already-open handoff: the tile's project has a live window. Surface it properly (project:open only
  // calls focus(), which does nothing for a minimized/backgrounded window) and tell it to front the
  // app's face, so clicking a tile always lands on the running app instead of a dead "already open" note.
  ipcMain.handle(IpcChannels.miniAppsFront, async (_event, rawArgs: unknown) => {
    if (!loadMiniAppsEnabled()) return
    const { dir, projectPath } = MiniAppFrontRequestSchema.parse(rawArgs)
    const win = windowForProject(realpathSync(projectPath))
    if (!win) return // the window closed between list and click — the caller falls back to a fresh open
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IpcChannels.uiFrontFace, dir)
  })

  // Lane B bridge: the Settings "may use your API key" toggle + per-app spend. Names come from the
  // registry (the bridge store is keyed by dir only); same flag gate as the list.
  ipcMain.handle(IpcChannels.miniAppsBridgeInfo, async () => {
    if (!loadMiniAppsEnabled()) return MiniAppBridgeListSchema.parse([])
    const apps = await listMiniApps()
    const info = await Promise.all(
      apps.map(async (a) => {
        const s = await bridgeAppState(a.dir)
        return { dir: a.dir, name: a.name, consent: s.consent, spend: s.spend }
      }),
    )
    return MiniAppBridgeListSchema.parse(info)
  })
  ipcMain.handle(IpcChannels.miniAppsSetBridgeConsent, async (_event, rawArgs: unknown) => {
    const { dir, allowed } = MiniAppBridgeConsentRequestSchema.parse(rawArgs)
    // Only registered apps can be granted — a stray dir can't be pre-consented into the store.
    if (!(await listMiniApps()).some((a) => a.dir === dir)) throw new Error('that app is not registered')
    await setBridgeConsent(dir, allowed)
  })
  // Spend changes ride the existing miniApps:changed push so the Settings line refreshes live.
  setBridgeSpendListener(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.miniAppsChanged)
  })

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
