import { ipcMain, type IpcMainEvent } from 'electron'
import { IpcChannels } from '@shared/channels'
import { registeredWindows } from './window-registry'

/**
 * Ask every renderer to persist its current workspace state and return the instant immediately before
 * that snapshot began. `undefined` means at least one renderer timed out or reported a failed save, so
 * a caller must not treat the disk hot-session store as complete.
 *
 * The same primitive protects both quit and Dream. Tracking acknowledgements by webContents id keeps
 * one noisy renderer from accidentally certifying the others. Only registered workspace windows are
 * asked: auxiliary windows have no preload to acknowledge, and waiting on them would time out every pass.
 */
export function flushRendererState(timeoutMs = 1_000): Promise<number | undefined> {
  const windows = registeredWindows().filter((window) => !window.isDestroyed())
  const snapshotStartedAt = Date.now()
  if (windows.length === 0) return Promise.resolve(snapshotStartedAt)

  return new Promise((resolve) => {
    const pending = new Set(windows.map((window) => window.webContents.id))
    let allSaved = true
    const finish = (complete: boolean): void => {
      clearTimeout(timer)
      ipcMain.removeListener(IpcChannels.uiFlushStateDone, onDone)
      resolve(complete && allSaved ? snapshotStartedAt : undefined)
    }
    const onDone = (event: IpcMainEvent, saved: unknown): void => {
      if (!pending.delete(event.sender.id)) return
      if (saved !== true) allSaved = false
      if (pending.size === 0) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    ipcMain.on(IpcChannels.uiFlushStateDone, onDone)
    for (const window of windows) window.webContents.send(IpcChannels.uiFlushState)
  })
}
