/**
 * Electron wiring around the PlaywrightManager: resolves the vendored server, owns the lazy singleton,
 * broadcasts download progress to the Settings UI, and exposes the two seams the session layer needs —
 * merging the Playwright server into a session's mcp-config and the conditional skill denial.
 *
 * "Wired" = the user's toggle is on AND a complete install is present. Only then does the agent get
 * browser tools (and the browser-verify skill); otherwise the skill is denied so it never dangles
 * guidance for tools that aren't there (mirrors the DISALLOWED_DEEP_RESEARCH pattern in adapter.ts).
 */
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/channels'
import type { PlaywrightStatus } from '@shared/ipc'
import { resolvePlaywright } from './binary'
import { PlaywrightManager, type PlaywrightState } from './manager'
import { loadPlaywrightEnabled } from '../settings'
import { log } from '../logger'

/** The pack skill that teaches browser verification — denied when the capability isn't wired. */
const BROWSER_VERIFY_SKILL = 'Skill(browser-verify)'

let manager: PlaywrightManager | null = null

function getManager(): PlaywrightManager {
  if (!manager) {
    const cli = resolvePlaywright({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined })
    manager = new PlaywrightManager({
      cli,
      browsersPath: join(app.getPath('userData'), 'playwright-browsers'),
      outputDir: join(app.getPath('userData'), 'playwright-output'),
      execPath: process.execPath,
      onProgress: ({ state, message }) => broadcast({ state, enabled: loadPlaywrightEnabled(), message }),
    })
  }
  return manager
}

function broadcast(status: PlaywrightStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.playwrightProgress, status)
  }
}

/** Current install state + the user's toggle, for the Settings pane to render on mount. */
export function playwrightStatus(): PlaywrightStatus {
  return { state: getManager().state(), enabled: loadPlaywrightEnabled() }
}

/** Toggle ON → kick the background Chromium download (the setting is persisted by the IPC handler). */
export function enablePlaywright(): Promise<PlaywrightState> {
  return getManager().ensureBrowsers()
}

/** Boot hook: finish a download the user enabled but didn't see complete (quit mid-install). */
export function resumePlaywrightIfEnabled(): void {
  if (loadPlaywrightEnabled() && getManager().state() !== 'ready') void getManager().ensureBrowsers()
}

/** True when the agent should get browser tools this session (toggle on AND install complete). */
function isWired(): boolean {
  return loadPlaywrightEnabled() && getManager().isReady()
}

/**
 * Merge the Playwright stdio server into a session's broker mcp-config when wired, else return it
 * unchanged. Fail-soft: a malformed broker JSON (shouldn't happen) is returned as-is.
 */
export function applyPlaywrightToMcpConfig(brokerConfigJson: string): string {
  if (!isWired()) return brokerConfigJson
  const entry = getManager().mcpServerEntry()
  if (!entry) return brokerConfigJson
  try {
    const cfg = JSON.parse(brokerConfigJson)
    cfg.mcpServers = { ...cfg.mcpServers, playwright: entry }
    return JSON.stringify(cfg)
  } catch (err) {
    log.warn('playwright', 'could not merge mcp-config', err instanceof Error ? err.message : err)
    return brokerConfigJson
  }
}

/** Deny the browser-verify skill unless the capability is wired (no dangling guidance). */
export function playwrightDisallowedTools(): string[] {
  return isWired() ? [] : [BROWSER_VERIFY_SKILL]
}

/** True when the browser capability is fully wired (toggle on AND install ready) — for the Codex path,
 *  which gates both the MCP attach and the browser-verify skill materialization on it. */
export function playwrightWired(): boolean {
  return isWired()
}

/**
 * The Playwright stdio server for a Codex session (attached via the driver's `-c mcp_servers.playwright.*`
 * overrides, the Codex analog of Claude's mcp-config merge), or null when the capability isn't wired.
 */
export function playwrightMcpServerForCodex(): import('./manager').McpStdioServer | null {
  return isWired() ? getManager().mcpServerEntry() : null
}
