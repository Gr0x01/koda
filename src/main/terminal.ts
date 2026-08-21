/**
 * The Terminal surface (a Dock tool): a real interactive shell scoped to the window's project — the
 * advanced "human can run it themselves" escape hatch (KODA governing principle: default is Claude
 * does it; advanced is the human can). One pty per workspace root, shared by the Mac window and any
 * phone session in that workspace. It lives while either side still owns it.
 *
 * This is a RAW shell — deliberately NOT routed through the approval gate or safety-git (unlike the
 * agent's Bash). It's the power-user tier, so the user owns what they type. Billing is untouched:
 * `buildEngineEnv()` is for the ENGINE; a user shell just wants the user's own environment, with PATH
 * fixed the same way every other user-tool spawn is (a Finder-launched .app otherwise can't find
 * node/brew — see user-path.ts).
 */
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { IpcChannels } from '@shared/channels'
import {
  TerminalSizeSchema,
  TerminalInputSchema,
  type RemoteTerminalStartResult,
  type RemoteTerminalState,
  type TerminalStartResult,
} from '@shared/ipc'
import { userPath } from './engine/user-path'
import { projectPathForWindow } from './window-registry'
import { log } from './logger'
import { TerminalOutputBuffer } from './terminal-buffer'

type Term = {
  pty: IPty
  cwd: string
  alive: boolean
  exitCode: number | null
  output: TerminalOutputBuffer
}

/** Workspace root → shell, plus the independent Mac-window and phone-session claims on that shell. */
const terms = new Map<string, Term>()
const windowTerms = new Map<number, string>()
const remoteTerms = new Map<string, { cwd: string; inputToken: string; lastInputSeq: number }>()

/** The user's interactive login shell. A pty makes it read that shell's startup files; PATH is
 *  restored via userPath() so brew/nvm tools resolve. Windows falls back to PowerShell. */
const DEFAULT_SHELL =
  process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || userInfo().shell || '/bin/sh'

