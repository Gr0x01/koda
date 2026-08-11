/**
 * Persistent app settings — a tiny JSON file in userData. Deliberately NOT a library (a couple of
 * user preferences don't justify one). Today it holds just the approval mode so "Ask me" survives a
 * restart; add keys here as real settings appear. All access is fail-soft: a bad/missing file falls
 * back to defaults, and a failed write never breaks the caller (the in-memory value still applies).
 *
 * Unlike session-store.ts, a corrupt settings file does NOT refuse the next write: every loader below
 * already reads its own field with its own per-call fallback, so the data is effectively lost at READ
 * time regardless — a write-refusal would only protect a `{}` that's already forensically useless. What
 * still matters: telling first-run (absent, benign) apart from real corruption (log it), keeping a copy
 * of the unreadable file before the next write overwrites it, and not letting `billingMode` revert from
 * 'api' to 'subscription' with nothing said (CLAUDE.md: billing-mode changes are "user-visible, never
 * silent") — see `noteCorruptRead`, which both warns ONCE and latches the billing fact for the
 * data-integrity banner to show. A log line is not "user-visible"; the banner is.
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import {
  ApprovalModeSchema,
  BillingModeSchema,
  CodexBillingModeSchema,
  clampLayout,
  EngineIdSchema,
  ImageDetailSchema,
  type ApprovalMode,
  type BillingMode,
  type CodexBillingMode,
  type EngineId,
  type ImageDetail,
  type KodaSettings,
  type RuntimeId,
  type WorkspaceLayoutSizes,
} from '@shared/ipc'
import { log } from './logger'

function settingsPath(): string {
  return join(app.getPath('userData'), 'koda-settings.json')
}

/** Best-effort forensic copy of a settings file that failed to parse, made BEFORE any writer's
 *  read-modify-write can overwrite it. One fixed slot (not session-store's rotating, content-keyed
 *  pile) — settings are already effectively lost at READ time (every loader falls back to its own
 *  default per field), so this is for support/forensics, not row-level recovery. Never overwrites an
 *  existing backup: the FIRST corruption is the one worth keeping. */
function keepCorruptSettings(path: string, text: string): void {
  const backup = `${path}.corrupt.bak`
  if (existsSync(backup)) return
  try {
    writeFileSync(backup, text)
  } catch (err) {
    log.warn('settings', 'could not back up an unreadable settings file', err instanceof Error ? err.message : err)
  }
}

/** The corrupt bytes the warnings below have already been said about. `readSettings` has no cache and
 *  36 call sites in this file, so ONE `loadSettings()` on a corrupt file used to emit 38 warnings (19 of
 *  them the billing one) — and `loadSettings` runs on every `settings:get` and every `updateSettings`
 *  return, so opening Settings a few times buried the log this warning exists to be found in. Keyed by
 *  content rather than a plain boolean so a file that goes corrupt a SECOND, different way still says so. */
let warnedCorruptText: string | null = null

/** `billingMode` flipping from 'api' to 'subscription' is the one field CLAUDE.md calls out as
 *  "user-visible, never silent" — a lost read otherwise defaults it back to subscription with nothing
 *  said. Latched here and served over `app:dataIntegrity`, so the data-integrity banner says it in the
 *  window; the log line alone was never "user-visible". Cleared when the user sets a billing mode
 *  themselves (updateSettings), because at that point they've said which one they want.
 *
 *  A raw scan of the bytes is all that's left once JSON.parse has thrown, so it's a hint, not a proof:
 *  it can miss (those bytes were the destroyed ones) and it can false-positive (that text inside some
 *  other key's value). Both are acceptable for a "check your billing" nudge; neither would be
 *  acceptable if this were the only mechanism, which is exactly why it now reaches a surface. The flip
 *  itself is safe-direction (api can't materialize out of nothing), so this is a trust gap rather than
 *  a spend one. */
let billingModeLost = false

export function settingsHealth(): { billingModeReset: boolean } {
  return { billingModeReset: billingModeLost }
}

