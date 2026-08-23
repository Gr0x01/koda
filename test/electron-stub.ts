/**
 * Minimal `electron` stub for vitest — main-process modules import `electron` transitively (logger →
 * app.getPath), but unit tests run in plain Node with no Electron runtime. Only the surface the tests'
 * import graph actually touches is stubbed; extend as more main modules come under test.
 */
import { tmpdir } from 'node:os'

export const app = {
  getPath: (_name: string): string => tmpdir(),
  getName: (): string => 'Koda',
  getVersion: (): string => '0.0.0-test',
  isPackaged: false,
  isReady: (): boolean => true,
  on: (): void => {},
  whenReady: (): Promise<void> => Promise.resolve(),
}

/**
 * A recording `ipcMain` — `registerIpcHandlers()` only ever registers here, so a test can register the
 * real handlers and then invoke one directly (`invokeIpc(channel, sender, args)`). That keeps the IPC
 * boundary tests honest: they exercise the shipped handler body, not a copy of its logic.
 */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

export const ipcMain = {
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
    handlers.set(channel, fn)
  },
  on: (): void => {},
  removeHandler: (channel: string): void => {
    handlers.delete(channel)
  },
}

/** Call a registered handler as the renderer would. `sender` is any object; BrowserWindow.fromWebContents
 *  reads its `__win` back out, so a test seeds `{ __win: { id } }` alongside registerWindow(). */
export async function invokeIpc(channel: string, sender: unknown, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no IPC handler registered for ${channel}`)
  return await fn({ sender }, ...args)
}

export const BrowserWindow = {
  fromWebContents: (sender: { __win?: unknown }): unknown => sender?.__win,
  getAllWindows: (): unknown[] => [],
  fromId: (): unknown => null,
}

/** preview.ts registers the `koda-preview://` scheme at import time in production. Tests call its
 *  exported request handler directly, so registration only has to resolve, not do anything. */
export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (): void => {},
}

export const dialog = {
  showSaveDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }),
  showOpenDialog: async (): Promise<{ canceled: boolean }> => ({ canceled: true }),
}

export const shell = {
  openExternal: async (): Promise<void> => {},
  showItemInFolder: (): void => {},
  openPath: async (): Promise<string> => '',
  trashItem: async (): Promise<void> => {},
}

// status-watch (pulled in transitively by the engine adapter) imports Notification at module load and
// calls it only on provider-recovery — never in a test. Stub it so the import resolves; isSupported()
// returns false so the notify path stays inert if ever reached.
export class Notification {
  static isSupported(): boolean {
    return false
  }
  constructor(_opts?: unknown) {}
  show(): void {}
}

// vault-key (backup) imports safeStorage; unit tests only exercise the pure recovery-code/crypto
// paths, so "encryption unavailable" keeps the persistence paths inert (they fail-soft to null).
// suspension-watchdog imports powerMonitor; tests inject a fake emitter, so this only needs to resolve.
export const powerMonitor = {
  on: (): void => {},
  off: (): void => {},
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (_s: string): Buffer => {
    throw new Error('safeStorage unavailable in tests')
  },
  decryptString: (_b: Buffer): string => {
    throw new Error('safeStorage unavailable in tests')
  },
}

export default {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  protocol,
  safeStorage,
  powerMonitor,
  shell,
}
