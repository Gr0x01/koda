/**
 * The backup vault key — the ONE secret behind blind-E2E cloud backup. 32 random bytes, generated
 * on this Mac at first enable, never sent to any server (the server only ever sees ciphertext).
 * Stored like every other Koda secret: safeStorage-encrypted file in userData (api-key.ts pattern).
 *
 * The recovery code IS the raw key, Crockford-base32-encoded with a 2-byte checksum — the
 * 1Password-Secret-Key shape: one secret, one job, no wrapping-key tier (there's no password layer
 * for a KDF to combine with, so a second tier buys nothing). Losing the Mac's Keychain AND the code
 * means the backup is unrecoverable by anyone, including Koda — that's the promise, not a bug.
 * (iCloud Keychain sync of this key is a Phase 2 spike; Phase 1 cross-Mac recovery is the code.)
 *
 * `readVaultKeyState()` is the load-bearing distinction: a key file that EXISTS but can't be
 * decrypted (Keychain reset, corrupt bytes, a stray truncated write) is `'unreadable'`, never
 * `'absent'`. Only `'absent'` may mint a fresh key — minting over an unreadable file would silently
 * re-key the vault out from under every blob it already sealed (see decision-log 2026-08-08).
 */
import { app, safeStorage } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import { log } from '../logger'

const KEY_BYTES = 32
const CHECKSUM_BYTES = 2

function keyPath(): string {
  return join(app.getPath('userData'), 'backup-vault-key.enc')
}

export type VaultKeyState = { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; key: Buffer }

/** The three-state read: distinguishes "no key file yet" (safe to mint) from "a key file exists
 *  but this Mac can't open it right now" (must NEVER be treated as absent). */
export function readVaultKeyState(): VaultKeyState {
  const p = keyPath()
  if (!existsSync(p)) return { state: 'absent' }
  try {
    if (!safeStorage.isEncryptionAvailable()) return { state: 'unreadable' }
    const key = Buffer.from(safeStorage.decryptString(Buffer.from(readFileSync(p, 'utf8'), 'base64')), 'base64')
    if (key.length !== KEY_BYTES) {
      log.warn('backup', 'vault key file decrypted to the wrong length — treating as unreadable')
      return { state: 'unreadable' }
    }
    return { state: 'ok', key }
  } catch (err) {
    log.warn('backup', 'could not read vault key', err instanceof Error ? err.message : err)
    return { state: 'unreadable' }
  }
}

/** Decrypt the stored vault key. Null covers absent, unreadable, and encryption-unavailable alike —
 *  callers that only need "do I have a usable key" (e.g. restoreCloudBackup's "fall back to the typed
 *  recovery code" branch) treat both the same way already. Callers that must NOT mint over an
 *  unreadable file use `readVaultKeyState()` directly. */
export function getVaultKey(): Buffer | null {
  const s = readVaultKeyState()
  return s.state === 'ok' ? s.key : null
}

/** Get the vault key, generating + persisting one on first use. Mints ONLY when no key file exists
 *  at all — an unreadable file returns null without ever being touched, so a Keychain hiccup can
 *  never overwrite a key that already sealed real blobs. Null also covers safeStorage being
 *  unavailable or the write failing — backup stays disabled rather than holding a key only in RAM
 *  (a key that evaporates on quit would strand every blob it sealed). */
export function ensureVaultKey(): Buffer | null {
  const existing = readVaultKeyState()
  if (existing.state === 'ok') return existing.key
  if (existing.state === 'unreadable') return null
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('backup', 'encryption unavailable — refusing to create a vault key')
      return null
    }
    const key = randomBytes(KEY_BYTES)
    writeFileAtomic(keyPath(), safeStorage.encryptString(key.toString('base64')).toString('base64'), {
      mode: 0o600,
    })
    return key
  } catch (err) {
    log.warn('backup', 'could not create vault key', err instanceof Error ? err.message : err)
    return null
  }
}

/** Store a key recovered from a typed recovery code (fresh-Mac restore). */
export function setVaultKey(key: Buffer): boolean {
  if (key.length !== KEY_BYTES) return false
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    writeFileAtomic(keyPath(), safeStorage.encryptString(key.toString('base64')).toString('base64'), {
      mode: 0o600,
    })
    return true
  } catch (err) {
    log.warn('backup', 'could not store vault key', err instanceof Error ? err.message : err)
    return false
  }
}

// NB: deliberately no clearVaultKey — sign-out must NOT drop the key (it would strand every blob
// it sealed); the key simply sits unused until sign-in. Add deletion only with an explicit
// "forget my backups" flow that says exactly that.

// ---------------------------------------------------------------------------
// Recovery code — Crockford base32 (no 0/O or 1/I/L ambiguity), 5-char groups.
// key(32) + sha256(key)[0..2](2) = 34 bytes = 272 bits → 55 chars → 11 groups.
// The checksum catches a typo'd code in the UI before any decrypt is attempted.
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base32Encode(buf: Buffer): string {
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of buf) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]
  return out
}

function base32Decode(str: string): Buffer | null {
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function checksum(key: Buffer): Buffer {
  return createHash('sha256').update(key).digest().subarray(0, CHECKSUM_BYTES)
}

/** `KODA-XXXXX-XXXXX-…` — 11 groups of 5. Shown once at enable, on user-initiated reveal, never logged. */
export function encodeRecoveryCode(key: Buffer): string {
  const raw = base32Encode(Buffer.concat([key, checksum(key)]))
  return `KODA-${raw.match(/.{1,5}/g)!.join('-')}`
}

/** Decode a typed code back to the key. Forgiving input: case, spaces/dashes, the optional KODA
 *  prefix, and Crockford's ambiguous letters (O→0, I/L→1) are all normalized. Null = bad code. */
export function decodeRecoveryCode(code: string): Buffer | null {
  const cleaned = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/^KODA/, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  const decoded = base32Decode(cleaned)
  if (!decoded || decoded.length < KEY_BYTES + CHECKSUM_BYTES) return null
  const key = decoded.subarray(0, KEY_BYTES)
  const check = decoded.subarray(KEY_BYTES, KEY_BYTES + CHECKSUM_BYTES)
  return checksum(key).equals(check) ? Buffer.from(key) : null
}