/** One place for everything a corrupt read has to say, said once per distinct corruption. */
function noteCorruptRead(path: string, text: string): void {
  keepCorruptSettings(path, text)
  // THIS read's bytes, never the latch: the latch stays true for the run once set, and warning off it
  // would report a lost API-key choice about a file that plainly still shows a different one.
  const lostApiChoice = /"billingMode"\s*:\s*"api"/.test(text)
  if (lostApiChoice) billingModeLost = true
  if (warnedCorruptText === text) return
  warnedCorruptText = text
  if (lostApiChoice) {
    log.warn(
      'settings',
      'settings file unreadable and appears to have had billingMode "api" — falling back to ' +
        'subscription; this is a silent billing-mode change',
    )
  }
  log.warn('settings', 'settings file present but invalid — starting from defaults, original kept aside as .corrupt.bak')
}

function readSettings(): Record<string, unknown> {
  const path = settingsPath()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn('settings', 'settings file unreadable — starting from defaults', err instanceof Error ? err.message : err)
    }
    return {} // absent (first run, benign) or a read error with nothing left to copy
  }
  // A zero-length (or whitespace-only) file holds no data — same torn-write case session-store treats as
  // benign (a power cut right after `writeFileAtomic`'s rename). Nothing to protect, not corruption.
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  noteCorruptRead(path, text)
  return {}
}

/** The persisted DEFAULT posture new sessions start at, or 'auto' when unset/invalid. `plan` is a
 *  per-session choice only (it's the engine's spawn-time --permission-mode) — never a global default,
 *  or a new session would be labeled Plan while its engine ran in default mode. Clamp it out here. */
export function loadApprovalMode(): ApprovalMode {
  const parsed = ApprovalModeSchema.safeParse(readSettings().approvalMode)
  return parsed.success && parsed.data !== 'plan' ? parsed.data : 'auto'
}

/** Most-recent-first model ids the user has explicitly chosen (engine aliases excluded by the caller).
 *  Powers the picker's "Recently used" quick-picks so an older fallback model is one click next time.
 *  Koda can't enumerate available models, so this list — built from real usage — is the substitute. */
const RECENT_MODELS_CAP = 6

export function loadRecentModels(): string[] {
  const v = readSettings().recentModels
  if (!Array.isArray(v)) return []
  return v.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).slice(0, RECENT_MODELS_CAP)
}

/** The model/effort/engine the user last explicitly ran a session on — so a NEW session opens on their
 *  last-used settings instead of the engine default (the desktop keeps its own renderer-local copy; this
 *  is main's copy, which the phone's headless new-session path reads since it has no renderer). Written
 *  at the one model/effort chokepoint (setSessionModelEffort), so desktop and phone picks both feed it. */
export type LastPosture = { model?: string; effort?: string; engineId?: EngineId }

export function loadLastPosture(): LastPosture {
  const v = readSettings().lastPosture
  if (!v || typeof v !== 'object') return {}
  const r = v as Record<string, unknown>
  const engineId = EngineIdSchema.safeParse(r.engineId)
  return {
    model: typeof r.model === 'string' && r.model.trim() ? r.model : undefined,
    effort: typeof r.effort === 'string' && r.effort.trim() ? r.effort : undefined,
    engineId: engineId.success ? engineId.data : undefined,
  }
}

/** Persist the last-used posture. Fail-soft on write (a nicety, never fatal). */
export function saveLastPosture(p: LastPosture): void {
  const lastPosture: LastPosture = { model: p.model || undefined, effort: p.effort || undefined, engineId: p.engineId }
  try {
    writeFileAtomic(settingsPath(), JSON.stringify({ ...readSettings(), lastPosture }, null, 2))
  } catch (err) {
    log.warn('settings', 'failed to persist last posture', err instanceof Error ? err.message : err)
  }
}

/** Push a model id to the front (dedup, cap). Returns the updated list. Fail-soft on write. */
export function addRecentModel(model: string): string[] {
  const id = model.trim()
  if (!id) return loadRecentModels()
  const next = [id, ...loadRecentModels().filter((m) => m !== id)].slice(0, RECENT_MODELS_CAP)
  try {
    writeFileAtomic(settingsPath(), JSON.stringify({ ...readSettings(), recentModels: next }, null, 2))
  } catch (err) {
    log.warn('settings', 'failed to persist recent models', err instanceof Error ? err.message : err)
  }
  return next
}

