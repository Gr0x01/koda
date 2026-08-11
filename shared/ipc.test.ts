import { describe, it, expect } from 'vitest'
import { undoPointRefusal } from './ipc'

/**
 * The renderer's half of the "your undo net failed" contract (debt item 17). Main refuses a destroying
 * edit it couldn't first make undoable and rejects with a sentence written for the user — but Electron
 * wraps a rejection's message inside its own text and drops the error type across the boundary, so the
 * renderer has to recover that sentence from a string. Every surface that shows the refusal (the Files
 * browser, the Find overlay's replace, Settings → Guardrails) goes through this one function.
 */
describe('undoPointRefusal', () => {
  it('recovers the user-facing sentence from a real Electron-wrapped rejection', () => {
    const wrapped = new Error(
      "Error invoking remote method 'fs:deletePath': Error: Couldn't make an undo point, so nothing was deleted.",
    )
    expect(undoPointRefusal(wrapped)).toBe("Couldn't make an undo point, so nothing was deleted.")
  })

  it('keeps each action’s own tail, so the message says what did not happen', () => {
    const replace = "Error: Couldn't make an undo point, so nothing was replaced."
    expect(undoPointRefusal(replace)).toBe("Couldn't make an undo point, so nothing was replaced.")
  })

  it('returns null for an unrelated failure, so ordinary errors keep their own copy', () => {
    expect(undoPointRefusal(new Error('a file or folder with that name already exists'))).toBeNull()
    expect(undoPointRefusal(undefined)).toBeNull()
  })
})
