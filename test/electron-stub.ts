/**
 * Minimal `electron` stub for vitest — main-process modules import `electron` transitively (logger →
 * app.getPath), but unit tests run in plain Node with no Electron runtime. Only the surface the tests'
 * import graph actually touches is stubbed; extend as more main modules come under test.
 */
import { tmpdir } from 'node:os'

export const app = {
  getPath: (_name: string): string => tmpdir(),
  getName: (): string => 'Koda',
  isReady: (): boolean => true,
  on: (): void => {},
  whenReady: (): Promise<void> => Promise.resolve(),
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
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (_s: string): Buffer => {
    throw new Error('safeStorage unavailable in tests')
  },
  decryptString: (_b: Buffer): string => {
    throw new Error('safeStorage unavailable in tests')
  },
}

export default { app, Notification, safeStorage }
