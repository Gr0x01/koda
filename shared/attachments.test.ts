import { describe, it, expect } from 'vitest'
import {
  ATTACHABLE_EXTENSIONS,
  ATTACHABLE_IMAGE_MIME,
  ATTACHABLE_MIME,
  EXT_FOR_MEDIA_TYPE,
  attachableMediaType,
  extensionOf,
} from './attachments'

// The accept-list used to be written out in four places and drifted (avif dropped in, was refused by
// the picker, saved as `.img`). These lock the two doors to the same set.
describe('attachment accept-list', () => {
  it('accepts the same set through the drop path and the file picker', () => {
    // Picker: the native dialog filters on ATTACHABLE_EXTENSIONS, then main resolves ATTACHABLE_MIME.
    // Drop/paste: the renderer calls attachableMediaType on each File. Same answer, every extension.
    for (const ext of ATTACHABLE_EXTENSIONS) {
      const dropped = attachableMediaType({ name: `shot.${ext}`, type: '' })
      expect(dropped, `drop rejected .${ext} that the picker offers`).toBe(ATTACHABLE_MIME[ext])
    }
  })

  it('rejects the same set through both doors', () => {
    for (const ext of ['heic', 'tiff', 'exe', 'md']) {
      expect(ATTACHABLE_EXTENSIONS).not.toContain(ext)
      expect(attachableMediaType({ name: `x.${ext}`, type: `image/${ext}` })).toBeNull()
    }
  })

  // Both engines take jpeg/png/gif/webp and nothing else. Accepting anything outside that set stages
  // a file that is rejected at send — and it cannot be justified by attach.ts re-encoding it first,
  // because a decode failure falls back to the raw file and Recent images skips compression entirely.
  it('accepts exactly the media types both engines can receive', () => {
    const ENGINE_OK = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
    for (const mime of Object.values(ATTACHABLE_IMAGE_MIME)) {
      expect(ENGINE_OK.has(mime), `${mime} is accepted but no engine can receive it`).toBe(true)
    }
  })

  it('refuses formats that would only work if a transcode never failed', () => {
    for (const ext of ['avif', 'svg', 'bmp']) {
      expect(ATTACHABLE_EXTENSIONS, `.${ext} can reach the engine as-is`).not.toContain(ext)
      expect(attachableMediaType({ name: `photo.${ext}`, type: `image/${ext}` })).toBeNull()
    }
  })

  it('maps every accepted media type back to an extension', () => {
    for (const mime of Object.values(ATTACHABLE_MIME)) {
      expect(EXT_FOR_MEDIA_TYPE[mime], `no save extension for ${mime}`).toBeTruthy()
    }
    expect(EXT_FOR_MEDIA_TYPE['image/jpeg']).toBe('jpg') // first extension listed wins
  })

  it('falls back to the browser MIME when a file has no extension', () => {
    expect(attachableMediaType({ name: 'clipboard', type: 'image/png' })).toBe('image/png')
    expect(attachableMediaType({ name: 'clipboard', type: 'application/zip' })).toBeNull()
    expect(extensionOf('.gitignore')).toBe('')
  })
})
