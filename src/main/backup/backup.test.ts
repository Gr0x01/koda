import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeRecoveryCode, decodeRecoveryCode } from './vault-key'
import { encryptBlob, decryptBlob, backupAad } from './crypto'
import { createBundle, restoreFromBundle } from './bundle'
import { ensureRepo } from '../safety-git/repo'
import { checkpoint, listCheckpoints } from '../safety-git/checkpoint'

describe('recovery code', () => {
  it('round-trips a key', () => {
    const key = randomBytes(32)
    const code = encodeRecoveryCode(key)
    expect(code.startsWith('KODA-')).toBe(true)
    expect(decodeRecoveryCode(code)).toEqual(key)
  })

  it('forgives case, spacing, and Crockford look-alikes', () => {
    const key = randomBytes(32)
    const code = encodeRecoveryCode(key)
    const sloppy = code.toLowerCase().replaceAll('-', ' ').replace(/0/, 'O').replace(/1/, 'l')
    expect(decodeRecoveryCode(sloppy)).toEqual(key)
  })

  it('rejects a typo via the checksum', () => {
    const code = encodeRecoveryCode(randomBytes(32))
    // Flip one payload character to a different valid alphabet character.
    const i = 6
    const swapped = code[i] === 'A' ? 'B' : 'A'
    expect(decodeRecoveryCode(code.slice(0, i) + swapped + code.slice(i + 1))).toBeNull()
  })

  it('rejects garbage', () => {
    expect(decodeRecoveryCode('')).toBeNull()
    expect(decodeRecoveryCode('KODA-NOPE')).toBeNull()
  })
})

describe('blob sealing', () => {
  const key = randomBytes(32)
  const aad = backupAad('abc123')

  it('round-trips', () => {
    const plain = randomBytes(64 * 1024)
    expect(decryptBlob(encryptBlob(plain, aad, key), aad, key)).toEqual(plain)
  })

  it('refuses the wrong project AAD (no cross-project blob swap)', () => {
    const sealed = encryptBlob(Buffer.from('hello'), aad, key)
    expect(() => decryptBlob(sealed, backupAad('other!'), key)).toThrow()
  })

  it('refuses the wrong key and tampered bytes', () => {
    const sealed = encryptBlob(Buffer.from('hello'), aad, key)
    expect(() => decryptBlob(sealed, aad, randomBytes(32))).toThrow()
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => decryptBlob(tampered, aad, key)).toThrow()
  })

  it('refuses an unknown version byte', () => {
    const sealed = encryptBlob(Buffer.from('hello'), aad, key)
    const wrong = Buffer.from(sealed)
    wrong[0] = 0x02
    expect(() => decryptBlob(wrong, aad, key)).toThrow(/version/)
  })
})

/**
 * The kill test (ship-checklist-backup-sync.md, Phase 1): a backup that's never been restored is a
 * hope, not a feature. Full pipeline minus the network — checkpointed project → bundle → seal →
 * unseal → rebuild into a fresh dir → byte-identical files AND the intact undo timeline.
 */
describe('kill test: bundle → seal → delete → restore', () => {
  it('rebuilds the tree and the timeline', async () => {
    const src = await mkdtemp(join(tmpdir(), 'koda-killtest-src-'))
    const dst = await mkdtemp(join(tmpdir(), 'koda-killtest-dst-'))
    await rm(dst, { recursive: true }) // restore wants an absent/empty target; recreate via git clone
    try {
      await ensureRepo(src)
      await writeFile(join(src, 'app.ts'), 'export const v = 1\n')
      await checkpoint(src, 'first version')
      await writeFile(join(src, 'app.ts'), 'export const v = 2\n')
      await writeFile(join(src, 'notes.md'), '# plan\n')
      await checkpoint(src, 'second version')
      const timeline = await listCheckpoints(src)

      const bundle = await createBundle(src)
      expect(bundle).not.toBeNull()
      const key = randomBytes(32)
      const sealed = encryptBlob(bundle!, backupAad('hash'), key)

      // "The Mac dies" — the source is gone; all that's left is ciphertext + the key.
      await rm(src, { recursive: true, force: true })

      await restoreFromBundle(dst, decryptBlob(sealed, backupAad('hash'), key))
      expect(await readFile(join(dst, 'app.ts'), 'utf8')).toBe('export const v = 2\n')
      expect(await readFile(join(dst, 'notes.md'), 'utf8')).toBe('# plan\n')
      // restore() records its own "before recovery" / "recovered to …" points on top (the restore
      // is itself undoable) — the original timeline must survive underneath, in order.
      const restored = await listCheckpoints(dst)
      expect(restored.map((c) => c.label).slice(-timeline.length)).toEqual(timeline.map((c) => c.label))
    } finally {
      await rm(src, { recursive: true, force: true }).catch(() => {})
      await rm(dst, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('has nothing to back up before the first checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koda-killtest-empty-'))
    try {
      await ensureRepo(dir)
      expect(await createBundle(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('refuses to restore over a project that already has a safety store', async () => {
    const src = await mkdtemp(join(tmpdir(), 'koda-killtest-live-'))
    try {
      await ensureRepo(src)
      await writeFile(join(src, 'a.txt'), 'x')
      await checkpoint(src, 'work')
      const bundle = await createBundle(src)
      await expect(restoreFromBundle(src, bundle!)).rejects.toThrow(/safety store/)
    } finally {
      await rm(src, { recursive: true, force: true }).catch(() => {})
    }
  })
})
