/**
 * IPC channel names — the single source of truth for both main and preload.
 * Kept free of any runtime deps (no zod) so the preload bundle stays minimal.
 */
export const IpcChannels = {
  getAppInfo: 'app:getInfo',
  echo: 'app:echo',
  probeEngine: 'engine:probe',
  // Engine adapter — commands flow renderer→main (invoke); normalized events
  // flow main→renderer (push) over the single `engineEvent` channel.
  startSession: 'engine:startSession',
  sendTurn: 'engine:sendTurn',
  interruptSession: 'engine:interrupt',
  disposeSession: 'engine:dispose',
  engineEvent: 'engine:event',
  // Side questions ("btw" / aside) — a throwaway one-shot fork of the live session; the answer streams
  // back over `asideEvent` and never enters the conversation.
  askAside: 'aside:ask',
  cancelAside: 'aside:cancel',
  asideEvent: 'aside:event',
  // Safety-git recovery surface (Settings → Recovery) — project-scoped timeline + restore + the
  // "what would going back undo" diff (changed files + per-file before/after).
  safetyList: 'safety:list',
  safetyRestore: 'safety:restore',
  safetyChanges: 'safety:changes',
  safetyFileDiff: 'safety:fileDiff',
  // Multi-session persistence — open sessions + their transcripts survive an app restart.
  // load = invoke (returns the saved blob); save = send (fire-and-forget, debounced in the renderer).
  sessionsLoad: 'sessions:load',
  sessionsSave: 'sessions:save',
  // Archived sessions live in their own COLD per-project file (they'd otherwise ride the hot blob
  // above, which is rewritten every ~500ms while streaming — the 53MB-freeze bug). load = invoke on
  // boot; save = send, fired only when the archived list actually changes (archive/restore/delete).
  archivedLoad: 'sessions:archivedLoad',
  archivedSave: 'sessions:archivedSave',
  // Desktop adoption of phone-started sessions — a session the phone launched runs windowless on the
  // Mac (invisible to the desktop otherwise). adoptHeadless = invoke (this window claims its project's
  // live headless sessions + gets their replayable history); headlessAppeared = main→renderer push (a
  // phone just started/resumed a session in a project this window has open → adopt it live). See
  // EngineSessionManager.adoptHeadlessForWindow.
  sessionsAdoptHeadless: 'sessions:adoptHeadless',
  headlessAppeared: 'sessions:headlessAppeared',
  // The phone asked to archive a past session in a project a window has open — the renderer owns that
  // project's session store while open (its whole-blob saves would clobber a main-side file write), so
  // main forwards the request and the renderer archives it (store.archiveSession → its normal persist).
  // main→renderer push. Windowless projects skip this: main writes the store directly (archiveRemote).
  sessionArchiveRequested: 'sessions:archiveRequested',
  // Same two-owner rule for a phone RENAME of a live session in a windowed project: main forwards,
  // the renderer renames (store.renameSession → its normal persist). main→renderer push.
  sessionRenameRequested: 'sessions:renameRequested',
  // A phone turn landed on a session a window already OWNS (it adopted the session empty, before this
  // turn). The engine stream never echoes the human's prompt, so main forwards it to that window only
  // (not the remote sinks — the sending phone shows its own optimistic bubble) → the renderer appends
  // the user turn and runs first-turn titling. main→renderer push.
  sessionRemoteUserTurn: 'sessions:remoteUserTurn',
  // Renderer warnings/errors forwarded into the main-process log file (send, not invoke).
  rendererLog: 'app:rendererLog',
  // Count of sessions needing attention → the macOS dock badge (send, not invoke).
  setAttentionCount: 'app:setAttentionCount',
  // Local-assist: on-device QoL micro-tasks (e.g. a clean session title). invoke; falls back
  // to a deterministic string in main, so the renderer always gets a usable answer.
  assistTitle: 'assist:title',
  // Project Files browser — path-contained to the project root, size-capped. invoke.
  // readDir/readFile are read-only; writeFile (the editor's save) checkpoints via safety-git first.
  fsReadDir: 'fs:readDir',
  // Flat recency-sorted list of the project's prose docs (the doc-first sidebar). Read-only. invoke.
  fsListDocs: 'fs:listDocs',
  fsReadFile: 'fs:readFile',
  fsWriteFile: 'fs:writeFile',
  // Live file watching, scoped to the paths a `file` surface currently has open. watch/unwatch =
  // renderer→main (send) as an editor mounts/unmounts; fileChanged = main→renderer push when that
  // file changes on disk (agent, another session, external editor) so the open editor re-reads.
  // See file-watch.ts.
  fsWatchFile: 'fs:watchFile',
  fsUnwatchFile: 'fs:unwatchFile',
  fsFileChanged: 'fs:fileChanged',
  // Live watching of the Documents/ folder so the doc-first sidebar refreshes on agent/external
  // adds+removes, not just UI-initiated ones. watch/unwatch = renderer→main (send) as the docs sidebar
  // mounts/unmounts; docsChanged = main→renderer push when the folder changes. See docs-watch.ts.
  fsWatchDocs: 'fs:watchDocs',
  fsUnwatchDocs: 'fs:unwatchDocs',
  fsDocsChanged: 'fs:docsChanged',
  // Create a new empty document at the project root (the "New document" entry point). invoke.
  fsCreateFile: 'fs:createFile',
  // File-management mutations (rename/move, delete, new folder). rename/delete checkpoint via
  // safety-git first (recoverable, like an engine edit); new folder doesn't (an empty dir is
  // trivially discardable + git doesn't track it). All path-contained to the project root. invoke.
  fsRenamePath: 'fs:renamePath',
  fsDeletePath: 'fs:deletePath',
  fsCreateDir: 'fs:createDir',
  // Duplicate a file/folder ("<name> copy"), and import files dragged in from Finder into a folder
  // (or Documents/). Both add files → checkpoint via safety-git first (recoverable). Path-contained
  // to the project root; import writes external bytes, never follows an external path. invoke.
  fsDuplicatePath: 'fs:duplicatePath',
  fsImportFiles: 'fs:importFiles',
  // Basic Mac QoL from the Files right-click: reveal a file/folder in Finder, or open it in the OS
  // default app. Read-only shell actions, path-contained to the project root. invoke.
  fsRevealPath: 'fs:revealPath',
  fsOpenPath: 'fs:openPath',
  // Live-edits diff: a file's pre-edit state (safety-git HEAD) vs its current contents. Read-only.
  fsDiffFile: 'fs:diffFile',
  // Project-wide find (the Find overlay) — filename + content matches across the project root,
  // contained + capped like the other fs reads. Read-only. invoke.
  fsSearch: 'fs:search',
  // Project-wide replace — checkpoints the tree via safety-git first (undoable as one step), then
  // rewrites every case-insensitive occurrence. invoke.
  fsReplaceAll: 'fs:replaceAll',
  // User-git (the real `.git`) — the "Versions" panel. detect/status/graph/review are read-only;
  // init/commit + the user-confirmed discardBranch are the mutations. All per-window root.
  gitDetect: 'git:detect',
  gitStatus: 'git:status',
  gitGraph: 'git:graph',
  gitInit: 'git:init',
  gitCommit: 'git:commit',
  gitCommitPaths: 'git:commitPaths',
  // Reword the just-saved version (amend HEAD's message) — the "Rename" on a one-click save. Safe
  // only while that version is still HEAD; the main process refuses otherwise (no history rewrite).
  gitRenameHead: 'git:renameHead',
  // Restore a past version's files as a NEW version on top (clean-tree gated; never rewrites history).
  gitRestoreVersion: 'git:restoreVersion',
  // Discard ONE file's uncommitted change — revert an edit to the last version, or remove a new file.
  // Safety-git checkpoints the tree first (so it's undoable from the recovery timeline).
  gitDiscardFile: 'git:discardFile',
  // A changed file's diff "since the last version" (user-git HEAD → working tree), or a commit's
  // own change (ref^ → ref); + the files a given commit changed. Read-only.
  gitFileDiff: 'git:fileDiff',
  gitCommitChanges: 'git:commitChanges',
  // Branch Review: an unmerged branch's commits + combined diff, a per-file diff, and the discard op.
  gitBranchOverview: 'git:branchOverview',
  gitBranchFileDiff: 'git:branchFileDiff',
  gitDiscardBranch: 'git:discardBranch',
  // Backup: remote sync-state (read-only, never fetches) + push the current branch. Remote SETUP
  // (create a repo, sign in) is the agent's job — no channel for it on purpose.
  gitSyncState: 'git:syncState',
  gitPush: 'git:push',
  // Worktrees a past session left behind: list them (with their stranded dirty count) + open one in
  // its own window.
  gitWorktrees: 'git:worktrees',
  worktreeOpen: 'git:worktreeOpen',
  // Leftovers from finished work: merged branches (+ their clean checkouts) and the safe tidy.
  gitMergedStrays: 'git:mergedStrays',
  gitTidyStrays: 'git:tidyStrays',
  // One-project-per-window: a window asks which project it is (or '' for ProjectHome), picks a
  // folder (native dialog), opens one in-place, and lists recents for the ProjectHome screen.
  projectGetContext: 'project:getContext',
  projectChooseFolder: 'project:chooseFolder',
  projectCreate: 'project:create',
  projectHasGuidelines: 'project:hasGuidelines',
  projectOpen: 'project:open',
  projectGetRecents: 'project:getRecents',
  // Approval gate — the permission broker's "Ask me" round-trip. A request pushes
  // main→renderer; the user's decision + the mode setting flow renderer→main.
  approvalRequest: 'approval:request',
  approvalCancelled: 'approval:cancelled',
  // One specific request was answered (on ANY head) — clear just that prompt. Distinct from
  // approvalCancelled (whole-session void); needed so a second head's stale prompt doesn't latch.
  approvalResolved: 'approval:resolved',
  approvalResolve: 'approval:resolve',
  approvalSetMode: 'approval:setMode',
  approvalGetMode: 'approval:getMode',
  // Per-session model/effort intent, pushed at pick time (mirrors approvalSetMode's broadcast contract).
  modelEffortSet: 'engine:setModelEffort',
  // Model picker — the full model ids the user has chosen, so an older fallback model becomes a
  // quick-pick next time (Koda can't enumerate available models; see AddRecentModelSchema).
  modelsGetRecent: 'models:getRecent',
  modelsAddRecent: 'models:addRecent',
  codexModels: 'engine:codexModels',
  codexAuthStatus: 'engine:codexAuthStatus',
  // Codex (ChatGPT OAuth) sign-in — loginStart = invoke (spawns `codex login`, fire-and-forget);
  // loginCancel = invoke; progress = main→renderer push (awaiting-browser/verifying/completed/failed/
  // cancelled/timeout). Loopback flow (localhost:1455 callback) → no code-paste step. See codex-auth.ts.
  codexLoginStart: 'engine:codexLoginStart',
  codexLoginCancel: 'engine:codexLoginCancel',
  codexLoginProgress: 'engine:codexLoginProgress',
  // App preferences (the Settings pane). get = invoke (full settings); set = invoke (merge a
  // partial, returns the updated full settings). Per-session posture/model live elsewhere.
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // DEV-only retest affordance: wipe all settings to defaults (re-shows onboarding). See Settings → Developer.
  settingsReset: 'settings:reset',
  // Open the Settings pane in the focused window — sent from the app-menu "Settings…" item (⌘,).
  // main→renderer (send, not invoke).
  uiOpenSettings: 'ui:openSettings',
  // Settings changed (in any window) — broadcast to ALL windows so each one's live gates (notification
  // pref, default approval posture) stay in sync without a restart. main→renderer (send).
  uiSettingsChanged: 'ui:settingsChanged',
  // Quit flush — main asks each window to fire its pending debounced state save NOW (push), and the
  // preload acks once it's sent (send). app.exit() never fires unload events, so without this a turn
  // finished inside the save-debounce window would be lost at ⌘Q. See flushRendererState (index.ts).
  uiFlushState: 'ui:flushState',
  uiFlushStateDone: 'ui:flushStateDone',
  // Preview surface — the window's static-preview entry URL (invoke); and a main→renderer push telling
  // the renderer to show a preview URL (the agent started the managed dev server). See preview.ts.
  previewStaticUrl: 'preview:staticUrl',
  previewShow: 'preview:show',
  // Re-run a session's last preview (dev command or static file) when it's gone — the user-facing
  // "Restart preview" button. A window-direct invoke (like previewStaticUrl), NOT the agent's gated
  // capability: it re-runs a command the user already saw the agent run. See preview.ts.
  previewRestart: 'preview:restart',
  // Agent-sees-preview (preview-surface.md, Rung 3): main asks the window's renderer for the preview
  // iframe's on-screen rect (request push → response send, correlated by id), then captures those
  // pixels via webContents.capturePage and returns them to the agent through the broker. See preview.ts.
  previewCaptureRequest: 'preview:captureRequest',
  previewCaptureResponse: 'preview:captureResponse',
  // Persist a pasted/dropped image to the project's scratch folder; returns its relative path. See scratch.ts.
  scratchSave: 'scratch:save',
  // List the project's recent scratch images (newest first) for the Recent images strip. See scratch.ts.
  scratchList: 'scratch:list',
  // Read/write a doc's presentation sidecar (table column widths, …) under `.koda/docmeta/`. The doc
  // file stays canonical markdown; layout state lives beside it. invoke. See docmeta.ts.
  docmetaGet: 'docmeta:get',
  docmetaSet: 'docmeta:set',
  // How heavy this project's always-injected memory pair (MEMORY.md + active-context.md) is — powers
  // the status-bar tidy pill + Settings → Memory. Read-only. invoke. See engine/pack.ts.
  memoryWeight: 'memory:weight',
  // The behavior layer (Settings → Guardrails) — enumerates the curated Koda pack + this project's
  // own rules/skills/subagents shaping the agent. Read-only. invoke. See guardrails.ts.
  guardrailsList: 'guardrails:list',
  // Write a typed/pasted rule/skill/subagent straight to this project (the "Save" authoring path —
  // no agent round-trip). Checkpointed in main before the write. invoke. See guardrails.ts.
  guardrailsSave: 'guardrails:save',
  // Switch a bundled Koda default off/on for this project (persists to .koda/guardrails.json; the
  // engine reads it at session spawn). invoke. See guardrails-config.ts.
  guardrailsSetEnabled: 'guardrails:setEnabled',
  // Save an edited skill/subagent body into the project (forks a Koda default; overwrites a project one) /
  // remove a project skill/subagent (the default reappears if it was a fork). Checkpointed. invoke.
  guardrailsSaveItemBody: 'guardrails:saveItemBody',
  guardrailsRemoveItem: 'guardrails:removeItem',
  // Edit a Koda rule principle's wording for this project, or restore the bundled default. The override
  // is injected at the prompt seam + member rules drop. Checkpointed. invoke. See guardrails.ts.
  guardrailsSetRuleOverride: 'guardrails:setRuleOverride',
  // The skills gallery (Settings → Skills) — the bundled, curated Apache-2.0 subset of Anthropic's
  // Agent Skills. list = invoke (catalog + per-skill active scopes); setActive = invoke (turn a skill
  // on/off globally or per-project; project writes are checkpointed). See engine/skills-catalog.ts.
  skillsList: 'skills:list',
  skillsSetActive: 'skills:setActive',
  // Voice input (push-to-talk dictation) — on-device macOS Speech. start/stop are renderer→main
  // (invoke); transcript events stream main→renderer (push) over `voiceEvent`. See voice/index.ts.
  voiceStart: 'voice:start',
  voiceStop: 'voice:stop',
  voiceEvent: 'voice:event',
  // Optional Playwright browser-testing capability (Settings → Browser testing). status = invoke
  // (current install state); enable = invoke (toggle on → background Chromium download); progress =
  // push main→renderer (download state/log lines). The setting itself rides settings:get/set. See
  // playwright/index.ts.
  playwrightStatus: 'playwright:status',
  playwrightEnable: 'playwright:enable',
  playwrightProgress: 'playwright:progress',
  // On-demand runtime provisioning (Node / Python) — all keyed by a runtime id. status = invoke; install
  // = invoke (fire-and-forget, streams progress); progress = main→renderer push. See runtime/provision.ts.
  runtimeStatus: 'runtime:status',
  runtimeInstall: 'runtime:install',
  runtimeProgress: 'runtime:progress',
  // Onboarding sign-in — subscription OAuth via the bundled CLI. detect = invoke (adaptive ✓ when
  // already signed in); loginStart = invoke (spawns `claude auth login`, fire-and-forget); submitCode =
  // invoke (writes the browser code to the child's stdin); loginCancel = invoke; progress = main→renderer
  // push (awaiting-code/verifying/completed/failed/cancelled/timeout). See auth.ts.
  authDetect: 'auth:detect',
  authLoginStart: 'auth:loginStart',
  authSubmitCode: 'auth:submitCode',
  authLoginCancel: 'auth:loginCancel',
  authProgress: 'auth:progress',
  // Billing mode (Settings → Account). getState = invoke (mode + whether a key is stored + the engine's
  // mode-aware verdict); saveApiKey = invoke (validate + store encrypted + switch to API mode);
  // removeApiKey = invoke (clear + back to subscription). The key never crosses to the renderer. See
  // api-key.ts + auth.ts.
  billingGetState: 'billing:getState',
  // Daily usage history rollup (Settings → Usage) — read-only.
  usageGetHistory: 'usage:getHistory',
  billingSaveApiKey: 'billing:saveApiKey',
  billingRemoveApiKey: 'billing:removeApiKey',
  // OpenAI/Codex BYO key (Settings → OpenAI): its own provider account + key slot, mirrors the pair above.
  billingSaveCodexApiKey: 'billing:saveCodexApiKey',
  billingRemoveCodexApiKey: 'billing:removeCodexApiKey',
  // 'auto' mode only: the user confirmed continuing on the API key after hitting the plan limit. Marks
  // API billing effective until the rejected window resets; live sessions reattach on API next turn.
  billingActivateFallback: 'billing:activateFallback',
  // Remote Control (Settings → Remote) — drive the live agent from a phone on the LAN
  // (remote-control-security.md, Phase 0 walking skeleton). getState = invoke (running/url/pairing
  // code/devices/connected count); setEnabled = invoke (start/stop the LAN server); newCode = invoke
  // (rotate the pairing code); revoke = invoke (drop a paired device). activity = main→renderer push
  // (connected-client count → the "remote session active" indicator). See remote/server.ts.
  remoteGetState: 'remote:getState',
  remoteSetEnabled: 'remote:setEnabled',
  remoteNewCode: 'remote:newCode',
  remoteRevoke: 'remote:revoke',
  remoteActivity: 'remote:activity',
  // Cloud relay account (Phase 1b) — email-OTP sign-in so the Mac + phone share one Supabase account
  // (owner-scoped rc:<uid>:* channels). authState = invoke (signed-in/email); requestOtp/verifyOtp =
  // invoke (the 6-digit code flow); signOut = invoke. See remote/auth-otp.ts.
  remoteAuthState: 'remote:authState',
  remoteRequestOtp: 'remote:requestOtp',
  remoteVerifyOtp: 'remote:verifyOtp',
  remoteSignOut: 'remote:signOut',
  // Cloud relay (Phase 1b) — the outbound Supabase Realtime door + QR pairing. relayState = invoke
  // (signed-in/running/paired); relayPair = invoke (start the relay + issue a pairing blob for the QR).
  // relayActivity = main→renderer push (paired state changed). See remote/relay.ts.
  remoteRelayState: 'remote:relayState',
  remoteRelayPair: 'remote:relayPair',
  // Forget the paired phone (drop the relay + relay keys) WITHOUT signing out of the cloud account —
  // a local kill switch when you have the Mac in hand. See remote/relay.ts.
  remoteRelayForget: 'remote:relayForget',
  remoteRelayActivity: 'remote:relayActivity',
  // Cloud-relay feature flag (LAN-only first release) — invoke, returns whether the from-anywhere
  // tier is enabled on this Mac; the renderer hides every cloud surface when it's off. See settings.ts.
  remoteCloudEnabled: 'remote:cloudEnabled',
  // Provider-outage watch — providerStatus = main→renderer push (an engine's provider entered/left a
  // feed-confirmed outage → the status-bar pill); providerStatusGet = invoke (seed a window that opens
  // mid-outage). See engine/status-watch.ts.
  providerStatus: 'status:provider',
  providerStatusGet: 'status:providerGet',
  // App self-update (releases-and-updates.md) — getState = invoke (seed a window with the current
  // update status); checkNow = invoke (manual "Check for updates"); quitAndInstall = invoke (restart
  // into a downloaded update). status = main→renderer push (checking/downloading/ready/up-to-date/
  // error) → the passive restart banner + Settings surface. whatsNew = invoke (the current version's
  // release notes, returned once per update → the "What's New" popup). See updater.ts.
  updateGetState: 'update:getState',
  updateCheckNow: 'update:checkNow',
  updateQuitAndInstall: 'update:quitAndInstall',
  updateStatus: 'update:status',
  updateWhatsNew: 'update:whatsNew',
  // In-app feedback — invoke: post the user's typed feedback (message + optional email) to the
  // Supabase `feedback` edge fn, which writes a row to the private feedback inbox. See main/feedback.ts.
  feedbackSubmit: 'feedback:submit',
  // Terminal surface (a Dock tool) — a real interactive shell in the window's project, for the
  // power user who needs to run things themselves. start = invoke (spawn/ensure the window's pty at
  // cols×rows; respawns if the prior shell exited); input/resize = renderer→main (send). data/exit
  // stream main→renderer (push). One pty per window, killed on window close. See terminal.ts.
  terminalStart: 'terminal:start',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  // main→renderer push: the agent asked Koda to pop the terminal shelf open (open_terminal tool),
  // optionally staging a command at the prompt (never auto-run). See terminal.ts / broker.
  terminalShow: 'terminal:show',
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
