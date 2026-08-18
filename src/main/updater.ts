/**
 * App self-update (releases-and-updates.md, downstream half). Wraps electron-updater's autoUpdater:
 * check on launch + every few hours, download quietly in the background, and surface a calm
 * "restart to update" — NEVER a silent auto-restart (the "updates are user-visible, never silent"
 * ethos). Distinct from the bundled `claude` engine, which is pinned and forbidden from self-updating
 * (engine-updates.md); this updates the whole signed .app wholesale, only ever on relaunch.
 *
 * Squirrel.Mac updates from the .zip in the release (not the .dmg), read via the koda repo's
 * `latest-mac.yml` feed baked in as app-update.yml by electron-builder's `publish` block.
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannels } from '@shared/channels'
import type { UpdateStatus } from '@shared/ipc'
import { loadWhatsNewSeenVersion, setWhatsNewSeenVersion } from './settings'
import { governProbe, type GovernedProbe } from './probe-governor'
import { log } from './logger'

// Re-check on this cadence after the launch check. A running app that stays open for days still learns
// about a new release without a restart; the download stays background, the prompt stays passive.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

let status: UpdateStatus = { state: 'idle' }
// The version being downloaded — tracked independently of `status` so a stray download-progress event
// (or one that races a re-check) can't emit a blank version.
let downloadingVersion = ''
// The durable fact: this build is downloaded and staged on disk, installable right now. Kept apart
// from `status` because `status` also carries transient check outcomes.
let staged: { version: string } | null = null
// The re-check's power-aware gate (probe-governor.ts). Nobody can act on an update offer while the
// screen is locked, and a check that finds one pulls a whole .app down the wire.
let checkProbe: GovernedProbe | null = null

export type UpdateChannel = 'latest' | 'nightly'

/** A prerelease follows only its named prerelease feed. Stable builds never opt into prereleases, so
 *  publishing a nightly cannot make an ordinary Koda install discover it. */
export function updateChannelForVersion(version: string): UpdateChannel {
  return version.match(/^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z-]+)(?:\.|$)/)?.[1] === 'nightly'
    ? 'nightly'
    : 'latest'
}

function broadcast(next: UpdateStatus): void {
  // A staged update outlives every later check. The 6-hourly re-check emits checking / up-to-date /
  // error (and re-download churn for the version already on disk); none of that unstages anything, so
  // none of it may erase the install offer. Only news of a genuinely different build supersedes it.
  // A blank version is a stray progress event, not a new build — `next.version` is '' when progress
  // arrives before any update-available, and treating that as superseding would replace a real offer
  // with an untitled "Downloading…".
  const supersedes = 'version' in next && !!next.version && next.version !== staged?.version
  const effective: UpdateStatus =
    staged && !supersedes ? { state: 'ready', version: staged.version } : next
  status = effective
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send(IpcChannels.updateStatus, effective)
}

/** Wire autoUpdater + kick the first check. Packaged-only: autoUpdater throws in dev ("application is
 *  not packed"), so unpackaged runs just sit at `idle` and the manual "Check" reports the same. */
