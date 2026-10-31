import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAllWindows, everyWindow, on, removeListener, listeners } = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  everyWindow: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: everyWindow },
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      on(channel, listener)
      listeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      removeListener(channel, listener)
      if (listeners.get(channel) === listener) listeners.delete(channel)
    }),
  },
}))

vi.mock('./window-registry', () => ({ registeredWindows: getAllWindows }))

import { IpcChannels } from '@shared/channels'
import { flushRendererState } from './renderer-state'

function windowStub(id: number) {
  return {
    isDestroyed: () => false,
    webContents: { id, send: vi.fn() },
  }
}

describe('flushRendererState', () => {
  beforeEach(() => {
    getAllWindows.mockReset()
    everyWindow.mockReset()
    on.mockClear()
    removeListener.mockClear()
    listeners.clear()
  })

  it('returns a certification timestamp only after every distinct renderer reports a saved state', async () => {
    const first = windowStub(11)
    const second = windowStub(22)
    getAllWindows.mockReturnValue([first, second])

    const pending = flushRendererState()
    const acknowledge = listeners.get(IpcChannels.uiFlushStateDone)
    acknowledge?.({ sender: { id: 11 } }, true)
    acknowledge?.({ sender: { id: 11 } }, true) // duplicate cannot certify the second renderer
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    acknowledge?.({ sender: { id: 22 } }, true)

    await expect(pending).resolves.toEqual(expect.any(Number))
    expect(first.webContents.send).toHaveBeenCalledWith(IpcChannels.uiFlushState)
    expect(second.webContents.send).toHaveBeenCalledWith(IpcChannels.uiFlushState)
  })

  it('refuses to certify the hot store when any renderer save fails', async () => {
    getAllWindows.mockReturnValue([windowStub(11), windowStub(22)])

    const pending = flushRendererState()
    const acknowledge = listeners.get(IpcChannels.uiFlushStateDone)
    acknowledge?.({ sender: { id: 11 } }, true)
    acknowledge?.({ sender: { id: 22 } }, false)

    await expect(pending).resolves.toBeUndefined()
  })

  it('does not wait on auxiliary windows that have no preload to acknowledge', async () => {
    const project = windowStub(11)
    const neuralView = windowStub(99)
    getAllWindows.mockReturnValue([project])
    everyWindow.mockReturnValue([project, neuralView])

    const pending = flushRendererState()
    listeners.get(IpcChannels.uiFlushStateDone)?.({ sender: { id: 11 } }, true)

    await expect(pending).resolves.toEqual(expect.any(Number))
    expect(neuralView.webContents.send).not.toHaveBeenCalled()
  })
})
