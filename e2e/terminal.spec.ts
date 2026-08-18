import { test, expect } from '@playwright/test'
import { launchKoda } from './support/koda'

// The terminal's value is the pty round-trip: spawn a real shell (node-pty, rebuilt for Electron's
// ABI), feed it a command, and stream output back. Driving the preload API directly exercises the
// whole main↔renderer pipe (start → input → data) without needing to read xterm's canvas. The marker
// is the RESULT of shell arithmetic, so its presence proves the shell actually EXECUTED the line (the
// typed echo only ever shows the literal `$((6*7))`, never `TERM-OK:42`).
test('terminal spawns a real shell and streams command output back', async () => {
  const app = await launchKoda()
  try {
    const window = await app.firstWindow()
    await window.getByRole('heading', { name: 'Open a project' }).waitFor({ timeout: 15_000 })

    const out = await window.evaluate(
      () =>
        new Promise<string>((resolve) => {
          let buf = ''
          const off = window.koda.onTerminalData(({ data }) => {
            buf += data
            if (buf.includes('TERM-OK:42')) {
              off()
              resolve(buf)
            }
          })
          void window.koda.startTerminal({ cols: 80, rows: 24 }).then(() => {
            setTimeout(() => window.koda.sendTerminalInput({ data: "printf 'TERM-OK:%s\\n' $((6*7))\r" }), 400)
          })
          setTimeout(() => {
            off()
            resolve(`TIMEOUT: ${buf}`)
          }, 10_000)
        }),
    )

    expect(out).toContain('TERM-OK:42')
  } finally {
    await app.close()
  }
})
