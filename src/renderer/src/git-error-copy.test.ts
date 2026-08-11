import { describe, expect, it } from 'vitest'
import { gitErrorCopy } from './git-error-copy'

describe('gitErrorCopy', () => {
  it('keeps the missing-identity recovery consistent across save and restore', () => {
    const expected = 'Git needs your name and email first. Ask Koda to set them up.'

    expect(gitErrorCopy('no_identity', 'save')).toBe(expected)
    expect(gitErrorCopy('no_identity', 'restore')).toBe(expected)
  })

  it('keeps action-specific refusals distinct', () => {
    expect(gitErrorCopy('not_clean', 'save')).toBe('Save or discard your other changes first.')
    expect(gitErrorCopy('not_clean', 'restore')).toContain('before restoring')
  })
})
