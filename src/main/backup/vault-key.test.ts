/**
 * The vault key is the ONE secret behind cloud backup, and the failure mode that matters isn't
 * "backup breaks" — it's "backup silently re-keys and reports success". A key file that exists but
 * can't be decrypted (Keychain reset, corrupt bytes) must never be treated the same as no file at
 * all: only `ensureVaultKey` minting on a genuinely absent file is safe. `electron` is mocked
 * (rather than the shared stub) so decrypt failures can be forced deterministically, the same
 * pattern relay-keys.test.ts uses for the same reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  dir: { value: '' },
  encryptionAvailable: { value: true },
  decryptImpl: { value: (b: Buffer) => b.toString('utf8') } as { value: (b: Buffer) => string },
  renameShouldThrow: { value: false },
  userId: { value: null as string | null },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (h.renameShouldThrow.value) throw new Error('simulated power cut between write and rename')
      return actual.renameSync(...args)
    },
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.dir.value, getName: () => 'Koda', on: () => {}, isReady: () => true, whenReady: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => h.encryptionAvailable.value,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => h.decryptImpl.value(b),
  },
}))

// index.ts's revealRecoveryCode pulls in the whole remote-control/supabase stack through its
// sibling imports — none of it runs for this function, so it's all stubbed to import the real
// wiring (not a hand-rolled equivalent) without dragging that stack into a vault-key unit test.
vi.mock('../settings', () => ({ loadBackupEnabled: () => true, loadReplicaEnabled: () => false }))
vi.mock('../remote-control', () => ({ onAuthState: () => {} }))
vi.mock('./replica', () => ({ replicaNow: async () => ({}) }))
vi.mock('./bundle', () => ({ bundleFingerprint: async () => null, createBundle: async () => null, restoreFromBundle: async () => {} }))
vi.mock('./crypto', () => ({ backupAad: () => '', decryptBlob: () => Buffer.alloc(0), encryptBlob: () => Buffer.alloc(0) }))
vi.mock('./storage', () => ({
  currentUserId: async () => h.userId.value,
  downloadBundle: async () => Buffer.alloc(0),
  downloadManifest: async () => null,
  listBackups: async () => [],
  projectHash: async () => '',
  uploadBackup: async () => ({}),
}))

import { log } from '../logger'
import { decodeRecoveryCode, ensureVaultKey, getVaultKey, readVaultKeyState, setVaultKey } from './vault-key'
import { backupNow, revealRecoveryCode } from './index'

function keyFilePath(): string {
  return join(h.dir.value, 'backup-vault-key.enc')
}

/** Seeds a key file the mock's identity "cipher" (encryptString(s) = utf8 bytes of s) can read back,
 *  matching how ensureVaultKey/setVaultKey actually write: base64(encryptString(base64(key))). */
function seedValidKey(): Buffer {
  const key = Buffer.alloc(32, 7)
  const cipherBytes = Buffer.from(key.toString('base64'), 'utf8') // == encryptString's mocked output
  writeFileSync(keyFilePath(), cipherBytes.toString('base64'))
  return key
}

