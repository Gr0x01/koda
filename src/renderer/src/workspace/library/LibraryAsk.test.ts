import { describe, expect, it, vi } from 'vitest'
import { useWorkspace } from '../store'
import { askWithFreshHotStore } from './LibraryAsk'

describe('Library Ask preflight cancellation', () => {
  it('never starts the billed ask when the surface closes during a deferred hot-store save', async () => {
    let releaseSave!: () => void
    let markSaveStarted!: () => void
    const saveGate = new Promise<void>((resolve) => (releaseSave = resolve))
    const saveStarted = new Promise<void>((resolve) => (markSaveStarted = resolve))
    const libraryAsk = vi.fn(async () => ({ question: 'What changed?', answer: '', citations: [] }))
    ;(globalThis as unknown as { window: unknown }).window = {
      koda: {
        saveSessions: vi.fn(async () => {
          markSaveStarted()
          await saveGate
          return true
        }),
        libraryAsk,
      },
    }
    useWorkspace.setState({ hydrated: true, sessions: {}, order: [], activeId: null })

    let current = true
    const pending = askWithFreshHotStore(
      { question: 'What changed?', requestId: 'ask-1' },
      () => current,
    )
    await saveStarted
    current = false // Back/unmount/owner loss increments the component request generation.
    releaseSave()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(libraryAsk).not.toHaveBeenCalled()
  })
})
