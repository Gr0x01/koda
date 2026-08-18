import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ATTACHABLE_IMAGE_MIME } from '@shared/attachments'
import { listScratchImages, pruneScratch, saveScratchImage } from './scratch'

const readRace = vi.hoisted(() => ({ removeBeforeRead: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0]) => {
      if (readRace.removeBeforeRead && String(path).endsWith(readRace.removeBeforeRead)) {
        readRace.removeBeforeRead = null
        await actual.unlink(path as string)
      }
      return actual.readFile(path)
    },
  }
})

const NOW = Date.parse('2026-08-15T18:00:00.000Z')

/**
 * The scratch store names the saved copy of an attachment from its media type. That map used to be
 * hand-written here and drifted from the composer's accept-list, so a type the composer accepted but
 * this map had never heard of landed as `<stem>.img` and then never listed back as an image. Both
 * now derive from `@shared/attachments`, so the drift is unrepresentable.
 */
describe('scratch attachments', () => {
  let dir: string
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    readRace.removeBeforeRead = null
    dir = mkdtempSync(join(tmpdir(), 'koda-scratch-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function seed(rel: string, ageHours: number): string {
    const path = join(dir, '.koda', 'scratch', rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, rel)
    const stamp = new Date(NOW - ageHours * 60 * 60 * 1000)
    utimesSync(path, stamp, stamp)
    return path
  }

  it('saves a webp under .webp and lists it back as image/webp', async () => {
    const rel = await saveScratchImage(dir, 'image/webp', Buffer.from('webp-bytes').toString('base64'), 0)
    expect(rel.endsWith('.webp'), `webp saved as ${rel}`).toBe(true)
    const { images } = await listScratchImages(dir)
    expect(images.map((i) => i.mediaType)).toEqual(['image/webp'])
  })

  it('names every accepted image type from its own extension, never .img', async () => {
    for (const [ext, mediaType] of Object.entries(ATTACHABLE_IMAGE_MIME)) {
      const rel = await saveScratchImage(dir, mediaType, Buffer.from('x').toString('base64'), 0)
      // jpeg saves as .jpg — one canonical extension per media type, not the alias.
      const expected = mediaType === 'image/jpeg' ? 'jpg' : ext
      expect(rel.endsWith(`.${expected}`), `${mediaType} saved as ${rel}`).toBe(true)
    }
  })

  it('prunes expired top-level attachments but preserves recent files and nested work artifacts', async () => {
    const expiredImage = seed('expired.webp', 25)
    const expiredDocument = seed('expired.csv', 25)
    const recentImage = seed('recent.png', 23)
    const nestedArtifact = seed('mockups/keep.png', 240)

    await expect(pruneScratch(dir, 1)).resolves.toBe(2)

    expect(existsSync(expiredImage)).toBe(false)
    expect(existsSync(expiredDocument)).toBe(false)
    expect(existsSync(recentImage)).toBe(true)
    expect(existsSync(nestedArtifact)).toBe(true)
  })

  it('keeps even ancient attachments when retention is Forever', async () => {
    const ancient = seed('ancient.webp', 24 * 365)
    await expect(pruneScratch(dir, 0)).resolves.toBe(0)
    expect(existsSync(ancient)).toBe(true)
  })

  it('rebuilds a page when cleanup removes an image between stat and read', async () => {
    seed('vanish.webp', 1)
    readRace.removeBeforeRead = 'vanish.webp'

    await expect(listScratchImages(dir)).resolves.toEqual({ images: [], total: 0 })
  })
})
