import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { encryptBlob, replicaAad } from './crypto'
import { buildDocsSnapshot, docImageRefs, type ReplicaSnapshot } from './replica'

/**
 * The phone's exact read path, re-run under Node's WebCrypto: same [version|nonce|tag|ct] parse,
 * same AES-GCM+AAD subtle.decrypt, same DecompressionStream gunzip (src/mobile/src/replica.ts).
 * Proves a Mac-sealed blob opens on the other runtime — the cross-platform seam this feature
 * lives or dies on.
 */
async function phoneDecrypt(blob: Uint8Array, aad: string, rawKey: Uint8Array): Promise<ReplicaSnapshot> {
  expect(blob[0]).toBe(0x01)
  const nonce = blob.slice(1, 13)
  const tag = blob.slice(13, 29)
  const ct = blob.slice(29)
  const joined = new Uint8Array(ct.length + tag.length)
  joined.set(ct)
  joined.set(tag, ct.length)
  const key = await crypto.subtle.importKey('raw', rawKey.buffer as ArrayBuffer, 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) },
    key,
    joined,
  )
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(stream).text()) as ReplicaSnapshot
}

async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-replica-test-'))
  await mkdir(join(dir, 'Documents', 'plans'), { recursive: true })
  await mkdir(join(dir, '.koda', 'memory'), { recursive: true })
  await writeFile(join(dir, 'Documents', 'notes.md'), '# Notes\n\nhello from the mac')
  await writeFile(join(dir, 'Documents', 'plans', 'roadmap.md'), '# Roadmap\n\n- ship it')
  await writeFile(join(dir, '.koda', 'memory', 'MEMORY.md'), '# Memory index')
  await writeFile(join(dir, 'Documents', '.DS_Store'), 'junk') // hidden — never shipped
  await writeFile(join(dir, 'src.ts'), 'not a doc') // outside the replica roots
  return dir
}

describe('docs snapshot', () => {
  it('collects Documents + memory, skips hidden files and non-doc roots', async () => {
    const dir = await scaffold()
    try {
      const snap = await buildDocsSnapshot(dir)
      expect(snap).not.toBeNull()
      const rels = snap!.files.map((f) => f.rel).sort()
      expect(rels).toEqual(['.koda/memory/MEMORY.md', 'Documents/notes.md', 'Documents/plans/roadmap.md'])
      expect(snap!.skipped).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caps oversized files into the sealed skipped list instead of shipping them', async () => {
    const dir = await scaffold()
    try {
      await writeFile(join(dir, 'Documents', 'big.mov'), randomBytes(3 * 1024 * 1024))
      const snap = await buildDocsSnapshot(dir)
      expect(snap!.files.some((f) => f.rel === 'Documents/big.mov')).toBe(false)
      expect(snap!.skipped).toEqual([{ rel: 'Documents/big.mov', bytes: 3 * 1024 * 1024 }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a project with nothing to replicate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koda-replica-empty-'))
    try {
      expect(await buildDocsSnapshot(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('embedded image refs', () => {
  it('pulls markdown local image refs, skips remote/data URLs and raw <img>', () => {
    const md = [
      '![a](assets/one.png)',
      '![b](../shared/two.jpg "a title")',
      '<img src="raw.webp" alt="c">', // raw HTML — never rendered (no rehype-raw), so never collected
      '![remote](https://example.com/x.png)',
      '![inline](data:image/png;base64,AAAA)',
      '[not an image](notes.md)',
    ].join('\n\n')
    expect(docImageRefs(md).sort()).toEqual(['../shared/two.jpg', 'assets/one.png'])
  })

  it('decodes percent-encoded paths so the lookup key matches the file on disk', () => {
    expect(docImageRefs('![x](my%20folder/a%20shot.png)')).toEqual(['my folder/a shot.png'])
  })
})

describe('mac-seals, phone-opens', () => {
  it('a Mac-built sealed snapshot decrypts via the phone’s exact WebCrypto steps', async () => {
    const dir = await scaffold()
    try {
      const key = randomBytes(32)
      const hash = 'abcdef0123456789'
      const snap = await buildDocsSnapshot(dir)
      const sealed = encryptBlob(gzipSync(Buffer.from(JSON.stringify(snap))), replicaAad(hash), key)

      const opened = await phoneDecrypt(new Uint8Array(sealed), `koda-replica:v1:${hash}`, new Uint8Array(key))
      expect(opened.schemaVersion).toBe(1)
      const notes = opened.files.find((f) => f.rel === 'Documents/notes.md')!
      expect(Buffer.from(notes.b64, 'base64').toString()).toBe('# Notes\n\nhello from the mac')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the wrong AAD domain refuses (a replica blob can never feed the bundle-restore path)', async () => {
    const key = randomBytes(32)
    const sealed = encryptBlob(gzipSync(Buffer.from('{}')), replicaAad('aaaa'), key)
    await expect(phoneDecrypt(new Uint8Array(sealed), 'koda-backup:v1:aaaa', new Uint8Array(key))).rejects.toThrow()
  })
})