/**
 * Local-assist toggle — Apple-style default-on (does the considerate polish unless turned off). Read
 * live by the assist engine, so the Settings toggle (`settings:set assistEnabled`) takes effect on the
 * next assist call with no restart.
 */
export function loadAssistEnabled(): boolean {
  const v = readSettings().assistEnabled
  return typeof v === 'boolean' ? v : true
}

/** Native-notification toggle — default-on. Read by the renderer at boot to gate the background-session
 *  notification (the in-app ring + dock badge are unaffected). */
function loadNotificationsEnabled(): boolean {
  const v = readSettings().notificationsEnabled
  return typeof v === 'boolean' ? v : true
}

/** 5-hour-reset ping toggle — default-on. Read live by the main-process notifier at fire time, so a
 *  Settings change applies immediately (no restart). */
export function loadUsageResetNotify(): boolean {
  const v = readSettings().usageResetNotify
  return typeof v === 'boolean' ? v : true
}

/** Provider-recovery ping toggle — default-on. The "Claude/Codex is back up" notification after a
 *  feed-confirmed outage interrupted a turn. Read live by the main-process watcher at fire time. */
export function loadProviderStatusNotify(): boolean {
  const v = readSettings().providerStatusNotify
  return typeof v === 'boolean' ? v : true
}

/** Preview auto-start toggle — default-on (the agent starts the preview server without a confirm).
 *  Read by the gate to decide whether to confirm the `preview` capability before spawning. */
export function loadPreviewAutoStart(): boolean {
  const v = readSettings().previewAutoStart
  return typeof v === 'boolean' ? v : true
}

/** Mini-app day threads — default-on. Both heads read it at face-turn dispatch (the phone gets it in
 *  the launcher payload), so flipping it applies to the very next thing said to an app. */
export function loadAppDaySessions(): boolean {
  const v = readSettings().appDaySessions
  return typeof v === 'boolean' ? v : true
}

/** Fresh-critic pass on finished work the user will look at — default-on, and general (not just mini
 *  apps). Read at spawn: it gates the `critique-stood-down` rule, so flipping it applies to the next
 *  session rather than mid-turn. Off only when the user would rather spend the usage window building
 *  than checking. */
export function loadCritiquePass(): boolean {
  const v = readSettings().critiquePass
  return typeof v === 'boolean' ? v : true
}

/** Image-detail level — how much the renderer downscales pasted/dropped images before sending them.
 *  Default 'balanced'. Read by the composer at attach time, so a change applies on the next paste. */
export function loadImageDetail(): ImageDetail {
  const parsed = ImageDetailSchema.safeParse(readSettings().imageDetail)
  return parsed.success ? parsed.data : 'balanced'
}

/** Scratch-image retention in days — saved pasted/dropped images older than this are pruned. `0` keeps
 *  them forever. Default 7. Read by the scratch:save handler so a change applies on the next save. */
export function loadScratchRetentionDays(): number {
  const v = readSettings().scratchRetentionDays
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 7
}

/** Archived-session retention in days — archives older than this are auto-deleted on load. `0` (the
 *  default) keeps them forever: archives live outside the safety-git undo net, so a purge is permanent,
 *  and the safe default never deletes. Opt-in from the Archived settings section. */
