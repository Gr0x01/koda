/**
 * PlaywrightManager — owns the optional browser-testing capability's install state and the stdio
 * MCP-server config the engine spawns. Mirrors the assist seam's contract: every method is fail-soft
 * (no throw); a miss just means the capability stays unavailable and the agent isn't offered it.
 *
 * Channel-detect: prefer the user's installed Google Chrome (`--browser chrome`, zero download); only
 * download bundled Chromium when there's no system Chrome to drive. Either way `--isolated` launches a
 * fresh in-memory profile, so we never touch the user's real Chrome session/tabs.
 *
 * Two jobs:
 *  1. Make a browser available (`ensureBrowsers`) — instant when system Chrome is present; otherwise a
 *     ONE-TIME Chromium download into a Koda-owned shared dir, reused by every project (this is what
 *     removes the per-project `playwright install` RB does today).
 *  2. Hand the session layer the `@playwright/mcp` stdio server config (`mcpServerEntry`), run via
 *     Electron-as-node so no separate Node runtime is bundled. Its env scopes PLAYWRIGHT_BROWSERS_PATH
 *     to that child, so the engine's own env (env.ts) is untouched.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '../logger'

export type PlaywrightState = 'not-installed' | 'installing' | 'ready' | 'error'

/** System Google Chrome (stable channel) — `--browser chrome` drives it with no download. macOS only
 *  (Koda is macOS today). Beta/Canary/Chromium-the-app deliberately excluded — stable is the target. */
const CHROME_BINARIES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
]

/** A Claude Code `--mcp-config` stdio server entry (the shape the engine spawns). */
export interface McpStdioServer {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

export interface PlaywrightManagerOpts {
  /** Vendored cli paths, or null when `vendor-playwright` hasn't run (→ permanently unavailable). */
  cli: { mcpCli: string; installCli: string } | null
  /** The shared, Koda-owned browsers dir (userData/playwright-browsers). */
  browsersPath: string
  /** Koda-owned dir for browser artifacts (screenshots/PDFs/downloads) — kept OUT of the project tree
   *  so a non-mutating browser tool can never drop an unsnapshotted file into the user's work. */
  outputDir: string
  /** process.execPath — the Electron binary, run as Node via ELECTRON_RUN_AS_NODE for both clis. */
  execPath: string
  /** Progress sink (state changes + download log lines) for the Settings UI. */
  onProgress?: (status: { state: PlaywrightState; message?: string }) => void
}

export class PlaywrightManager {
  private current: PlaywrightState
  /** In-flight install, so a second enable/boot-resume joins it instead of racing a second download. */
  private installing: Promise<PlaywrightState> | null = null

  constructor(private readonly opts: PlaywrightManagerOpts) {
    // No vendored server → permanently unavailable. Else ready when a browser is already drivable
    // (system Chrome present, or a prior Chromium download exists) so a restart / second project finds
    // it ready without re-downloading.
    this.current = !opts.cli ? 'error' : this.hasBrowser() ? 'ready' : 'not-installed'
  }

  state(): PlaywrightState {
    return this.current
  }

  /** Wired into a session only when the toggle is on AND this is true (index.isPlaywrightWired).
   *  Resolved from reality (cli + a drivable browser), not the cached UI state. */
  isReady(): boolean {
    return !!this.opts.cli && this.hasBrowser()
  }

  browsersPath(): string {
    return this.opts.browsersPath
  }

  /**
   * Make a browser available. Instant when system Chrome is present (chrome channel — no download);
   * otherwise download bundled Chromium into the shared dir. Idempotent, single-flighted, and never
   * throws — offline / no toolchain / spawn miss → 'error', the capability just stays off. The Settings
   * toggle is the trigger; boot-resume joins the same promise.
   */
  ensureBrowsers(): Promise<PlaywrightState> {
    if (!this.opts.cli) return Promise.resolve(this.setState('error'))
    if (this.hasBrowser()) return Promise.resolve(this.setState('ready')) // system Chrome or prior download
    if (this.installing) return this.installing
    this.installing = this.runInstall().finally(() => {
      this.installing = null
    })
    return this.installing
  }