/** Every desktop renderer currently bound to this workspace gets the same pty stream. */
function sendToWindows(cwd: string, channel: string, payload: unknown): void {
  for (const [winId, bound] of windowTerms) {
    if (bound !== cwd) continue
    const win = BrowserWindow.fromId(winId)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Spawn (or re-ensure) one workspace shell at `cols`×`rows`. A dead shell is replaced on the next
 * explicit start; its bounded output remains readable until then so an exit is never missed. */
function ensureTerm(cwd: string, cols: number, rows: number): Term {
  const existing = terms.get(cwd)
  if (existing?.alive) {
    try {
      existing.pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      /* a start racing an exit will replace it on the next explicit start */
    }
    return existing
  }

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
  const term: Term = {
    pty,
    cwd,
    alive: true,
    exitCode: null,
    output: new TerminalOutputBuffer(),
  }
  terms.set(cwd, term)

  pty.onData((data) => {
    term.output.append(data)
    sendToWindows(cwd, IpcChannels.terminalData, { data })
  })
  pty.onExit(({ exitCode }) => {
    if (terms.get(cwd) !== term) return
    term.alive = false
    term.exitCode = exitCode ?? null
    sendToWindows(cwd, IpcChannels.terminalExit, { code: term.exitCode })
  })
  log.info('terminal', `spawned ${DEFAULT_SHELL} in ${cwd}`)
  return term
}

function ensureWindowTerm(win: BrowserWindow, cols: number, rows: number): Term {
  const cwd = projectPathForWindow(win.id) || homedir()
  const previous = windowTerms.get(win.id)
  if (previous && previous !== cwd) {
    windowTerms.delete(win.id)
    disposeIfUnowned(previous)
  }
  windowTerms.set(win.id, cwd)
  return ensureTerm(cwd, cols, rows)
}

function ownsWorkspace(cwd: string): boolean {
  return [...windowTerms.values()].includes(cwd) || [...remoteTerms.values()].some((binding) => binding.cwd === cwd)
}

function disposeIfUnowned(cwd: string): void {
  if (ownsWorkspace(cwd)) return
  const term = terms.get(cwd)
  terms.delete(cwd)
  if (!term?.alive) return
  try {
    term.pty.kill()
  } catch {
    /* already gone */
  }
}

function remoteState(term: Term, after: number): RemoteTerminalState {
  return {
    cwd: term.cwd,
    ...term.output.read(after),
    exited: !term.alive,
    exitCode: term.exitCode,
  }
}

/** Bind a phone session to the shell for its authoritative workspace root. Starting again replaces
 * only that phone view's input capability and respawns the shell if the prior one exited. */
export function startRemoteTerminal(
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
): RemoteTerminalStartResult {
  const prior = remoteTerms.get(sessionId)
  if (prior && prior.cwd !== cwd) {
    remoteTerms.delete(sessionId)
    disposeIfUnowned(prior.cwd)
  }
  const inputToken = randomUUID()
  remoteTerms.set(sessionId, { cwd, inputToken, lastInputSeq: 0 })
  const term = ensureTerm(cwd, cols, rows)
  return { ...remoteState(term, 0), inputToken }
}

/** Read output since one phone cursor. No shell is implicitly created by a poll. */
export function pollRemoteTerminal(sessionId: string, after: number): RemoteTerminalState {
  const binding = remoteTerms.get(sessionId)
  const term = binding ? terms.get(binding.cwd) : undefined
  if (!binding || !term) throw new Error('terminal is not open')
  return remoteState(term, after)
}

/** Idempotent phone input. The per-open capability dies with this process/pty, while `inputSeq` makes a
 * lost reply safe to retry and makes a replayed relay frame a no-op. */
export function inputRemoteTerminal(
  sessionId: string,
  inputToken: string,
  inputSeq: number,
  data: string,
): void {
  const binding = remoteTerms.get(sessionId)
  if (!binding || binding.inputToken !== inputToken) throw new Error('terminal input expired')
  if (inputSeq <= binding.lastInputSeq) return
  if (inputSeq !== binding.lastInputSeq + 1) throw new Error('terminal input out of order')
  const term = terms.get(binding.cwd)
  if (!term?.alive) throw new Error('terminal has exited')
  term.pty.write(data)
  binding.lastInputSeq = inputSeq
}

export function resizeRemoteTerminal(
  sessionId: string,
  inputToken: string,
  cols: number,
  rows: number,
): void {
  const binding = remoteTerms.get(sessionId)
  if (!binding || binding.inputToken !== inputToken) throw new Error('terminal input expired')
  try {
    const term = terms.get(binding.cwd)
    if (term?.alive) term.pty.resize(Math.max(1, cols), Math.max(1, rows))
  } catch {
    /* a resize racing an exit — harmless */
  }
}

/** Release a session's phone claim. The Mac window's claim, if any, keeps the shared shell alive. */
export function killRemoteTerminal(sessionId: string): void {
  const binding = remoteTerms.get(sessionId)
  if (!binding) return
  remoteTerms.delete(sessionId)
  disposeIfUnowned(binding.cwd)
}

/** Put the terminal on stage in a window (the agent's open_terminal tool). `command`, when given, is
 *  staged at the prompt for the user to run — never executed here. The renderer owns the open + the
 *  staging (it drives the pty), so timing against the shell prompt stays correct. */
export function showTerminal(winId: number, sessionId: string, command?: string): void {
  const win = BrowserWindow.fromId(winId)
  if (!win || win.isDestroyed()) throw new Error('the terminal window is gone')
  win.webContents.send(IpcChannels.terminalShow, { sessionId, command })
}

/** Kill the window's shell (window close). No-op if none. */
export function killTerminal(winId: number): void {
  const cwd = windowTerms.get(winId)
  if (!cwd) return
  windowTerms.delete(winId)
  disposeIfUnowned(cwd)
}

/** Wire the terminal IPC. Call once from registerIpcHandlers(). */
export function registerTerminalIpc(): void {
  const windowOf = (sender: WebContents): BrowserWindow | null => BrowserWindow.fromWebContents(sender)

  ipcMain.handle(IpcChannels.terminalStart, (event, raw: unknown): TerminalStartResult => {
    const win = windowOf(event.sender)
    if (!win) return { ok: false }
    const { cols, rows } = TerminalSizeSchema.parse(raw)
    const term = ensureWindowTerm(win, cols, rows)
    // The phone may have created this workspace shell before the Dock mounted. Rehydrate the new xterm
    // from the same bounded replay the phone uses; otherwise the Mac would join a live shell after its
    // prompt/output and appear blank until the process happened to print again.
    const replay = term.output.read(0)
    if (replay.data) event.sender.send(IpcChannels.terminalData, { data: replay.data })
    if (!term.alive) event.sender.send(IpcChannels.terminalExit, { code: term.exitCode })
    return { ok: true, cwd: term.cwd }
  })

  ipcMain.on(IpcChannels.terminalInput, (event, raw: unknown) => {
    const win = windowOf(event.sender)
    if (!win) return
    const { data } = TerminalInputSchema.parse(raw)
    const cwd = windowTerms.get(win.id)
    const term = cwd ? terms.get(cwd) : undefined
    if (term?.alive) term.pty.write(data)
  })

  ipcMain.on(IpcChannels.terminalResize, (event, raw: unknown) => {
    const win = windowOf(event.sender)
    if (!win) return
    const { cols, rows } = TerminalSizeSchema.parse(raw)
    try {
      const cwd = windowTerms.get(win.id)
      const term = cwd ? terms.get(cwd) : undefined
      if (term?.alive) term.pty.resize(Math.max(1, cols), Math.max(1, rows))
    } catch {
      /* a resize racing an exit — harmless */
    }
  })
}
