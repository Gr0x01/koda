import { describe, expect, it } from 'vitest'
import { providerModelCatalogs } from './model-catalog'

describe('provider model catalogs', () => {
  it('distinguishes loading, sign-out, probe failure, empty, and ready states', () => {
    expect(providerModelCatalogs().codex.availability).toBe('checking')
    expect(
      providerModelCatalogs({
        codexAuthStatus: {
          signedIn: false,
          authMethod: null,
          requiresOpenaiAuth: true,
        },
      }).codex.availability,
    ).toBe('signed-out')
    expect(providerModelCatalogs({ codexProbeFailed: true }).codex.availability).toBe(
      'probe-failed',
    )
    expect(
      providerModelCatalogs({
        codexAuthStatus: {
          signedIn: true,
          authMethod: 'chatgpt',
          requiresOpenaiAuth: false,
        },
      }).codex.availability,
    ).toBe('empty')
    expect(
      providerModelCatalogs({
        codexModels: [{ id: 'gpt-current', label: 'GPT Current', isDefault: true }],
        codexAuthStatus: {
          signedIn: true,
          authMethod: 'chatgpt',
          requiresOpenaiAuth: false,
        },
      }).codex,
    ).toEqual({
      availability: 'ready',
      models: [{ id: 'gpt-current', label: 'GPT Current', isDefault: true }],
    })
  })
})
