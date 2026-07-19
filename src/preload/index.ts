import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '@shared/channels'
import type {
  ApprovalCancelled,
  ApprovalResolved,
  ApprovalRequest,
  ArchiveRequested,
  AsideEvent,
  RenameRequested,
  EngineEvent,
  HeadlessAppeared,
  KodaApi,
  KodaSettings,
  VoiceEvent,
  PlaywrightStatus,
  RuntimeProgress,
  AuthProgress,
  CodexLoginProgress,
  ProviderStatusEvent,
  UpdateStatus,
  RemoteActivity,
  RemoteRelayState,
  RemoteUserTurnLive,
  TerminalData,
  TerminalExit,
  TerminalShow,
  PreviewRestart,
  FileMenuCommand,
} from '@shared/ipc'

const api: KodaApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.getAppInfo),
  echo: (args) => ipcRenderer.invoke(IpcChannels.echo, args),
  probeEngine: () => ipcRenderer.invoke(IpcChannels.probeEngine),
  getUpdateStatus: () => ipcRenderer.invoke(IpcChannels.updateGetState),
  checkForUpdates: () => ipcRenderer.invoke(IpcChannels.updateCheckNow),
  quitAndInstallUpdate: () => ipcRenderer.invoke(IpcChannels.updateQuitAndInstall),
  onUpdateStatus: (listener) => {
    const handler = (_e: IpcRendererEvent, status: UpdateStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.updateStatus, handler)
    return () => ipcRenderer.removeListener(IpcChannels.updateStatus, handler)
  },
  getWhatsNew: () => ipcRenderer.invoke(IpcChannels.updateWhatsNew),
  submitFeedback: (args) => ipcRenderer.invoke(IpcChannels.feedbackSubmit, args),
  startSession: (args) => ipcRenderer.invoke(IpcChannels.startSession, args),
  sendTurn: (args) => ipcRenderer.invoke(IpcChannels.sendTurn, args),
  interruptSession: (args) => ipcRenderer.invoke(IpcChannels.interruptSession, args),
  disposeSession: (args) => ipcRenderer.invoke(IpcChannels.disposeSession, args),
  loadSessions: () => ipcRenderer.invoke(IpcChannels.sessionsLoad),
  saveSessions: (data) => ipcRenderer.send(IpcChannels.sessionsSave, data),
  loadArchived: () => ipcRenderer.invoke(IpcChannels.archivedLoad),
  saveArchived: (archived) => ipcRenderer.send(IpcChannels.archivedSave, archived),
  loadArchivedBody: (id) => ipcRenderer.invoke(IpcChannels.archivedLoadBody, id),
  writeArchivedBody: (id, items) => ipcRenderer.invoke(IpcChannels.archivedWriteBody, { id, items }),
  deleteArchivedBody: (id) => ipcRenderer.invoke(IpcChannels.archivedDeleteBody, id),
  adoptHeadlessSessions: () => ipcRenderer.invoke(IpcChannels.sessionsAdoptHeadless),
  onHeadlessAppeared: (listener) => {
    const handler = (_e: IpcRendererEvent, payload: HeadlessAppeared) => listener(payload)
    ipcRenderer.on(IpcChannels.headlessAppeared, handler)
    return () => ipcRenderer.removeListener(IpcChannels.headlessAppeared, handler)
  },
  onArchiveRequested: (listener) => {
    const handler = (_e: IpcRendererEvent, payload: ArchiveRequested) => listener(payload)
    ipcRenderer.on(IpcChannels.sessionArchiveRequested, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sessionArchiveRequested, handler)
  },
  onRenameRequested: (listener) => {
    const handler = (_e: IpcRendererEvent, payload: RenameRequested) => listener(payload)
    ipcRenderer.on(IpcChannels.sessionRenameRequested, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sessionRenameRequested, handler)
  },
  onRemoteUserTurn: (listener) => {
    const handler = (_e: IpcRendererEvent, payload: RemoteUserTurnLive) => listener(payload)
    ipcRenderer.on(IpcChannels.sessionRemoteUserTurn, handler)
    return () => ipcRenderer.removeListener(IpcChannels.sessionRemoteUserTurn, handler)
  },
  onEngineEvent: (listener) => {
    // Wrap so the renderer never receives the raw IpcRendererEvent (no leak of
    // the ipc surface); hand it only the validated EngineEvent payload.
    const handler = (_e: IpcRendererEvent, event: EngineEvent) => listener(event)
    ipcRenderer.on(IpcChannels.engineEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.engineEvent, handler)
  },
  askAside: (args) => ipcRenderer.invoke(IpcChannels.askAside, args),
  cancelAside: (args) => ipcRenderer.invoke(IpcChannels.cancelAside, args),
  onAsideEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AsideEvent) => listener(event)
    ipcRenderer.on(IpcChannels.asideEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.asideEvent, handler)
  },
  listCheckpoints: () => ipcRenderer.invoke(IpcChannels.safetyList),
  restoreCheckpoint: (args) => ipcRenderer.invoke(IpcChannels.safetyRestore, args),
  checkpointChanges: (args) => ipcRenderer.invoke(IpcChannels.safetyChanges, args),
  checkpointFileDiff: (args) => ipcRenderer.invoke(IpcChannels.safetyFileDiff, args),
  logFromRenderer: (entry) => ipcRenderer.send(IpcChannels.rendererLog, entry),
  setAttentionCount: (count) => ipcRenderer.send(IpcChannels.setAttentionCount, { count }),
  assistTitle: (args) => ipcRenderer.invoke(IpcChannels.assistTitle, args),
  readDir: (args) => ipcRenderer.invoke(IpcChannels.fsReadDir, args),
  listDocs: (args) => ipcRenderer.invoke(IpcChannels.fsListDocs, args),
  readFile: (args) => ipcRenderer.invoke(IpcChannels.fsReadFile, args),
  writeFile: (args) => ipcRenderer.invoke(IpcChannels.fsWriteFile, args),
  watchFile: (args) => ipcRenderer.send(IpcChannels.fsWatchFile, args),
  unwatchFile: (args) => ipcRenderer.send(IpcChannels.fsUnwatchFile, args),
  onFileChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, path: string) => listener(path)
    ipcRenderer.on(IpcChannels.fsFileChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.fsFileChanged, handler)
  },
  watchDocs: () => ipcRenderer.send(IpcChannels.fsWatchDocs),
  unwatchDocs: () => ipcRenderer.send(IpcChannels.fsUnwatchDocs),
  onDocsChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IpcChannels.fsDocsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.fsDocsChanged, handler)
  },
  createFile: (args) => ipcRenderer.invoke(IpcChannels.fsCreateFile, args),
  renamePath: (args) => ipcRenderer.invoke(IpcChannels.fsRenamePath, args),
  deletePath: (args) => ipcRenderer.invoke(IpcChannels.fsDeletePath, args),
  duplicatePath: (args) => ipcRenderer.invoke(IpcChannels.fsDuplicatePath, args),
  importFiles: (args) => ipcRenderer.invoke(IpcChannels.fsImportFiles, args),
  revealPath: (args) => ipcRenderer.invoke(IpcChannels.fsRevealPath, args),
  openPath: (args) => ipcRenderer.invoke(IpcChannels.fsOpenPath, args),
  createDir: (args) => ipcRenderer.invoke(IpcChannels.fsCreateDir, args),
  diffFile: (args) => ipcRenderer.invoke(IpcChannels.fsDiffFile, args),
  search: (args) => ipcRenderer.invoke(IpcChannels.fsSearch, args),
  replaceAll: (args) => ipcRenderer.invoke(IpcChannels.fsReplaceAll, args),
  gitDetect: () => ipcRenderer.invoke(IpcChannels.gitDetect),
  gitStatus: () => ipcRenderer.invoke(IpcChannels.gitStatus),
  gitGraph: (args) => ipcRenderer.invoke(IpcChannels.gitGraph, args),
  gitInit: () => ipcRenderer.invoke(IpcChannels.gitInit),
  gitCommit: (args) => ipcRenderer.invoke(IpcChannels.gitCommit, args),
  gitCommitPaths: (args) => ipcRenderer.invoke(IpcChannels.gitCommitPaths, args),
  gitRenameHead: (args) => ipcRenderer.invoke(IpcChannels.gitRenameHead, args),
  gitRestoreVersion: (args) => ipcRenderer.invoke(IpcChannels.gitRestoreVersion, args),
  gitDiscardFile: (args) => ipcRenderer.invoke(IpcChannels.gitDiscardFile, args),
  gitFileDiff: (args) => ipcRenderer.invoke(IpcChannels.gitFileDiff, args),
  gitCommitChanges: (args) => ipcRenderer.invoke(IpcChannels.gitCommitChanges, args),
  gitBranchOverview: (args) => ipcRenderer.invoke(IpcChannels.gitBranchOverview, args),
  gitBranchFileDiff: (args) => ipcRenderer.invoke(IpcChannels.gitBranchFileDiff, args),
  gitDiscardBranch: (args) => ipcRenderer.invoke(IpcChannels.gitDiscardBranch, args),
  gitSyncState: () => ipcRenderer.invoke(IpcChannels.gitSyncState),
  gitPush: () => ipcRenderer.invoke(IpcChannels.gitPush),
  gitWorktrees: () => ipcRenderer.invoke(IpcChannels.gitWorktrees),
  gitMergedStrays: () => ipcRenderer.invoke(IpcChannels.gitMergedStrays),
  gitTidyStrays: (args) => ipcRenderer.invoke(IpcChannels.gitTidyStrays, args),
  openWorktree: (args) => ipcRenderer.invoke(IpcChannels.worktreeOpen, args),
  getProjectContext: () => ipcRenderer.invoke(IpcChannels.projectGetContext),
  chooseFolder: () => ipcRenderer.invoke(IpcChannels.projectChooseFolder),
  openProject: (args) => ipcRenderer.invoke(IpcChannels.projectOpen, args),
  createProject: (args) => ipcRenderer.invoke(IpcChannels.projectCreate, args),
  hasGuidelines: () => ipcRenderer.invoke(IpcChannels.projectHasGuidelines),
  getRecentProjects: () => ipcRenderer.invoke(IpcChannels.projectGetRecents),
  onFileMenuCommand: (listener) => {
    const handler = (_e: IpcRendererEvent, command: FileMenuCommand): void => listener(command)
    ipcRenderer.on(IpcChannels.uiFileCommand, handler)
    return () => ipcRenderer.removeListener(IpcChannels.uiFileCommand, handler)
  },
  deleteProject: (args) => ipcRenderer.invoke(IpcChannels.projectDelete, args),
  miniAppsList: () => ipcRenderer.invoke(IpcChannels.miniAppsList),
  miniAppsStart: (args) => ipcRenderer.invoke(IpcChannels.miniAppsStart, args),
  onMiniAppsChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IpcChannels.miniAppsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.miniAppsChanged, handler)
  },
  onApprovalRequest: (listener) => {
    const handler = (_e: IpcRendererEvent, req: ApprovalRequest) => listener(req)
    ipcRenderer.on(IpcChannels.approvalRequest, handler)
    return () => ipcRenderer.removeListener(IpcChannels.approvalRequest, handler)
  },
  onApprovalCancelled: (listener) => {
    const handler = (_e: IpcRendererEvent, e: ApprovalCancelled) => listener(e)
    ipcRenderer.on(IpcChannels.approvalCancelled, handler)
    return () => ipcRenderer.removeListener(IpcChannels.approvalCancelled, handler)
  },
  onApprovalResolved: (listener) => {
    const handler = (_e: IpcRendererEvent, e: ApprovalResolved) => listener(e)
    ipcRenderer.on(IpcChannels.approvalResolved, handler)
    return () => ipcRenderer.removeListener(IpcChannels.approvalResolved, handler)
  },
  resolveApproval: (args) => ipcRenderer.invoke(IpcChannels.approvalResolve, args),
  setApprovalMode: (args) => ipcRenderer.invoke(IpcChannels.approvalSetMode, args),
  getApprovalMode: () => ipcRenderer.invoke(IpcChannels.approvalGetMode),
  setModelEffort: (args) => ipcRenderer.invoke(IpcChannels.modelEffortSet, args),
  getRecentModels: () => ipcRenderer.invoke(IpcChannels.modelsGetRecent),
  addRecentModel: (args) => ipcRenderer.invoke(IpcChannels.modelsAddRecent, args),
  getCodexModels: () => ipcRenderer.invoke(IpcChannels.codexModels),
  getCodexAuthStatus: () => ipcRenderer.invoke(IpcChannels.codexAuthStatus),
  startCodexLogin: () => ipcRenderer.invoke(IpcChannels.codexLoginStart),
  cancelCodexLogin: () => ipcRenderer.invoke(IpcChannels.codexLoginCancel),
  onCodexLoginProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, event: CodexLoginProgress): void => listener(event)
    ipcRenderer.on(IpcChannels.codexLoginProgress, handler)
    return () => ipcRenderer.removeListener(IpcChannels.codexLoginProgress, handler)
  },
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IpcChannels.settingsSet, patch),
  resetSettings: () => ipcRenderer.invoke(IpcChannels.settingsReset),
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IpcChannels.uiOpenSettings, handler)
    return () => ipcRenderer.removeListener(IpcChannels.uiOpenSettings, handler)
  },
  onSettingsChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, settings: KodaSettings): void => listener(settings)
    ipcRenderer.on(IpcChannels.uiSettingsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannels.uiSettingsChanged, handler)
  },
  onFlushState: (listener) => {
    const handler = (): void => {
      listener()
      // Ack AFTER the listener's own sends — same-renderer IPC is FIFO, so the flushed save is
      // guaranteed to land in main before this does.
      ipcRenderer.send(IpcChannels.uiFlushStateDone)
    }
    ipcRenderer.on(IpcChannels.uiFlushState, handler)
    return () => ipcRenderer.removeListener(IpcChannels.uiFlushState, handler)
  },
  previewStaticUrl: (filePath?: string) =>
    ipcRenderer.invoke(IpcChannels.previewStaticUrl, filePath),
  docAssetUrl: (docPath: string, ref: string) =>
    ipcRenderer.invoke(IpcChannels.docAssetUrl, { docPath, ref }),
  previewRestart: (sessionId, restart) =>
    ipcRenderer.invoke(IpcChannels.previewRestart, { sessionId, restart }),
  onPreviewShow: (listener) => {
    const handler = (
      _e: IpcRendererEvent,
      payload: { url: string; sessionId: string; restart: PreviewRestart },
    ): void => listener(payload.url, payload.sessionId, payload.restart)
    ipcRenderer.on(IpcChannels.previewShow, handler)
    return () => ipcRenderer.removeListener(IpcChannels.previewShow, handler)
  },
  onPreviewCaptureRequest: (listener) => {
    const handler = (_e: IpcRendererEvent, payload: { correlationId: string }): void =>
      listener(payload.correlationId)
    ipcRenderer.on(IpcChannels.previewCaptureRequest, handler)
    return () => ipcRenderer.removeListener(IpcChannels.previewCaptureRequest, handler)
  },
  respondPreviewCapture: (correlationId, rect, dpr) =>
    ipcRenderer.send(IpcChannels.previewCaptureResponse, { correlationId, rect, dpr }),
  saveScratchImage: (args) => ipcRenderer.invoke(IpcChannels.scratchSave, args),
  pickComposerFiles: () => ipcRenderer.invoke(IpcChannels.composerPickFiles),
  pickComposerPath: () => ipcRenderer.invoke(IpcChannels.composerPickPath),
  listScratchImages: (args) => ipcRenderer.invoke(IpcChannels.scratchList, args),
  getDocMeta: (args) => ipcRenderer.invoke(IpcChannels.docmetaGet, args),
  setDocMeta: (args) => ipcRenderer.invoke(IpcChannels.docmetaSet, args),
  getMemoryWeight: () => ipcRenderer.invoke(IpcChannels.memoryWeight),
  getBackupStatus: () => ipcRenderer.invoke(IpcChannels.backupStatus),
  backupNow: () => ipcRenderer.invoke(IpcChannels.backupNow),
  getBackupRecoveryCode: () => ipcRenderer.invoke(IpcChannels.backupRecoveryCode),
  listCloudBackups: () => ipcRenderer.invoke(IpcChannels.backupList),
  restoreCloudBackup: (args) => ipcRenderer.invoke(IpcChannels.backupRestore, args),
  listGuardrails: () => ipcRenderer.invoke(IpcChannels.guardrailsList),
  saveGuardrail: (args) => ipcRenderer.invoke(IpcChannels.guardrailsSave, args),
  setGuardrailEnabled: (args) => ipcRenderer.invoke(IpcChannels.guardrailsSetEnabled, args),
  saveItemBody: (args) => ipcRenderer.invoke(IpcChannels.guardrailsSaveItemBody, args),
  removeGuardrailItem: (args) => ipcRenderer.invoke(IpcChannels.guardrailsRemoveItem, args),
  setRuleOverride: (args) => ipcRenderer.invoke(IpcChannels.guardrailsSetRuleOverride, args),
  listSkills: () => ipcRenderer.invoke(IpcChannels.skillsList),
  setSkillActive: (args) => ipcRenderer.invoke(IpcChannels.skillsSetActive, args),
  startVoice: () => ipcRenderer.invoke(IpcChannels.voiceStart),
  stopVoice: () => ipcRenderer.invoke(IpcChannels.voiceStop),
  onVoiceEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: VoiceEvent): void => listener(event)
    ipcRenderer.on(IpcChannels.voiceEvent, handler)
    return () => ipcRenderer.removeListener(IpcChannels.voiceEvent, handler)
  },
  playwrightStatus: () => ipcRenderer.invoke(IpcChannels.playwrightStatus),
  enablePlaywright: () => ipcRenderer.invoke(IpcChannels.playwrightEnable),
  onPlaywrightProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, status: PlaywrightStatus): void => listener(status)
    ipcRenderer.on(IpcChannels.playwrightProgress, handler)
    return () => ipcRenderer.removeListener(IpcChannels.playwrightProgress, handler)
  },
  getRuntimeStatus: (runtime) => ipcRenderer.invoke(IpcChannels.runtimeStatus, runtime),
  installRuntime: (runtime) => ipcRenderer.invoke(IpcChannels.runtimeInstall, runtime),
  onRuntimeProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, event: RuntimeProgress): void => listener(event)
    ipcRenderer.on(IpcChannels.runtimeProgress, handler)
    return () => ipcRenderer.removeListener(IpcChannels.runtimeProgress, handler)
  },
  detectAuth: () => ipcRenderer.invoke(IpcChannels.authDetect),
  startLogin: () => ipcRenderer.invoke(IpcChannels.authLoginStart),
  submitAuthCode: (code) => ipcRenderer.invoke(IpcChannels.authSubmitCode, code),
  cancelLogin: () => ipcRenderer.invoke(IpcChannels.authLoginCancel),
  onAuthProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AuthProgress): void => listener(event)
    ipcRenderer.on(IpcChannels.authProgress, handler)
    return () => ipcRenderer.removeListener(IpcChannels.authProgress, handler)
  },
  getBillingState: () => ipcRenderer.invoke(IpcChannels.billingGetState),
  getUsageHistory: () => ipcRenderer.invoke(IpcChannels.usageGetHistory),
  saveApiKey: (key) => ipcRenderer.invoke(IpcChannels.billingSaveApiKey, key),
  removeApiKey: () => ipcRenderer.invoke(IpcChannels.billingRemoveApiKey),
  saveCodexApiKey: (key) => ipcRenderer.invoke(IpcChannels.billingSaveCodexApiKey, key),
  removeCodexApiKey: () => ipcRenderer.invoke(IpcChannels.billingRemoveCodexApiKey),
  activateApiFallback: (req) => ipcRenderer.invoke(IpcChannels.billingActivateFallback, req),
  getRemoteState: () => ipcRenderer.invoke(IpcChannels.remoteGetState),
  setRemoteEnabled: (args) => ipcRenderer.invoke(IpcChannels.remoteSetEnabled, args),
  newRemoteCode: () => ipcRenderer.invoke(IpcChannels.remoteNewCode),
  revokeRemoteDevice: (args) => ipcRenderer.invoke(IpcChannels.remoteRevoke, args),
  onRemoteActivity: (listener) => {
    const handler = (_e: IpcRendererEvent, activity: RemoteActivity): void => listener(activity)
    ipcRenderer.on(IpcChannels.remoteActivity, handler)
    return () => ipcRenderer.removeListener(IpcChannels.remoteActivity, handler)
  },
  onProviderStatus: (listener) => {
    const handler = (_e: IpcRendererEvent, ev: ProviderStatusEvent): void => listener(ev)
    ipcRenderer.on(IpcChannels.providerStatus, handler)
    return () => ipcRenderer.removeListener(IpcChannels.providerStatus, handler)
  },
  getProviderStatus: () => ipcRenderer.invoke(IpcChannels.providerStatusGet),
  refreshProviderStatus: (engines: string[]) =>
    ipcRenderer.invoke(IpcChannels.providerStatusRefresh, engines),
  getRemoteAuth: () => ipcRenderer.invoke(IpcChannels.remoteAuthState),
  requestRemoteOtp: (args) => ipcRenderer.invoke(IpcChannels.remoteRequestOtp, args),
  verifyRemoteOtp: (args) => ipcRenderer.invoke(IpcChannels.remoteVerifyOtp, args),
  signOutRemoteAccount: () => ipcRenderer.invoke(IpcChannels.remoteSignOut),
  getRelayState: () => ipcRenderer.invoke(IpcChannels.remoteRelayState),
  getCloudRelayEnabled: () => ipcRenderer.invoke(IpcChannels.remoteCloudEnabled),
  pairRelayDevice: () => ipcRenderer.invoke(IpcChannels.remoteRelayPair),
  forgetRelayDevice: () => ipcRenderer.invoke(IpcChannels.remoteRelayForget),
  onRelayActivity: (listener) => {
    const handler = (_e: IpcRendererEvent, state: RemoteRelayState): void => listener(state)
    ipcRenderer.on(IpcChannels.remoteRelayActivity, handler)
    return () => ipcRenderer.removeListener(IpcChannels.remoteRelayActivity, handler)
  },
  startTerminal: (size) => ipcRenderer.invoke(IpcChannels.terminalStart, size),
  sendTerminalInput: (args) => ipcRenderer.send(IpcChannels.terminalInput, args),
  resizeTerminal: (size) => ipcRenderer.send(IpcChannels.terminalResize, size),
  onTerminalData: (listener) => {
    const handler = (_e: IpcRendererEvent, chunk: TerminalData): void => listener(chunk)
    ipcRenderer.on(IpcChannels.terminalData, handler)
    return () => ipcRenderer.removeListener(IpcChannels.terminalData, handler)
  },
  onTerminalExit: (listener) => {
    const handler = (_e: IpcRendererEvent, info: TerminalExit): void => listener(info)
    ipcRenderer.on(IpcChannels.terminalExit, handler)
    return () => ipcRenderer.removeListener(IpcChannels.terminalExit, handler)
  },
  onTerminalShow: (listener) => {
    const handler = (_e: IpcRendererEvent, info: TerminalShow): void => listener(info)
    ipcRenderer.on(IpcChannels.terminalShow, handler)
    return () => ipcRenderer.removeListener(IpcChannels.terminalShow, handler)
  },
}

// contextIsolation is mandatory (overview.md §6). If it is ever off, refuse to
// expose the bridge rather than leak ipcRenderer onto the page.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('koda', api)
} else {
  throw new Error('contextIsolation is disabled — refusing to expose the Koda bridge')
}
