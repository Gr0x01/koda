import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from '@shared/ipc'

// updater.ts is packaged-only and talks to electron-updater's autoUpdater. Stand in a plain
// EventEmitter for it so the tests can drive the exact event order a real 6-hourly re-check produces.
const fakeUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  logger: null as unknown,
  checkForUpdates: vi.fn(async () => null),
  quitAndInstall: vi.fn(() => {}),
})

vi.mock('electron-updater', () => ({ autoUpdater: fakeUpdater }))

// What the renderer would receive: every push on the update:status channel, in order.
const sent: UpdateStatus[] = []

// Layered on test/electron-stub.ts (the vitest alias for `electron`): updater.ts is packaged-only and
// broadcasts to every window. Typed loosely because tsconfig.node.json doesn't include test/.
vi.mock('electron', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    app: { ...(actual.app as object), isPackaged: true, getVersion: () => '0.1.9' },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: { send: (_ch: string, s: UpdateStatus) => sent.push(s) } }],
    },
  }
})

/** Fresh module state per test — `status`/`staged` live at module scope in updater.ts. */
async function bootUpdater(): Promise<typeof import('./updater')> {
  vi.resetModules()
  fakeUpdater.removeAllListeners()
  fakeUpdater.checkForUpdates.mockClear()
  fakeUpdater.quitAndInstall.mockClear()
  sent.length = 0
  const mod = await import('./updater')
  mod.initUpdater()
  await Promise.resolve() // let the launch check settle
  return mod
}

beforeEach(() => {
  vi.useFakeTimers() // initUpdater sets a 6h re-check interval; don't leave a live timer behind
})

afterEach(() => {
  vi.useRealTimers()
})

// Item 27: a downloaded update is a durable fact -- the build is on disk and installable. The status
// variable also carried transient check outcomes, so the next automatic check (every 6h) overwrote
// `ready` with `checking` and then `error`/`up-to-date`, and the install affordance vanished for the
// rest of the run even though the update was still staged.
describe('a staged update survives a later check', () => {
  it('stays ready through a failed re-check, and still installs', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('update-downloaded', { version: '0.2.0' })
    expect(updater.getUpdateStatus()).toEqual({ state: 'ready', version: '0.2.0' })

    // Six hours later: the feed is unreachable.
    fakeUpdater.emit('checking-for-update')
    fakeUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))

    expect(updater.getUpdateStatus()).toEqual({ state: 'ready', version: '0.2.0' })
    // ...and the renderer was never told otherwise, so the banner/button stay on screen.
    expect(sent.every((s) => s.state !== 'error' && s.state !== 'checking')).toBe(true)
    expect(sent.at(-1)).toEqual({ state: 'ready', version: '0.2.0' })

    updater.quitAndInstallUpdate()
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('stays ready through an empty re-check (feed says nothing new)', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('update-downloaded', { version: '0.2.0' })

    fakeUpdater.emit('checking-for-update')
    fakeUpdater.emit('update-not-available', { version: '0.1.9' })

    expect(updater.getUpdateStatus()).toEqual({ state: 'ready', version: '0.2.0' })
  })

  it('stays ready through the re-download churn for the build already on disk', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('update-downloaded', { version: '0.2.0' })

    // A re-check re-announces the same version and electron-updater re-runs its (cached) download.
    fakeUpdater.emit('checking-for-update')
    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('download-progress', { percent: 3 })

    expect(updater.getUpdateStatus()).toEqual({ state: 'ready', version: '0.2.0' })
  })

  // A newer build DELETES the staged one: electron-updater empties its pending cache before fetching a
  // different version. So the honest behavior after a failed supersede is the error — offering the old
  // build back would be a "Restart to update" button pointing at a file that is gone.
  it('shows progress for a genuinely newer build and does not resurrect the deleted one on failure', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('update-downloaded', { version: '0.2.0' })

    fakeUpdater.emit('update-available', { version: '0.3.0' })
    fakeUpdater.emit('download-progress', { percent: 42 })
    expect(updater.getUpdateStatus()).toEqual({ state: 'downloading', version: '0.3.0', percent: 42 })

    fakeUpdater.emit('error', new Error('download aborted'))
    expect(updater.getUpdateStatus()).toEqual({ state: 'error', message: 'download aborted' })

    updater.quitAndInstallUpdate()
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  // A progress event that beats update-available carries no version. It must not read as a new build
  // and wipe a real offer.
  it('keeps the offer when a versionless progress event arrives', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('update-downloaded', { version: '0.2.0' })

    fakeUpdater.emit('download-progress', { percent: 7 })
    expect(updater.getUpdateStatus()).toEqual({ state: 'ready', version: '0.2.0' })
  })
})

// Positive control for the above: durability must come from something actually being on disk, not
// from the state being sticky. A run with nothing staged offers no install.
describe('a fresh launch with nothing staged offers no install', () => {
  it('reports the real check outcome and refuses to quit-and-install', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('checking-for-update')
    expect(updater.getUpdateStatus()).toEqual({ state: 'checking' })
    fakeUpdater.emit('update-not-available', { version: '0.1.9' })
    expect(updater.getUpdateStatus()).toEqual({ state: 'up-to-date' })

    fakeUpdater.emit('checking-for-update')
    fakeUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(updater.getUpdateStatus()).toEqual({
      state: 'error',
      message: 'net::ERR_INTERNET_DISCONNECTED',
    })

    expect(sent.some((s) => s.state === 'ready')).toBe(false)
    updater.quitAndInstallUpdate()
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('an in-flight download is not installable either', async () => {
    const updater = await bootUpdater()

    fakeUpdater.emit('update-available', { version: '0.2.0' })
    fakeUpdater.emit('download-progress', { percent: 10 })
    expect(updater.getUpdateStatus()).toEqual({ state: 'downloading', version: '0.2.0', percent: 10 })

    updater.quitAndInstallUpdate()
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})
