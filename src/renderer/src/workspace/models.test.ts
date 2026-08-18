import { describe, expect, it } from 'vitest'
import { providerModelCatalogs } from '@shared/model-catalog'
import { modelChoicesFor, providerAvailability } from './models'

describe('shared model picker catalog', () => {
  it('builds Claude aliases, useful recents, and the resolved default once for both surfaces', () => {
    const choices = modelChoicesFor('claude', {
      engineId: 'claude',
      activeModel: 'claude-opus-4-8',
      recentModels: ['sonnet', 'claude-legacy-3-7'],
      providerCatalogs: providerModelCatalogs(),
    })

    expect(choices[0]).toMatchObject({ id: 'fable', badge: 'Recommended' })
    expect(choices).toContainEqual({
      id: 'claude-legacy-3-7',
      label: 'Legacy 3.7',
      description: 'claude-legacy-3-7',
    })
    expect(choices).not.toContainEqual(expect.objectContaining({ id: 'sonnet', description: 'sonnet' }))
    expect(choices.at(-1)).toEqual({
      id: undefined,
      label: 'Engine default',
      description: 'Currently Opus 4.8',
      badge: 'Auto',
    })
  })

  it('renders a provider-reported Codex catalog without a surface-specific model map', () => {
    const catalogs = providerModelCatalogs({
      codexModels: [{ id: 'gpt-current', label: 'GPT Current', isDefault: true }],
      codexAuthStatus: {
        signedIn: true,
        authMethod: 'chatgpt',
        requiresOpenaiAuth: false,
      },
    })
    expect(
      modelChoicesFor('codex', {
        engineId: 'claude',
        model: 'opus',
        recentModels: [],
        providerCatalogs: catalogs,
      }),
    ).toEqual([
      { id: 'gpt-current', label: 'GPT Current', badge: 'Recommended' },
      {
        id: undefined,
        label: 'Engine default',
        description: 'Let Codex choose',
        badge: 'Auto',
      },
    ])
    expect(providerAvailability('codex', catalogs)).toBe('ready')
    expect(
      providerAvailability('codex', providerModelCatalogs({ codexProbeFailed: true })),
    ).toBe('probe-failed')
  })
})
