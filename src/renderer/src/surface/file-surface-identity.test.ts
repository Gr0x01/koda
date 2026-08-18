import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILE_SURFACE_SOURCE = readFileSync(join(__dirname, 'FileSurfaceView.tsx'), 'utf8')
const DOC_SURFACE_SOURCE = readFileSync(join(__dirname, 'DocSurfaceView.tsx'), 'utf8')

describe('file surface identity handoff', () => {
  it.each([
    ['raw file', FILE_SURFACE_SOURCE, 'MonacoFileEditor'],
    ['document', DOC_SURFACE_SOURCE, 'CrepeDocEditor'],
  ])(
    'keeps the lexical %s path as the surface key while editing main’s resolved path',
    (_name, source, editor) => {
      expect(source).toContain('.readFile({ path })')
      const editorStart = source.indexOf(`<${editor}`)
      expect(editorStart, `${editor} is gone from its surface`).toBeGreaterThan(-1)
      const editorProps = source.slice(editorStart, source.indexOf('/>', editorStart))
      expect(editorProps).toContain('path={file.path}')
      expect(editorProps).toContain('surfacePath={path}')
    },
  )
})
