/**
 * Voice-input controller — owns the long-lived on-device Speech helper process (one per window) that
 * streams dictation transcript lines into the renderer's composer.
 *
 * Fail-soft like the assist seam: no helper (non-mac / not built) or a spawn miss just returns
 * `{ started:false }` — the mic button stays unavailable. This NEVER throws; the renderer degrades to a
 * calm "voice unavailable" rather than a crash. Privileged work (the mic, the child process) stays here
 * in main; the renderer only sees parsed `VoiceEvent`s over IPC.
 */
import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { IpcChannels } from '@shared/channels'
import { VoiceEventSchema, type VoiceStartResponse } from '@shared/ipc'
import { resolveVoiceHelperPath } from './binary'
import { log } from '../logger'

interface Live {
  child: ChildProcess
  /** Carry-over for the stdout line splitter (a chunk can split mid-line). */
  buf: string
}

class VoiceController {
  /** At most one live helper per window, keyed by BrowserWindow id (the lifecycle hook has win.id). */
  private readonly live = new Map<number, Live>()
  private helperPath: string | null | undefined

  private resolvePath(): string | null {
    if (this.helperPath === undefined) {
      this.helperPath = resolveVoiceHelperPath({
        resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      })
    }
    return this.helperPath
  }

  startVoice(win: BrowserWindow): VoiceStartResponse {
    const helperPath = this.resolvePath()
    if (!helperPath) return { started: false, reason: 'unavailable' }

    const id = win.id
    this.killForWindow(id) // one helper per window — replace any prior

    let child: ChildProcess
    try {
      child = spawn(helperPath, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (err) {
      log.warn('voice', 'spawn failed', err instanceof Error ? err.message : err)
      return { started: false, reason: 'unavailable' }
    }

    const entry: Live = { child, buf: '' }
    this.live.set(id, entry)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      entry.buf += chunk
      let nl: number
      while ((nl = entry.buf.indexOf('\n')) >= 0) {
        const line = entry.buf.slice(0, nl).trim()
        entry.buf = entry.buf.slice(nl + 1)
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue // a non-JSON line (shouldn't happen) is dropped, never thrown
        }
        const event = VoiceEventSchema.safeParse(parsed)
        if (event.success && !win.isDestroyed()) win.webContents.send(IpcChannels.voiceEvent, event.data)
      }
    })

    // On exit (clean stop, error, or kill) tell the renderer to drop the recording UI. Guard against a
    // racing restart: only the CURRENT child for this window may emit `end`.
    const onExit = (): void => {
      if (this.live.get(id)?.child !== child) return
      this.live.delete(id)
      if (!win.isDestroyed()) win.webContents.send(IpcChannels.voiceEvent, { type: 'end' })
    }
    child.on('exit', onExit)
    child.on('error', (err) => {
      log.warn('voice', 'helper error', err instanceof Error ? err.message : err)
      onExit()
    })

    return { started: true }
  }

  stopVoice(win: BrowserWindow): void {
    const entry = this.live.get(win.id)
    if (!entry) return
    // Ask the helper to finish (newline → flush a pending final + exit), then SIGTERM as a backstop in
    // case it doesn't wind down. The exit handler does the map cleanup + `end` event.
    try {
      entry.child.stdin?.write('\n')
    } catch {
      /* stdin may already be closed — the SIGTERM backstop still applies */
    }
    const { child } = entry
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }, 2500)
  }

  /** Kill the window's helper immediately (window closed) — no `end` event needed, the UI is gone. */
  killForWindow(winId: number): void {
    const entry = this.live.get(winId)
    if (!entry) return
    this.live.delete(winId)
    entry.child.removeAllListeners()
    entry.child.stdout?.removeAllListeners()
    try {
      entry.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

export const voiceController = new VoiceController()