export function loadArchiveRetentionDays(): number {
  const v = readSettings().archiveRetentionDays
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/** Optional Playwright browser-testing toggle — default-OFF (it costs a ~150 MB download). Read live at
 *  session spawn (playwright/index.ts) so the agent gains/loses browser tools on the next session. */
export function loadPlaywrightEnabled(): boolean {
  const v = readSettings().playwrightEnabled
  return typeof v === 'boolean' ? v : false
}

/** First-run onboarding completion — app-global, default false (show the wizard). Set true when the
 *  user finishes the onboarding flow; never reset (re-running onboarding would be an explicit action). */
export function loadHasOnboarded(): boolean {
  return readSettings().hasOnboarded === true
}

/** Anonymous usage events — default-ON, but PRESENTED consent: telemetry.ts also gates every send on
 *  hasOnboarded, so nothing flows until the user has walked past the visible toggle on the onboarding
 *  safety step (decided 2026-07-09; supersedes the earlier opt-in default). Read live at every
 *  track() call, so flipping the toggle applies instantly; off = zero pings. */
export function loadTelemetryEnabled(): boolean {
  return readSettings().telemetryEnabled !== false
}

/** Random install id for telemetry events — internal state, not a preference (like RuntimeRecord).
 *  Minted on first use, tied to nothing about the user, and reset trivially by clearing settings. */
export function loadTelemetryInstallId(): string {
  const v = readSettings().telemetryInstallId
  if (typeof v === 'string' && v.length > 0) return v
  const id = randomUUID()
  try {
    writeFileAtomic(settingsPath(), JSON.stringify({ ...readSettings(), telemetryInstallId: id }, null, 2))
  } catch (err) {
    log.warn('settings', 'failed to persist install id', err instanceof Error ? err.message : err)
  }
  return id
}

/** The Koda version whose "What's New" the user has already seen — internal one-shot state (like the
 *  install id), not a preference. '' means never set (a fresh install). See updater.ts getWhatsNew. */
export function loadWhatsNewSeenVersion(): string {
  const v = readSettings().whatsNewSeenVersion
  return typeof v === 'string' ? v : ''
}

export function setWhatsNewSeenVersion(version: string): void {
  try {
    writeFileAtomic(
      settingsPath(),
      JSON.stringify({ ...readSettings(), whatsNewSeenVersion: version }, null, 2),
    )
  } catch (err) {
    log.warn('settings', 'failed to persist whats-new version', err instanceof Error ? err.message : err)
  }
}

/** Remote Control LAN server toggle — default-OFF (it opens a LAN port; see remote-control-security.md).
 *  Read at boot so an enabled server auto-starts, and by the Remote pane. */
export function loadRemoteEnabled(): boolean {
  return readSettings().remoteEnabled === true
}

/** Cloud-relay ("from anywhere") feature flag — default-OFF: the first release ships LAN-only remote.
 *  Deliberately no Settings UI; flip it with `"cloudRelay": true` in koda-settings.json (survives other
 *  writes — every write spreads readSettings()) or `KODA_CLOUD_RELAY=1` in dev. Gates the relay
 *  auto-start, the from-anywhere pairing surfaces on the Mac, and (via the LAN server's /api/features)
 *  the phone's "Connect from anywhere" door. LAN pairing is unaffected. */
export function loadCloudRelayEnabled(): boolean {
  return process.env.KODA_CLOUD_RELAY === '1' || readSettings().cloudRelay === true
}

/** Encrypted cloud backup (dogfood flag, same posture as cloudRelay: no Settings toggle yet — flip
 *  with `"backupEnabled": true` in koda-settings.json or `KODA_BACKUP=1` in dev). Gates the debounced
 *  uploader and the Settings → Backup surface. "Any signed-in account" is the dogfood gate; the paid
 *  entitlement replaces it when IAP ships (ship-checklist-backup-sync.md). */
export function loadBackupEnabled(): boolean {
  return process.env.KODA_BACKUP === '1' || readSettings().backupEnabled === true
}

/** Docs replica upload (the paid tier's launch feature; full-project backup stays behind
 *  loadBackupEnabled separately). Same dogfood posture: `"replicaEnabled": true` in
 *  koda-settings.json or `KODA_REPLICA=1`; the paid entitlement replaces it when IAP ships. */
export function loadReplicaEnabled(): boolean {
  return process.env.KODA_REPLICA === '1' || readSettings().replicaEnabled === true
}

/** Mini-apps make-and-run (the in-progress apps platform; mini-apps-plan.md). ONE gate for the whole
 *  half-built project so normal releases stay shippable while it lands over a couple weeks: it's read
 *  at every *activation seam* — the create-mini-app skill (a staging --plugin-dir wired only when on),
 *  the lifecycle capability's broker tools, and the "turn this into an app" UI entry. The guts (verbs,
 *  component kit, bridge) land freely on main because they're inert until a seam surfaces them. Same
 *  dogfood posture as backup/replica: `"miniAppsEnabled": true` in koda-settings.json or
 *  `KODA_MINI_APPS=1` in dev. Default OFF; flip it (or graduate the pieces) when the project ships. */
export function loadMiniAppsEnabled(): boolean {
  return process.env.KODA_MINI_APPS === '1' || readSettings().miniAppsEnabled === true
}

/** Overnight dream consolidation (dream-plan.md) — a real user setting (Settings → Memory toggle),
 *  default OFF because it spends the user's plan while they're away. Read live by the scheduler in
 *  engine/dream.ts at every arm/fire, so flipping the toggle applies without a restart. */
export function loadDreamEnabled(): boolean {
  return readSettings().dreamEnabled === true
}

/** Generative REM is a second, more speculative turn after the proven memory tidy. Keep its
 *  dogfood gate separate so existing "Tidy overnight" users are never silently opted into it. */
export function loadRemEnabled(): boolean {
  return process.env.KODA_REM === '1' || readSettings().remEnabled === true
}

/**
 * Provisioned-runtime record — NOT a user preference (so it's out of the Settings surface below): it's
 * internal state recording which on-demand runtime (Node / Python) Koda installed and where. Read at
 * boot to re-activate it, and after an install to persist it. Fail-soft like everything else here.
 */
export interface RuntimeRecord {
  version: string
  binDir: string
}

/** Each runtime gets its own settings key; `node` keeps the original `nodeRuntime` key (back-compat). */
const RUNTIME_SETTINGS_KEY: Record<RuntimeId, string> = {
  node: 'nodeRuntime',
  python: 'pythonRuntime',
}

export function loadRuntimeRecord(id: RuntimeId): RuntimeRecord | null {
  const v = readSettings()[RUNTIME_SETTINGS_KEY[id]]
  if (!v || typeof v !== 'object') return null
  const { version, binDir } = v as Record<string, unknown>
  if (typeof version !== 'string' || typeof binDir !== 'string') return null
  return { version, binDir }
}

export function saveRuntimeRecord(id: RuntimeId, rec: RuntimeRecord): void {
  try {
    writeFileAtomic(
      settingsPath(),
      JSON.stringify({ ...readSettings(), [RUNTIME_SETTINGS_KEY[id]]: rec }, null, 2),
    )
  } catch (err) {
    log.warn('settings', `failed to persist ${id} runtime`, err instanceof Error ? err.message : err)
  }
}

// ── The Settings surface ───────────────────────────────────────────────────────────────────────
// The user-facing app preferences exposed by the Settings pane. Distinct from per-session state
// (approval posture, model — saved in the session blob) and from recentModels (usage tracking, not a
// set preference). Theme is renderer-only (localStorage), so it isn't here. Each field reuses its
// existing loader so defaults/clamps stay in one place. `defaultApprovalMode` shares the on-disk
// `approvalMode` key, so loadApprovalMode() (which the gate seeds from) stays the single reader.

/** Persisted workspace pane sizes — clamped on read so a hand-edited/corrupt file can't wedge the UI. */
function loadLayout(): WorkspaceLayoutSizes {
  const v = readSettings().layout
  return clampLayout(v && typeof v === 'object' ? (v as Partial<WorkspaceLayoutSizes>) : undefined)
}

/** Billing mode, defaulting to subscription. Note: 'api' here is the user's INTENT — the spawn path
 *  still requires an actual stored key (api-key.ts) to bill via API; absent a key it falls back to
 *  subscription. Settings → Account keeps the two in sync (saving a key sets 'api', removing it resets). */
function loadBillingMode(): BillingMode {
  const parsed = BillingModeSchema.safeParse(readSettings().billingMode)
  return parsed.success ? parsed.data : 'subscription'
}

function loadCodexBillingMode(): CodexBillingMode {
  const parsed = CodexBillingModeSchema.safeParse(readSettings().codexBillingMode)
  return parsed.success ? parsed.data : 'subscription'
}

export function loadSettings(): KodaSettings {
  return {
    defaultApprovalMode: loadApprovalMode(),
    assistEnabled: loadAssistEnabled(),
    notificationsEnabled: loadNotificationsEnabled(),
    usageResetNotify: loadUsageResetNotify(),
    providerStatusNotify: loadProviderStatusNotify(),
    previewAutoStart: loadPreviewAutoStart(),
    imageDetail: loadImageDetail(),
    scratchRetentionDays: loadScratchRetentionDays(),
    archiveRetentionDays: loadArchiveRetentionDays(),
    playwrightEnabled: loadPlaywrightEnabled(),
    dreamEnabled: loadDreamEnabled(),
    hasOnboarded: loadHasOnboarded(),
    billingMode: loadBillingMode(),
    codexBillingMode: loadCodexBillingMode(),
    remoteEnabled: loadRemoteEnabled(),
    telemetryEnabled: loadTelemetryEnabled(),
    appDaySessions: loadAppDaySessions(),
    critiquePass: loadCritiquePass(),
    layout: loadLayout(),
  }
}

/** Wipe the settings file back to an empty object → every loader falls through to its default (incl.
 *  `hasOnboarded:false`, so the wizard shows again). DEV retest affordance only; not user-facing. Also
 *  drops provisioned-runtime records — the on-disk binaries stay, they just re-probe as not-installed. */
export function resetSettings(): KodaSettings {
  try {
    writeFileAtomic(settingsPath(), '{}')
  } catch (err) {
    log.warn('settings', 'failed to reset settings', err instanceof Error ? err.message : err)
  }
  return loadSettings()
}

/** Merge a partial update into the settings file and return the full, re-clamped settings. Fail-soft:
 *  a write failure logs and the previous on-disk value still applies. `plan` is never a valid DEFAULT
 *  (it's a per-session, spawn-time mode), so it's coerced to 'auto' here as well as on read. */
export function updateSettings(patch: Partial<KodaSettings>): KodaSettings {
  const next = readSettings()
  if (patch.defaultApprovalMode !== undefined)
    next.approvalMode = patch.defaultApprovalMode === 'plan' ? 'auto' : patch.defaultApprovalMode
  if (patch.assistEnabled !== undefined) next.assistEnabled = patch.assistEnabled
  if (patch.notificationsEnabled !== undefined) next.notificationsEnabled = patch.notificationsEnabled
  if (patch.usageResetNotify !== undefined) next.usageResetNotify = patch.usageResetNotify
  if (patch.providerStatusNotify !== undefined) next.providerStatusNotify = patch.providerStatusNotify
  if (patch.previewAutoStart !== undefined) next.previewAutoStart = patch.previewAutoStart
  if (patch.appDaySessions !== undefined) next.appDaySessions = patch.appDaySessions
  if (patch.critiquePass !== undefined) next.critiquePass = patch.critiquePass
  if (patch.imageDetail !== undefined) next.imageDetail = patch.imageDetail
  if (patch.scratchRetentionDays !== undefined)
    next.scratchRetentionDays = Math.max(0, Math.floor(patch.scratchRetentionDays))
  if (patch.archiveRetentionDays !== undefined)
    next.archiveRetentionDays = Math.max(0, Math.floor(patch.archiveRetentionDays))
  if (patch.playwrightEnabled !== undefined) next.playwrightEnabled = patch.playwrightEnabled
  if (patch.dreamEnabled !== undefined) next.dreamEnabled = patch.dreamEnabled
  if (patch.hasOnboarded !== undefined) next.hasOnboarded = patch.hasOnboarded
  if (patch.billingMode !== undefined) {
    next.billingMode = patch.billingMode
    billingModeLost = false // they've now said which mode they want, so there's nothing left to report
  }
  if (patch.codexBillingMode !== undefined) next.codexBillingMode = patch.codexBillingMode
  if (patch.remoteEnabled !== undefined) next.remoteEnabled = patch.remoteEnabled
  if (patch.telemetryEnabled !== undefined) next.telemetryEnabled = patch.telemetryEnabled
  if (patch.layout !== undefined) next.layout = clampLayout(patch.layout)
  try {
    writeFileAtomic(settingsPath(), JSON.stringify(next, null, 2))
  } catch (err) {
    log.warn('settings', 'failed to persist settings', err instanceof Error ? err.message : err)
  }
  return loadSettings()
}
