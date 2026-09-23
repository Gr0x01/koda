import { describe, expect, it } from 'vitest'
import { friendlyEngineError } from './engine-error'

describe('a model the engine refused', () => {
  const REFUSAL =
    "There's an issue with the selected model (claude-opus-5.5). It may not exist or you may not have access to it. Run --model to pick a different model."

  it('names the rejected model and offers no retry', () => {
    const copy = friendlyEngineError(REFUSAL, false, { code: 'model_not_found', model: 'claude-opus-5.5' })
    expect(copy.title).toBe('That model is not available')
    expect(copy.detail).toContain('claude-opus-5.5')
    // A retry sends the same refused id again, so "Try again" would be a lie.
    expect(copy.retryable).toBe(false)
  })

  it('still says what happened when the engine named no model', () => {
    const copy = friendlyEngineError(REFUSAL, false, { code: 'model_not_found' })
    expect(copy.title).toBe('That model is not available')
    expect(copy.retryable).toBe(false)
  })

  it('reads as a plain failure without the typed code', () => {
    // The same sentence with no code attached must not be pattern-matched into the model branch:
    // only the engine's own marking earns that copy.
    expect(friendlyEngineError(REFUSAL, false).title).not.toBe('That model is not available')
  })

  it('does not shadow a transient failure that carries a different code', () => {
    const copy = friendlyEngineError('API Error: 529 Overloaded', false, { code: 'overloaded_error' })
    expect(copy.retryable).toBe(true)
  })
})
