import { describe, expect, it } from 'vitest'
import { resolvePreviewAddress } from './preview-address'

const page = 'koda-preview://tok/.koda/scratch/mocks/d.html'

describe('resolvePreviewAddress', () => {
  it('reads a bare path from the project root and ./ or ../ from the page on screen', () => {
    expect(resolvePreviewAddress('mocks/a.html', page)).toEqual({ url: 'koda-preview://tok/mocks/a.html' })
    expect(resolvePreviewAddress('./a.html', page)).toEqual({
      url: 'koda-preview://tok/.koda/scratch/mocks/a.html',
    })
    expect(resolvePreviewAddress('../b.html', page)).toEqual({ url: 'koda-preview://tok/.koda/scratch/b.html' })
    expect(resolvePreviewAddress('/index.html', page)).toEqual({ url: 'koda-preview://tok/index.html' })
  })

  it('takes a full preview or localhost URL as written and refuses anything off this Mac', () => {
    expect(resolvePreviewAddress('koda-preview://tok/x.html', page)).toEqual({ url: 'koda-preview://tok/x.html' })
    expect(resolvePreviewAddress('http://localhost:5173/about', page)).toEqual({
      url: 'http://localhost:5173/about',
    })
    expect(resolvePreviewAddress('localhost:5173', page)).toEqual({ url: 'http://localhost:5173/' })
    expect(resolvePreviewAddress('https://example.com', page)).toMatchObject({ refused: expect.any(String) })
    expect(resolvePreviewAddress('http://[::1]:5173/', page)).toMatchObject({ refused: expect.any(String) })
    expect(resolvePreviewAddress('file:///etc/hosts', page)).toMatchObject({ refused: expect.any(String) })
  })

  it('keeps browser rules on a dev-server page and ignores an empty entry', () => {
    expect(resolvePreviewAddress('/about', 'http://localhost:5173/home')).toEqual({
      url: 'http://localhost:5173/about',
    })
    expect(resolvePreviewAddress('team', 'http://localhost:5173/about/')).toEqual({
      url: 'http://localhost:5173/about/team',
    })
    expect(resolvePreviewAddress('   ', page)).toBeNull()
  })
})
