import { describe, expect, it } from 'vitest'
import { isChunkLoadError } from './ErrorBoundary'

describe('isChunkLoadError', () => {
  it('matches the real Vite dynamic-import failure from the logs', () => {
    // Verbatim message the renderer threw when MonacoDiffEditor's chunk failed to fetch.
    const err = new Error(
      'Failed to fetch dynamically imported module: http://localhost:5173/src/surface/MonacoDiffEditor.tsx',
    )
    expect(isChunkLoadError(err)).toBe(true)
  })

  it('matches the Safari/Firefox variants', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })

  it('does not misfire on an unrelated app error', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError('some string')).toBe(false)
  })
})