export function initUpdater(): void {
  if (!app.isPackaged) {
    log.info('updater', 'skipped (not packaged)')
    return
  }

  autoUpdater.autoDownload = true // background download the moment one is found
  const channel = updateChannelForVersion(app.getVersion())
  autoUpdater.channel = channel
  autoUpdater.allowPrerelease = channel === 'nightly'
  // Setting a channel makes electron-updater enable downgrades. Koda's feeds are monotonic; an older
  // nightly must never replace a newer installed build, even if GitHub returns releases out of order.
  autoUpdater.allowDowngrade = false
  // Install ONLY on the user's explicit "Restart to update" — never on quit. (autoInstallOnAppQuit is
  // also dead here: Koda's before-quit force-exits via app.exit(), which skips the `quit` event the
  // hook needs; and on macOS the Squirrel install path relaunches the app, which the "never silent"
  // ethos avoids anyway.) A downloaded update persists on disk, so the banner re-offers each launch
  // until the user restarts — no silent behavior, and the offer isn't lost if they click "Later".
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (m: unknown) => log.info('updater', String(m)),
    warn: (m: unknown) => log.warn('updater', String(m)),
    error: (m: unknown) => log.error('updater', String(m)),
    debug: () => {},
  }

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    downloadingVersion = info.version
    // electron-updater empties its pending-update cache before downloading a DIFFERENT build, so the
    // previously staged file is deleted from disk the moment this fires. Forget it here or a later
    // failure would coerce the offer back to a build that no longer exists — "Restart to update" that
    // can never succeed. Same-version churn re-downloads over the same file and is left alone.
    if (staged && info.version !== staged.version) staged = null
    broadcast({ state: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('update-not-available', () => broadcast({ state: 'up-to-date' }))
  autoUpdater.on('download-progress', (p) => {
    // Progress events don't carry the version; use the one captured at update-available.
    broadcast({ state: 'downloading', version: downloadingVersion, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    staged = { version: info.version }
    broadcast({ state: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  })

  void checkForUpdatesNow()
  checkProbe = governProbe('update-check', CHECK_INTERVAL_MS, {
    // A Mac that slept through the night comes back a check overdue; catch it up rather than making
    // the user wait out the rest of a six-hour window for news that already exists.
    wake: () => void checkForUpdatesNow(),
  })
  setInterval(() => {
    if (checkProbe?.due()) void checkForUpdatesNow()
  }, CHECK_INTERVAL_MS)
}

/** Manual "Check for updates" (Settings). No-op-safe in dev + mid-download (autoUpdater ignores a
 *  re-check while one is in flight). Always returns the current status for the caller to render. */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  checkProbe?.ran() // a manual "Check for updates" is this probe's run; the stretch counts from here
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return status
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/** Restart into the downloaded update. Guarded on the staged build (not the possibly-transient
 *  `status`) so a stray call can't quit with nothing on disk to install. */
export function quitAndInstallUpdate(): void {
  if (!staged) return
  autoUpdater.quitAndInstall()
}

/** The "What's New" popup source: the current version's CHANGELOG section, returned ONCE per
 *  version-to-version update. Fresh installs are marked seen silently (no popup competing with
 *  onboarding); only a real update (a seen version older than this one) shows it. Reading + marking
 *  in one call guarantees a single window shows it, never two. */
export function getWhatsNew(): { version: string; markdown: string } | null {
  const current = app.getVersion()
  const seen = loadWhatsNewSeenVersion()
  if (seen === current) return null
  // First run ever (nothing seen): adopt this version without a popup.
  const firstRun = seen === ''
  setWhatsNewSeenVersion(current)
  if (firstRun) return null
  const markdown = readChangelogSection(current)
  return markdown ? { version: current, markdown } : null
}

/** Pull one `## [x.y.z]` block out of the bundled CHANGELOG (up to the next `## `), stripping the
 *  heading + the trailing link-reference lines. Offline — reads the copy shipped inside the app. */
function readChangelogSection(version: string): string | null {
  try {
    const path = join(app.getAppPath(), 'CHANGELOG.md')
    const text = readFileSync(path, 'utf8')
    const lines = text.split('\n')
    // Match `## [0.1.0]` (bracketed, per Keep a Changelog) or a bare `## 0.1.0`.
    const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?${escapeRegex(version)}\\]?`).test(l))
    if (start === -1) return null
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((l) => /^##\s/.test(l))
    const body = (end === -1 ? rest : rest.slice(0, end))
      .filter((l) => !/^\[[^\]]+\]:\s+http/.test(l)) // drop link-reference definitions
      .join('\n')
      .trim()
    return body || null
  } catch (err) {
    log.warn('updater', 'changelog read failed', err instanceof Error ? err.message : err)
    return null
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
