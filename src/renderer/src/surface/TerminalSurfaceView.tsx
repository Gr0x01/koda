import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspace } from '../workspace/store'

/**
 * The Terminal Dock tool: a real interactive shell (xterm.js) bound to the window's per-project pty in
 * main (terminal.ts). The power-user escape hatch — run `npm run dev`, git, a one-off script — without
 * leaving Koda for VSCode. The parent (SurfaceHost) keeps this MOUNTED once opened and only hides it
 * with CSS on a tab switch, so the pty keeps running and scrollback survives.
 */

/** xterm theme derived from Koda's live CSS vars, so it tracks light/dark + appearance packs. The ANSI
 *  16-palette is a fixed, mid-saturation set (Nord-family) chosen to stay legible on BOTH the light-ink
 *  default and the dark packs — bg/fg/cursor come from the theme so the chrome always matches. */
function readTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback
  const bg = v('--koda-bg', '#0d0d0f')
  const fg = v('--koda-text', '#ededee')
  const accent = v('--koda-accent', '#6a93e6')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: `${accent}44`, // builtins + packs set --koda-accent as hex → 8-digit alpha is safe
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#d0a770',
    blue: '#5e81ac',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#d06b74',
    brightGreen: '#b5cfa0',
    brightYellow: '#e0b884',
    brightBlue: '#7a9edd',
    brightMagenta: '#c4a0bf',
    brightCyan: '#9fd6e3',
    brightWhite: '#f4f6fb',
  }
}

export function TerminalSurfaceView() {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // The shell has printed its first output (prompt is up) → safe to stage a command at it.
  const readyRef = useRef(false)
  const pendingTermCommand = useWorkspace((s) => s.pendingTermCommand)
  const clearPendingTermCommand = useWorkspace((s) => s.clearPendingTermCommand)

  // Type an agent-staged command (open_terminal) at the prompt once the shell is ready — but strip any
  // trailing newline so it's only STAGED, never run: the user reviews it and presses Enter themselves.
  // Held in a ref, reassigned every render, so the []-effect's data handler always calls the current
  // version (no stale closure on pendingTermCommand).
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () => {
    if (!readyRef.current || !pendingTermCommand) return
    window.koda.sendTerminalInput({ data: pendingTermCommand.replace(/[\r\n]+$/, '') })
    termRef.current?.focus()
    clearPendingTermCommand()
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'Spline Sans Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: readTheme(),
      allowProposedApi: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term

    let exited = false
    const start = (): void => {
      exited = false
      readyRef.current = false // a fresh shell hasn't printed its prompt yet
      void window.koda.startTerminal({ cols: term.cols, rows: term.rows })
    }
    start()

    const offData = window.koda.onTerminalData(({ data }) => {
      term.write(data)
      // First output = the prompt is up → a staged command (open_terminal) can now be typed at it.
      readyRef.current = true
      flushRef.current()
    })
    const offExit = window.koda.onTerminalExit(({ code }) => {
      exited = true
      term.write(
        `\r\n\x1b[2m[shell exited${code ? ` (code ${code})` : ''}] — press Enter to start a new one\x1b[0m\r\n`,
      )
    })
    // Keystrokes → pty stdin. When the shell has exited, swallow input and let Enter respawn a fresh one.
    const onInput = term.onData((data) => {
      if (exited) {
        if (data === '\r') {
          term.clear()
          start()
        }
        return
      }
      window.koda.sendTerminalInput({ data })
    })

    // Refit + tell the pty on any pane resize: tab shown (0→size), dock resized, window resized. Hidden
    // (display:none) → 0 size → FitAddon no-ops, so this is safe while the tool sits in the background.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* proposeDimensions bailed on a zero-size (hidden) pane */
      }
      if (!exited) window.koda.resizeTerminal({ cols: term.cols, rows: term.rows })
    })
    ro.observe(host)

    // Light/dark toggle + appearance-pack switches mutate <html>'s class / inline --koda-* vars — re-read.
    const mo = new MutationObserver(() => {
      term.options.theme = readTheme()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })

    return () => {
      offData()
      offExit()
      onInput.dispose()
      ro.disconnect()
      mo.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // The shelf may already be open (prompt up) when the command lands — flush on the store change too.
  useEffect(() => {
    flushRef.current()
  }, [pendingTermCommand])

  // The pty is torn down in main on window close; leaving the tool just hides it (see SurfaceHost).
  return <div ref={hostRef} className="h-full w-full overflow-hidden px-2 py-1.5" style={{ background: 'var(--koda-bg)' }} />
}