  /**
   * The `@playwright/mcp` stdio server for the engine's `--mcp-config`, or null when not ready.
   * Headless + isolated: the agent verifies without popping a window or carrying state between runs.
   * Artifacts go to a Koda-owned --output-dir, never the project.
   */
  mcpServerEntry(): McpStdioServer | null {
    if (!this.isReady() || !this.opts.cli) return null
    // This entry is serialized into --mcp-config on argv, so keep env MINIMAL (no full-env dump in
    // `ps`). Pass only what headless Chromium needs beyond our two vars — HOME (crashpad/caches) and
    // PATH — so the browser launches even if the engine REPLACES rather than merges the server env.
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: this.opts.browsersPath,
    }
    if (process.env.HOME) env.HOME = process.env.HOME
    if (process.env.PATH) env.PATH = process.env.PATH
    return {
      type: 'stdio',
      command: this.opts.execPath,
      args: [
        this.opts.cli.mcpCli,
        '--browser', this.channel(), // system Chrome if present, else bundled Chromium
        '--headless',
        '--isolated',
        // Let the agent navigate to local file:// URLs (its own generated HTML mocks/reports). Blocked
        // by default in @playwright/mcp, which otherwise forces a pointless local-HTTP-server dance to
        // preview one file. No blast-radius cost: the agent already has full FS read via Read/Bash.
        '--allow-unrestricted-file-access',
        '--output-dir', this.opts.outputDir,
      ],
      env,
    }
  }

  private runInstall(): Promise<PlaywrightState> {
    const cli = this.opts.cli!
    this.setState('installing', 'Downloading Chromium…')
    return new Promise<PlaywrightState>((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(
          this.opts.execPath,
          [cli.installCli, 'install', 'chromium'],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              PLAYWRIGHT_BROWSERS_PATH: this.opts.browsersPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      } catch (err) {
        log.error('playwright', 'install spawn failed', err instanceof Error ? err.message : err)
        return resolve(this.setState('error', 'Could not start the download'))
      }
      // Playwright prints human progress to stderr; surface the last line so the UI isn't a blank wait.
      child.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim().split('\n').pop()
        if (line) this.opts.onProgress?.({ state: 'installing', message: line })
      })
      child.on('error', (err) => {
        log.error('playwright', 'install error', err.message)
        resolve(this.setState('error', 'Download failed'))
      })
      child.on('close', (code) => {
        if (code === 0 && this.browsersPresent()) resolve(this.setState('ready', 'Ready'))
        else resolve(this.setState('error', 'Download failed'))
      })
    })
  }

  /** Which browser to drive: the user's installed Chrome when present (no download), else our Chromium. */
  private channel(): 'chrome' | 'chromium' {
    return this.systemChromePresent() ? 'chrome' : 'chromium'
  }

  /** True when Google Chrome (stable) is installed — then we drive it directly, zero download. */
  private systemChromePresent(): boolean {
    return CHROME_BINARIES.some((p) => existsSync(p))
  }

  /** A browser is drivable now: system Chrome present, OR a bundled Chromium download exists. */
  private hasBrowser(): boolean {
    return this.systemChromePresent() || this.browsersPresent()
  }

  /** A complete-enough Chromium download = a chromium build dir exists under the shared path. */
  private browsersPresent(): boolean {
    try {
      return (
        existsSync(this.opts.browsersPath) &&
        readdirSync(this.opts.browsersPath).some((d) => d.startsWith('chromium'))
      )
    } catch {
      return false
    }
  }

  private setState(state: PlaywrightState, message?: string): PlaywrightState {
    this.current = state
    this.opts.onProgress?.({ state, message })
    return state
  }
}
