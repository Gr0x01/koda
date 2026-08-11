import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTACHABLE_IMAGE_MIME } from '@shared/attachments'
import { listScratchImages, saveScratchImage } from './scratch'

/**
 * The scratch store names the saved copy of an attachment from its media type. That map used to be
 * hand-written here and drifted from the composer's accept-list, so a type the composer accepted but
 * this map had never heard of landed as `<stem>.img` and then never listed back as an image. Both
 * now derive from `@shared/attachments`, so the drift is unrepresentable.
 */
describe('scratch image naming', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'koda-scratch-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

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
})
