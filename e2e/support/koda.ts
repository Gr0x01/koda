import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OFF_SETTINGS = {
  telemetryEnabled: false,
  notificationsEnabled: false,
  usageResetNotify: false,
  providerStatusNotify: false,
  remoteEnabled: false,
  cloudRelay: false,
  backupEnabled: false,
  replicaEnabled: false,
  dreamEnabled: false,
  remEnabled: false,
  miniAppsEnabled: false,
  playwrightEnabled: false,
}

const SAFE_ENV_KEYS = [
  'CI',
  'COLORTERM',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SystemRoot',
  'TERM',
  'USER',
  'USERNAME',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  '__CFBundleIdentifier',
  '__CF_USER_TEXT_ENCODING',
]

function safeParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function launchEnv(userDataDir: string, realAccounts: boolean): Record<string, string> {
  // Start from a display/runtime allowlist rather than trying to enumerate every credential an
  // engineer might have exported. No token, askpass helper, SSH agent, or tool-specific config path
  // crosses into ordinary E2E by default.
  const env = safeParentEnv()

  env.KODA_APP_PROFILE = 'e2e'
  if (realAccounts) {
    env.KODA_E2E_REAL_ACCOUNTS = '1'
    for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
  } else {
    const home = join(userDataDir, 'home')
    mkdirSync(home, { recursive: true })
    env.HOME = home
    env.XDG_CONFIG_HOME = join(home, '.config')
    env.XDG_CACHE_HOME = join(home, '.cache')
    env.XDG_DATA_HOME = join(home, '.local', 'share')
    env.XDG_STATE_HOME = join(home, '.local', 'state')
  }

  const scratch = join(userDataDir, 'tmp')
  mkdirSync(scratch, { recursive: true })
  env.TMPDIR = scratch
  if (process.platform === 'win32') {
    env.TEMP = scratch
    env.TMP = scratch
    if (!realAccounts) env.USERPROFILE = env.HOME
  }
  return env
}

/** Put disposable profiles under a caller-selected short root; ordinary local runs stay in OS temp. */
export function makeUserDataDir(prefix = 'koda-e2e-'): string {
  const root = process.env.KODA_E2E_STATE_DIR || tmpdir()
  mkdirSync(root, { recursive: true })
  return realpathSync(mkdtempSync(join(root, prefix)))
}

export type LaunchKodaOptions = {
  projectPath?: string
  userDataDir?: string
  onboarded?: boolean
  settings?: Record<string, unknown>
  /** Explicit account assay only. Ordinary E2E gets an empty HOME and deterministic signed-out state. */
  realAccounts?: boolean
}

export async function launchKoda(opts: LaunchKodaOptions = {}): Promise<ElectronApplication> {
  const userDataDir = opts.userDataDir ?? makeUserDataDir()
  if (opts.projectPath) {
    writeFileSync(
      join(userDataDir, 'koda-app-state.json'),
      JSON.stringify({ version: 1, openProjects: [opts.projectPath], recentProjects: [opts.projectPath] }),
    )
  }
  writeFileSync(
    join(userDataDir, 'koda-settings.json'),
    JSON.stringify({
      ...OFF_SETTINGS,
      ...(opts.onboarded !== false && { hasOnboarded: true }),
      ...opts.settings,
    }),
  )
  return electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    // Playwright disables Chromium's sandbox for Electron unless this is explicit. The dedicated
    // Linux worker supports unprivileged user namespaces, so exercise the production boundary there.
    chromiumSandbox: process.platform === 'linux',
    env: launchEnv(userDataDir, opts.realAccounts === true),
  })
}

/**
 * Open a project file by name through the Library, the one search door (⌘K/⌘P). Matching the row by
 * the filename reliably lands on its Project files row (document rows are titled, not filenamed),
 * and double-click opens through the same `openFile` seam every overlay caller uses.
 */
export async function openFileViaLibrary(win: Page, filename: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+p')
  const find = win.getByLabel('Find a document or a file')
  await find.waitFor({ timeout: 20_000 })
  await find.fill(filename)
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const row = win.getByRole('option', { name: new RegExp(escaped) }).first()
  await row.waitFor({ timeout: 20_000 })
  await row.dblclick()
}
