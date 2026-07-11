/**
 * App self-update (releases-and-updates.md, downstream half). Wraps electron-updater's autoUpdater:
 * check on launch + every few hours, download quietly in the background, and surface a calm
 * "restart to update" — NEVER a silent auto-restart (the "updates are user-visible, never silent"
 * ethos). Distinct from the bundled `claude` engine, which is pinned and forbidden from self-updating
 * (engine-updates.md); this updates the whole signed .app wholesale, only ever on relaunch.
 *
 * Squirrel.Mac updates from the .zip in the release (not the .dmg), read via the koda-public
 * `latest-mac.yml` feed baked in as app-update.yml by electron-builder's `publish` block.
 */
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannels } from '@shared/channels'
import type { UpdateStatus } from '@shared/ipc'
import { loadWhatsNewSeenVersion, setWhatsNewSeenVersion } from './settings'
import { log } from './logger'

// Re-check on this cadence after the launch check. A running app that stays open for days still learns
// about a new release without a restart; the download stays background, the prompt stays passive.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

let status: UpdateStatus = { state: 'idle' }
// The version being downloaded — tracked independently of `status` so a stray download-progress event
// (or one that races a re-check) can't emit a blank version.
let downloadingVersion = ''

function broadcast(next: UpdateStatus): void {
  status = next
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IpcChannels.updateStatus, next)
}

/** Wire autoUpdater + kick the first check. Packaged-only: autoUpdater throws in dev ("application is
 *  not packed"), so unpackaged runs just sit at `idle` and the manual "Check" reports the same. */
export function initUpdater(): void {
  if (!app.isPackaged) {
    log.info('updater', 'skipped (not packaged)')
    return
  }

  autoUpdater.autoDownload = true // background download the moment one is found
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
    broadcast({ state: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('update-not-available', () => broadcast({ state: 'up-to-date' }))
  autoUpdater.on('download-progress', (p) => {
    // Progress events don't carry the version; use the one captured at update-available.
    broadcast({ state: 'downloading', version: downloadingVersion, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  })

  void checkForUpdatesNow()
  setInterval(() => void checkForUpdatesNow(), CHECK_INTERVAL_MS)
}

/** Manual "Check for updates" (Settings). No-op-safe in dev + mid-download (autoUpdater ignores a
 *  re-check while one is in flight). Always returns the current status for the caller to render. */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
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

/** Restart into the downloaded update. Guarded to `ready` so a stray call can't quit mid-download. */
export function quitAndInstallUpdate(): void {
  if (status.state !== 'ready') return
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
