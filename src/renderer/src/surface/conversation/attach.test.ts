import { beforeAll, describe, expect, it } from 'vitest'
import { refusedAttachmentMessage, stagingFromFiles } from './attach'

/**
 * The refusal half of the composer's attach path: an unattachable file (a HEIC off an iPhone is the
 * real case) used to vanish with no chip and no word, which reads as the app being broken.
 *
 * `stagingFromFiles` reads bytes through browser APIs Node doesn't ship, so the two it needs are
 * stubbed here: FileReader (base64 out) and window.koda.getSettings (the downscale cap). Nothing else
 * is faked — the accept-list verdict and the staging pipeline are the real ones. `createImageBitmap`
 * stays missing on purpose: that's the "decode failed" branch, which falls back to the raw bytes.
 */
beforeAll(() => {
  class StubFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(blob: Blob): void {
      void blob
        .arrayBuffer()
        .then((buf) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`
          this.onload?.()
        })
        .catch(() => this.onerror?.())
    }
  }
  ;(globalThis as Record<string, unknown>).FileReader = StubFileReader
  ;(globalThis as Record<string, unknown>).window = {
    koda: { getSettings: async () => ({ imageDetail: 'balanced' }) },
  }
})

const file = (name: string, type: string): File => new File([new Uint8Array([1, 2, 3])], name, { type })

describe('refusedAttachmentMessage', () => {
  it('says nothing when every file is attachable', () => {
    expect(refusedAttachmentMessage([file('shot.png', 'image/png'), file('rows.csv', 'text/csv')])).toBeNull()
  })

  it('names a single refused file and how to fix it', () => {
    expect(refusedAttachmentMessage([file('IMG_0042.heic', 'image/heic')])).toBe(
      "Koda can't attach IMG_0042.heic. Export as JPEG or PNG.",
    )
  })

  it('names the extension once when several files share it', () => {
    const msg = refusedAttachmentMessage([file('a.heic', ''), file('b.heic', '')])
    expect(msg).toBe("Koda can't attach .heic files. Export as JPEG or PNG.")
  })

  it('lists every refused extension when they differ', () => {
    const msg = refusedAttachmentMessage([file('a.heic', ''), file('b.zip', ''), file('c.tiff', '')])
    expect(msg).toBe("Koda can't attach .heic, .zip and .tiff files. Export as JPEG or PNG.")
  })

  it('points a non-image at the read-it-in-place fix instead of exporting', () => {
    expect(refusedAttachmentMessage([file('notes.txt', 'text/plain')])).toBe(
      "Koda can't attach notes.txt. Point at it with the attach menu so the agent reads it in place.",
    )
  })

  it('ignores the attachable files when reporting a mixed drop', () => {
    const msg = refusedAttachmentMessage([file('shot.png', 'image/png'), file('IMG_1.heic', 'image/heic')])
    expect(msg).toBe("Koda can't attach IMG_1.heic. Export as JPEG or PNG.")
  })
})

describe('stagingFromFiles', () => {
  it('stages nothing for a refused file', async () => {
    expect(await stagingFromFiles([file('IMG_0042.heic', 'image/heic')])).toEqual([])
  })

  it('stages an attachable file', async () => {
    const staged = await stagingFromFiles([file('shot.png', 'image/png')])
    expect(staged).toHaveLength(1)
    expect(staged[0].mediaType).toBe('image/png')
  })

  it('stages the attachable half of a mixed drop', async () => {
    const staged = await stagingFromFiles([file('shot.png', 'image/png'), file('IMG_1.heic', 'image/heic')])
    expect(staged.map((s) => s.mediaType)).toEqual(['image/png'])
  })
})
