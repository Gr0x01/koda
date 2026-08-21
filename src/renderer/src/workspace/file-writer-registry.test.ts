import { describe, expect, it, vi } from 'vitest'
import {
  createSerialFlush,
  flushAllFileWriters,
  flushFileWritersUnder,
  registerFileWriter,
} from './file-writer-registry'

describe('file writer registry', () => {
  it('flushes the target and its descendants, but not an unrelated path', async () => {
    const calls: string[] = []
    const cleanups = [
      registerFileWriter('/project/Documents', '/project/Documents', async () => void calls.push('root')),
      registerFileWriter(
        '/project/Documents/note.md',
        '/project/Documents/note.md',
        async () => void calls.push('note'),
      ),
      registerFileWriter('/project/src/app.ts', '/project/src/app.ts', async () => void calls.push('source')),
    ]

    try {
      const affected = await flushFileWritersUnder('/project/Documents/')
      expect(calls).toEqual(['root', 'note'])
      expect(affected).toEqual(['/project/Documents', '/project/Documents/note.md'])
    } finally {
      cleanups.forEach((cleanup) => cleanup())
    }
  })

  it('stops exposing a writer after its identity-safe cleanup', async () => {
    const flush = vi.fn(async () => {})
    const unregister = registerFileWriter('/project/Documents/note.md', '/project/alias/note.md', flush)
    unregister()

    const replacement = vi.fn(async () => {})
    const unregisterReplacement = registerFileWriter(
      '/project/Documents/note.md',
      '/project/Documents/note.md',
      replacement,
    )
    // A stale React cleanup is harmless even if a new pane for the canonical file already mounted.
    unregister()

    try {
      const affected = await flushFileWritersUnder('/project/Documents/note.md')
      expect(flush).not.toHaveBeenCalled()
      expect(replacement).toHaveBeenCalledOnce()
      expect(affected).toEqual(['/project/Documents/note.md'])
    } finally {
      unregisterReplacement()
    }
  })

  it('matches a canonical delete to a writer opened through a lexical alias', async () => {
    const flush = vi.fn(async () => {})
    const canonicalPath = '/project/Documents/note.md'
    const surfacePath = '/project/linked-docs/NOTE.md'
    const unregister = registerFileWriter(canonicalPath, surfacePath, flush)

    try {
      await expect(flushFileWritersUnder(canonicalPath)).resolves.toEqual([surfacePath])
      expect(flush).toHaveBeenCalledOnce()
    } finally {
      unregister()
    }
  })

  it('propagates a writer failure and does not continue the destructive boundary', async () => {
    const afterFailure = vi.fn(async () => {})
    const cleanups = [
      registerFileWriter('/project/Documents/note.md', '/project/Documents/note.md', async () => {
        throw new Error('disk full')
      }),
      registerFileWriter('/project/Documents/note.md', '/project/Documents/note.md', afterFailure),
    ]

    try {
      await expect(flushFileWritersUnder('/project/Documents/note.md')).rejects.toThrow('disk full')
      expect(afterFailure).not.toHaveBeenCalled()
    } finally {
      cleanups.forEach((cleanup) => cleanup())
    }
  })

  it('drains writers across unrelated paths before a renderer reload', async () => {
    const calls: string[] = []
    const cleanups = [
      registerFileWriter(
        '/project/Documents/note.md',
        '/project/Documents/note.md',
        async () => void calls.push('doc'),
      ),
      registerFileWriter('/project/src/app.ts', '/project/src/app.ts', async () => void calls.push('code')),
    ]

    try {
      await flushAllFileWriters()
      expect(calls).toEqual(['doc', 'code'])
    } finally {
      cleanups.forEach((cleanup) => cleanup())
    }
  })
})

describe('createSerialFlush', () => {
  it('waits for an in-flight write, then reads the latest buffered value', async () => {
    const written: string[] = []
    const releases: Array<() => void> = []
    let value = 'first'
    const flush = createSerialFlush(async () => {
      const captured = value
      await new Promise<void>((resolve) => releases.push(resolve))
      written.push(captured)
    })

    const first = flush()
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    value = 'second'
    const latest = flush()
    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()

    await Promise.all([first, latest])
    expect(written).toEqual(['first', 'second'])
  })

  it('allows a retry after an earlier write rejects', async () => {
    const write = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce(undefined)
    const flush = createSerialFlush(write)

    await expect(flush()).rejects.toThrow('first failed')
    await expect(flush()).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledTimes(2)
  })
})
