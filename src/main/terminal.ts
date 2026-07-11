/**
 * The Terminal surface (a Dock tool): a real interactive shell scoped to the window's project — the
 * advanced "human can run it themselves" escape hatch (KODA governing principle: default is Claude
 * does it; advanced is the human can). One pty per window, keyed by window id, killed on window close.
 *
 * This is a RAW shell — deliberately NOT routed through the approval gate or safety-git (unlike the
 * agent's Bash). It's the power-user tier, so the user owns what they type. Billing is untouched:
 * `buildEngineEnv()` is for the ENGINE; a user shell just wants the user's own environment, with PATH
 * fixed the same way every other user-tool spawn is (a Finder-launched .app otherwise can't find
 * node/brew — see user-path.ts).
 */
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { homedir } from 'node:os'
import { IpcChannels } from '@shared/channels'
import { TerminalSizeSchema, TerminalInputSchema, type TerminalStartResult } from '@shared/ipc'
import { userPath } from './engine/user-path'
import { projectPathForWindow } from './window-registry'
import { log } from './logger'

type Term = { pty: IPty; cwd: string }

/** One shell per window (the Dock is window-scoped; every session in the window shares its project cwd). */
const terms = new Map<number, Term>()

/** The user's interactive login shell. A pty makes it interactive (reads ~/.zshrc → aliases); PATH is
 *  restored via userPath() so brew/nvm tools resolve. Windows falls back to PowerShell. */
const DEFAULT_SHELL =
  process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'

/** Spawn (or re-ensure) the window's shell at `cols`×`rows`. Respawns if the prior one exited (the
 *  user typed `exit`, or a crash). Returns the cwd so the renderer can show it once as a hint. */
function ensureTerm(win: BrowserWindow, cols: number, rows: number): Term {
  const existing = terms.get(win.id)
  if (existing) return existing

  const cwd = projectPathForWindow(win.id) || homedir()
  // The user's own environment (NOT buildEngineEnv — that's the billing chokepoint for the engine).
  // Only PATH is fixed, exactly like preview/dev-server spawns, so `node`/`npm`/`python3` resolve.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: userPath(), TERM: 'xterm-256color' }
  delete env.ELECTRON_RUN_AS_NODE // never leak Electron's node-mode flag into the user's shell

  const pty = ptySpawn(DEFAULT_SHELL, [], {
    name: 'xterm-256color',
    cwd,
    env,
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
  })
  const term: Term = { pty, cwd }
  terms.set(win.id, term)

  pty.onData((data) => {
    // The pty can outlive a reload's webContents momentarily; guard the send.
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.terminalData, { data })
  })
  pty.onExit(({ exitCode }) => {
    if (terms.get(win.id) === term) terms.delete(win.id)
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.terminalExit, { code: exitCode ?? null })
  })
  log.info('terminal', `spawned ${DEFAULT_SHELL} in ${cwd} (win ${win.id})`)
  return term
}

/** Pop the terminal shelf open in a window (the agent's open_terminal tool). `command`, when given, is
 *  staged at the prompt for the user to run — never executed here. The renderer owns the open + the
 *  staging (it drives the pty), so timing against the shell prompt stays correct. */
export function showTerminal(winId: number, sessionId: string, command?: string): void {
  const win = BrowserWindow.fromId(winId)
  if (!win || win.isDestroyed()) throw new Error('the terminal window is gone')
  win.webContents.send(IpcChannels.terminalShow, { sessionId, command })
}

/** Kill the window's shell (window close). No-op if none. */
export function killTerminal(winId: number): void {
  const term = terms.get(winId)
  if (!term) return
  terms.delete(winId)
  try {
    term.pty.kill()
  } catch {
    /* already gone */
  }
}

/** Wire the terminal IPC. Call once from registerIpcHandlers(). */
export function registerTerminalIpc(): void {
  const windowOf = (sender: WebContents): BrowserWindow | null => BrowserWindow.fromWebContents(sender)

  ipcMain.handle(IpcChannels.terminalStart, (event, raw: unknown): TerminalStartResult => {
    const win = windowOf(event.sender)
    if (!win) return { ok: false }
    const { cols, rows } = TerminalSizeSchema.parse(raw)
    const term = ensureTerm(win, cols, rows)
    return { ok: true, cwd: term.cwd }
  })

  ipcMain.on(IpcChannels.terminalInput, (event, raw: unknown) => {
    const win = windowOf(event.sender)
    if (!win) return
    const { data } = TerminalInputSchema.parse(raw)
    terms.get(win.id)?.pty.write(data)
  })

  ipcMain.on(IpcChannels.terminalResize, (event, raw: unknown) => {
    const win = windowOf(event.sender)
    if (!win) return
    const { cols, rows } = TerminalSizeSchema.parse(raw)
    try {
      terms.get(win.id)?.pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      /* a resize racing an exit — harmless */
    }
  })
}
