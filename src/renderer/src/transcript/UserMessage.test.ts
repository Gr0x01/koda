import { describe, expect, it } from 'vitest'
import { visiblePhotoAttachments } from './UserMessage'

describe('UserMessage attachment rendering', () => {
  it('keeps failed document retry bytes hidden while retaining real photo thumbnails', () => {
    expect(
      visiblePhotoAttachments([
        { mediaType: 'application/pdf', dataBase64: 'UERG' },
        { mediaType: 'text/csv', dataBase64: 'Q1NW' },
        { mediaType: 'image/png', dataBase64: 'UE5H' },
      ]),
    ).toEqual([{ mediaType: 'image/png', dataBase64: 'UE5H' }])
  })
})