beforeEach(() => {
  h.dir.value = mkdtempSync(join(tmpdir(), 'koda-vault-key-'))
  h.encryptionAvailable.value = true
  h.decryptImpl.value = (b: Buffer) => b.toString('utf8')
  // Reset here as well as after: a test that fails mid-body must not leak a throwing rename into
  // every test that follows it.
  h.renameShouldThrow.value = false
  h.userId.value = null
})
afterEach(() => {
  h.renameShouldThrow.value = false
  h.userId.value = null
  rmSync(h.dir.value, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('absent key file — the happy path', () => {
  it('readVaultKeyState reports absent, getVaultKey is null, no file exists', () => {
    expect(readVaultKeyState()).toEqual({ state: 'absent' })
    expect(getVaultKey()).toBeNull()
    expect(existsSync(keyFilePath())).toBe(false)
  })

  it('ensureVaultKey mints exactly as before: creates a 32-byte key and persists it', () => {
    const key = ensureVaultKey()
    expect(key).not.toBeNull()
    expect(key!.length).toBe(32)
    expect(existsSync(keyFilePath())).toBe(true)
    // Round-trips through the real read path.
    expect(getVaultKey()).toEqual(key)
  })

  // Reveal is the ONLY user-initiated way to obtain the code, and there is no enable flow — if it
  // refused here, the key would first appear via a background backup and a user could hold real
  // cloud backups having never seen their only cross-Mac recovery. Minting is safe precisely
  // because `absent` is the one state the invariant allows to be minted over.
  it('revealRecoveryCode mints on absent, and prints the key it actually persisted', () => {
    const result = revealRecoveryCode()
    expect(result.unreadable).toBe(false)
    expect(result.code).toMatch(/^KODA-/)
    expect(existsSync(keyFilePath())).toBe(true)
    expect(decodeRecoveryCode(result.code!)).toEqual(getVaultKey())
  })

  it('a minted key file is 0600 — the one secret is not group- or world-readable', () => {
    expect(ensureVaultKey()).not.toBeNull()
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600)
  })
})

describe('a readable key file', () => {
  it('revealRecoveryCode returns the code for the key on disk', () => {
    const key = seedValidKey()
    const result = revealRecoveryCode()
    expect(result.unreadable).toBe(false)
    expect(result.code).toMatch(/^KODA-/)
    // Round-trips back to the exact stored key — not merely "some string was returned".
    expect(decodeRecoveryCode(result.code!)).toEqual(key)
  })
})

describe('existing key file that fails to decrypt', () => {
  beforeEach(() => {
    seedValidKey()
    // Force every decrypt to throw from here on — simulates a Keychain reset / corrupt bytes.
    h.decryptImpl.value = () => {
      throw new Error('decryption failed')
    }
  })

  it('is reported unreadable, not absent', () => {
    expect(readVaultKeyState()).toEqual({ state: 'unreadable' })
    expect(getVaultKey()).toBeNull()
  })

  it('is left byte-identical after ensureVaultKey(), which returns null', () => {
    const before = readFileSync(keyFilePath())
    const result = ensureVaultKey()
    expect(result).toBeNull()
    const after = readFileSync(keyFilePath())
    expect(after.equals(before)).toBe(true)
  })

  it('revealRecoveryCode reports unreadable and does not touch the file', () => {
    const before = readFileSync(keyFilePath())
    const result = revealRecoveryCode()
    expect(result).toEqual({ code: null, unreadable: true })
    expect(readFileSync(keyFilePath()).equals(before)).toBe(true)
  })

  it('logs the read failure', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    readVaultKeyState()
    expect(warnSpy).toHaveBeenCalledWith('backup', 'could not read vault key', expect.anything())
  })
})

describe('existing key file that decrypts to the wrong length', () => {
  beforeEach(() => {
    // Decrypts successfully but to garbage of the wrong size — not a throw, a silent short/long value.
    writeFileSync(keyFilePath(), Buffer.from('short', 'utf8').toString('base64'))
    h.decryptImpl.value = (b: Buffer) => b.toString('utf8')
  })

  it('is reported unreadable, not absent — same as a decrypt throw', () => {
    expect(readVaultKeyState()).toEqual({ state: 'unreadable' })
    expect(getVaultKey()).toBeNull()
  })

  it('is left byte-identical after ensureVaultKey(), which returns null', () => {
    const before = readFileSync(keyFilePath())
    expect(ensureVaultKey()).toBeNull()
    expect(readFileSync(keyFilePath()).equals(before)).toBe(true)
  })

  it('logs the wrong-length branch (previously completely silent)', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    readVaultKeyState()
    expect(warnSpy).toHaveBeenCalledWith('backup', expect.stringMatching(/wrong length/))
  })
})

describe('setVaultKey / ensureVaultKey write atomically', () => {
  it('a successful write leaves no orphaned temp file at the final path', () => {
    expect(setVaultKey(Buffer.alloc(32, 3))).toBe(true)
    expect(existsSync(join(h.dir.value, 'backup-vault-key.enc.tmp'))).toBe(false)
    expect(getVaultKey()).toEqual(Buffer.alloc(32, 3))
  })

  // Going through a temp file + rename is what made the mode explicit: writeFileSync's default 0666
  // would leave the one secret readable by every process running as anyone on the Mac.
  it('setVaultKey writes the key file 0600', () => {
    expect(setVaultKey(Buffer.alloc(32, 3))).toBe(true)
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600)
  })

  it('a crash mid-write (rename throws) leaves the previous key file untouched', () => {
    seedValidKey()
    const before = readFileSync(keyFilePath())
    h.renameShouldThrow.value = true
    expect(setVaultKey(Buffer.alloc(32, 9))).toBe(false)
    // The old file is exactly what it was — a torn write in this scheme can only ever produce an
    // orphaned .tmp sibling, never a half-written file at the real path.
    expect(readFileSync(keyFilePath()).equals(before)).toBe(true)
  })
})

/** The refusal only matters where it reaches the user: a paused backup, in Settings, with a message
 *  that sends them to their recovery code instead of reading as "nothing to do". */
describe('runBackup refuses an unreadable key', () => {
  it('reports the refusal as backup status and never touches the key file', async () => {
    h.userId.value = 'user-1'
    seedValidKey()
    h.decryptImpl.value = () => {
      throw new Error('decryption failed')
    }
    const before = readFileSync(keyFilePath())

    const status = await backupNow(join(h.dir.value, 'project'))

    expect(status.state).toBe('error')
    expect(status.error).toMatch(/can.t open its backup key/)
    // Honest in all three causes of `unreadable`, and points at the only thing that helps.
    expect(status.error).toMatch(/recovery code/)
    expect(status.error).toMatch(/paused/)
    expect(readFileSync(keyFilePath()).equals(before)).toBe(true)
  })
})
