/**
 * Blob sealing for cloud backup — AES-256-GCM with the vault key, pure functions over Buffers.
 *
 * Frame: [1 byte version][12 byte nonce][16 byte GCM tag][ciphertext]. Fixed-size header fields
 * make parsing trivial; the version byte lets a future scheme change without guessing. The AAD
 * binds a blob to its project identity so the server (or an attacker holding the bucket) can't
 * silently swap ciphertext between projects — decrypt fails instead of restoring the wrong tree.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 0x01
const NONCE_BYTES = 12
const TAG_BYTES = 16

export function backupAad(projectHash: string): string {
  return `koda-backup:v1:${projectHash}`
}

/** Distinct AAD domain so a replica blob can never be fed to the bundle-restore path (or vice versa). */
export function replicaAad(projectHash: string): string {
  return `koda-replica:v1:${projectHash}`
}

/** A mini app's SQLite snapshot — its OWN domain, scoped to project + app, so a binary `.db` blob is
 *  cryptographically separable from the (text-only) docs replica and the safety-git bundle: feeding an
 *  app-data blob to the replica reader, or one app's blob to another app, fails decrypt instead of
 *  loading the wrong database. The phone hardcodes this same string. */
export function appDataAad(projectHash: string, appId: string): string {
  return `koda-appdata:v1:${projectHash}:${appId}`
}

export function encryptBlob(plain: Buffer, aad: string, key: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ct])
}

/** Throws on any mismatch (wrong key, wrong project AAD, tampered blob, unknown version). */
export function decryptBlob(blob: Buffer, aad: string, key: Buffer): Buffer {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error('backup blob truncated')
  if (blob[0] !== VERSION) throw new Error(`unknown backup blob version ${blob[0]}`)
  const nonce = blob.subarray(1, 1 + NONCE_BYTES)
  const tag = blob.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES)
  const ct = blob.subarray(1 + NONCE_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}
