import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerFileWriter } from '../workspace/file-writer-registry'
import {
  isChunkLoadError,
  isModuleGraphError,
  noteModuleGraphRecovered,
  reloadForModuleGraphError,
} from './ErrorBoundary'

afterEach(() => vi.unstubAllGlobals())

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

describe('isModuleGraphError', () => {
  it('matches Milkdown mixing two Vite dependency generations', () => {
    expect(
      isModuleGraphError(new Error('MilkdownError: Timer "InitReady" not found, do you forget to record it?')),
    ).toBe(true)
  })

  it('keeps ordinary editor failures local', () => {
    expect(isModuleGraphError(new Error('Timing SchemaReady timeout.'))).toBe(false)
    expect(isModuleGraphError(new Error('Cannot parse markdown'))).toBe(false)
  })

  it('drains live editor buffers before reloading the renderer', async () => {
    const stored = new Map<string, string>()
    const reload = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    vi.stubGlobal('window', { location: { reload } })

    let release!: () => void
    const flush = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const unregister = registerFileWriter('/project/note.md', '/project/note.md', flush)

    try {
      const recovery = reloadForModuleGraphError(new Error('Timer "InitReady" not found'))
      await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
      expect(reload).not.toHaveBeenCalled()
      release()
      await expect(recovery).resolves.toBe(true)
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      unregister()
    }
  })

  it('reloads a few times to outlast a churn burst, then stops instead of looping', async () => {
    // A dev hot-reload burst splits Milkdown on more than one rebuild, so one reload is not enough.
    const stored = new Map<string, string>()
    const reload = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('window', { location: { reload } })
    const err = new Error('Timer "InitReady" not found')

    expect(await reloadForModuleGraphError(err)).toBe(true)
    expect(await reloadForModuleGraphError(err)).toBe(true)
    expect(await reloadForModuleGraphError(err)).toBe(true)
    // The fourth failure without a clean mount is a genuinely broken module: surface the card, don't loop.
    expect(await reloadForModuleGraphError(err)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('does not refill the budget just because the user retried slowly', async () => {
    // The regression that made ⌘K → open doc silently revert forever: each hand-paced retry arrived
    // after a quiet stretch, a time-based reset handed it a fresh budget, and the renderer reloaded
    // instead of ever showing the recovery card. Only a clean mount may restore the budget.
    const stored = new Map<string, string>()
    const reload = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('window', { location: { reload } })
    vi.useFakeTimers()
    const err = new Error('Timer "InitReady" not found')

    try {
      for (let i = 0; i < 3; i++) {
        expect(await reloadForModuleGraphError(err)).toBe(true)
        vi.advanceTimersByTime(10 * 60_000) // user waits, retries, fails again
      }
      expect(await reloadForModuleGraphError(err)).toBe(false)
      expect(reload).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the full budget once an editor mounts cleanly again', async () => {
    const stored = new Map<string, string>()
    const reload = vi.fn()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('window', { location: { reload } })
    const err = new Error('Timer "InitReady" not found')

    for (let i = 0; i < 3; i++) await reloadForModuleGraphError(err)
    expect(await reloadForModuleGraphError(err)).toBe(false) // budget spent within the window

    noteModuleGraphRecovered() // a doc editor mounted cleanly — the graph settled
    expect(await reloadForModuleGraphError(err)).toBe(true) // a later burst gets a fresh budget
    expect(reload).toHaveBeenCalledTimes(4)
  })

  it('keeps the renderer alive when an editor refuses its final save', async () => {
    const reload = vi.fn()
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() })
    vi.stubGlobal('window', { location: { reload } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unregister = registerFileWriter('/project/note.md', '/project/note.md', async () => {
      throw new Error('disk full')
    })

    try {
      await expect(reloadForModuleGraphError(new Error('Timer "InitReady" not found'))).resolves.toBe(false)
      expect(reload).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(
        'renderer reload blocked because an editor could not save:',
        expect.objectContaining({ message: 'disk full' }),
      )
    } finally {
      unregister()
      log.mockRestore()
    }
  })
})
